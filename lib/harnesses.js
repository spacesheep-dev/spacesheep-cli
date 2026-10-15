// Where each coding harness on this machine keeps its MCP servers, and how to put
// the bridge (`spacesheep mcp`, lib/bridge.js) there.
//
// One entry per harness, written into the harness's own user-level config, so every
// project on the machine has it. An entry that already reaches spacesheep — the
// remote server by URL, under any name, or an older bridge — is replaced, never
// added beside: two of them would show every tool twice and still ask for a sign-in.
//
// Each config is replaced atomically through its real path; Claude state is read
// and written under its lock. A file that doesn't parse is reported and left alone
// (~/.claude.json holds Claude Code's state; a guess there costs their setup).
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { scan } = require("./codex-config");
const { pluginServers, pluginNote } = require("./claude-plugins");

const NAME = "spacesheep";
const REMOTE_HOST = "mcp.spacesheep.dev";

/** Is this config entry one of ours: the bridge, at any path? */
function isBridge(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (typeof entry.headersHelper === "string" && /spacesheep(\.js)?"?\s+mcp\s+headers/.test(entry.headersHelper)) return true;
  const argv = Array.isArray(entry.command) ? entry.command : [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
  const words = argv.filter((x) => typeof x === "string");
  return words.some((w) => /spacesheep(\.js)?$/.test(w.replace(/\\/g, "/")) || /(^|\/)spacesheep(@[\w.-]+)?$/.test(w)) && words.includes("mcp");
}

/** Does this entry reach spacesheep, by any route? */
function reachesSpacesheep(name, entry) {
  if (name === NAME) return true;
  if (isBridge(entry)) return true;
  try { return JSON.stringify(entry).includes(REMOTE_HOST); } catch (_) { return false; }
}

/** The script a bridge entry runs, when it names one. */
function bridgeScript(entry) {
  if (typeof entry.headersHelper === "string") {
    const m = /"([^"]*spacesheep\.js)"|(\S*spacesheep\.js)/.exec(entry.headersHelper);
    if (m) return m[1] || m[2];
  }
  const argv = Array.isArray(entry.command) ? entry.command : [entry.command, ...(entry.args || [])];
  return argv.find((w) => typeof w === "string" && /spacesheep\.js$/.test(w.replace(/\\/g, "/"))) || null;
}

// --- the harnesses -----------------------------------------------------------------

function vscodeUserDirs(home, platform, env) {
  const base = platform === "darwin" ? path.join(home, "Library", "Application Support")
    : platform === "win32" ? (env.APPDATA || path.join(home, "AppData", "Roaming"))
    : (env.XDG_CONFIG_HOME || path.join(home, ".config"));
  return [["vscode", "VS Code", "Code"], ["vscode-insiders", "VS Code Insiders", "Code - Insiders"]]
    .map(([id, label, dir]) => ({ id, label, dir: path.join(base, dir, "User") }));
}

const claudeId = (dir, first) => (first ? "claude-code" : `claude-code:${path.basename(dir)}`);

/** Does a --only / --skip word name this harness? Its id (`codex`, `claude-code` for
 *  every Claude home, `claude-code:.claude-work` for one), its label, or for a Claude
 *  home its folder's name with or without the `.claude-` (`.claude-work`, `work`). */
function matches(h, word) {
  const w = String(word).trim().toLowerCase();
  if (!w) return false;
  const id = h.id.toLowerCase();
  if (id === w || id.startsWith(w + ":") || h.label.toLowerCase() === w) return true;
  if (!id.startsWith("claude-code:")) return false;
  const base = id.slice("claude-code:".length);
  return base === w || base.replace(/^\.claude[-_.]/, "") === w.replace(/^\.claude[-_.]/, "");
}

/** Every Claude Code config dir: ~/.claude, CLAUDE_CONFIG_DIR, and ~/.claude-* ones
 *  that hold an account (the same walk the session hooks do). */
function claudeDirs(home, env) {
  const out = [];
  const add = (d) => { if (d && !out.includes(path.resolve(d))) out.push(path.resolve(d)); };
  add(path.join(home, ".claude"));
  add(env.CLAUDE_CONFIG_DIR);
  try {
    for (const e of fs.readdirSync(home, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^\.claude[-_.]/.test(e.name)) continue;
      const d = path.join(home, e.name);
      if (fs.existsSync(path.join(d, "projects")) || fs.existsSync(path.join(d, "settings.json")) || fs.existsSync(path.join(d, ".claude.json"))) add(d);
    }
  } catch (_) {}
  return out;
}

/**
 * The harnesses this machine could have. `present` says whether it does: the
 * harness's own folder exists (it made it on first run). Each has a `kind` saying
 * how its file is shaped.
 */
function harnesses({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const list = [];
  const exists = (p) => { try { fs.statSync(p); return true; } catch (_) { return false; } };
  const tilde = (p) => (p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p);

  claudeDirs(home, env).forEach((dir, i) => {
    // The default account's state is ~/.claude.json, beside the folder; another
    // account's (CLAUDE_CONFIG_DIR) is .claude.json inside its folder. A second home
    // counts only once Claude Code has run in it (its .claude.json exists): a folder
    // with only settings in it is a placeholder, and writing a .claude.json there
    // would be the first state Claude Code ever finds in it.
    const file = i === 0 ? path.join(home, ".claude.json") : path.join(dir, ".claude.json");
    list.push({ id: claudeId(dir, i === 0), label: i === 0 ? "Claude Code" : `Claude Code (${tilde(dir)})`, kind: "claude", file, dir, present: i === 0 ? exists(dir) || exists(file) : exists(file) });
  });
  const codexHome = env.CODEX_HOME || path.join(home, ".codex");
  list.push({ id: "codex", label: "Codex", kind: "toml", file: path.join(codexHome, "config.toml"), dir: codexHome, present: exists(codexHome) });
  const gemini = path.join(home, ".gemini");
  // ~/.gemini is shared with Antigravity; Gemini CLI's own sign is its settings or its login.
  list.push({ id: "gemini", label: "Gemini CLI", kind: "json", key: "mcpServers", file: path.join(gemini, "settings.json"), dir: gemini,
    present: ["settings.json", "oauth_creds.json", "google_accounts.json"].some((f) => exists(path.join(gemini, f))) });
  list.push({ id: "antigravity", label: "Antigravity", kind: "json", key: "mcpServers", file: path.join(gemini, "config", "mcp_config.json"), dir: path.join(gemini, "config"), present: exists(path.join(gemini, "config")) });
  // Older Antigravity builds kept it beside their data; only touched when that file exists.
  const agOld = path.join(gemini, "antigravity", "mcp_config.json");
  list.push({ id: "antigravity-ide", label: "Antigravity (older config)", kind: "json", key: "mcpServers", file: agOld, dir: path.dirname(agOld), present: exists(agOld) });
  list.push({ id: "cursor", label: "Cursor", kind: "json", key: "mcpServers", file: path.join(home, ".cursor", "mcp.json"), dir: path.join(home, ".cursor"), present: exists(path.join(home, ".cursor")) });
  const windsurf = path.join(home, ".codeium", "windsurf");
  list.push({ id: "windsurf", label: "Windsurf", kind: "json", key: "mcpServers", file: path.join(windsurf, "mcp_config.json"), dir: windsurf, present: exists(windsurf) });
  for (const v of vscodeUserDirs(home, platform, env)) {
    list.push({ id: v.id, label: v.label, kind: "json", key: "servers", typed: true, file: path.join(v.dir, "mcp.json"), dir: v.dir, present: exists(v.dir) });
  }
  const opencode = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode");
  list.push({ id: "opencode", label: "opencode", kind: "json", key: "mcp", opencode: true, file: path.join(opencode, "opencode.json"), dir: opencode, present: exists(opencode) });
  for (const h of list) h.shown = tilde(h.file);
  return list;
}

const REMOTE_URL = `https://${REMOTE_HOST}/mcp`;
const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a));

/**
 * The entry this harness needs, from `argv` (node, script, "mcp").
 *
 * Claude Code gets the server by URL, signed in by a headersHelper that prints this
 * machine's key (`spacesheep mcp headers`), not the stdio bridge. Claude Code
 * (2.1.71+) skips a plugin's MCP server when a configured one has the same URL, so
 * the spacesheep plugin keeps its skill and commands while its own copy of the
 * server, which wants a sign-in of its own, stands down: no tool shows twice, and
 * nobody has to switch the plugin off. Without a key, the helper prints no header
 * and Claude Code falls back to its own sign-in.
 */
function entryFor(h, argv, { url = REMOTE_URL } = {}) {
  const [command, ...args] = argv;
  if (h.kind === "claude") return { type: "http", url, headersHelper: [command, ...args, "headers"].map(quote).join(" ") };
  if (h.opencode) return { type: "local", command: argv, enabled: true };
  if (h.typed) return { type: "stdio", command, args };
  return { command, args };
}

// --- JSON files ----------------------------------------------------------------------

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

function indentOf(text) {
  const m = /^\{\s*\n([ \t]+)"/.exec(text || "");
  return m ? m[1] : 2;
}

/** Resolve existing files and parent directories, including dangling symlinks. */
function writeTarget(file, seen = new Set()) {
  const absolute = path.resolve(file);
  if (seen.has(absolute)) throw new Error(`symlink loop at ${file}`);
  seen.add(absolute);
  try { return fs.realpathSync(absolute); } catch (e) { if (e.code !== "ENOENT") throw e; }
  try {
    if (fs.lstatSync(absolute).isSymbolicLink()) return writeTarget(path.resolve(path.dirname(absolute), fs.readlinkSync(absolute)), seen);
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  const parent = path.dirname(absolute);
  return path.join(writeTarget(parent, seen), path.basename(absolute));
}

/** Claude Code uses mkdir(<config>.lock), including the configured symlink path.
 * Hold that lock across read/modify/rename; also lock the real target for aliases.
 * Never reclaim another process's lock. No network or async work in this section.
 * See docs/install-safety.md for the upstream protocol probe. */
function withConfig(h, dryRun, fn) {
  const file = writeTarget(h.file);
  const locks = h.kind === "claude" ? [...new Set([`${h.file}.lock`, `${file}.lock`]
    .map((p) => path.join(writeTarget(path.dirname(p)), path.basename(p))))] : [];
  const held = [];
  try {
    for (const lock of locks) {
      try {
        if (dryRun) {
          try { fs.lstatSync(lock); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
          throw Object.assign(new Error("lock exists"), { code: "EEXIST" });
        }
        fs.mkdirSync(path.dirname(lock), { recursive: true });
        fs.mkdirSync(lock);
        held.push(lock);
      } catch (e) {
        if (e.code === "EEXIST") throw new Error(`${h.file} is locked (${lock}); wait for Claude Code to finish saving or close its sessions, then retry install/uninstall`);
        throw e;
      }
    }
    return fn(file);
  } finally {
    for (const lock of held.reverse()) fs.rmdirSync(lock);
  }
}

/** Writes beside the real file, then renames over it, keeping its mode. */
function writeAtomic(file, text) {
  file = writeTarget(file);
  let mode = 0o644;
  try { mode = fs.statSync(file).mode & 0o777; } catch (_) {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.spacesheep-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode, flag: "wx" });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}

/** The JSON file's new text with `entry` as the only spacesheep server, or why not. */
function planJson(h, text, entry) {
  let doc = {};
  if (text !== null && text.trim()) {
    try { doc = JSON.parse(text); } catch (_) { return { error: `${h.shown} isn't plain JSON (comments?), so it was left alone — add the server by hand` }; }
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { error: `${h.shown} isn't a JSON object, so it was left alone` };
  const key = h.kind === "claude" ? "mcpServers" : h.key;
  const servers = doc[key] && typeof doc[key] === "object" && !Array.isArray(doc[key]) ? doc[key] : {};
  const replaced = Object.keys(servers).filter((n) => reachesSpacesheep(n, servers[n]));
  const same = replaced.length === 1 && replaced[0] === NAME && JSON.stringify(servers[NAME]) === JSON.stringify(entry);
  if (same) return { unchanged: true, replaced: [] };
  const next = {};
  for (const [n, v] of Object.entries(servers)) if (!replaced.includes(n)) next[n] = v;
  next[NAME] = entry;
  doc[key] = next;
  const out = JSON.stringify(doc, null, indentOf(text)) + "\n";
  return { text: out, replaced };
}

function removeJson(h, text) {
  if (text === null) return { unchanged: true, removed: [] };
  let doc;
  try { doc = JSON.parse(text); } catch (_) { return { error: `${h.shown} isn't plain JSON, so it was left alone` }; }
  const key = h.kind === "claude" ? "mcpServers" : h.key;
  const servers = doc && doc[key];
  if (!servers || typeof servers !== "object") return { unchanged: true, removed: [] };
  const removed = Object.keys(servers).filter((n) => isBridge(servers[n]));
  if (!removed.length) return { unchanged: true, removed };
  for (const n of removed) delete servers[n];
  return { text: JSON.stringify(doc, null, indentOf(text)) + "\n", removed };
}

function jsonEntries(h, text) {
  if (text === null) return {};
  try {
    const doc = JSON.parse(text);
    const s = doc && doc[h.kind === "claude" ? "mcpServers" : h.key];
    return s && typeof s === "object" ? s : {};
  } catch (_) { return null; }
}

// --- Codex's config.toml -------------------------------------------------------------

/** The table headers in a TOML text, outside multi-line strings and arrays:
 *  [{ start, end, name }] where end is where the next header begins. */
function tomlTables(text) {
  const lines = text.split("\n");
  const st = { depth: 0, str: null };
  const heads = [];
  let pos = 0;
  for (const line of lines) {
    if (!st.str && st.depth === 0) {
      const m = /^[ \t]*\[\[?([^\]]*)\]\]?/.exec(line);
      if (m) heads.push({ start: pos, name: m[1].trim() });
    }
    scan(line, st);
    pos += line.length + 1;
  }
  for (let i = 0; i < heads.length; i++) heads[i].end = i + 1 < heads.length ? heads[i + 1].start : text.length;
  return heads;
}

/** `mcp_servers.<name>` or a subtable of one, with the name unquoted; else null. */
function mcpServerOf(header) {
  const m = /^mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*(\..*)?$/.exec(header);
  return m ? { name: m[1] || m[2] || m[3], sub: !!m[4] } : null;
}

/** The [mcp_servers.<name>] tables (with their subtables) that reach spacesheep. */
function tomlSpacesheepBlocks(text, only = reachesTomlBody) {
  const tables = tomlTables(text);
  const names = new Set();
  for (const t of tables) {
    const s = mcpServerOf(t.name);
    if (s && !s.sub && only(s.name, text.slice(t.start, t.end))) names.add(s.name);
  }
  return { names: [...names], blocks: tables.filter((t) => { const s = mcpServerOf(t.name); return s && names.has(s.name); }) };
}
function reachesTomlBody(name, body) {
  return name === NAME || body.includes(REMOTE_HOST) || isTomlBridge(body);
}
function isTomlBridge(body) {
  return /spacesheep(\.js)?"/.test(body) && /"mcp"/.test(body);
}

function cut(text, blocks) {
  let out = text;
  for (const b of [...blocks].sort((a, z) => z.start - a.start)) out = out.slice(0, b.start) + out.slice(b.end);
  return out.replace(/\n{3,}/g, "\n\n");
}

const tomlString = (s) => JSON.stringify(String(s));

function tomlEntry(argv) {
  const [command, ...args] = argv;
  return `[mcp_servers.${NAME}]\ncommand = ${tomlString(command)}\nargs = [${args.map(tomlString).join(", ")}]\n# A publish can outlast Codex's 60-second default.\ntool_timeout_sec = 300\n`;
}

function planToml(h, text, argv) {
  const src = text || "";
  const { names, blocks } = tomlSpacesheepBlocks(src);
  const entry = tomlEntry(argv);
  if (names.length === 1 && names[0] === NAME && blocks.length === 1 && src.slice(blocks[0].start, blocks[0].end).trim() === entry.trim()) {
    return { unchanged: true, replaced: [] };
  }
  let out = cut(src, blocks).replace(/\n*$/, "\n");
  out = out.trim() ? out + "\n" + entry : entry;
  return { text: out, replaced: names };
}

function removeToml(h, text) {
  if (text === null) return { unchanged: true, removed: [] };
  const { names, blocks } = tomlSpacesheepBlocks(text, (_, body) => isTomlBridge(body));
  if (!names.length) return { unchanged: true, removed: [] };
  return { text: cut(text, blocks), removed: names };
}

function tomlEntries(text) {
  if (text === null) return {};
  const tables = tomlTables(text);
  const out = {};
  for (const t of tables) {
    const s = mcpServerOf(t.name);
    if (!s || s.sub) continue;
    const body = text.slice(t.start, t.end);
    const cmd = /^\s*command\s*=\s*("(?:[^"\\]|\\.)*")/m.exec(body);
    const args = /^\s*args\s*=\s*(\[.*\])/m.exec(body);
    const url = /^\s*url\s*=\s*("(?:[^"\\]|\\.)*")/m.exec(body);
    const e = {};
    try { if (cmd) e.command = JSON.parse(cmd[1]); } catch (_) {}
    try { if (args) e.args = JSON.parse(args[1]); } catch (_) {}
    try { if (url) e.url = JSON.parse(url[1]); } catch (_) {}
    out[s.name] = e;
  }
  return out;
}

// --- the operations ------------------------------------------------------------------

/** Puts the bridge in one harness. → { harness, file, action, replaced, error } */
function install(h, argv, { dryRun = false, url } = {}) {
  const base = { id: h.id, harness: h.label, file: h.shown };
  try {
    if (h.kind === "claude") {
      const plugin = pluginServers(h.dir, url);
      if (plugin.length) return { ...base, action: "skipped", note: pluginNote(plugin), plugin };
    }
    return withConfig(h, dryRun, (file) => {
      const text = readText(file);
      const plan = h.kind === "toml" ? planToml(h, text, argv) : planJson(h, text, entryFor(h, argv, { url }));
      if (plan.error) return { ...base, action: "skipped", error: plan.error };
      if (plan.unchanged) return { ...base, action: "unchanged", replaced: [] };
      if (!dryRun) writeAtomic(file, plan.text);
      return { ...base, action: plan.replaced.length ? "replaced" : "added", replaced: plan.replaced };
    });
  } catch (e) {
    return { ...base, action: "skipped", error: `couldn't write ${h.shown}: ${e.message}` };
  }
}

/** Takes the bridge out of one harness (only the bridge; a remote entry stays). */
function uninstall(h, { dryRun = false } = {}) {
  const base = { id: h.id, harness: h.label, file: h.shown };
  try {
    return withConfig(h, dryRun, (file) => {
      const text = readText(file);
      const plan = h.kind === "toml" ? removeToml(h, text) : removeJson(h, text);
      if (plan.error) return { ...base, action: "skipped", error: plan.error };
      if (plan.unchanged) return { ...base, action: "unchanged", removed: [] };
      if (!dryRun) writeAtomic(file, plan.text);
      return { ...base, action: "removed", removed: plan.removed };
    });
  } catch (e) {
    return { ...base, action: "skipped", error: e.message };
  }
}

/** What reaches spacesheep from this harness today. */
function status(h) {
  const base = { id: h.id, harness: h.label, file: h.shown, present: h.present };
  let text;
  try { text = readText(h.file); } catch (e) { return { ...base, error: e.message, entries: [] }; }
  const all = h.kind === "toml" ? tomlEntries(text) : jsonEntries(h, text);
  if (all === null) return { ...base, error: "isn't plain JSON", entries: [] };
  const entries = Object.entries(all).filter(([n, e]) => reachesSpacesheep(n, e)).map(([n, e]) => {
    if (isBridge(e)) {
      const script = bridgeScript(e);
      return { name: n, via: "bridge", script, ok: !script || fs.existsSync(script) };
    }
    return { name: n, via: "remote", ok: true };
  });
  if (h.kind === "claude") {
    try { entries.push(...pluginServers(h.dir).map((p) => ({ ...p, via: "plugin", ok: true }))); }
    catch (e) { return { ...base, entries, error: e.message }; }
  }
  return { ...base, entries };
}

module.exports = { matches, claudeId, NAME, harnesses, entryFor, install, uninstall, status, isBridge, reachesSpacesheep, planJson, planToml, removeToml, removeJson, tomlTables, mcpServerOf, tomlEntries, claudeDirs };
