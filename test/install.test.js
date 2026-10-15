"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { PassThrough } = require("stream");

const H = require("../lib/harnesses");
const S = require("../lib/skills");
const { runBridge } = require("../lib/bridge");

const ARGV = ["/usr/local/bin/node", "/home/me/.config/spacesheep/cli/bin/spacesheep.js", "mcp"];
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "ss-home-"));
const byId = (home, id, env = {}) => H.harnesses({ home, platform: "linux", env }).find((h) => h.id === id);

test("finds only the harnesses whose folders exist", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".codex"));
  fs.mkdirSync(path.join(home, ".cursor"));
  fs.mkdirSync(path.join(home, ".gemini", "config"), { recursive: true });
  const present = H.harnesses({ home, platform: "linux", env: {} }).filter((h) => h.present).map((h) => h.id);
  assert.deepStrictEqual(present.sort(), ["antigravity", "codex", "cursor"]);
});

test("Claude Code: replaces the remote entry, keeps everything else in ~/.claude.json", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".claude"));
  const state = { numStartups: 9, projects: { "/x": { allowedTools: [] } }, mcpServers: { spacesheep: { type: "http", url: "https://mcp.spacesheep.dev/mcp" }, yc: { type: "http", url: "https://api.ycombinator.com/v1/mcp" } } };
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify(state, null, 2));
  const h = byId(home, "claude-code");
  const r = H.install(h, ARGV);
  assert.strictEqual(r.action, "replaced");
  const after = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
  assert.strictEqual(after.numStartups, 9);
  assert.deepStrictEqual(after.projects, state.projects);
  assert.deepStrictEqual(after.mcpServers.yc, state.mcpServers.yc);
  // By URL — the plugin's own URL, so Claude Code drops the plugin's copy — signed in
  // by this machine's key through the helper.
  assert.deepStrictEqual(after.mcpServers.spacesheep, { type: "http", url: "https://mcp.spacesheep.dev/mcp", headersHelper: `${ARGV[0]} ${ARGV[1]} mcp headers` });
  assert.strictEqual(H.install(h, ARGV).action, "unchanged");
  const st = H.status(h);
  assert.strictEqual(st.entries.length, 1);
  assert.strictEqual(st.entries[0].via, "bridge");
});

test("a remote spacesheep under another name is replaced too, never doubled", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".cursor"));
  fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "my sheep": { url: "https://mcp.spacesheep.dev/mcp" }, mastra: { command: "npx", args: ["-y", "@mastra/mcp"] } } }));
  const r = H.install(byId(home, "cursor"), ARGV);
  assert.deepStrictEqual(r.replaced, ["my sheep"]);
  const s = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers;
  assert.deepStrictEqual(Object.keys(s).sort(), ["mastra", "spacesheep"]);
});

test("a JSON file with comments is left alone and said so", () => {
  const home = tmpHome();
  const dir = path.join(home, ".config", "Code", "User");
  fs.mkdirSync(dir, { recursive: true });
  const text = '{\n  // mine\n  "servers": {}\n}\n';
  fs.writeFileSync(path.join(dir, "mcp.json"), text);
  const r = H.install(byId(home, "vscode"), ARGV);
  assert.strictEqual(r.action, "skipped");
  assert.match(r.error, /isn't plain JSON/);
  assert.strictEqual(fs.readFileSync(path.join(dir, "mcp.json"), "utf8"), text);
});

test("VS Code gets servers with a type; opencode gets its local shape", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".config", "Code", "User"), { recursive: true });
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  H.install(byId(home, "vscode"), ARGV);
  H.install(byId(home, "opencode"), ARGV);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, ".config", "Code", "User", "mcp.json"), "utf8")).servers.spacesheep, { type: "stdio", command: ARGV[0], args: ARGV.slice(1) });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, ".config", "opencode", "opencode.json"), "utf8")).mcp.spacesheep, { type: "local", command: ARGV, enabled: true });
});

test("Codex: the old [mcp_servers.spacesheep] goes, the rest of config.toml stays", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".codex"));
  const before = [
    'model = "gpt-5.5"',
    'notify = ["node", "/x/spacesheep.js", "memory", "sync"]',
    "",
    '[projects."/Users/me/repo"]',
    'trust_level = "trusted"',
    "",
    "[mcp_servers.ycombinator]",
    'url = "https://api.ycombinator.com/v1/mcp"',
    "",
    "[mcp_servers.spacesheep]",
    'url = "https://mcp.spacesheep.dev/mcp"',
    "",
    "[mcp_servers.spacesheep.env]",
    'X = "1"',
    "",
    "[desktop]",
    'conversationDetailMode = "STEPS_COMMANDS"',
    "",
  ].join("\n");
  const file = path.join(home, ".codex", "config.toml");
  fs.writeFileSync(file, before);
  const h = byId(home, "codex");
  const r = H.install(h, ARGV);
  assert.strictEqual(r.action, "replaced");
  const after = fs.readFileSync(file, "utf8");
  assert.ok(after.includes('notify = ["node", "/x/spacesheep.js", "memory", "sync"]'));
  assert.ok(after.includes('[projects."/Users/me/repo"]'));
  assert.ok(after.includes("[mcp_servers.ycombinator]"));
  assert.ok(after.includes("[desktop]\nconversationDetailMode"));
  assert.ok(!after.includes("mcp.spacesheep.dev"));
  assert.ok(!after.includes("[mcp_servers.spacesheep.env]"));
  assert.strictEqual((after.match(/\[mcp_servers\.spacesheep\]/g) || []).length, 1);
  assert.ok(after.includes(`command = ${JSON.stringify(ARGV[0])}`));
  assert.ok(after.includes(`args = [${JSON.stringify(ARGV[1])}, "mcp"]`));
  assert.strictEqual(H.install(h, ARGV).action, "unchanged");
  assert.strictEqual(H.status(h).entries[0].via, "bridge");
  // Uninstall takes only the bridge out.
  assert.strictEqual(H.uninstall(h).action, "removed");
  const gone = fs.readFileSync(file, "utf8");
  assert.ok(!gone.includes("[mcp_servers.spacesheep]"));
  assert.ok(gone.includes("[mcp_servers.ycombinator]") && gone.includes("[desktop]"));
});

test("Codex: a header-looking line inside a multi-line string is not a table", () => {
  const text = 'instructions = """\n[mcp_servers.spacesheep]\nnot a table\n"""\n\n[mcp_servers.spacesheep]\nurl = "https://mcp.spacesheep.dev/mcp"\n';
  const plan = H.planToml({ shown: "x" }, text, ARGV);
  assert.ok(plan.text.startsWith('instructions = """\n[mcp_servers.spacesheep]\nnot a table\n"""'));
  // The string's line, and the new table: the old table (and its URL) is gone.
  assert.strictEqual((plan.text.match(/^\[mcp_servers\.spacesheep\]/gm) || []).length, 2);
  assert.ok(!plan.text.includes("mcp.spacesheep.dev"));
  assert.deepStrictEqual(plan.replaced, ["spacesheep"]);
});

test("the bridge is recognised wherever it is installed from", () => {
  assert.ok(H.isBridge({ command: "/opt/node", args: ["/a/b/spacesheep.js", "mcp"] }));
  assert.ok(H.isBridge({ command: "npx", args: ["-y", "spacesheep@latest", "mcp"] }));
  assert.ok(H.isBridge({ type: "local", command: ["node", "C:\\x\\spacesheep\\bin\\spacesheep.js", "mcp"] }));
  assert.ok(!H.isBridge({ command: "npx", args: ["-y", "spacesheep@latest", "deploy"] }));
  assert.ok(!H.isBridge({ command: "npx", args: ["-y", "@mastra/mcp"] }));
});

test("skill: added where a harness reads skills, the command copy updated in place, plugins left alone", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".claude", "commands"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "commands", "sheep.md"), "<!-- spacesheep-skill-version: 1.0.0 -->\nold");
  fs.mkdirSync(path.join(home, ".codex", "skills"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude-work", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude-work", ".claude.json"), "{}");
  fs.writeFileSync(path.join(home, ".claude-work", "settings.json"), '{"enabledPlugins":{"spacesheep@spacesheep":true}}');
  fs.writeFileSync(path.join(home, ".claude-work", "plugins", "installed_plugins.json"), '{"plugins":{"spacesheep@spacesheep":[{"scope":"user","version":"1.0.0"}]}}');
  fs.mkdirSync(path.join(home, ".cursor", "skills", "sheep"), { recursive: true });
  fs.writeFileSync(path.join(home, ".cursor", "skills", "sheep", "SKILL.md"), "someone else's sheep");
  const skill = "<!-- spacesheep-skill-version: 2.0.0 -->\n# Deploy";
  const res = S.installSkills(skill, S.skillTargets({ home, env: {} }));
  const by = Object.fromEntries(res.map((r) => [r.harness, r]));
  assert.strictEqual(by["Claude Code"].action, "updated");
  assert.strictEqual(fs.readFileSync(path.join(home, ".claude", "commands", "sheep.md"), "utf8"), skill);
  assert.strictEqual(by.Codex.action, "added");
  assert.ok(fs.readFileSync(path.join(home, ".codex", "skills", "sheep", "SKILL.md"), "utf8").startsWith("---\nname: sheep\n"));
  assert.match(by["Claude Code (~/.claude-work)"].note, /plugin/);
  assert.strictEqual(by.Cursor.action, "skipped");
  assert.strictEqual(fs.readFileSync(path.join(home, ".cursor", "skills", "sheep", "SKILL.md"), "utf8"), "someone else's sheep");
  // Uninstall removes the folder copy it wrote, never the command or someone else's.
  S.uninstallSkills(S.skillTargets({ home, env: {} }));
  assert.ok(!fs.existsSync(path.join(home, ".codex", "skills", "sheep")));
  assert.ok(fs.existsSync(path.join(home, ".claude", "commands", "sheep.md")));
  assert.ok(fs.existsSync(path.join(home, ".cursor", "skills", "sheep", "SKILL.md")));
});

// --- the bridge, against a stand-in server ----------------------------------------------

function standIn(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => { const msg = JSON.parse(body); seen.push({ headers: req.headers, msg }); handler(req, res, msg, seen); });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function drive(origin, lines, key = "ss_test") {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  let out = "";
  let err = "";
  output.on("data", (d) => (out += d));
  errors.on("data", (d) => (err += d));
  const done = runBridge({ input, output, errors, key: () => key, origin: () => origin });
  for (const l of lines) input.write(JSON.stringify(l) + "\n");
  input.end();
  await done;
  return { messages: out.trim() ? out.trim().split("\n").map((l) => JSON.parse(l)) : [], err };
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "1" } } };

test("bridge: relays JSON and SSE answers, carries the session, the version and the key", async () => {
  const { server, seen, origin } = await standIn((req, res, msg) => {
    if (msg.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }));
    }
    if (!msg.id) { res.writeHead(202); return res.end(); }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`);
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "deploy" }] } })}\n\n`);
  });
  try {
    const { messages } = await drive(origin, [INIT, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    assert.deepStrictEqual(messages.map((m) => m.id ?? m.method), [1, "notifications/progress", 2]);
    assert.strictEqual(messages[2].result.tools[0].name, "deploy");
    const later = seen.find((s) => s.msg.id === 2).headers;
    assert.strictEqual(later.authorization, "Bearer ss_test");
    assert.strictEqual(later["mcp-session-id"], "sess-1");
    assert.strictEqual(later["mcp-protocol-version"], "2025-06-18");
    assert.match(later["user-agent"], /^spacesheep-mcp\/[\d.]+ \(codex\)$/);
  } finally { server.close(); }
});

test("bridge: a forgotten session is started again and the call retried", async () => {
  let sessions = 0;
  const { server, origin } = await standIn((req, res, msg) => {
    if (msg.method === "initialize") {
      sessions++;
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": `s${sessions}` });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18" } }));
    }
    if (!msg.id) { res.writeHead(202); return res.end(); }
    if (req.headers["mcp-session-id"] === "s1") { res.writeHead(404); return res.end("session not found"); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: req.headers["mcp-session-id"] } }));
  });
  try {
    const { messages, err } = await drive(origin, [INIT, { jsonrpc: "2.0", id: 7, method: "tools/list" }]);
    assert.strictEqual(sessions, 2);
    assert.deepStrictEqual(messages.find((m) => m.id === 7).result, { ok: "s2" });
    assert.match(err, /new one/);
  } finally { server.close(); }
});

test("bridge: no key and a refused key answer the request with what to run", async () => {
  const { server, origin } = await standIn((req, res) => {
    res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="x"', "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_token", error_description: "Unknown or revoked API key" }));
  });
  try {
    const none = await drive(origin, [INIT], null);
    assert.match(none.messages[0].error.message, /isn't signed in.*npx -y spacesheep@latest install/);
    const bad = await drive(origin, [INIT], "ss_revoked");
    assert.match(bad.messages[0].error.message, /refused this machine's key \(Unknown or revoked API key\)/);
  } finally { server.close(); }
});

test("--skip takes one Claude home out by its folder name; --only still picks", () => {
  const { chosen } = require("../lib/install");
  const home = tmpHome();
  for (const d of [".claude", ".claude-work", ".claude-nekko"]) fs.mkdirSync(path.join(home, d));
  fs.writeFileSync(path.join(home, ".claude.json"), "{}");
  fs.writeFileSync(path.join(home, ".claude-work", ".claude.json"), "{}");
  fs.writeFileSync(path.join(home, ".claude-nekko", ".claude.json"), "{}");
  fs.mkdirSync(path.join(home, ".codex"));
  const all = H.harnesses({ home, platform: "linux", env: {} });
  const ids = (list) => list.map((h) => h.id).sort();
  assert.deepStrictEqual(ids(chosen(all, {})), ["claude-code", "claude-code:.claude-nekko", "claude-code:.claude-work", "codex"]);
  assert.deepStrictEqual(ids(chosen(all, { skip: ["nekko"] })), ["claude-code", "claude-code:.claude-work", "codex"]);
  assert.deepStrictEqual(ids(chosen(all, { skip: [".claude-nekko,codex"] })), ["claude-code", "claude-code:.claude-work"]);
  assert.deepStrictEqual(ids(chosen(all, { only: "claude-code", skip: ["work"] })), ["claude-code", "claude-code:.claude-nekko"]);
  assert.throws(() => chosen(all, { skip: ["nope"] }), /--skip: no harness called nope/);
});

test("a second Claude home where Claude Code never ran isn't written", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".claude"));
  fs.mkdirSync(path.join(home, ".claude-placeholder"));
  fs.writeFileSync(path.join(home, ".claude-placeholder", "settings.json"), "{}");
  const h = H.harnesses({ home, platform: "linux", env: {} }).find((x) => x.id === "claude-code:.claude-placeholder");
  assert.strictEqual(h.present, false);
});

test("--ssh: a machine already signed in is installed with its own key; nothing is minted or sent", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ss-ssh-"));
  const log = path.join(bin, "calls.txt");
  fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\ncat >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-cfg-"));
  const env = { PATH: process.env.PATH, SPACESHEEP_CONFIG_DIR: process.env.SPACESHEEP_CONFIG_DIR, SPACESHEEP_KEY: process.env.SPACESHEEP_KEY };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.SPACESHEEP_CONFIG_DIR = cfgDir;
  delete process.env.SPACESHEEP_KEY;
  try {
    const lines = [];
    await require("../lib/install").run({ ssh: ["box-1,box-2"], skip: ["nekko"] }, (l) => lines.push(l), () => {});
    const calls = fs.readFileSync(log, "utf8");
    assert.deepStrictEqual(calls.split("\n").filter((l) => /^box-/.test(l)).map((l) => l.split(" ")[0]), ["box-1", "box-2"]);
    assert.ok(calls.split("\n").filter((l) => /^box-/.test(l)).every((l) => l.includes("install --no-login")));
    assert.match(calls, /--skip nekko/);
    assert.ok(!/ss_/.test(calls), "no key went over ssh");
    assert.match(lines.join("\n"), /2 of 2 machine\(s\) connected/);
  } finally {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("Claude Code's helper path is quoted when it has spaces, and still recognised", () => {
  const argv = ["/Applications/My Node/node", "/Users/a b/.config/spacesheep/cli/bin/spacesheep.js", "mcp"];
  const e = H.entryFor({ kind: "claude" }, argv);
  assert.strictEqual(e.headersHelper, '"/Applications/My Node/node" "/Users/a b/.config/spacesheep/cli/bin/spacesheep.js" mcp headers');
  assert.ok(H.isBridge(e));
  assert.ok(H.isBridge({ type: "http", url: "https://mcp.spacesheep.dev/mcp", headersHelper: "node /x/spacesheep.js mcp headers" }));
  assert.ok(!H.isBridge({ type: "http", url: "https://mcp.spacesheep.dev/mcp" }));
});

test("plugin: a disabled plugin no longer counts, so the skill comes from install", () => {
  const home = tmpHome();
  const dir = path.join(home, ".claude");
  fs.mkdirSync(path.join(dir, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude.json"), "{}");
  fs.writeFileSync(path.join(dir, "plugins", "installed_plugins.json"), '{"version":2,"plugins":{"spacesheep@spacesheep":[{"scope":"user"}]}}');
  assert.strictEqual(S.pluginEnabled(dir), true);
  assert.match(S.skillTargets({ home, env: {} })[0].skip, /plugin/);
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ enabledPlugins: { "spacesheep@spacesheep": false } }));
  assert.strictEqual(S.pluginEnabled(dir), false);
  assert.ok(S.skillTargets({ home, env: {} })[0].file.endsWith(path.join("skills", "sheep", "SKILL.md")));
});

test("mcp headers prints only the header JSON", () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-cfg-"));
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ key: "ss_abc" }));
  const run = (env) => require("child_process").execFileSync(process.execPath, [path.join(__dirname, "..", "bin", "spacesheep.js"), "mcp", "headers"], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  assert.deepStrictEqual(JSON.parse(run({ SPACESHEEP_CONFIG_DIR: cfgDir })), { Authorization: "Bearer ss_abc" });
  assert.deepStrictEqual(JSON.parse(run({ SPACESHEEP_CONFIG_DIR: path.join(cfgDir, "none") })), {});
});
