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

const machineName = (opts) => String(opts.name || cfg.readConfig().machine || os.hostname().split(".")[0] || "machine").slice(0, 60);
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
    if (/insufficient_scope/.test(e.message)) {
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
  // `--no-login`: say so rather than start a sign-in.
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

function claudeVersion() {
  try {
    const out = require("child_process").execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    return (/(\d+\.\d+\.\d+)/.exec(out) || [])[1] || null;
  } catch (_) { return null; }
}
const atLeast = (v, min) => { const a = v.split(".").map(Number), b = min.split(".").map(Number); for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };

/** Which harnesses to touch: --only names them (else every one on this machine),
 *  and --skip takes some out — one Claude home by its folder name included. */
function chosen(all, opts = {}) {
  const words = (v) => [].concat(v || []).flatMap((x) => String(x).split(",")).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const only = words(opts.only);
  const skip = words(opts.skip);
  for (const [flag, list] of [["--only", only], ["--skip", skip]]) {
    const unknown = list.filter((w) => !all.some((h) => H.matches(h, w)));
    if (unknown.length) throw new Error(`${flag}: no harness called ${unknown.join(", ")} (known: ${[...new Set(all.filter((h) => h.present || !h.id.includes(":")).map((h) => h.id))].join(", ")})`);
  }
  return all.filter((h) => (only.length ? only.some((w) => H.matches(h, w)) : h.present) && !skip.some((w) => H.matches(h, w)));
}
/** The skill targets for the same choice (a target has the id of its harness). */
function chosenSkills(targets, opts = {}) {
  const words = (v) => [].concat(v || []).flatMap((x) => String(x).split(",")).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const only = words(opts.only);
  const skip = words(opts.skip);
  const asH = (t) => ({ id: t.id, label: t.harness });
  return targets.filter((t) => (!only.length || only.some((w) => H.matches(asH(t), w))) && !skip.some((w) => H.matches(asH(t), w)));
}

const pad = (s, n) => (s + " ".repeat(n)).slice(0, Math.max(n, s.length));
const MARKS = { added: "✓", replaced: "✓", updated: "✓", unchanged: "·", removed: "✓", skipped: "!" };

function describe(r) {
  if (r.error) return r.error;
  if (r.note) return r.note;
  if (r.action === "replaced") return `replaced ${r.replaced.map((n) => `"${n}"`).join(", ")} (it signed in on its own)`;
  if (r.action === "updated") return `updated${r.from ? ` from ${r.from}` : ""}`;
  if (r.action === "unchanged") return "already set up";
  return r.action;
}

async function run(opts, log, out) {
  if (opts.ssh) return viaSsh(opts, log);
  const dryRun = !!opts.dryRun;
  // Planning must also work on a signed-out host, without minting, redeeming a
  // code, reading a key from stdin or starting browser sign-in.
  const k = dryRun ? { how: "sign-in checked when installed" } : await ensureKey(opts, log);
  const tools = dryRun ? null : await checkKey(k.key);
  const who = k.username || cfg.readConfig().username;
  const machine = machineName(opts);
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

  log(`\n  ${dryRun ? "Would connect" : "Connected"} this machine${who ? ` (@${who}` : " ("}${machine ? ` on "${machine}"` : ""}) with ${k.how}${tools === null ? "" : ` — ${tools} tools`}.`);
  log(`  The agents below run: ${cmd.argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
  log(`  (Claude Code connects by URL instead, signed in by the same command's \`mcp headers\`.)\n`);
  const w = Math.max(12, ...results.map((r) => r.harness.length));
  for (const r of results) log(`    ${MARKS[r.action] || "·"} ${pad(r.harness, w)}  ${pad(r.file, 34)}  ${describe(r)}`);
  if (!results.length) log("    (no coding harness found on this machine — install one, then run this again)");
  if (missing.length) log(`\n  Not on this machine: ${missing.map((h) => h.label).join(", ")}`);
  if (skillError) log(`\n  ! /sheep skill not installed: ${skillError}`);
  else if (skills.length) {
    log(`\n  /sheep skill ${S.versionOf(skillText) || ""}`.trimEnd());
    for (const s of skills) log(`    ${s.error ? "!" : s.note ? "·" : MARKS[s.action] || "·"} ${pad(s.harness, w)}  ${pad(s.file || "", 34)}  ${describe(s)}`);
  }
  // The plugin's own copy of the server stands down for one with the same URL, in
  // Claude Code 2.1.71 and newer; an older one would list every tool twice.
  const plugin = H.claudeDirs(os.homedir(), process.env).some((d) => S.pluginEnabled(d));
  if (plugin && results.some((r) => r.id.startsWith("claude-code") && r.action !== "skipped")) {
    const v = claudeVersion();
    if (v && !atLeast(v, "2.1.71")) log(`\n  ! Claude Code ${v} lists the spacesheep plugin's tools beside these ones. Update it (2.1.71 or newer), and the plugin's copy steps aside.`);
    else log(`\n  The spacesheep plugin keeps its /sheep and /talk; its own copy of the server steps aside for this one.`);
  }
  if (cmd.copied) log(`\n  The CLI ${dryRun ? "would be" : "was"} copied to ${cmd.copied.replace(os.homedir(), "~")} for the harnesses to run (npx clears its own cache).`);
  log(`\n  ${dryRun ? "Nothing was written (--dry-run)." : "Restart open harnesses (or reconnect: /mcp in Claude Code) to pick it up."}`);
  log(`  Other machines: run \`npx -y spacesheep@latest install\` on each, or from here: \`spacesheep install --ssh host1,host2\`\n`);
}

const shellQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// Quote twice: argv for the login shell, then that entire script for SSH's shell.
function overSsh(host, inner, { input = "", capture = false } = {}) {
  const quoted = shellQuote(inner);
  const remote = `if command -v bash >/dev/null 2>&1; then exec bash -lc ${quoted}; else exec sh -lc ${quoted}; fi`;
  return new Promise((resolve, reject) => {
    const p = spawn("ssh", ["--", host, remote], { stdio: ["pipe", capture ? "pipe" : "inherit", "inherit"] });
    let stdout = "";
    if (capture) p.stdout.on("data", (s) => { stdout += s; });
    p.on("error", reject);
    p.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(code === null ? "ssh stopped by a signal" : `ssh exit ${code}`)));
    // SSH may exit before consuming stdin (e.g. connection lost after the probe).
    p.stdin.on("error", (e) => { if (e.code !== "EPIPE") reject(e); });
    p.stdin.end(input);
  });
}

const SSH_PROBE = [
  "missing=0",
  "command -v node >/dev/null 2>&1 || { echo 'Node is missing (requires Node >= 20)' >&2; missing=1; }",
  "command -v npx >/dev/null 2>&1 || { echo 'npx is missing' >&2; missing=1; }",
  '[ "$missing" -eq 0 ] || exit 1',
  "version=$(node -v) || exit 1",
  "major=${version#v}; major=${major%%.*}",
  "case $major in ''|*[!0-9]*) echo \"Cannot read Node version: $version\" >&2; exit 1;; esac",
  '[ "$major" -ge 20 ] || { echo "Requires Node >= 20; found $version" >&2; exit 1; }',
].join("; ");

/** Probe each host, keep working keys unless --force, then mint only when needed.
 *  A new key travels on stdin, never on a screen or in a process list. */
async function viaSsh(opts, log) {
  const { connectWithKey } = require("./login");
  const have = cfg.resolveKey();
  const hosts = [].concat(opts.ssh).flatMap((h) => String(h).split(",")).map((h) => h.trim()).filter(Boolean);
  for (const h of hosts) if (!/^[A-Za-z0-9._@:-]+$/.test(h)) throw new Error(`--ssh takes host or user@host names (got "${h}")`);
  const spec = opts.package || "spacesheep@latest";
  if (!/^[\w@./:#-]+$/.test(spec)) throw new Error("--package takes an npm spec such as spacesheep@latest or github:spacesheep-dev/spacesheep-cli");
  const cli = (args) => "SPACESHEEP_NO_UPDATE_CHECK=1 " + ["npx", "-y", spec, ...args].map(shellQuote).join(" ");
  const extra = [
    ...(opts.noSkill ? ["--no-skill"] : []),
    ...(opts.only ? ["--only", String(opts.only)] : []),
    ...[].concat(opts.skip || []).flatMap((s) => ["--skip", String(s)]),
    ...(opts.name ? ["--name", String(opts.name)] : []),
  ];
  const failed = [];
  let skipped = 0;
  for (const host of hosts) {
    log(`\n  ── ${host} ──`);
    let state;
    try {
      // The same login shell is used for the probe, status and installation, so
      // Node from nvm / Homebrew is resolved the same way in every step.
      await overSsh(host, SSH_PROBE);
      state = JSON.parse(await overSsh(host, cli(["mcp", "status", "--json"]), { capture: true }));
      if (typeof state.key_valid !== "boolean" || typeof state.machine !== "string") {
        throw new Error("status did not report a verified key and machine name; use a package with SSH preflight support");
      }
    } catch (e) {
      log(`  ✗ ${host}: preflight failed (${e.message}); no key was minted.`);
      failed.push(host);
      continue;
    }
    if (state.key_valid && !opts.force) {
      log(`  · ${host}: already has a working key — skipped (use --force to replace it).`);
      skipped++;
      continue;
    }
    const name = String(opts.name || state.machine).slice(0, 60);
    if (opts.dryRun) {
      log(`  Would mint a key for "${name}"${state.key_valid ? " and replace its current key" : ""}; previewing the host's plan.`);
      try { await overSsh(host, cli(["install", "--dry-run", ...extra])); }
      catch (e) { log(`  ✗ ${host}: preview failed (${e.message}); no key was minted.`); failed.push(host); }
      continue;
    }
    if (!have) {
      log(`  ✗ ${host} needs a key, but this machine is not signed in: run install here first.`);
      failed.push(host);
      continue;
    }
    let key, keyId;
    try { ({ key, keyId } = await connectWithKey(cfg.appOrigin(), have.key, name, () => {})); }
    catch (e) { log(`  ✗ couldn't mint a key for ${host}: ${e.message}`); failed.push(host); continue; }
    try { await overSsh(host, cli(["install", "--key", "-", ...extra]), { input: key + "\n" }); }
    catch (e) {
      log(`  ✗ ${host}: install didn't finish (${e.message}). Its key ${keyId} ("${name}") was made; revoke it in Settings → API keys before retrying.`);
      failed.push(host);
    }
  }
  log(`\n  ${hosts.length - failed.length - skipped} machine(s) ${opts.dryRun ? "previewed" : "connected"}, ${skipped} skipped${failed.length ? ` — failed: ${failed.join(", ")}` : ""}.\n`);
  if (failed.length) process.exitCode = 1;
}

async function status(opts, out, log) {
  const k = cfg.resolveKey();
  const rows = H.harnesses().filter((h) => h.present).map((h) => H.status(h));
  const skills = S.skillTargets().map((t) => {
    if (t.skip) return { harness: t.harness, note: t.skip };
    let text = null;
    try { text = fs.readFileSync(t.file, "utf8"); } catch (_) {}
    return { harness: t.harness, file: t.shown, version: text && text.includes(S.MARK) ? S.versionOf(text) : null };
  });
  if (opts.json) {
    let valid = false, keyError = null;
    if (k) {
      try { await checkKey(k.key); valid = true; }
      catch (e) {
        // An outage is not permission to overwrite a potentially working key.
        if (e.code !== "EAUTH") throw e;
        keyError = e.message;
      }
    }
    return out({ signed_in: !!k, key_valid: valid, key_error: keyError, machine: machineName({}), key_prefix: k ? k.key.slice(0, 8) : null, harnesses: rows, skills });
  }
  log(`\n  This machine: ${k ? `signed in (${k.key.slice(0, 8)}…)` : "not signed in — run `npx -y spacesheep@latest install`"}\n`);
  const w = Math.max(12, ...rows.map((r) => r.harness.length));
  for (const r of rows) {
    const bridge = r.entries.find((e) => e.via === "bridge");
    const remote = r.entries.filter((e) => e.via === "remote");
    const what = r.error ? `! ${r.error}`
      : bridge && !bridge.ok ? `! runs ${bridge.script}, which is gone — run install again`
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
  for (const r of [...results, ...skills]) if (r.action !== "unchanged") log(`    ${MARKS[r.action] || "·"} ${pad(r.harness, 14)}  ${pad(r.file || "", 34)}  ${r.error || r.action}`);
  log(`\n  ${dryRun ? "Would remove" : "Removed"} the bridge from ${results.filter((r) => r.action === "removed").length} harness(es). This machine's key stays (\`spacesheep logout\` forgets it).\n`);
}

module.exports = { run, status, uninstall, stableCommand, chosen, chosenSkills, ensureKey };
