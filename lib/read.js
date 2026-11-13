// `spacesheep read`: a space's files, printed or written into a folder. A whole space
// read into a folder is that folder's base: it reads one named version (the newest),
// writes its files byte for byte, and saves its sha for the folder, so the next deploy
// from there merges with whatever landed since instead of being refused or replacing it.
//
// read_space returns every file as text, so a binary file (an image, a font) comes back
// damaged. Such a file is fetched whole with get_file where the server has it (up to
// 1 MB); a file still not exact stops the read before anything is written or saved. A
// folder half written with a base would be the worst case: a plain deploy uploads it.
"use strict";
const fs = require("fs");
const path = require("path");
const { saveBase } = require("./bases");
const { newestOf } = require("./deploy");

const DISCUSSION = /^--- discussion ---\n[\s\S]*?\n--- end of discussion ---\n\n/;
/** What a server's text decoding puts where bytes weren't UTF-8. */
const DAMAGED = Buffer.from("�", "utf-8");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** read_space's text as files. A whole space answers "--- path (N bytes) ---\n" then
 *  exactly N bytes per file, a blank line between; one path answers "--- path ---\n"
 *  and the rest. A version line or an editor's Discussion before them is not a file.
 *  `exact`: the bytes are the file's own (its size, and nothing a decoder replaced). */
function parseRead(text) {
  const buf = Buffer.from(text.replace(DISCUSSION, ""), "utf-8");
  // One character per byte, so a match's index is a byte offset.
  const s = buf.toString("latin1");
  const files = [];
  const sized = /^--- (.+?) \((\d+) bytes\) ---\n/gm;
  let m;
  while ((m = sized.exec(s))) {
    const start = m.index + m[0].length;
    const size = Number(m[2]);
    let end = start + size;
    const fits = end === s.length || (end < s.length && s.startsWith("\n\n--- ", end));
    // Not the size it says (a binary file read as text): up to the next file.
    if (!fits) {
      const next = s.indexOf("\n\n--- ", start);
      end = next < 0 ? s.length : next;
    }
    const content = buf.subarray(start, end);
    files.push({ path: Buffer.from(m[1], "latin1").toString("utf-8"), size, content, exact: fits && !content.includes(DAMAGED) });
    sized.lastIndex = end;
  }
  if (files.length) return files;
  const one = /^--- (.+?) ---\n/m.exec(s);
  if (one && !/ \(characters \d/.test(one[1])) {
    const content = buf.subarray(one.index + one[0].length);
    files.push({ path: Buffer.from(one[1], "latin1").toString("utf-8"), size: null, content, exact: !content.includes(DAMAGED) });
  }
  return files;
}

/** One file's exact bytes from get_file (a non-text file comes back as base64 `data`),
 *  or null: a server without the call, a file over its 1 MB, or bytes still not whole. */
async function wholeFile(client, space, f, version) {
  const args = { file: f.path };
  args[UUID.test(space) ? "space_id" : "space"] = space;
  if (version) args.version = version;
  const r = await client.call("get_file", args).catch(() => null);
  const got = r && typeof r === "object" && r.file;
  if (!got) return null;
  const bytes = typeof got.data === "string" ? Buffer.from(got.data, "base64")
    : typeof got.content === "string" ? Buffer.from(got.content, "utf-8") : null;
  if (!bytes || (f.size !== null && bytes.length !== f.size) || (typeof got.data !== "string" && bytes.includes(DAMAGED))) return null;
  return bytes;
}

/** Read `space` (or one `file` of it). With `dir`, every file is written there exactly
 *  and a whole read is saved as the folder's base, or nothing is. → { files, text, sha } */
async function read(client, space, { file, dir, log = () => {} } = {}) {
  // Viewers can't list versions (or read one by name): theirs is the plain read, no base.
  const newest = dir && !file ? await newestOf(client, space).catch(() => null) : null;
  const sha = newest && newest.sha;
  const args = { uuid: space };
  if (file) args.path = file;
  if (sha) args.version = sha;
  const r = await client.call("read_space", args);
  const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
  const files = parseRead(text);
  if (!dir) return { files, text, sha: null };
  if (!files.length) throw new Error(text);
  for (const f of files) {
    if (f.exact) continue;
    const bytes = await wholeFile(client, space, f, sha);
    if (bytes) Object.assign(f, { content: bytes, exact: true });
  }
  const bad = files.filter((f) => !f.exact).map((f) => f.path);
  if (bad.length) {
    const names = `${bad.slice(0, 5).join(", ")}${bad.length > 5 ? `, and ${bad.length - 5} more` : ""}`;
    throw new Error(`${names} can't be read byte for byte (read_space returns files as text, and this server can't send ${bad.length === 1 ? "it" : "them"} whole), so nothing was written to ${dir} and no version was saved for it.`);
  }
  for (const f of files) {
    const p = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
    log(`  ↓ ${f.path}`);
  }
  if (sha) {
    // Under the space's id as well as the name typed: a deploy from here may name it either
    // way (its pin holds the id and the link), and must build on what was just read.
    saveBase({ origin: client.url, space: [space, newest.uuid], dir }, sha);
    log(`  = version ${sha.slice(0, 12)}: a deploy from ${dir} --space ${space} builds on it, and merges what lands meanwhile`);
  }
  return { files, text, sha };
}

module.exports = { parseRead, read };
