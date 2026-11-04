// The generic door: `spacesheep <noun> <verb>` runs any call in the server's doors
// table, GET <SPACESHEEP_ORIGIN>/v1/doors.json. Each method's `cli` entry is the whole
// contract (command, usage, args, flags, replaces), so nothing here knows any one call.
//
//   table    fetched with no key, cached per origin in SPACESHEEP_CONFIG_DIR/doors/,
//            revalidated by ETag. A 404 (a server without /v1) is cached too, for
//            MISSING_TTL, and today's hand-written commands run unchanged.
//   command  `<noun> <verb>` from cli.command, or an old name in cli.replaces
//            (`talk reply <text> --to N` → talk-messages create --text … --reply-to N).
//   request  method `http`; `{a.b}` in `path` filled from the inputs (an id is left out
//            of the rest; a name stays in it too, so the server never has to guess which
//            it got); the rest in the query (`where: query`) or a JSON body, keyed by
//            input name as the server's codec takes them; Bearer <the saved key>.
//   answer   printed as text; --json prints the body as it came. An error is ErrorInfo
//            {code, message, violations}: on stderr, exit 1 (--json prints it). A wrong
//            command line exits 2 before any request.
//
// SPACESHEEP_DOORS_FILE reads the table from a file instead (a server branch's
// shared/doors.json, before its /v1/doors.json is up).
"use strict";

const fs = require("fs");
const path = require("path");

const MISSING_TTL = 10 * 60 * 1000;
const FETCH_TIMEOUT = 5000;
// One of today's commands asking for the table on a fresh config waits no longer than
// this, so a machine with no network runs it almost as soon as before.
const PROBE_TIMEOUT = 1500;

class UsageError extends Error {
  constructor(message, usage) { super(message); this.code = "EUSAGE"; this.usage = usage; }
}

// ---------------------------------------------------------------- the table

function cachePath(configDir, origin) {
  const name = String(origin).replace(/\/+$/, "").replace(/[^A-Za-z0-9.-]+/g, "_");
  return path.join(configDir, "doors", `${name}.json`);
}
function readCache(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function writeCache(file, entry) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch { /* a read-only config dir only costs the next call a full fetch */ }
}
const isTable = (t) => t && Array.isArray(t.services);

/** The table this origin serves, or null when it has none (404). Network trouble falls
 *  back on the cached copy; `offline` reads only the cache (help, and hand-written
 *  commands deciding whether the table names them). */
async function loadTable({ origin, configDir, fetchImpl = fetch, now = Date.now(), offline = false, timeout = FETCH_TIMEOUT, env = process.env }) {
  if (env.SPACESHEEP_DOORS_FILE) {
    const t = JSON.parse(fs.readFileSync(env.SPACESHEEP_DOORS_FILE, "utf8"));
    if (!isTable(t)) throw new Error(`${env.SPACESHEEP_DOORS_FILE} isn't a doors table (no services)`);
    return t;
  }
  const file = cachePath(configDir, origin);
  const cached = readCache(file);
  const table = cached && isTable(cached.table) ? cached.table : null;
  if (offline) return table;
  if (cached && cached.missing && now - (cached.fetched_at || 0) < MISSING_TTL) return null;
  const headers = { Accept: "application/json" };
  if (table && cached.etag) headers["If-None-Match"] = cached.etag;
  let resp;
  try {
    resp = await fetchImpl(`${String(origin).replace(/\/+$/, "")}/v1/doors.json`, { headers, signal: AbortSignal.timeout(timeout) });
  } catch { return table; }
  if (resp.status === 304 && table) return table;
  if (resp.status === 404) { writeCache(file, { origin, missing: true, fetched_at: now }); return null; }
  if (!resp.ok) return table;
  let fresh;
  try { fresh = JSON.parse(await resp.text()); } catch { return table; }
  if (!isTable(fresh)) return table;
  writeCache(file, { origin, etag: resp.headers.get("etag") || null, fetched_at: now, table: fresh });
  return fresh;
}

// ---------------------------------------------------------------- commands

const methodsOf = (table) => table.services.flatMap((s) => s.methods || []).filter((m) => m.cli && m.cli.command);
const words = (command) => command.replace(/^spacesheep\s+/, "").trim().split(/\s+/);

/** The command line's door: its method, how many words name it, and the old name it
 *  came in by (a `replaces` entry), if any. Longest name first: `talk listen` before `talk`. */
function match(table, argv) {
  const lead = [];
  for (const a of argv) { if (a.startsWith("-")) break; lead.push(a); if (lead.length === 2) break; }
  const ms = methodsOf(table);
  for (let n = lead.length; n >= 1; n--) {
    const key = lead.slice(0, n).join(" ");
    const m = ms.find((x) => words(x.cli.command).join(" ") === key);
    if (m) return { method: m, used: n, via: null };
    const old = ms.flatMap((x) => (x.cli.replaces || []).filter((r) => r.command && words(r.command).join(" ") === key).map((r) => ({ method: x, used: n, via: r })));
    if (old.length) return old;          // several: the one whose `when` is given (resolve() picks)
  }
  return null;
}
/** Does the table name this first word at all (a noun, or an old command's first word)? */
function namesWord(table, word) {
  return methodsOf(table).some((m) => words(m.cli.command)[0] === word || (m.cli.replaces || []).some((r) => r.command && words(r.command)[0] === word));
}
/** The table's commands under one noun. */
const verbsOf = (table, noun) => methodsOf(table).filter((m) => words(m.cli.command)[0] === noun);

// ---------------------------------------------------------------- the command line

const snake = (s) => s.replace(/-/g, "_");
const pair = (s) => { const i = s.indexOf("="); return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)]; };

function inputOf(method, name) {
  return (method.inputs || []).find((d) => d.name === name) || null;
}
const isList = (type) => /^list of /.test(type || "");
const isBool = (type) => type === "true or false";

/** One raw value (text from the command line) → what the server's codec takes. */
function convert(flag, type, raw, { json, secret }) {
  if (json) {
    if (raw !== null && typeof raw === "object") return raw;
    try { return JSON.parse(raw); } catch { throw new UsageError(`${flag} takes JSON (${type}); got ${secret ? "something else" : JSON.stringify(raw)}`); }
  }
  if (isBool(type)) {
    if (raw === true || raw === "true") return true;
    if (raw === false || raw === "false") return false;
    throw new UsageError(`${flag} takes true or false; got ${JSON.stringify(raw)}`);
  }
  if (type === "integer") {
    if (!/^-?\d+$/.test(String(raw).trim())) throw new UsageError(`${flag} takes a whole number; got ${JSON.stringify(raw)}`);
    return Number(raw);
  }
  if (type === "64-bit whole number") {
    if (!/^-?\d+$/.test(String(raw).trim())) throw new UsageError(`${flag} takes a whole number; got ${JSON.stringify(raw)}`);
    return String(raw).trim();       // protobuf JSON's own form for int64: a string, which every codec takes
  }
  if (type === "number") {
    const n = Number(raw);
    if (String(raw).trim() === "" || !Number.isFinite(n)) throw new UsageError(`${flag} takes a number; got ${JSON.stringify(raw)}`);
    return n;
  }
  if (type === "time" && /^\d+$/.test(String(raw))) return Number(raw);   // Unix ms, as today's tools took it
  const one = /^one of (.+)$/.exec(type || "");
  if (one) {
    const allowed = one[1].split(/,\s*/);
    const v = String(raw).toLowerCase();
    if (!allowed.includes(v)) throw new UsageError(`${flag} takes one of ${allowed.join(", ")}; got ${JSON.stringify(raw)}`);
    return v;
  }
  if (isList(type)) return String(raw).split(",").map((x) => x.trim()).filter(Boolean);
  return String(raw);
}

/** The command line after the command's words → the call's inputs, keyed by input name.
 *  Throws UsageError for anything the table doesn't take. `readStdin` serves `-` for a
 *  JSON or secret flag (a secret never sits on the command line). */
async function parseInputs(found, argv, { env = process.env, readStdin } = {}) {
  const { method, via } = found;
  const cli = method.cli;
  const usage = via ? `${via.command} → ${cli.usage}` : cli.usage;
  const byFlag = new Map((cli.flags || []).map((f) => [f.flag, f]));
  const byInput = new Map((cli.flags || []).map((f) => [f.input, f]));
  const renamed = new Map(((via && via.renamed) || []).map(pair));
  const global = { json: false, help: false, out: null };
  const raw = new Map();       // input name → [values]
  const positional = [];

  // An old command's flag or word → today's input name (`--to` → reply_to, word 1 → text).
  const target = (oldName) => (renamed.has(oldName) ? renamed.get(oldName) || null : snake(oldName));
  const specOf = (name, shown) => {
    const f = byInput.get(name);
    if (f) return { name, flag: f.flag, type: f.type, json: !!f.json, secret: !!f.secret };
    if (cli.args.includes(name) || (via && inputOf(method, name))) {
      const d = inputOf(method, name) || { type: "text" };
      return { name, flag: shown, type: d.type, json: !!d.json, secret: !!d.secret };
    }
    throw new UsageError(`${via ? via.command : cli.command} takes no ${shown}`, usage);
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (a === "--json") { global.json = true; continue; }
    if (a === "-h" || a === "--help") { global.help = true; continue; }
    if (a === "-o" || a === "--out") { global.out = argv[++i]; if (global.out === undefined) throw new UsageError(`${a} needs a file`, usage); continue; }
    if (!a.startsWith("--") || a === "-") { positional.push(a); continue; }
    const [flagName, inline] = a.includes("=") ? pair(a) : [a, undefined];
    let spec;
    if (!via) {
      const f = byFlag.get(flagName);
      if (!f) throw new UsageError(`${cli.command} takes no ${flagName}`, usage);
      spec = specOf(f.input, flagName);
    } else {
      const name = target(flagName.slice(2));
      if (name === null) { if (inline === undefined && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) i++; continue; }  // `action=`: dropped
      spec = specOf(name, flagName);
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (isBool(spec.type)) { if (next === "true" || next === "false") { value = next; i++; } else value = true; }
      else if (next === undefined || (next.startsWith("--") && next !== "--")) throw new UsageError(`${flagName} needs a value (${spec.type})`, usage);
      else { value = next; i++; }
    }
    if (!raw.has(spec.name)) raw.set(spec.name, { spec, values: [] });
    raw.get(spec.name).values.push(value);
  }
  if (global.help) return { help: true, global };

  // Words after the command: the table's args, in order; an old command's by number.
  // An old command's last word, when it is text, takes the words after it too, as
  // today's did (`talk reply all done` is the text "all done").
  let last = null;
  positional.forEach((w, i) => {
    let name;
    if (!via) {
      name = cli.args[i];
      if (!name) throw new UsageError(`${cli.command} takes ${cli.args.length ? `only <${cli.args.join("> <")}>` : "no words after it"}; got ${JSON.stringify(w)}`, usage);
    } else {
      name = target(String(i + 1));
      if (name === null) return;
      if (name === String(i + 1) && last && !last.spec.json && ["text", "Markdown", "a title"].includes(last.spec.type)) {
        last.values[last.values.length - 1] += ` ${w}`;
        return;
      }
      if (name === String(i + 1)) throw new UsageError(`${via.command} takes no word ${JSON.stringify(w)} here`, usage);
    }
    const spec = specOf(name, `<${name}>`);
    if (!raw.has(name)) raw.set(name, { spec, values: [] });
    raw.get(name).values.push(w);
    last = raw.get(name);
  });

  const inputs = {};
  for (const [name, { spec, values }] of raw) {
    const vals = [];
    for (const v of values) vals.push(v === "-" && (spec.json || spec.secret) && readStdin ? (await readStdin()).replace(/\r?\n$/, "") : v);
    if (isList(spec.type) && !spec.json) inputs[name] = vals.flatMap((v) => convert(spec.flag, spec.type, v, spec));
    else {
      if (vals.length > 1) throw new UsageError(`${spec.flag} given ${vals.length} times`, usage);
      inputs[name] = convert(spec.flag, spec.type, vals[0], spec);
    }
  }
  // An old command's fixed values (`talk on` sets enabled=true).
  for (const s of (via && via.set) || []) {
    const [name, v] = pair(s);
    const d = inputOf(method, name);
    inputs[name] = convert(name, d ? d.type : "text", v, { json: d && d.json });
  }
  // A session the flag leaves out: the harness's own (Claude Code, Codex).
  for (const f of cli.flags || []) {
    if (f.env && inputs[f.input] === undefined) {
      const v = f.env.map((k) => env[k]).find(Boolean);
      if (v) inputs[f.input] = convert(f.flag, f.type, v, f);
    }
  }
  // What must be there: required flags, the words, one of each name/id pair.
  for (const f of cli.flags || []) {
    if (f.required && inputs[f.input] === undefined) throw new UsageError(`${via ? via.command : cli.command} needs ${f.flag} <${f.type}>`, usage);
  }
  for (const a of cli.args) {
    const d = inputOf(method, a) || {};
    if ((d.required || d.either) && inputs[a] === undefined && !(d.either && (method.inputs || []).some((x) => x.either === d.either && inputs[x.name] !== undefined)))
      throw new UsageError(`${via ? via.command : cli.command} needs <${a}>`, usage);
  }
  const groups = [...new Set((cli.flags || []).filter((f) => f.either).map((f) => f.either))];
  for (const g of groups) {
    const members = cli.flags.filter((f) => f.either === g);
    if (!members.some((f) => inputs[f.input] !== undefined)) throw new UsageError(`${via ? via.command : cli.command} needs ${members.map((f) => f.flag).join(" or ")}`, usage);
  }
  return { inputs, global };
}

/** Several old-name matches (a `when` each): the one whose `when` input is given, else the one without. */
async function resolve(found, argv, opts) {
  if (!Array.isArray(found)) return { found, parsed: await parseInputs(found, argv, opts) };
  let fallback = null, lastErr = null;
  for (const f of found) {
    try {
      const parsed = await parseInputs(f, argv, opts);
      if (parsed.help) return { found: f, parsed };
      if (!f.via.when) { fallback = fallback || { found: f, parsed }; continue; }
      if (parsed.inputs[f.via.when] !== undefined) return { found: f, parsed };
    } catch (e) { lastErr = e; }
  }
  if (fallback) return fallback;
  throw lastErr || new UsageError(`${found[0].via.command}: none of its forms fit`);
}

// ---------------------------------------------------------------- the request

/** The input that fills a path variable: `{space.id}` takes `space_id`, else `space`
 *  (a name: `ref` says which); `{stream}` takes `stream`. */
function pathValue(method, variable, inputs) {
  const [head, part] = variable.split(".");
  const fits = (method.inputs || []).filter((d) => d.at && d.at[0] === head && (
    part ? (d.at.length === 1 ? !!d.ref : ["id", "name"].includes(d.at[1]) && !!d.ref) : d.at.length === 1));
  const given = fits.filter((d) => inputs[d.name] !== undefined);
  const pick = given.find((d) => d.ref === "id" || d.at[1] === "id") || given[0];
  return pick ? { name: pick.name, value: inputs[pick.name], ref: pick.ref || null } : null;
}

function buildRequest(method, inputs, { origin, key, version }) {
  const rest = { ...inputs };
  const filled = method.path.replace(/\{([^}]+)\}/g, (_, variable) => {
    const p = pathValue(method, variable, inputs);
    if (!p) throw new UsageError(`${method.cli.command} needs ${variable.split(".")[0]}`, method.cli.usage);
    if (p.ref !== "name") delete rest[p.name];     // a name goes as its own input too (team=<name>)
    return encodeURIComponent(String(p.value));
  });
  let url = `${String(origin).replace(/\/+$/, "")}${filled}`;
  const headers = { Accept: "application/json", "User-Agent": `spacesheep-cli/${version}` };
  if (key) headers.Authorization = `Bearer ${key}`;
  let body;
  if (method.where === "query") {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(rest)) {
      for (const one of Array.isArray(v) ? v : [v]) q.append(k, one !== null && typeof one === "object" ? JSON.stringify(one) : String(one));
    }
    const s = q.toString();
    if (s) url += `?${s}`;
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(rest);
  }
  return { method: method.http, url, headers, body };
}

// ---------------------------------------------------------------- the answer

/** ErrorInfo from an error body: top level, or under `error`. Anything else gets one. */
function errorInfo(status, text) {
  let b = null;
  try { b = JSON.parse(text); } catch {}
  const e = b && typeof b === "object" ? (b.error && typeof b.error === "object" ? b.error : b) : null;
  if (e && (e.code || e.message)) return { code: e.code || `http_${status}`, message: e.message || `the server answered ${status}`, violations: e.violations || [] };
  return { code: `http_${status}`, message: `the server answered ${status}${text ? `: ${String(text).slice(0, 300)}` : ""}`, violations: [] };
}

/** An answer as text: `key: value` lines, nested by two spaces, lists as `- `. */
function plain(v, indent = "") {
  if (v === null || v === undefined) return [];
  if (typeof v !== "object") return [`${indent}${v}`];
  const out = [];
  const scalar = (x) => x === null || typeof x !== "object";
  if (Array.isArray(v)) {
    for (const x of v) {
      if (scalar(x)) { out.push(`${indent}- ${x}`); continue; }
      const lines = plain(x, indent + "  ");
      if (lines.length) out.push(`${indent}- ${lines[0].slice(indent.length + 2)}`, ...lines.slice(1));
      else out.push(`${indent}- {}`);
    }
    return out;
  }
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined || x === "" || (Array.isArray(x) && !x.length) || (x && typeof x === "object" && !Array.isArray(x) && !Object.keys(x).length)) continue;
    if (scalar(x)) out.push(`${indent}${k}: ${x}`);
    else if (Array.isArray(x) && x.every(scalar)) out.push(`${indent}${k}: ${x.join(", ")}`);
    else {
      const lines = plain(x, indent + "  ");
      if (lines.length) out.push(`${indent}${k}:`, ...lines);   // `page: {next: ""}` on the last page: nothing to show
    }
  }
  return out;
}

/** Bytes at the top of an answer (a screenshot, a photo): to -o, never onto the terminal. */
function takeBytes(method, answer, outFile, writeFile) {
  const ab = method.answer_bytes;
  if (!ab || !answer || typeof answer[ab.field] !== "string") return null;
  const bytes = Buffer.from(answer[ab.field], "base64");
  const shown = { ...answer, [ab.field]: outFile ? `${bytes.length} bytes → ${outFile}` : `${bytes.length} bytes (-o FILE writes them)` };
  if (outFile) writeFile(outFile, bytes);
  return shown;
}

// ---------------------------------------------------------------- help

function helpFor(found) {
  const { method, via } = found;
  const cli = method.cli;
  const lines = [`\n  ${cli.usage}`];
  if (via) lines.push(`  (${via.command} runs this)`);
  if (method.doc) lines.push(`\n  ${method.doc}`);
  if (cli.args.length) {
    lines.push("");
    for (const a of cli.args) { const d = inputOf(method, a) || {}; lines.push(`    ${`<${a}>`.padEnd(26)} ${d.doc || ""}${d.type ? ` (${d.type})` : ""}`); }
  }
  if ((cli.flags || []).length) {
    lines.push("\n  flags");
    for (const f of cli.flags) {
      const left = `${f.flag}${isBool(f.type) ? "" : ` <${f.json ? "json" : f.type.replace(/^one of .*/, "word")}>`}`;
      const notes = [f.required ? "required" : null, f.either ? `or its ${f.either} pair` : null, ...(f.limits || []), /^one of /.test(f.type) ? f.type : null, f.secret ? "- reads stdin" : null, f.env ? `from $${f.env[0]} when left out` : null].filter(Boolean);
      lines.push(`    ${left.padEnd(26)} ${f.doc || ""}${notes.length ? ` (${notes.join("; ")})` : ""}`);
    }
  }
  lines.push(`    ${"--json".padEnd(26)} print the server's answer as it came`);
  if (method.answer_bytes) lines.push(`    ${"-o, --out <file>".padEnd(26)} write the answer's bytes to a file`);
  return lines.join("\n") + "\n\n";
}
function nounHelp(table, noun) {
  const ms = verbsOf(table, noun);
  if (!ms.length) return null;
  const w = Math.max(...ms.map((m) => m.cli.usage.length), 20);
  return `\n  spacesheep ${noun} <verb>\n\n` + ms.map((m) => `    ${m.cli.usage.padEnd(Math.min(w, 60))}  ${(m.doc || "").split(/(?<=\.)\s/)[0]}`).join("\n") + "\n\n";
}
/** The table's nouns, one line each, for the top-level --help. */
function tableHelp(table, origin) {
  const nouns = new Map();
  for (const m of methodsOf(table)) { const [n, v] = words(m.cli.command); if (!nouns.has(n)) nouns.set(n, []); nouns.get(n).push(v); }
  const lines = [...nouns].sort(([a], [b]) => a.localeCompare(b)).map(([n, vs]) => `    spacesheep ${n.padEnd(22)} ${vs.join(", ")}`);
  return `\n  From the server (${origin}/v1/doors.json): spacesheep <noun> <verb> [--help]\n${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------- run

/** Run one door command line. Resolves the exit code; never calls process.exit. */
async function run(found, argv, ctx) {
  const { out, err, fetchImpl = fetch, env = process.env } = ctx;
  let parsed, chosen;
  try {
    ({ found: chosen, parsed } = await resolve(found, argv, { env, readStdin: ctx.readStdin }));
  } catch (e) {
    if (e.code !== "EUSAGE") throw e;
    err(`\n  ✗ ${e.message}${e.usage ? `\n    usage: ${e.usage}` : ""}\n    (--help for its flags)\n`);
    return 2;
  }
  if (parsed.help) { out(helpFor(chosen).replace(/\n$/, "")); return 0; }
  const { method } = chosen;
  const key = ctx.key();
  if (!key) { err("\n  ✗ not signed in — run `spacesheep login` (or set SPACESHEEP_KEY)\n"); return 3; }
  let req;
  try { req = buildRequest(method, parsed.inputs, { origin: ctx.origin, key, version: ctx.version }); }
  catch (e) { if (e.code !== "EUSAGE") throw e; err(`\n  ✗ ${e.message}\n`); return 2; }
  let resp, text;
  try {
    resp = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body });
    text = await resp.text();
  } catch (e) {
    err(`\n  ✗ couldn't reach ${ctx.origin}: ${e.message}\n`);
    return 1;
  }
  if (!resp.ok) {
    const info = errorInfo(resp.status, text);
    if (parsed.global.json) out(JSON.stringify(info, null, 2));
    else {
      // A message that is its one violation already ("files.0.size: takes a whole number") isn't said twice.
      const v = (info.violations || []).map((x) => `${x.field}: ${x.message}`)
        .filter((line, i) => line !== info.message && info.violations[i].message !== info.message)
        .map((line) => `\n    ${line}`).join("");
      err(`\n  ✗ ${info.message}${v}\n`);
    }
    return 1;
  }
  if (parsed.global.json) { if (text) out(text.replace(/\n$/, "")); return 0; }
  if (!text) return 0;
  let answer;
  try { answer = JSON.parse(text); } catch { out(text.replace(/\n$/, "")); return 0; }
  const shown = takeBytes(method, answer, parsed.global.out, ctx.writeFile || fs.writeFileSync) || answer;
  const lines = plain(shown);
  if (lines.length) out(lines.join("\n"));
  else err("  ✓ done");
  return 0;
}

module.exports = {
  MISSING_TTL, PROBE_TIMEOUT, UsageError, cachePath, loadTable, match, namesWord, verbsOf, parseInputs, resolve,
  pathValue, buildRequest, errorInfo, plain, takeBytes, helpFor, nounHelp, tableHelp, run,
};
