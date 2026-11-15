// `spacesheep skills pull <skill> [dir]`: a skill's files from the library, written to a folder, so a
// coding agent can follow its SKILL.md. GetSkill (the table's `skills get`) is the only read of the skill: view full
// for the file list, then a call a file, and a call a part past 40,000 code points. It writes only into a new or
// empty folder.
const fs = require("fs");
const path = require("path");
const { refusalWords } = require("./doors");

/** A path from the server, refused when it could land outside the folder. */
function safe(p) {
  if (!p || path.isAbsolute(p) || p.includes("\\") || p.split("/").includes("..")) throw new Error(`refused ${JSON.stringify(p)}: not a path inside the folder`);
  return p;
}

/** `call(command, inputs)` runs one of the table's commands (newCall): { answer } or { error }, or null without it. */
async function run(opts, call, out) {
  const [skill, given] = opts._.slice(2);
  if (!skill) throw new Error("usage: spacesheep skills pull <skill> [dir] [--version N] [--json]");
  if (opts.version !== undefined && !/^[1-9]\d*$/.test(opts.version)) throw new Error("--version takes a version number: --version 2");
  const ask = async (command, inputs) => {
    const r = await call(command, inputs);
    if (!r) throw new Error(`this server's commands have no \`${command}\``);
    if (r.error) throw new Error(refusalWords(r.error, { word: true }));
    return r.answer;
  };
  let version = Number(opts.version) || 0;
  const read = async (inputs) => {
    const a = await ask("skills get", { skill, ...(version ? { version } : {}), ...inputs });
    if (a.withheld) throw new Error(`${skill} is withheld: someone else wrote it, so only its card can be read`);
    return a;
  };
  // Without --version, one version for every call, as the server picks it for a read that names none: your active
  // install's pin, else the latest approved (the card's). Asking again a part could join two versions' bytes.
  if (!version) {
    const card = (await read({})).skill;
    let after;
    do {
      const page = await ask("installs list", { limit: 200, ...(after ? { after } : {}) });
      version = (page.installs || []).find((i) => i.state === "active" && i.skill?.name === card.name)?.pinned?.number || 0;
      after = page.page?.next;
    } while (!version && after);
    version = version || card.version?.number || 0;
    if (!version) throw new Error(`${skill} has no version you can read`);
  }
  const full = await read({ view: "full" });
  const files = (full.files || []).map(safe);
  const dir = given || `./${full.skill.name.split("/").pop()}`;
  // Every folder under a new or empty one is one this pull made, so no link in it can send a write elsewhere.
  // Resolved first: `link/` (a trailing slash) would lstat the link's target, not the link.
  const root = path.resolve(dir);
  const st = fs.lstatSync(root, { throwIfNoEntry: false });
  if (st && (!st.isDirectory() || fs.readdirSync(root).length)) throw new Error(`pull writes into a new or empty folder: ${dir} ${st.isSymbolicLink() ? "is a link" : st.isDirectory() ? "has files in it" : "is a file"}`);
  const wrote = [];
  for (const p of files) {
    const parts = [];
    let offset = 0, before;
    do {
      before = offset;
      const { file = {}, next_offset } = await read({ path: p, offset });
      parts.push(file.data !== undefined ? Buffer.from(file.data, "base64") : Buffer.from(file.text || "", "utf8"));
      offset = next_offset || 0;
    } while (offset > before);
    const bytes = Buffer.concat(parts);
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), bytes, { flag: "wx" });
    wrote.push({ path: p, bytes: bytes.length });
    if (!opts.json) out(`  ✓ ${p}  ${bytes.length} bytes`);
  }
  if (opts.json) return out({ dir, skill: full.skill.name, version, files: wrote });
  out(`Follow ${path.join(dir, "SKILL.md")} (${full.skill.name} v${version})`);
}

module.exports = { run, safe };
