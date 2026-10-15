"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const BIN = path.join(ROOT, "bin", "spacesheep.js");
const PARENT = "ss_" + "a".repeat(48);
const CHILD = "ss_" + "b".repeat(48);
const WORKING = "ss_" + "c".repeat(48);
const REVOKED = "ss_" + "d".repeat(48);

function run(command, args, env, input = "") {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (s) => { stdout += s; });
    p.stderr.on("data", (s) => { stderr += s; });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, stdout, stderr }));
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}

function snapshot(dir) {
  const files = {};
  for (const name of fs.readdirSync(dir, { recursive: true }).sort()) {
    const file = path.join(dir, name);
    files[name] = fs.statSync(file).isDirectory() ? null : fs.readFileSync(file, "utf8");
  }
  return files;
}

// Real CLI processes and both SSH shell layers, with no external hosts, npm or
// credentials. The wrappers supply a login shell's PATH and an isolated HOME.
async function fixture(t, hosts = { lab: {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-install-ssh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = path.join(dir, "events.jsonl");
  const note = (e) => fs.appendFileSync(events, JSON.stringify(e) + "\n");
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/account/keys/connect") {
      note({ kind: "mint", body });
      return res.end(JSON.stringify({ key: CHILD, username: "ann", key_prefix: CHILD.slice(0, 11) }));
    }
    if (req.url === "/skill/sheep.md") return res.end("<!-- spacesheep-skill-version: 1.0.0 -->\n# Sheep\n");
    if (req.url !== "/mcp") { res.statusCode = 404; return res.end("{}"); }
    const key = req.headers.authorization;
    note({ kind: "mcp", method: body.method });
    if (key === `Bearer ${REVOKED}`) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", 'Bearer resource_metadata="test"');
      return res.end(JSON.stringify({ error: "revoked" }));
    }
    if (key === "Bearer ss_network_error") { res.statusCode = 503; return res.end("unavailable"); }
    if (key === "Bearer ss_proxy_error") { res.statusCode = 403; return res.end("blocked by proxy"); }
    if (key === "Bearer ss_scoped") { res.statusCode = 403; return res.end(JSON.stringify({ error: "insufficient_scope" })); }
    if (!body.id) { res.statusCode = 202; return res.end(); }
    const result = body.method === "tools/list" ? { tools: [{ name: "deploy" }] } : { protocolVersion: "2025-06-18", capabilities: {} };
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const local = path.join(dir, "local");
  fs.mkdirSync(local);
  const env = {
    ...process.env, HOME: local, XDG_CONFIG_HOME: path.join(local, ".config"),
    SPACESHEEP_CONFIG_DIR: path.join(local, ".config", "spacesheep"),
    SPACESHEEP_KEY: PARENT, SPACESHEEP_ORIGIN: origin, SPACESHEEP_APP_ORIGIN: origin,
    SPACESHEEP_NO_UPDATE_CHECK: "1", SPACESHEEP_QUIET: "", CI: "1",
    CLAUDE_CONFIG_DIR: "", CODEX_HOME: "",
  };
  const executable = (file, source) => fs.writeFileSync(file, source, { mode: 0o755 });
  for (const [host, h] of Object.entries(hosts)) {
    h.home = path.join(dir, host);
    h.bin = path.join(dir, host + "-bin");
    h.config = path.join(h.home, ".config", "spacesheep", "config.json");
    fs.mkdirSync(path.dirname(h.config), { recursive: true });
    fs.mkdirSync(h.bin);
    fs.mkdirSync(path.join(h.home, ".claude-work"));
    fs.writeFileSync(path.join(h.home, ".claude-work", "settings.json"), "{}\n");
    fs.writeFileSync(path.join(h.home, ".claude-work", ".claude.json"), "{}\n");
    if (h.key || h.machine) fs.writeFileSync(h.config, JSON.stringify({ key: h.key, machine: h.machine, username: "ann", other: "keep" }) + "\n");
    // Make stableCommand exercise the npx copy without ever contacting npm.
    h.cli = path.join(h.home, ".npm", "_npx", "spacesheep");
    fs.mkdirSync(h.cli, { recursive: true });
    for (const part of ["bin", "lib", "package.json", "LICENSE"]) fs.cpSync(path.join(ROOT, part), path.join(h.cli, part), { recursive: true });
    executable(path.join(h.bin, "sh"), '#!/bin/sh\nexec /bin/sh -c "$2"\n');
    if (!h.noBash) executable(path.join(h.bin, "bash"), '#!/bin/sh\nexec /bin/bash --noprofile --norc -c "$2"\n');
    if (!h.noNode) executable(path.join(h.bin, "node"), `#!${process.execPath}\nif (process.argv[2] === "-v") console.log(${JSON.stringify(h.version || "v22.0.0")});\nelse { const p = require("child_process").spawnSync(${JSON.stringify(process.execPath)}, process.argv.slice(2), {stdio:"inherit"}); process.exit(p.status || 0); }\n`);
    if (!h.noNpx) executable(path.join(h.bin, "npx"), String.raw`#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(4);
fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({kind:"cli", host:${JSON.stringify(host)}, args}) + "\n");
if (${!!h.failInstall} && args[0] === "install") process.exit(17);
if (${!!h.badStatus} && args.includes("status")) { console.log("not json"); process.exit(0); }
if (${!!h.oldStatus} && args.includes("status")) { console.log(JSON.stringify({signed_in:true})); process.exit(0); }
const p = require("child_process").spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(path.join(h.cli, "bin", "spacesheep.js"))}, ...args], {stdio:"inherit"});
p.on("close", (code) => process.exit(code));
`);
  }
  const sshBin = path.join(dir, "local-bin");
  fs.mkdirSync(sshBin);
  executable(path.join(sshBin, "ssh"), String.raw`#!${process.execPath}
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const [host, remote] = args;
const h = ${JSON.stringify(hosts)}[host];
fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({kind:"ssh", host, remote}) + "\n");
if (!h || h.unreachable) { console.error("ssh: host unreachable"); process.exit(255); }
const env = {...process.env, HOME:h.home, PATH:h.bin, XDG_CONFIG_HOME:path.join(h.home,".config"), SPACESHEEP_CONFIG_DIR:path.dirname(h.config), SPACESHEEP_KEY:h.envKey || "", CI:"1"};
const p = require("child_process").spawn("/bin/sh", ["-c", remote], {env, stdio:"inherit"});
p.on("close", (code) => process.exit(code));
`);
  env.PATH = sshBin + path.delimiter + process.env.PATH;
  return {
    hosts, dir, env,
    events: () => fs.existsSync(events) ? fs.readFileSync(events, "utf8").trim().split("\n").map(JSON.parse) : [],
    run: (args = []) => run(process.execPath, [BIN, "install", "--ssh", Object.keys(hosts).join(","), ...args], env),
  };
}

test("SSH skips a host with a working saved or environment key without renaming it", async (t) => {
  const f = await fixture(t, { saved: { key: WORKING, machine: "My laptop" }, environment: { envKey: WORKING, machine: "Work laptop" } });
  const before = Object.values(f.hosts).map((h) => snapshot(h.home));
  const r = await f.run();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.events().filter((e) => e.kind === "mint").length, 0);
  assert.equal(f.events().filter((e) => e.kind === "cli" && e.args[0] === "install").length, 0);
  assert.match(r.stderr, /already.*working key.*skip|skip.*working key/i);
  assert.deepEqual(Object.values(f.hosts).map((h) => snapshot(h.home)), before);
});

test("SSH --force replaces a working key but preserves the configured machine name", async (t) => {
  const f = await fixture(t, { lab: { key: WORKING, machine: "My laptop" } });
  const r = await f.run(["--force"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(f.events().filter((e) => e.kind === "mint").map((e) => e.body), [{ name: "My laptop" }]);
  const saved = JSON.parse(fs.readFileSync(f.hosts.lab.config));
  assert.equal(saved.key, CHILD);
  assert.equal(saved.machine, "My laptop");
  assert.equal(saved.other, "keep");
});

test("SSH --name explicitly renames a host when replacement is forced", async (t) => {
  const f = await fixture(t, { lab: { key: WORKING, machine: "Old name" } });
  const name = "Ann's laptop $(false); `false`";
  const r = await f.run(["--force", "--name", name]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(f.hosts.lab.config)).machine, name);
  assert.equal(f.events().find((e) => e.kind === "mint").body.name, name);
});

for (const [label, host, message] of [
  ["unreachable", { unreachable: true }, /unreachable/],
  ["missing Node", { noNode: true }, /Node.*missing|node.*not found/i],
  ["missing npx", { noNpx: true }, /npx.*missing|npx.*not found/i],
  ["old Node", { version: "v18.20.8" }, /Node >= 20.*v18\.20\.8/],
]) {
  test(`SSH probes ${label} before minting`, async (t) => {
    const f = await fixture(t, { lab: host });
    const r = await f.run();
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, message);
    assert.equal(f.events().filter((e) => e.kind === "mint").length, 0);
    assert.equal(f.events().filter((e) => e.kind === "cli").length, 0);
  });
}

test("SSH checks status before minting for a revoked key and keeps its machine name", async (t) => {
  const f = await fixture(t, { lab: { key: REVOKED, machine: "Bench 03", version: "v20.0.0" } });
  const r = await f.run(["--no-skill"]);
  assert.equal(r.code, 0, r.stderr);
  const events = f.events();
  assert.ok(events.findIndex((e) => e.kind === "cli" && e.args.includes("status")) < events.findIndex((e) => e.kind === "mint"));
  assert.equal(events.find((e) => e.kind === "mint").body.name, "Bench 03");
  assert.equal(JSON.parse(fs.readFileSync(f.hosts.lab.config)).machine, "Bench 03");
});

for (const host of [{ key: "ss_network_error" }, { key: "ss_proxy_error" }, { badStatus: true }, { oldStatus: true }]) {
  test(`SSH refuses to mint when status cannot be established (${JSON.stringify(host)})`, async (t) => {
    const f = await fixture(t, { lab: host });
    const r = await f.run();
    assert.notEqual(r.code, 0);
    assert.equal(f.events().filter((e) => e.kind === "mint").length, 0);
  });
}

test("SSH --force still probes before minting", async (t) => {
  const f = await fixture(t, { lab: { key: WORKING, noNpx: true } });
  const r = await f.run(["--force"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /npx is missing/);
  assert.equal(f.events().filter((e) => e.kind === "mint").length, 0);
});

test("SSH replaces a key explicitly refused for insufficient scope", async (t) => {
  const f = await fixture(t, { lab: { key: "ss_scoped" } });
  const r = await f.run(["--no-skill"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.events().filter((e) => e.kind === "mint").length, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.hosts.lab.config)).key, CHILD);
});

test("SSH passes a dotted --only home id intact through a POSIX sh fallback", async (t) => {
  const f = await fixture(t, { lab: { noBash: true } });
  const r = await f.run(["--only", "claude-code:.claude-work", "--no-skill"]);
  assert.equal(r.code, 0, r.stderr);
  const entry = JSON.parse(fs.readFileSync(path.join(f.hosts.lab.home, ".claude-work", ".claude.json")));
  assert.ok(entry.mcpServers.spacesheep);
  assert.ok(f.events().find((e) => e.kind === "cli" && e.args.includes("claude-code:.claude-work")));
});

test("SSH preserves hostile --only literally; no shell injection on either shell layer", async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.dir, "INJECTED");
  const only = `claude-code:.claude-work'; > ${marker}; #\n$(> ${marker}) \`> ${marker}\` "`;
  const r = await f.run(["--only", only, "--no-skill"]);
  assert.notEqual(r.code, 0);
  assert.equal(fs.existsSync(marker), false);
  const args = f.events().find((e) => e.kind === "cli" && e.args[0] === "install").args;
  assert.equal(args[args.indexOf("--only") + 1], only);
  assert.match(r.stderr, /--only: no harness called/);
  assert.match(r.stderr, /ss_bbbbbbbb.*revoke/i);
  assert.ok(!r.stderr.includes(CHILD));
});

test("SSH forwards repeated --skip and keeps skipped configs and skills untouched", async (t) => {
  const f = await fixture(t);
  const home = f.hosts.lab.home;
  fs.mkdirSync(path.join(home, ".codex", "skills"), { recursive: true });
  fs.mkdirSync(path.join(home, ".cursor"));
  const before = snapshot(path.join(home, ".claude-work"));
  const r = await f.run(["--skip", "claude-code:.claude-work", "--skip", "cursor"]);
  assert.equal(r.code, 0, r.stderr);
  const args = f.events().find((e) => e.kind === "cli" && e.args[0] === "install").args;
  assert.equal(args.filter((a) => a === "--skip").length, 2);
  assert.deepEqual(snapshot(path.join(home, ".claude-work")), before);
  assert.equal(fs.existsSync(path.join(home, ".cursor", "mcp.json")), false);
  assert.ok(fs.existsSync(path.join(home, ".codex", "config.toml")));
  assert.ok(fs.existsSync(path.join(home, ".codex", "skills", "sheep", "SKILL.md")));
});

test("SSH dry-run forwards the flag, prints the host plan, mints nothing and writes nothing", async (t) => {
  const f = await fixture(t);
  const before = snapshot(f.hosts.lab.home);
  const r = await f.run(["--dry-run", "--only", "claude-code"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.events().filter((e) => e.kind === "mint").length, 0);
  const args = f.events().find((e) => e.kind === "cli" && e.args[0] === "install").args;
  assert.ok(args.includes("--dry-run"));
  assert.ok(!args.includes("--key"));
  assert.match(r.stderr, /Would connect/);
  assert.match(r.stderr, /claude-work/);
  assert.match(r.stderr, /Nothing was written/);
  assert.deepEqual(snapshot(f.hosts.lab.home), before);
});

test("SSH --force --dry-run previews replacement without changing the existing key/name", async (t) => {
  const f = await fixture(t, { lab: { key: WORKING, machine: "My laptop" } });
  const before = snapshot(f.hosts.lab.home);
  const r = await f.run(["--force", "--dry-run", "--name", "New name"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.events().filter((e) => e.kind === "mint").length, 0);
  assert.match(r.stderr, /New name/);
  assert.deepEqual(snapshot(f.hosts.lab.home), before);
});

test("SSH failures after minting identify the key to revoke and continue the fleet", async (t) => {
  const f = await fixture(t, { broken: { failInstall: true }, ready: { key: WORKING }, fresh: {} });
  const r = await f.run(["--no-skill"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /broken.*exit 17.*ss_bbbbbbbb.*revoke/);
  assert.ok(!r.stderr.includes(CHILD));
  assert.equal(f.events().filter((e) => e.kind === "mint").length, 2);
  assert.equal(JSON.parse(fs.readFileSync(f.hosts.fresh.config)).key, CHILD);
});

test("local install --key - keeps a configured name unless --name is explicit", async (t) => {
  const f = await fixture(t);
  fs.mkdirSync(f.env.SPACESHEEP_CONFIG_DIR, { recursive: true });
  const file = path.join(f.env.SPACESHEEP_CONFIG_DIR, "config.json");
  fs.writeFileSync(file, JSON.stringify({ machine: "Existing name" }));
  const r = await run(process.execPath, [BIN, "install", "--key", "-", "--no-skill"], f.env, CHILD);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(file)).machine, "Existing name");
});

test("local dry-run without a key never signs in or writes an update-check cache", async (t) => {
  const f = await fixture(t);
  const env = { ...f.env, SPACESHEEP_KEY: "", SPACESHEEP_NO_UPDATE_CHECK: "", CI: "" };
  const before = snapshot(env.HOME);
  const r = await run(process.execPath, [BIN, "install", "--dry-run", "--key", PARENT], env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.events().filter((e) => e.kind === "mint").length, 0);
  assert.match(r.stderr, /Would connect/);
  assert.deepEqual(snapshot(env.HOME), before);
});
