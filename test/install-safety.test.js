"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const H = require("../lib/harnesses");
const S = require("../lib/skills");
const I = require("../lib/install");
const cfg = require("../lib/config");
const { McpClient } = require("../lib/mcp");
const { fleet, write, SKILL, TALK } = require("../fixtures/install-fleet.cjs");
const ARGV = [process.execPath, "/fixture/spacesheep.js", "mcp"];
function homeFor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ss-install-safety-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const byId = (home, id) => H.harnesses({ home, env: {}, platform: "linux" }).find((h) => h.id === id);
function offline(t, home) {
  t.mock.method(os, "homedir", () => home);
  t.mock.method(cfg, "resolveKey", () => ({ key: "ss_fixture", source: "env" }));
  t.mock.method(cfg, "readConfig", () => ({ username: "fixture", machine: "fleet" }));
  t.mock.method(cfg, "configDir", () => path.join(home, ".config", "spacesheep"));
  t.mock.method(McpClient.prototype, "listTools", async () => Array(107).fill({}));
  t.mock.method(S, "fetchSkill", async () => SKILL);
}

for (const wrapped of [false, true]) test(`enabled plugin's own MCP file prevents a duplicate bridge (wrapped=${wrapped})`, (t) => {
  const home = homeFor(t);
  const { cache, homes } = fleet(home, true, wrapped);
  const file = path.join(cache, ".mcp.json");
  const before = fs.readFileSync(file, "utf8");
  for (const dir of homes.slice(0, 5)) {
    const h = byId(home, `claude-code:${dir}`);
    const state = fs.readFileSync(h.file, "utf8");
    const r = H.install(h, ARGV);
    assert.equal(r.action, "skipped");
    assert.ok(r.note.includes(file));
    assert.match(r.note, /plugin:spacesheep:spacesheep/);
    assert.equal(fs.readFileSync(h.file, "utf8"), state);
  }
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("disabled plugin via symlinked settings restores both /sheep and talk", (t) => {
  const home = homeFor(t);
  const { homes } = fleet(home, false);
  for (const name of homes.slice(0, 5)) assert.equal(S.hasPlugin(path.join(home, name)), false);
  const results = S.installSkills(SKILL, S.skillTargets({ home, env: {} }));
  assert.equal(results.some((r) => r.error), false);
  for (const name of homes.slice(0, 5)) {
    assert.match(fs.readFileSync(path.join(home, name, "skills", "sheep", "SKILL.md"), "utf8"), /Sheep fixture/);
    assert.ok(fs.readFileSync(path.join(home, name, "commands", "talk.md"), "utf8").includes(TALK));
    assert.equal(H.install(byId(home, `claude-code:${name}`), ARGV).action, "added");
  }
});

for (const id of ["claude-code", "codex", "cursor", "vscode"]) test(`${id}: install/uninstall preserve a symlinked config and its mode`, (t) => {
  const home = homeFor(t);
  const h = byId(home, id);
  const target = path.join(home, "dotfiles", path.basename(h.file));
  write(target, id === "codex" ? 'model = "fixture"\n' : { projects: { trusted: true } });
  fs.chmodSync(target, 0o600);
  fs.mkdirSync(path.dirname(h.file), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(h.file), target), h.file);
  const link = fs.readlinkSync(h.file);
  assert.equal(H.install(h, ARGV).action, "added");
  assert.equal(fs.lstatSync(h.file).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(h.file), link);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(target, "utf8"), /spacesheep/);
  assert.equal(H.uninstall(h).action, "removed");
  assert.equal(fs.lstatSync(h.file).isSymbolicLink(), true);
  assert.doesNotMatch(fs.readFileSync(target, "utf8"), /spacesheep/);
});

test("Claude lock held: install, dry-run and uninstall refuse without touching state or lock", (t) => {
  const home = homeFor(t);
  const h = byId(home, "claude-code");
  write(h.file, { projects: { live: true }, mcpServers: { spacesheep: H.entryFor(h, ARGV) } });
  const before = fs.readFileSync(h.file, "utf8");
  fs.mkdirSync(`${h.file}.lock`);
  for (const run of [() => H.install(h, [...ARGV, "--new"]), () => H.install(h, ARGV, { dryRun: true }), () => H.uninstall(h)]) {
    const r = run();
    assert.equal(r.action, "skipped");
    assert.ok(r.error.includes(`${h.file}.lock`));
    assert.match(r.error, /retry|run.*again/);
    assert.equal(fs.readFileSync(h.file, "utf8"), before);
    assert.equal(fs.statSync(`${h.file}.lock`).isDirectory(), true);
  }
});

test("Claude locks cover the read and atomic rename, preserving the latest session save", (t) => {
  const home = homeFor(t);
  const h = byId(home, "claude-code");
  write(h.file, {});
  const mkdir = fs.mkdirSync;
  t.mock.method(fs, "mkdirSync", (file, ...args) => {
    const value = mkdir(file, ...args);
    if (file === `${h.file}.lock`) write(h.file, { projects: { latest: true } });
    return value;
  });
  const read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === h.file) { reads++; assert.ok(fs.existsSync(`${h.file}.lock`), "state read must hold Claude's lock"); }
    return read(file, ...args);
  });
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === h.file) assert.ok(fs.existsSync(`${h.file}.lock`));
    return rename(from, to);
  });
  const result = H.install(h, ARGV);
  assert.equal(result.action, "added", result.error);
  assert.ok(reads > 0);
  assert.equal(fs.existsSync(`${h.file}.lock`), false);
  assert.deepEqual(JSON.parse(read(h.file, "utf8")).projects, { latest: true });
});

test("--except excludes one Claude home while --only selects the family", async (t) => {
  const home = homeFor(t);
  const { homes } = fleet(home, false);
  const all = H.harnesses({ home, env: {} });
  const excluded = "claude-code:.claude-placeholder";
  assert.equal(I.chosen(all, { only: "claude-code", except: excluded }).some((h) => h.id === excluded), false);
  assert.throws(() => I.chosen(all, { except: "typo" }), /--except/);
  offline(t, home);
  await I.run({ only: "claude-code", except: excluded }, () => {}, () => {});
  const dir = path.join(home, homes.at(-1));
  assert.equal(fs.existsSync(path.join(dir, ".claude.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "skills")), false);
  assert.equal(fs.existsSync(path.join(dir, "commands")), false);
});

test("dry-run uses future tense for the npx copy and every planned write", async (t) => {
  const home = homeFor(t);
  write(path.join(home, ".claude", "settings.json"), {});
  offline(t, home);
  const script = process.argv[1];
  process.argv[1] = path.join(home, ".npm", "_npx", "fixture", "spacesheep", "bin", "spacesheep.js");
  t.after(() => { process.argv[1] = script; });
  const lines = [];
  await I.run({ dryRun: true, only: "claude-code" }, (l) => lines.push(l), () => {});
  const output = lines.join("\n");
  assert.match(output, /CLI would be copied/);
  assert.match(output, /would add/);
  assert.doesNotMatch(output, /was copied|Every harness below runs|  added\b|  updated\b|  replaced\b/);
  assert.equal(fs.existsSync(path.join(home, ".config", "spacesheep", "cli")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude.json")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "skills")), false);
});

for (const targetLock of [false, true]) test(`symlinked Claude config refuses the ${targetLock ? "real target" : "configured path"} lock`, (t) => {
  const home = homeFor(t);
  const h = byId(home, "claude-code");
  const real = path.join(home, "dotfiles", "claude.json");
  write(real, { projects: { live: true } });
  fs.symlinkSync(real, h.file);
  const lock = `${targetLock ? real : h.file}.lock`;
  fs.mkdirSync(lock);
  const r = H.install(h, ARGV);
  assert.equal(r.action, "skipped");
  assert.ok(r.error.includes(lock));
  assert.equal(fs.lstatSync(h.file).isSymbolicLink(), true);
  assert.equal(fs.existsSync(`${targetLock ? h.file : real}.lock`), false, "release only our own locks");
  assert.deepEqual(JSON.parse(fs.readFileSync(real, "utf8")), { projects: { live: true } });
});

test("a symlinked Claude directory does not contend with its own real-path lock", (t) => {
  const home = homeFor(t);
  const dir = path.join(home, "account");
  fs.mkdirSync(dir);
  fs.symlinkSync(dir, path.join(home, ".claude-work"));
  const h = H.harnesses({ home, env: { CLAUDE_CONFIG_DIR: path.join(home, ".claude-work") } }).find((h) => h.id === "claude-code:.claude-work");
  assert.equal(H.install(h, ARGV).action, "added");
  assert.equal(fs.lstatSync(path.join(home, ".claude-work")).isSymbolicLink(), true);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, ".claude.json"), "utf8")).mcpServers.spacesheep);
  assert.equal(fs.existsSync(path.join(dir, ".claude.json.lock")), false);
});

test("a dangling config symlink is preserved when its target is created", (t) => {
  const home = homeFor(t);
  const h = byId(home, "codex");
  fs.mkdirSync(path.dirname(h.file), { recursive: true });
  const target = path.join(home, "dotfiles", "config.toml");
  fs.symlinkSync(target, h.file);
  assert.equal(H.install(h, ARGV).action, "added");
  assert.equal(fs.lstatSync(h.file).isSymbolicLink(), true);
  assert.match(fs.readFileSync(target, "utf8"), /mcp_servers.spacesheep/);
});

test("Claude releases its lock on malformed JSON and atomic-write failure", (t) => {
  const home = homeFor(t);
  const h = byId(home, "claude-code");
  write(h.file, "{bad");
  assert.equal(H.install(h, ARGV).action, "skipped");
  assert.equal(fs.existsSync(`${h.file}.lock`), false);
  write(h.file, {});
  t.mock.method(fs, "renameSync", () => { throw new Error("fixture rename failure"); });
  const r = H.install(h, ARGV);
  assert.match(r.error, /fixture rename failure/);
  assert.equal(fs.existsSync(`${h.file}.lock`), false);
  assert.equal(fs.readdirSync(home).some((f) => f.endsWith(".tmp")), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file, "utf8")), {});
});

test("plugin detection resolves a legacy versioned cache through a symlink", (t) => {
  const home = homeFor(t);
  const { shared, cache } = fleet(home);
  write(path.join(shared, "plugins", "installed_plugins.json"), { version: 1, plugins: { "spacesheep@spacesheep": { version: "1.110.0" } } });
  const r = H.install(byId(home, "claude-code:.claude-key1"), ARGV);
  assert.equal(r.action, "skipped");
  assert.ok(r.note.includes(path.join(cache, ".mcp.json")));
  assert.equal(H.status(byId(home, "claude-code:.claude-key1")).entries[0].via, "plugin");
});

test("plugin at another endpoint or installed only for a project does not suppress the bridge", (t) => {
  const home = homeFor(t);
  const { shared, cache } = fleet(home);
  write(path.join(cache, ".mcp.json"), { spacesheep: { url: "https://example.com/mcp" } });
  assert.equal(H.install(byId(home, "claude-code:.claude-key1"), ARGV).action, "added");
  write(path.join(cache, ".mcp.json"), { spacesheep: { url: "https://mcp.spacesheep.dev/mcp" } });
  assert.equal(H.install(byId(home, "claude-code:.claude-key3"), ARGV, { url: "https://example.com/mcp" }).action, "added");
  write(path.join(shared, "plugins", "installed_plugins.json"), { version: 2, plugins: { "spacesheep@spacesheep": [{ scope: "project", installPath: cache }] } });
  assert.equal(H.install(byId(home, "claude-code:.claude-key2"), ARGV).action, "added");
  assert.equal(S.hasPlugin(shared), false);
});

test("malformed plugin metadata is reported without adding a second route", (t) => {
  const home = homeFor(t);
  const { cache } = fleet(home);
  write(path.join(cache, ".mcp.json"), "{bad");
  const h = byId(home, "claude-code:.claude-key1");
  const r = H.install(h, ARGV);
  assert.equal(r.action, "skipped");
  assert.match(r.error, /\.mcp.json/);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file, "utf8")), {});
});

test("talk restoration is idempotent, protects unrelated commands, and reports a missing cache", (t) => {
  const home = homeFor(t);
  const { shared, cache } = fleet(home, false);
  const own = path.join(shared, "commands", "talk.md");
  const other = path.join(home, ".claude-key1", "commands", "talk.md");
  write(other, "my talk command");
  S.installSkills(SKILL, S.skillTargets({ home, env: {} }));
  const again = S.installSkills(SKILL, S.skillTargets({ home, env: {} }));
  assert.equal(again.find((r) => r.file === "~/.claude/commands/talk.md").action, "unchanged");
  assert.equal(fs.readFileSync(other, "utf8"), "my talk command");
  S.uninstallSkills(S.skillTargets({ home, env: {} }));
  assert.equal(fs.existsSync(own), false);
  assert.equal(fs.readFileSync(other, "utf8"), "my talk command");
  fs.unlinkSync(path.join(cache, "commands", "talk.md"));
  const result = S.installSkills(SKILL, S.skillTargets({ home, env: {} }));
  assert.ok(result.some((r) => r.error?.includes("couldn't restore talk")));
});

test("enabled fleet advisory names the exact settings and MCP entries, and both lost skills", async (t) => {
  const home = homeFor(t);
  const { shared, cache } = fleet(home);
  offline(t, home);
  const lines = [];
  await I.run({ only: "claude-code", except: "claude-code:.claude-placeholder", dryRun: true }, (l) => lines.push(l), () => {});
  const output = lines.join("\n");
  assert.ok(output.includes(path.join(cache, ".mcp.json") + ' entry "spacesheep"'));
  assert.ok(output.includes(path.join(shared, "settings.json") + ' enabledPlugins["spacesheep@spacesheep"]'));
  assert.match(output, /Disabling the plugin removes \/sheep and talk/);
  assert.doesNotMatch(output, /claude-placeholder|find.*\/mcp|  added\b/);
});

test("--only and --except scope skill writes and uninstall, including an excluded home already set up", async (t) => {
  const home = homeFor(t);
  fleet(home, false);
  fs.mkdirSync(path.join(home, ".codex", "skills"), { recursive: true });
  offline(t, home);
  await I.run({ only: "claude-code" }, () => {}, () => {});
  let status;
  await I.status({ json: true }, (value) => { status = value; }, () => {});
  assert.equal(status.skills.find((s) => s.file === "~/.claude/commands/talk.md").note, "talk restored from plugin cache");
  assert.equal(fs.existsSync(path.join(home, ".codex", "skills", "sheep")), false);
  const h = byId(home, "claude-code:.claude-placeholder");
  const config = fs.readFileSync(h.file, "utf8");
  const talk = path.join(h.dir, "commands", "talk.md");
  const command = fs.readFileSync(talk, "utf8");
  await I.uninstall({ only: "claude-code", except: h.id }, () => {}, () => {});
  assert.equal(fs.readFileSync(h.file, "utf8"), config);
  assert.equal(fs.readFileSync(talk, "utf8"), command);
  assert.equal(fs.existsSync(path.join(home, ".claude-key1", "skills", "sheep")), false);
});

test("dry-run replacement, skill update and uninstall use future tense without writes", async (t) => {
  const home = homeFor(t);
  write(path.join(home, ".claude", "skills", "sheep", "SKILL.md"), "<!-- spacesheep-skill-version: 0.1 -->\nold");
  const h = byId(home, "claude-code");
  write(h.file, { mcpServers: { spacesheep: { url: "https://mcp.spacesheep.dev/mcp" } } });
  offline(t, home);
  const before = fs.readFileSync(h.file, "utf8");
  const lines = [];
  await I.run({ only: "claude-code", dryRun: true }, (l) => lines.push(l), () => {});
  assert.match(lines.join("\n"), /would replace/);
  assert.match(lines.join("\n"), /would update/);
  assert.equal(fs.readFileSync(h.file, "utf8"), before);
  H.install(h, ARGV);
  const bridge = fs.readFileSync(h.file, "utf8");
  await I.uninstall({ only: "claude-code", dryRun: true }, (l) => lines.push(l), () => {});
  assert.match(lines.join("\n"), /would remove/);
  assert.equal(fs.readFileSync(h.file, "utf8"), bridge);
});
