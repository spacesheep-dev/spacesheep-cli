// `spacesheep skills lint [folder]`: a skill folder, or a skill repo, checked for its
// format the way Spacesheep checks it when it takes a release. No sign-in, no network.
//
// The rules are the published half of Spacesheep's own checker (lib/skill-check.gen.js,
// built from the app's shared/skill-format.ts by scripts/skill-check-bundle.mjs): nothing
// here re-implements one. Passing it means the folder is well-formed, never that it is
// accepted: what a skill declares it may ask for or do (spacesheep.yaml's scopes,
// triggers, tools and sends_to), and a review of what it holds, are checked by Spacesheep
// when it imports the release.
//
// A repo holds one skill, in a top-level folder named for it (`<name>/SKILL.md`), beside
// the repo's own files (README, LICENSE, .github/), which never enter a version. Given a
// repo, the check finds that folder; the refusals use the import's own words.
//
// Everything is read from one list of what a release would hold (`entries`): the folder
// that holds the skill is picked from it, and a symlink or a submodule in it is refused
// as the import refuses it, without reading what it points at.
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { checkSkillFormat, SKILL_FILE_NAMES, BUILT_FROM } = require("./skill-check.gen");

const SAID = {
  none: "No skill here: the repo needs one top-level folder with a SKILL.md.",
  several: (names) => `More than one skill here (${names.join(", ")}): a repo holds one skill.`,
  differ: (folder, name) => `The folder "${folder}" and the skill's name "${name}" differ: they must match.`,
  link: (rel) => `${rel} is a symlink: a skill holds its own files.`,
  submodule: (rel) => `${rel} is a submodule: a skill holds its own files.`,
};
const AT_IMPORT = "Spacesheep checks it again when it takes a release, with a review of what the skill holds that this lint doesn't do.";

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };

/** What each path is on disk, never following a link: "file", "link", "submodule" (a
 *  folder git lists as one entry: a submodule, or a repo inside the repo), or null. */
function kindOf(p) {
  let s;
  try { s = fs.lstatSync(p); } catch (_) { return null; }
  if (s.isSymbolicLink()) return "link";
  if (s.isDirectory()) return "submodule";
  return s.isFile() ? "file" : null;
}

/** What a release would hold under `dir`, as { path, kind }, paths relative and
 *  "/"-separated. In a git work tree, what a commit of it would hold (tracked files, and
 *  new ones git doesn't ignore), since a release is read from the commit; elsewhere every
 *  file under it. Links are listed, never followed. */
function listEntries(dir) {
  let paths;
  try {
    const out = execFileSync("git", ["-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    paths = [...new Set(out.split("\0").filter(Boolean).map((p) => p.replace(/\/$/, "")))];
  } catch (_) {
    paths = [];
    (function walk(rel) {
      for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (e.name !== ".git") walk(p); } else paths.push(p);
      }
    })("");
  }
  return paths.map((p) => ({ path: p, kind: kindOf(path.join(dir, p)) })).filter((e) => e.kind)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The skill folder in `entries` (listed at `dir`): `dir` itself when it holds a SKILL.md,
 *  else the one top-level folder of a repo that does, as the import picks it. */
function findSkill(dir, entries) {
  const names = SKILL_FILE_NAMES;
  if (entries.some((e) => names.includes(e.path))) return { dir, folder: path.basename(path.resolve(dir)), entries };
  const found = [...new Set(entries.filter((e) => /^[^/]+\/[^/]+$/.test(e.path) && names.includes(e.path.split("/")[1]))
    .map((e) => e.path.split("/")[0]))].sort();
  if (found.length === 0) return { refused: SAID.none };
  if (found.length > 1) return { refused: SAID.several(found) };
  const folder = found[0];
  const inside = entries.filter((e) => e.path.startsWith(`${folder}/`)).map((e) => ({ ...e, path: e.path.slice(folder.length + 1) }));
  return { dir: path.join(dir, folder), folder, entries: inside };
}

/** The check, as data: what `--json` prints. */
function lint(target) {
  if (!isDir(target)) throw new Error(`${target} isn't a folder`);
  const where = findSkill(target, listEntries(target));
  const base = { checker: BUILT_FROM, at_import: AT_IMPORT };
  const refuse = (folder, problems) => ({ ok: false, folder, name: null, hash: null, problems, warnings: [], spec_valid: false, spec_problems: [], declares: [], ...base });
  if (where.refused) return refuse(null, [where.refused]);
  const shown = path.relative(process.cwd(), where.dir) || ".";

  const odd = where.entries.filter((e) => e.kind !== "file").map((e) => SAID[e.kind](e.path));
  if (odd.length) return refuse(shown, odd);
  const files = where.entries.map((e) => ({ path: e.path, bytes: fs.readFileSync(path.join(where.dir, e.path)) }));
  const r = checkSkillFormat(files, { folder: where.folder });
  // The checker's own line for a name that isn't the folder's, in the import's words.
  const mismatch = `SKILL.md: Directory name '${where.folder}' must match skill name '`;
  const problems = r.problems.map((p) => (p.startsWith(mismatch) && p.endsWith("'") ? SAID.differ(where.folder, p.slice(mismatch.length, -1)) : p));
  const f = r.facts;
  return {
    ok: problems.length === 0,
    folder: shown,
    name: f ? f.name : null,
    hash: f ? f.hash : null,
    files: f ? f.files.length : files.length,
    bytes: files.reduce((n, x) => n + x.bytes.length, 0),
    problems,
    warnings: r.warnings,
    spec_valid: r.spec_valid,
    spec_problems: r.spec_problems,
    declares: r.declares,
    ...base,
  };
}

const kb = (n) => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(1)} KB`);

/** The check as lines for a person. */
function lines(c) {
  const out = [""];
  if (c.ok) out.push(`  ✓ ${c.name} is well-formed: ${c.files} file${c.files === 1 ? "" : "s"}, ${kb(c.bytes)}, hash ${c.hash.slice(0, 12)}`);
  else {
    out.push(`  ✗ ${c.folder ?? "This folder"} can't become a version: ${c.problems.length} problem${c.problems.length === 1 ? "" : "s"}`);
    for (const p of c.problems) out.push(`    - ${p}`);
  }
  for (const w of c.warnings) out.push(`  ! ${w}`);
  if (!c.spec_valid && c.spec_problems.length && c.ok) for (const s of c.spec_problems) out.push(`  ! Agent Skills spec: ${s}`);
  if (c.declares.length) out.push(`  · spacesheep.yaml declares ${c.declares.join(", ")}: Spacesheep checks what it may ask for when it takes a release.`);
  out.push(`  · ${c.at_import}`, "");
  return out.join("\n");
}

/** `spacesheep skills lint [folder]`: the exit code (0 well-formed, 1 not). */
function run(target, { json = false } = {}, write = (s) => process.stdout.write(s)) {
  const c = lint(target || ".");
  write(json ? JSON.stringify(c, null, 2) + "\n" : lines(c) + "\n");
  return c.ok ? 0 : 1;
}

module.exports = { lint, run, lines, findSkill, listEntries, SAID, AT_IMPORT };
