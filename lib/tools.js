// Every MCP tool from a shell, and deleting a space. The named commands cover the
// everyday jobs; `tools` and `call` reach everything else the server offers, so an
// agent working through the CLI (a cloud session, a box with no MCP connection) is
// never a release behind the server's tool list. 2026-10-11: an agent on Claude Code
// on the web published an empty space by accident and told its person "The CLI
// can't delete spaces" — the server could; the CLI had no way to ask it.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

/** `call`'s arguments: one JSON object, or any number of key=value (a string) and
 *  key:=json (a number, boolean, list or object) words. */
function callArgs(words) {
  if (!words.length) return {};
  if (words.length === 1 && /^\s*\{/.test(words[0])) {
    let v;
    try { v = JSON.parse(words[0]); } catch (e) { throw new Error(`the arguments aren't valid JSON: ${e.message}`); }
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("the arguments must be one JSON object");
    return v;
  }
  const args = {};
  for (const w of words) {
    const m = /^([A-Za-z_][\w.-]*)(:?=)([\s\S]*)$/.exec(w);
    if (!m) throw new Error(`"${w}" isn't key=value, key:=json or one JSON object`);
    const [, key, op, raw] = m;
    if (op === "=") { args[key] = raw; continue; }
    try { args[key] = JSON.parse(raw); } catch (e) { throw new Error(`${key}:= takes JSON (${e.message})`); }
  }
  return args;
}

/** The whole of stdin, for `call <tool> -`: a deploy's files can be far over any cap. */
function readAll(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (d) => { buf += d; });
    stream.on("end", () => resolve(buf));
    stream.on("error", reject);
  });
}

const EXT = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg",
  "audio/wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg", "application/pdf": "pdf",
};
const safeName = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40) || "tool";

/** A tool's result as a terminal can carry it: text as it came (JSON pretty-printed),
 *  and every picture or sound written to a file whose path is printed instead — an
 *  agent can open the file (a `screenshot` is how a CLI publish gets its visual check). */
function render(name, result, opts = {}) {
  const lines = [];
  const content = [];
  let dir = null;
  let n = 0;
  for (const b of result.content || []) {
    if ((b.type === "image" || b.type === "audio") && typeof b.data === "string") {
      if (!dir) {
        dir = opts.out || fs.mkdtempSync(path.join(os.tmpdir(), `spacesheep-${safeName(name)}-`));
        fs.mkdirSync(dir, { recursive: true });
      }
      const file = path.join(dir, `${safeName(name)}-${++n}.${EXT[b.mimeType] || "bin"}`);
      fs.writeFileSync(file, Buffer.from(b.data, "base64"));
      content.push({ type: b.type, mimeType: b.mimeType, file });
      lines.push(`${b.type === "image" ? "picture" : "audio"}: ${file}`);
    } else {
      content.push(b);
      if (b.type === "text") lines.push(pretty(b.text));
      else lines.push(JSON.stringify(b, null, 2));
    }
  }
  return { text: lines.join("\n"), json: { ...result, content } };
}

function pretty(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

/** Plain words for what a tool does to the account, from its own annotations. */
function effect(t) {
  const a = t.annotations || {};
  if (a.readOnlyHint) return "reads";
  if (a.destructiveHint) return "destructive";
  return "changes";
}

/** One line per tool for `spacesheep tools`. */
function toolLine(t) {
  const first = String(t.description || "").replace(/\s+/g, " ").split(/(?<=[.!?])\s/)[0];
  return `${t.name.padEnd(24)} ${effect(t).padEnd(11)} ${first.length > 100 ? first.slice(0, 99) + "…" : first}`;
}

function typeOf(p) {
  if (!p || typeof p !== "object") return "any";
  if (Array.isArray(p.enum)) return p.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (p.type === "array") return `${typeOf(p.items)}[]`;
  if (p.type) return Array.isArray(p.type) ? p.type.join(" | ") : p.type;
  const alts = p.anyOf || p.oneOf;
  if (Array.isArray(alts)) return alts.map(typeOf).join(" | ");
  return "any";
}

/** `spacesheep tools <name>`: what it does, every argument, and a line to run it. */
function toolHelp(t) {
  const schema = t.inputSchema || {};
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const out = [`${t.name} (${effect(t)})`, "", String(t.description || "").trim(), ""];
  const names = Object.keys(props);
  if (!names.length) out.push("No arguments.");
  else {
    out.push("Arguments:");
    for (const k of names) {
      const p = props[k] || {};
      out.push(`  ${k}${required.has(k) ? "" : "?"}: ${typeOf(p)}${p.description ? ` — ${String(p.description).replace(/\s+/g, " ")}` : ""}`);
    }
  }
  const example = names.filter((k) => required.has(k)).map((k) => {
    const ty = (props[k] || {}).type;
    return ty === "string" || ty === undefined ? `${k}=…` : `${k}:=…`;
  });
  out.push("", `Run: spacesheep call ${t.name}${example.length ? " " + example.join(" ") : ""}`);
  return out.join("\n");
}

/** Take the deleted space's pin out of a folder's .spacesheep.json, so the folder's
 *  next deploy makes a new space instead of failing on one that's gone. Keeps any
 *  other defaults the file holds; removes it when nothing is left. True if it changed. */
function unpin(dir, uuid) {
  const file = path.join(dir, ".spacesheep.json");
  let m;
  try { m = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return false; }
  if (!m || m.space !== uuid) return false;
  delete m.space; delete m.url; delete m.page_title;
  if (Object.keys(m).length) fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
  else fs.unlinkSync(file);
  return true;
}

/** `spacesheep delete <space>`: the server's delete_space, which only the owner may
 *  run. Answers the deleted space's uuid. */
async function deleteSpace(client, space) {
  const r = await client.call("delete_space", { uuid: space });
  const text = typeof r === "string" ? r : JSON.stringify(r);
  // Servers before 2026-10-12 answered "Space not found." and "Only the owner…" as
  // plain text rather than as errors; anything but the receipt is a refusal.
  const m = /^Deleted space ([0-9a-f-]{36})/i.exec(text);
  if (!m) { const e = new Error(text); e.code = "ETOOL"; throw e; }
  return { uuid: m[1], message: text };
}

module.exports = { callArgs, readAll, render, toolLine, toolHelp, unpin, deleteSpace };
