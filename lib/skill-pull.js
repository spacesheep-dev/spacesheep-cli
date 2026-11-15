// `spacesheep skills pull <skill> [dir]`: a skill's files from the library, written to a folder, so a
// coding agent can follow its SKILL.md. GetSkill (the table's `skills get`) is the only read: view full
// for the file list, then a call a file, and a call a part past 40,000 code points. A file already in
// the folder is overwritten; nothing else in it is touched.
const fs = require("fs");
const path = require("path");
const { refusalWords } = require("./doors");

/** A path from the server, refused when it could land outside the folder. */
function safe(p) {
  if (!p || path.isAbsolute(p) || p.includes("\\") || p.split("/").includes("..")) throw new Error(`refused ${JSON.stringify(p)}: not a path inside the folder`);
  return p;
}

/** `get(inputs)` is the table's `skills get` (newCall): { answer } or { error }, or null without one. */
async function run(opts, get, out) {
  const [skill, given] = opts._.slice(2);
  if (!skill) throw new Error("usage: spacesheep skills pull <skill> [dir] [--version N] [--json]");
  if (opts.version !== undefined && !/^[1-9]\d*$/.test(opts.version)) throw new Error("--version takes a version number: --version 2");
  // Without --version no call names one, so the server reads the same version (the install's pin, else the latest) for each.
  const ask = async (inputs) => {
    const r = await get({ skill, ...(opts.version ? { version: Number(opts.version) } : {}), ...inputs });
    if (!r) throw new Error("this server's commands have no `skills get`");
    if (r.error) throw new Error(refusalWords(r.error, { word: true }));
    if (r.answer.withheld) throw new Error(`${skill} is withheld: someone else wrote it, so only its card can be read`);
    return r.answer;
  };
  const full = await ask({ view: "full" });
  const files = (full.files || []).map(safe);
  const dir = given || `./${full.skill.name.split("/").pop()}`;
  const version = Number(opts.version) || (full.skill.version || {}).number;
  const wrote = [];
  for (const p of files) {
    const parts = [];
    let offset = 0, before;
    do {
      before = offset;
      const { file = {}, next_offset } = await ask({ path: p, offset });
      parts.push(file.data !== undefined ? Buffer.from(file.data, "base64") : Buffer.from(file.text || "", "utf8"));
      offset = next_offset || 0;
    } while (offset > before);
    const bytes = Buffer.concat(parts);
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), bytes);
    wrote.push({ path: p, bytes: bytes.length });
    if (!opts.json) out(`  ✓ ${p}  ${bytes.length} bytes`);
  }
  if (opts.json) return out({ dir, skill: full.skill.name, version, files: wrote });
  out(`Follow ${path.join(dir, "SKILL.md")} (${full.skill.name} v${version})`);
}

module.exports = { run, safe };
