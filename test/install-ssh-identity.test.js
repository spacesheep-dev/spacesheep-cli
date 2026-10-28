"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const KEY = "ss_existing_test_key";
const CHILD = "ss_minted_test_key";

function run(args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, "bin", "spacesheep.js"), "install", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir, { recursive: true }).sort().map((name) => {
    const file = path.join(dir, name);
    return [name, fs.statSync(file).isDirectory() ? null : fs.readFileSync(file, "utf8")];
  }));
}

// Execute both real shell layers and the real CLI with isolated homes. Only SSH,
// npm's package fetch and the HTTP server are stand-ins; no fleet or real keys.
async function fixture(t, hosts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-ssh-identity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, "events.jsonl");
  const note = (event) => fs.appendFileSync(logFile, JSON.stringify(event) + "\n");
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/account/keys/connect") {
      note({ kind: "mint", body });
      return res.end(JSON.stringify({ key: CHILD, username: "tester" }));
    }
    if (req.url !== "/mcp") { note({ kind: "unexpected", url: req.url }); res.statusCode = 404; return res.end("{}"); }
    note({ kind: "mcp", method: body.method });
    if (req.headers.authorization === "Bearer ss_revoked") {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", 'Bearer resource_metadata="test"');
      return res.end('{"error":"invalid_token"}');
    }
    if (req.headers.authorization === "Bearer ss_outage") { res.statusCode = 503; return res.end("offline"); }
    if (req.headers.authorization === "Bearer ss_proxy") { res.statusCode = 401; return res.end("proxy refusal"); }
    if (req.headers.authorization === "Bearer ss_scoped") { res.statusCode = 403; return res.end('{"error":"insufficient_scope"}'); }
    if (!body.id) { res.statusCode = 202; return res.end(); }
    const result = body.method === "tools/list" ? { tools: [{ name: "deploy" }] } : { protocolVersion: "2025-06-18", capabilities: {} };
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executable = (file, source) => fs.writeFileSync(file, source, { mode: 0o755 });
  const nodeAt = (file) => {
    try { fs.linkSync(process.execPath, file); }
    catch (e) { if (e.code !== "EXDEV") throw e; fs.copyFileSync(process.execPath, file); }
  };
  for (const [host, h] of Object.entries(hosts)) {
    h.home = path.join(dir, host);
    h.bin = path.join(dir, host + "-bin");
    h.config = path.join(h.home, ".config", "spacesheep", "config.json");
    fs.mkdirSync(path.dirname(h.config), { recursive: true });
    fs.mkdirSync(h.bin);
    if (h.key || h.machine || h.rawConfig) fs.writeFileSync(h.config, h.rawConfig || JSON.stringify({ key: h.key, machine: h.machine, other: "keep me" }) + "\n");
    // A real binary at a distinct path proves which node the probe selected.
    if (!h.noNode) nodeAt(path.join(h.bin, "node"));
    if (h.homebrew) {
      const cellar = path.join(h.home, "brew", "Cellar", "node", "22.0.0", "bin");
      const stable = path.join(h.home, "brew", "opt", "node", "bin");
      fs.mkdirSync(cellar, { recursive: true }); fs.mkdirSync(stable, { recursive: true });
      nodeAt(path.join(cellar, "node"));
      fs.unlinkSync(path.join(h.bin, "node"));
      fs.symlinkSync(path.join(cellar, "node"), path.join(h.bin, "node"));
      fs.symlinkSync(path.join(cellar, "node"), path.join(stable, "node"));
      h.resolvedNode = path.join(stable, "node");
    } else { h.resolvedNode = path.join(h.bin, "node"); }
    if (h.nvm) {
      const nvm = path.join(h.home, ".nvm", "versions", "node", "v22.0.0", "bin");
      fs.mkdirSync(nvm, { recursive: true });
      nodeAt(path.join(nvm, "node"));
      h.resolvedNode = path.join(nvm, "node");
    }
    h.preload = path.join(dir, host + "-preload.cjs");
    fs.writeFileSync(h.preload, `require("os").hostname = () => ${JSON.stringify(h.hostname || "physical-box.local")};\n` +
      (h.oldNode ? `if (process.execPath === ${JSON.stringify(path.join(h.bin, "node"))}) Object.defineProperty(process.versions, "node", { value: "18.0.0" });\n` : ""));
    executable(path.join(h.bin, "sh"), '#!/bin/sh\nexec /bin/sh -c "$2"\n');
    if (!h.noBash) executable(path.join(h.bin, "bash"), '#!/bin/sh\nexec /bin/bash --noprofile --norc -c "$2"\n');
    if (!h.noNpx) executable(path.join(h.bin, "npx"), String.raw`#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(4);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({kind:"install", host:${JSON.stringify(host)}, args, node:process.execPath}) + "\n");
if (${!!h.failInstall}) process.exit(17);
const p = require("child_process").spawn(process.execPath, [${JSON.stringify(path.join(ROOT, "bin", "spacesheep.js"))}, ...args], {stdio:"inherit"});
p.on("close", (code) => process.exit(code));
`);
  }
  const local = path.join(dir, "local"), bin = path.join(dir, "local-bin");
  fs.mkdirSync(local); fs.mkdirSync(bin);
  executable(path.join(bin, "ssh"), String.raw`#!${process.execPath}
const fs = require("fs"), path = require("path");
const [host, original] = process.argv.slice(2);
const h = ${JSON.stringify(hosts)}[host];
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({kind:"ssh",host,command:original}) + "\n");
if (!h || h.unreachable) process.exit(255);
// Keep the host's fallback search from discovering this test runner's Node.
const command = original.replace(/\/(?:opt\/homebrew|usr\/local)\/(?:opt\/node\/)?bin\/node/g, ${JSON.stringify(path.join(dir, "absent-node"))});
const env = {...process.env, HOME:h.home, PATH:h.bin, XDG_CONFIG_HOME:path.join(h.home,".config"), SPACESHEEP_CONFIG_DIR:path.dirname(h.config), SPACESHEEP_KEY:h.envKey || "", NODE_OPTIONS:"--require=" + h.preload};
const p = require("child_process").spawn("/bin/sh", ["-c", command], {env, stdio:"inherit"});
p.on("close", (code) => process.exit(code));
`);
  const env = { ...process.env, HOME: local, PATH: bin + path.delimiter + process.env.PATH,
    XDG_CONFIG_HOME: path.join(local, ".config"), SPACESHEEP_CONFIG_DIR: path.join(local, "config"),
    SPACESHEEP_KEY: "ss_parent_test_key", SPACESHEEP_ORIGIN: origin, SPACESHEEP_APP_ORIGIN: origin,
    SPACESHEEP_NO_UPDATE_CHECK: "1", SPACESHEEP_QUIET: "", CI: "1", CLAUDE_CONFIG_DIR: "", NODE_OPTIONS: "",
  };
  return { hosts, env, events: () => fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse) : [],
    run: (args = []) => run(["--ssh", Object.keys(hosts).join(","), "--no-skill", ...args], env) };
}

const mints = (f) => f.events().filter((e) => e.kind === "mint");
const installs = (f) => f.events().filter((e) => e.kind === "install");

test("SSH valid saved and environment keys: no mint, rename, install or config change", async (t) => {
  const f = await fixture(t, { alias: { key: KEY, machine: "nest-02" }, environment: { envKey: KEY, machine: "nest-03" } });
  const before = Object.values(f.hosts).map((h) => snapshot(h.home));
  const r = await f.run();
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(mints(f), []); assert.deepEqual(installs(f), []);
  assert.deepEqual(Object.values(f.hosts).map((h) => snapshot(h.home)), before);
  assert.match(r.stderr, /alias: existing machine 'nest-02', key valid — leaving it alone/);
  assert.match(r.stderr, /alias \| .*node \| nest-02 \| key reused/);
  assert.doesNotMatch(r.stderr + r.stdout + JSON.stringify(f.events()), /ss_existing_test_key|ss_parent_test_key/);
  assert.ok(f.events().some((e) => e.kind === "mcp" && e.method === "tools/list"));
});

for (const [label, options, machine] of [
  ["host's hostname", [], "physical-box"],
  ["--machine", ["--machine", "First box"], "First box"],
  ["explicit --name", ["--name", "Ann's box $(false); `false`"], "Ann's box $(false); `false`"],
]) test(`SSH missing key: mint using ${label}, never the alias`, async (t) => {
  const f = await fixture(t, { alias: {} });
  const r = await f.run(options);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(mints(f).map((e) => e.body), [{ name: machine }]);
  assert.equal(JSON.parse(fs.readFileSync(f.hosts.alias.config)).machine, machine);
  assert.equal(JSON.parse(fs.readFileSync(f.hosts.alias.config)).key, CHILD);
  assert.equal(installs(f).length, 1);
  assert.match(r.stderr, /no existing key — minted a key/);
  assert.match(r.stderr, /alias \| .*node \| .* \| key minted: no existing key/);
  assert.doesNotMatch(r.stderr + r.stdout + JSON.stringify(f.events()), /ss_minted_test_key|ss_parent_test_key/);
});

test("SSH revoked key: authenticate before minting and retain the configured name and fields", async (t) => {
  const f = await fixture(t, { alias: { key: "ss_revoked", machine: "nest-02" } });
  const r = await f.run();
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(mints(f).map((e) => e.body), [{ name: "nest-02" }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.hosts.alias.config)), { key: CHILD, machine: "nest-02", other: "keep me", origin: f.env.SPACESHEEP_ORIGIN, appOrigin: f.env.SPACESHEEP_APP_ORIGIN });
  assert.ok(f.events().findIndex((e) => e.kind === "mcp") < f.events().findIndex((e) => e.kind === "mint"));
  assert.match(r.stderr, /existing key failed to authenticate/);
});

for (const [label, host, reason] of [
  ["unreachable", { unreachable: true }, /SSH probe failed/],
  ["missing Node", { noNode: true }, /no usable Node.js/],
  ["old Node", { oldNode: true }, /no usable Node.js/],
  ["missing npx", { noNpx: true }, /npx is missing/],
  ["malformed config", { rawConfig: "{broken" }, /cannot read spacesheep config/],
  ["invalid config shape", { rawConfig: "null" }, /invalid spacesheep config/],
]) test(`SSH ${label}: zero mint/registration/config writes and later hosts still processed`, async (t) => {
  const f = await fixture(t, { bad: host, good: {} });
  const before = snapshot(f.hosts.bad.home);
  const r = await f.run();
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, reason);
  assert.deepEqual(snapshot(f.hosts.bad.home), before);
  assert.deepEqual(mints(f).map((e) => e.body), [{ name: "physical-box" }]);
  assert.deepEqual(installs(f).map((e) => e.host), ["good"]);
  assert.equal(f.events().filter((e) => e.kind === "unexpected").length, 0);
  assert.match(r.stderr, /bad \| .* \| .* \| skipped:/);
  assert.match(r.stderr, /good \| .*node \| physical-box \| key minted/);
  assert.match(r.stderr, /1 of 2 machine\(s\) connected — failed: bad/);
});

for (const [flag, value] of [["--machine", "Other name"], ["--name", "Other name"]]) {
  for (const key of [KEY, "ss_revoked", undefined]) test(`SSH ${flag} cannot conflict with a configured name (${key || "no key"})`, async (t) => {
    const f = await fixture(t, { alias: { key, machine: "nest-02" } });
    const before = snapshot(f.hosts.alias.home);
    const r = await f.run([flag, value]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /refusing to rename configured machine 'nest-02'/);
    assert.deepEqual(mints(f), []); assert.deepEqual(installs(f), []);
    assert.deepEqual(snapshot(f.hosts.alias.home), before);
  });
}

test("SSH accepts the existing explicit --name when it agrees with configured identity", async (t) => {
  const f = await fixture(t, { alias: { key: KEY, machine: "nest-02" } });
  const r = await f.run(["--name", "nest-02"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(mints(f), []);
  assert.match(r.stderr, /key reused/);
});

for (const key of ["ss_outage", "ss_proxy", "ss_scoped"]) test(`SSH uncertain/limited auth ${key}: no destructive replacement`, async (t) => {
  const f = await fixture(t, { alias: { key, machine: "nest-02" } });
  const before = snapshot(f.hosts.alias.home);
  const r = await f.run();
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /could not verify existing key/);
  assert.deepEqual(mints(f), []); assert.deepEqual(installs(f), []);
  assert.deepEqual(snapshot(f.hosts.alias.home), before);
});

test("SSH rejected environment override is reported without minting an unusable replacement", async (t) => {
  const f = await fixture(t, { alias: { envKey: "ss_revoked", key: KEY, machine: "nest-02" } });
  const r = await f.run();
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /SPACESHEEP_KEY was rejected/);
  assert.deepEqual(mints(f), []);
  assert.equal(JSON.parse(fs.readFileSync(f.hosts.alias.config)).key, KEY);
});

test("SSH Node fallback works with an old PATH node and nvm's usable Node", async (t) => {
  const f = await fixture(t, { alias: { oldNode: true, nvm: true } });
  const r = await f.run();
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stderr.includes(f.hosts.alias.resolvedNode));
  assert.equal(installs(f)[0].node, f.hosts.alias.resolvedNode);
});

test("SSH uses the same stable Homebrew Node path as local installs", async (t) => {
  const f = await fixture(t, { alias: { homebrew: true } });
  const r = await f.run();
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stderr.includes(f.hosts.alias.resolvedNode));
  assert.deepEqual(mints(f).map((e) => e.body), [{ name: "physical-box" }]);
});

test("SSH POSIX login shell fallback preserves the configured name on replacement", async (t) => {
  const f = await fixture(t, { alias: { noBash: true, key: "ss_revoked", machine: "Ann's box" } });
  const r = await f.run();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(f.hosts.alias.config)).machine, "Ann's box");
});

test("SSH failed install remains key minted in the summary and doesn't abort the next host", async (t) => {
  const f = await fixture(t, { bad: { failInstall: true }, good: { key: KEY, machine: "nest-02" } });
  const r = await f.run();
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /bad \| .* \| physical-box \| key minted: install didn't finish/);
  assert.match(r.stderr, /revoke it in Settings/);
  assert.match(r.stderr, /good \| .* \| nest-02 \| key reused/);
});

test("SSH dry-run keeps its existing no-mint behavior", async (t) => {
  const f = await fixture(t, { alias: {} });
  const before = snapshot(f.hosts.alias.home);
  const r = await f.run(["--dry-run"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(mints(f), []); assert.deepEqual(installs(f), []);
  assert.deepEqual(snapshot(f.hosts.alias.home), before);
  assert.match(r.stderr, /skipped: no existing key; would mint \(--dry-run\)/);
});

for (const machine of ["x".repeat(61), " nest-02 "]) test("SSH refuses to mint if the key service would change the configured name", async (t) => {
  const f = await fixture(t, { alias: { key: "ss_revoked", machine } });
  const before = snapshot(f.hosts.alias.home);
  const r = await f.run();
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /refusing to change it/);
  assert.deepEqual(mints(f), []);
  assert.deepEqual(snapshot(f.hosts.alias.home), before);
});

test("SSH conflicting explicit flags and an empty name are refused before minting", async (t) => {
  const f = await fixture(t, { alias: {} });
  const conflict = await f.run(["--machine", "One", "--name", "Two"]);
  assert.equal(conflict.code, 1, conflict.stderr);
  assert.match(conflict.stderr, /--name and --machine disagree/);
  const empty = await f.run(["--machine", ""]);
  assert.equal(empty.code, 1, empty.stderr);
  assert.match(empty.stderr, /machine name must be 1–60 characters/);
  assert.deepEqual(mints(f), []);
});

test("SSH without a local minting key still probes and reports the missing credential", async (t) => {
  const f = await fixture(t, { alias: {} });
  delete f.env.SPACESHEEP_KEY;
  const r = await f.run();
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /no existing key; this machine needs a key to mint one/);
  assert.deepEqual(mints(f), []);
  assert.deepEqual(installs(f), []);
});
