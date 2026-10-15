// `spacesheep install`: connect every coding harness on this machine to spacesheep
// at once — sign the machine in (once), point each harness's MCP config at the
// bridge (`spacesheep mcp`, which uses that one key), and put the /sheep skill where
// each harness reads skills. `--ssh host` does the same on other machines from here.
//
// Before this, each harness connected on its own: one sign-in per harness per
// machine. Eleven machines with five harnesses each was about fifty (2026-10-14).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const cfg = require("./config");
const { McpClient } = require("./mcp");
const H = require("./harnesses");
const S = require("./skills");
const { pluginNote } = require("./claude-plugins");

const machineName = (opts) => String(opts.name || os.hostname().split(".")[0] || "machine").slice(0, 60);
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return p; } };

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { if (buf.length < 4096) buf += d; });
    process.stdin.on("end", () => resolve(buf));
  });
}

/** Proves a key opens the tools. → number of tools. */
async function checkKey(key) {
  try {
    return (await new McpClient(cfg.origin(), key).listTools()).length;
  } catch (e) {
    if (/\b403\b|insufficient_scope/.test(e.message)) {
      throw Object.assign(new Error("this machine's key can't use the tools (a streams-only or sessions-only key). Sign in with a full key: `spacesheep login`, then run install again"), { code: "EAUTH" });
    }
    throw e;
  }
}

/** This machine's key: the one it holds, or a new one from --key / --code / the browser. */
async function ensureKey(opts, log) {
  const { connectWithKey, redeemCode, deviceLogin, agentClient } = require("./login");
  const save = (fields) => cfg.writeConfig({
    ...cfg.readConfig(), ...fields,
    origin: process.env.SPACESHEEP_ORIGIN || cfg.readConfig().origin || undefined,
    appOrigin: process.env.SPACESHEEP_APP_ORIGIN || cfg.readConfig().appOrigin || undefined,
  });
  const name = machineName(opts);
  if (opts.key === "-") {
    // From another machine's `install --ssh`: a key already minted for this one.
    const key = cfg.cleanKey(await readStdin());
    if (!key.startsWith("ss_")) throw new Error("--key - reads an ss_ key from stdin, and none came");
    await checkKey(key);
    save({ key, machine: name });
    return { key, how: "key from stdin" };
  }
  if (opts.key) {
    const parent = cfg.cleanKey(opts.key);
    if (!parent.startsWith("ss_")) throw new Error("--key takes an ss_ key (create one at https://spacesheep.dev/settings/api-keys#create)");
    const { key, username } = await connectWithKey(cfg.appOrigin(), parent, name, log);
    save({ key, username, machine: name });
    return { key, username, how: `a key of its own, "${name}"` };
  }
  if (opts.code !== undefined) {
    const { key, username, name: saved } = await redeemCode(cfg.appOrigin(), opts.code, name, log, agentClient(process.env));
    save({ key, username, machine: saved });
    return { key, username, how: `a key of its own, "${saved}"` };
  }
  const have = cfg.resolveKey();
  if (have) return { key: have.key, username: cfg.readConfig().username, how: have.source === "env" ? "the key in SPACESHEEP_KEY" : "the key it already had" };
  // `--no-login` (what --ssh asks first): say so rather than start a sign-in.
  if (opts.noLogin) throw Object.assign(new Error("this machine isn't signed in to spacesheep"), { code: "EAUTH" });
  // An agent's shell is not a terminal, and the device flow works there: it prints
  // one link for the person to approve. Only CI, where nobody can, is refused.
  if (process.env.CI) {
    throw Object.assign(new Error("this machine isn't signed in. In CI, set SPACESHEEP_KEY (spacesheep.dev/settings/api-keys#create), or pass --key ss_…"), { code: "EAUTH" });
  }
  const { key, username } = await deviceLogin(cfg.origin(), log);
  save({ key, username });
  return { key, username, how: "the browser" };
}

/**
 * The command every harness will run. A global install's own path survives
 * updates; a copy npx unpacked into its cache does not (npx cleans it), and
 * running npx on every harness start costs a registry check and fails offline.
 * So a run from npx copies the CLI (no dependencies, ~300 KB) into the config
 * folder and points the harnesses there.
 */
function stableCommand({ dryRun = false, script = process.argv[1] } = {}) {
  const { stableNode } = require("./memory");
  const p = real(script);
  const viaNpx = /[\\/]_npx[\\/]/.test(p) || /[\\/]\.npm[\\/]/.test(p);
  if (!viaNpx) return { argv: [stableNode(), p, "mcp"], copied: null };
  const root = path.resolve(path.dirname(p), "..");
  const dest = path.join(cfg.configDir(), "cli");
  if (!dryRun) {
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    for (const part of ["bin", "lib", "package.json", "LICENSE"]) {
      const from = path.join(root, part);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(tmp, part), { recursive: true });
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
  }
  return { argv: [stableNode(), path.join(dest, "bin", "spacesheep.js"), "mcp"], copied: dest };
}

/** Which harnesses to touch: --only names them (else every one on this machine),
 *  and --skip / --except take some out — one Claude home by its folder name included. */
function chosen(all, opts = {}) {
  const words = (v) => [].concat(v || []).flatMap((x) => String(x).split(",")).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const only = words(opts.only);
  const skip = [...words(opts.skip), ...words(opts.except)];
  for (const [flag, list] of [["--only", only], ["--skip", words(opts.skip)], ["--except", words(opts.except)]]) {
    const unknown = list.filter((w) => !all.some((h) => H.matches(h, w)));
    if (unknown.length) throw new Error(`${flag}: no harness called ${unknown.join(", ")} (known: ${[...new Set(all.filter((h) => h.present || !h.id.includes(":")).map((h) => h.id))].join(", ")})`);
  }
  return all.filter((h) => (only.length ? only.some((w) => H.matches(h, w)) : h.present) && !skip.some((w) => H.matches(h, w)));
}
/** The skill targets for the same choice (a target has the id of its harness). */
function chosenSkills(targets, opts = {}) {
  const words = (v) => [].concat(v || []).flatMap((x) => String(x).split(",")).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const only = words(opts.only);
  const skip = [...words(opts.skip), ...words(opts.except)];
  const asH = (t) => ({ id: t.id, label: t.harness });
  return targets.filter((t) => (!only.length || only.some((w) => H.matches(asH(t), w))) && !skip.some((w) => H.matches(asH(t), w)));
}

const pad = (s, n) => (s + " ".repeat(n)).slice(0, Math.max(n, s.length));
const MARKS = { added: "✓", replaced: "✓", updated: "✓", unchanged: "·", removed: "✓", skipped: "!" };

function describe(r, dryRun = false) {
  if (r.error) return r.error;
  if (r.note) return r.note;
  if (r.action === "replaced") return `${dryRun ? "would replace" : "replaced"} ${r.replaced.map((n) => `"${n}"`).join(", ")} (it signed in on its own)`;
  if (r.action === "updated") return `${dryRun ? "would update" : "updated"}${r.from ? ` from ${r.from}` : ""}`;
  if (r.action === "unchanged") return "already set up";
  return dryRun && r.action === "added" ? "would add" : dryRun && r.action === "removed" ? "would remove" : r.action;
}

async function run(opts, log, out) {
  if (opts.ssh) return viaSsh(opts, log);
  const dryRun = !!opts.dryRun;
  const k = await ensureKey(opts, log);
  const tools = await checkKey(k.key);
  const who = k.username || cfg.readConfig().username;
  const machine = cfg.readConfig().machine || machineName(opts);
  const cmd = stableCommand({ dryRun });
  const all = H.harnesses();
  const url = `${String(cfg.origin()).replace(/\/$/, "")}/mcp`;
  const results = chosen(all, opts).map((h) => H.install(h, cmd.argv, { dryRun, url }));
  let skills = [];
  let skillError = null;
  let skillText = "";
  if (!opts.noSkill) {
    try { skillText = await S.fetchSkill(cfg.appOrigin()); skills = S.installSkills(skillText, chosenSkills(S.skillTargets(), opts), { dryRun }); }
    catch (e) { skillError = e.message; }
  }
  const missing = opts.only ? [] : all.filter((h) => !h.present && !h.id.includes(":") && !/older config/.test(h.label));
  if (opts.json) return out({ machine, username: who || null, tools, command: cmd.argv, copied: cmd.copied, dry_run: dryRun, harnesses: results, skills, skill_error: skillError, not_found: missing.map((h) => h.id) });

  log(`\n  ${dryRun ? "Would connect" : "Connected"} this machine${who ? ` (@${who}` : " ("}${machine ? ` on "${machine}"` : ""}) with ${k.how} — ${tools} tools.`);
  log(`  ${dryRun ? "Planned bridge command" : "Bridge command"}: ${cmd.argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
  log(`  (Claude homes selected for configuration use HTTP with this command's \`mcp headers\` helper.)\n`);
  const w = Math.max(12, ...results.map((r) => r.harness.length));
  for (const r of results) log(`    ${MARKS[r.action] || "·"} ${pad(r.harness, w)}  ${pad(r.file, 34)}  ${describe(r, dryRun)}`);
  if (!results.length) log("    (no coding harness selected — check --only/--except or install a harness)");
  if (missing.length) log(`\n  Not on this machine: ${missing.map((h) => h.label).join(", ")}`);
  if (skillError) log(`\n  ! /sheep skill not installed: ${skillError}`);
  else if (skills.length) {
    log(`\n  Skills (/sheep ${S.versionOf(skillText) || ""}; talk from disabled plugin cache)`.trimEnd());
    for (const s of skills) log(`    ${MARKS[s.action] || "·"} ${pad(s.harness, w)}  ${pad(s.file || "", 34)}  ${describe(s, dryRun)}`);
  }
  const advised = new Set();
  for (const r of results) for (const p of r.plugin || []) {
    const setting = `${p.settingsFile} enabledPlugins["${p.plugin}"]`;
    if (advised.has(setting)) continue;
    advised.add(setting);
    log(`\n  To use this machine's bridge instead, set ${setting} to false and rerun install.`);
    log(`  Disabling the plugin removes /sheep and talk; rerunning install restores both from the skill service and installed plugin cache (omit --no-skill).`);
    log(`  Shared settings affect every home linked to that file. The plugin connection continues to sign in separately until disabled.`);
  }
  if (cmd.copied) log(`\n  The CLI ${dryRun ? "would be copied" : "was copied"} to ${cmd.copied.replace(os.homedir(), "~")} for the harnesses to run (npx clears its own cache).`);
  log(`\n  ${dryRun ? "Harness configs and skills were not written (--dry-run)." : "Restart open harnesses (or reconnect: /mcp in Claude Code) to pick it up."}`);
  log(`  Other machines: run \`npx -y spacesheep@latest install\` on each, or from here: \`spacesheep install --ssh host1,host2\`\n`);
}

/** `install --ssh a,b`: run install on each machine from here. A machine that is
 *  already signed in keeps its key; only one that isn't gets a key minted here for
 *  it, sent on stdin so it never shows on a screen or in a process list. */
async function viaSsh(opts, log) {
  const { connectWithKey } = require("./login");
  const have = cfg.resolveKey();
  const hosts = [].concat(opts.ssh).flatMap((h) => String(h).split(",")).map((h) => h.trim()).filter(Boolean);
  for (const h of hosts) if (!/^[A-Za-z0-9._@:-]+$/.test(h)) throw new Error(`--ssh takes host or user@host names (got "${h}")`);
  const spec = opts.package || "spacesheep@latest";
  if (!/^[\w@./:#-]+$/.test(spec)) throw new Error("--package takes an npm spec such as spacesheep@latest or github:spacesheep-dev/spacesheep-cli#v1.32.2");
  const clean = (v) => [].concat(v || []).join(",").replace(/[^\w,:.-]/g, "");
  const extra = [opts.noSkill ? "--no-skill" : "", opts.dryRun ? "--dry-run" : "", opts.only ? `--only ${clean(opts.only)}` : "", opts.skip ? `--skip ${clean(opts.skip)}` : "", opts.except ? `--except ${clean(opts.except)}` : ""].filter(Boolean).join(" ");
  // A login shell, so a node from nvm / Homebrew is on PATH; no node at all is said plainly.
  const remoteCmd = (args) => {
    const inner = `command -v npx >/dev/null 2>&1 || { echo "  ✗ no Node.js on $(hostname): install Node 20 or newer (https://nodejs.org), then run this again" >&2; exit 127; }; npx -y ${spec} install ${args}`;
    return `if command -v bash >/dev/null 2>&1; then exec bash -lc '${inner}'; else exec sh -lc '${inner}'; fi`;
  };
  const ssh = (host, args, input) => new Promise((resolve) => {
    const p = spawn("ssh", [host, remoteCmd(args)], { stdio: [input ? "pipe" : "ignore", "inherit", "inherit"] });
    p.on("error", (e) => { log(`  ✗ ssh: ${e.message}`); resolve(1); });
    p.on("close", (code) => resolve(code));
    if (input) p.stdin.end(input + "\n");
  });
  const failed = [];
  for (const host of hosts) {
    const name = host.replace(/^.*@/, "").split(".")[0].slice(0, 60);
    log(`\n  ── ${host} ──`);
    // First with the key it already has, if any; exit 3 means it has none.
    let code = await ssh(host, `--no-login ${extra}`.trim());
    if (code === 3) {
      if (!have) { log(`  ✗ ${host} isn't signed in, and neither is this machine to make it a key: run install here first`); failed.push(host); continue; }
      if (opts.dryRun) { log(`  · ${host} isn't signed in: a real run makes it a key of its own, "${name}"`); continue; }
      let key;
      try { ({ key } = await connectWithKey(cfg.appOrigin(), have.key, name, () => {})); }
      catch (e) { log(`  ✗ couldn't make a key for ${host}: ${e.message}`); failed.push(host); continue; }
      log(`  ${host} wasn't signed in: made it a key of its own, "${name}"`);
      code = await ssh(host, `--key - --name ${name} ${extra}`.trim(), key);
      if (code !== 0) log(`  ✗ ${host}: install didn't finish (exit ${code}). Its key "${name}" was made; revoke it in Settings → API keys if you won't retry.`);
    } else if (code === 127) {
      log(`  ✗ ${host}: no Node.js there (or no ssh login): install Node 20+ on it, then run this again`);
    } else if (code !== 0) {
      log(`  ✗ ${host}: install didn't finish (exit ${code})`);
    }
    if (code !== 0) failed.push(host);
  }
  log(`\n  ${hosts.length - failed.length} of ${hosts.length} machine(s) ${opts.dryRun ? "checked" : "connected"}${failed.length ? ` — failed: ${failed.join(", ")}` : ""}.\n`);
  if (failed.length) process.exitCode = 1;
}

async function status(opts, out, log) {
  const k = cfg.resolveKey();
  const rows = H.harnesses().filter((h) => h.present).map((h) => H.status(h));
  const skills = S.skillTargets().map((t) => {
    if (t.skip || t.error) return { harness: t.harness, note: t.skip || t.error };
    let text = null;
    try { text = fs.readFileSync(t.file, "utf8"); } catch (_) {}
    if (t.skill === "talk") return { harness: t.harness, file: t.shown, note: text?.includes(S.TALK_MARK) ? "talk restored from plugin cache" : "talk not installed" };
    return { harness: t.harness, file: t.shown, version: text && text.includes(S.MARK) ? S.versionOf(text) : null };
  });
  if (opts.json) return out({ signed_in: !!k, key_prefix: k ? k.key.slice(0, 8) : null, harnesses: rows, skills });
  log(`\n  This machine: ${k ? `signed in (${k.key.slice(0, 8)}…)` : "not signed in — run `npx -y spacesheep@latest install`"}\n`);
  const w = Math.max(12, ...rows.map((r) => r.harness.length));
  for (const r of rows) {
    const bridge = r.entries.find((e) => e.via === "bridge");
    const remote = r.entries.filter((e) => e.via === "remote");
    const plugin = r.entries.filter((e) => e.via === "plugin");
    const what = r.error ? `! ${r.error}`
      : bridge && !bridge.ok ? `! runs ${bridge.script}, which is gone — run install again`
      : plugin.length ? `· ${pluginNote(plugin)}${bridge ? "; an existing bridge is also configured" : ""}`
      : bridge ? `✓ through this machine's key${remote.length ? ` (plus ${remote.length} remote entr${remote.length > 1 ? "ies" : "y"})` : ""}`
      : remote.length ? `· connects on its own (signs in separately) — install switches it`
      : "· not connected";
    log(`    ${pad(r.harness, w)}  ${pad(r.file, 34)}  ${what}`);
  }
  if (skills.length) {
    log(`\n  /sheep skill`);
    for (const s of skills) log(`    ${pad(s.harness, w)}  ${pad(s.file || "", 34)}  ${s.note || (s.version ? s.version : "not installed")}`);
  }
  log("");
}

async function uninstall(opts, log, out) {
  const dryRun = !!opts.dryRun;
  const results = chosen(H.harnesses(), opts).map((h) => H.uninstall(h, { dryRun }));
  const skills = opts.noSkill ? [] : S.uninstallSkills(chosenSkills(S.skillTargets(), opts), { dryRun });
  if (opts.json) return out({ harnesses: results, skills });
  for (const r of [...results, ...skills]) if (r.action !== "unchanged") log(`    ${MARKS[r.action] || "·"} ${pad(r.harness, 14)}  ${pad(r.file || "", 34)}  ${describe(r, dryRun)}`);
  log(`\n  ${dryRun ? "Would remove" : "Removed"} the bridge from ${results.filter((r) => r.action === "removed").length} harness(es). This machine's key stays (\`spacesheep logout\` forgets it).\n`);
}

module.exports = { run, status, uninstall, stableCommand, chosen, chosenSkills, ensureKey };
