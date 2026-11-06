// `spacesheep read`: a space's files, printed or written into a folder. A whole space
// read into a folder is that folder's base: it reads one named version (the newest),
// writes its files byte for byte, and saves its sha for the folder, so the next deploy
// from there merges with whatever landed since instead of being refused or replacing it.
"use strict";
const fs = require("fs");
const path = require("path");
const { saveBase } = require("./bases");
const { newestVersion } = require("./deploy");

const DISCUSSION = /^--- discussion ---\n[\s\S]*?\n--- end of discussion ---\n\n/;

/** read_space's text as files. A whole space answers "--- path (N bytes) ---\n" then
 *  exactly N bytes per file, a blank line between; one path answers "--- path ---\n"
 *  and the rest. A version line or an editor's Discussion before them is not a file. */
function parseRead(text) {
  const buf = Buffer.from(text.replace(DISCUSSION, ""), "utf-8");
  // One character per byte, so a match's index is a byte offset.
  const s = buf.toString("latin1");
  const files = [];
  const sized = /^--- (.+?) \((\d+) bytes\) ---\n/gm;
  let m;
  while ((m = sized.exec(s))) {
    const start = m.index + m[0].length;
    let end = start + Number(m[2]);
    // Not the size it says (a binary file read as text): up to the next file.
    if (!(end === s.length || (end < s.length && s.startsWith("\n\n--- ", end)))) {
      const next = s.indexOf("\n\n--- ", start);
      end = next < 0 ? s.length : next;
    }
    files.push({ path: Buffer.from(m[1], "latin1").toString("utf-8"), content: buf.subarray(start, end) });
    sized.lastIndex = end;
  }
  if (files.length) return files;
  const one = /^--- (.+?) ---\n/m.exec(s);
  if (one && !/ \(characters \d/.test(one[1])) files.push({ path: Buffer.from(one[1], "latin1").toString("utf-8"), content: buf.subarray(one.index + one[0].length) });
  return files;
}

/** Read `space` (or one `file` of it). With `dir`, the files are written there and a
 *  whole read is saved as the folder's base. → { files, text, sha } */
async function read(client, space, { file, dir, log = () => {} } = {}) {
  // Viewers can't list versions (or read one by name): theirs is the plain read, no base.
  const sha = dir && !file ? await newestVersion(client, space).catch(() => null) : null;
  const args = { uuid: space };
  if (file) args.path = file;
  if (sha) args.version = sha;
  const r = await client.call("read_space", args);
  const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
  const files = parseRead(text);
  if (!dir) return { files, text, sha: null };
  if (!files.length) throw new Error(text);
  for (const f of files) {
    const p = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
    log(`  ↓ ${f.path}`);
  }
  if (sha) {
    saveBase({ origin: client.url, space, dir }, sha);
    log(`  = version ${sha.slice(0, 12)}: a deploy from ${dir} --space ${space} builds on it, and merges what lands meanwhile`);
  }
  return { files, text, sha };
}

module.exports = { parseRead, read };
