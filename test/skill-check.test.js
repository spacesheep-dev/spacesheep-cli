"use strict";
// `spacesheep skills check`: the published half of Spacesheep's skill checker
// (lib/skill-check.gen.js), a folder or a repo read from disk, and the import's words for
// the three ways a repo can't hold a skill.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync, spawn } = require("child_process");
const { check, run, SAID } = require("../lib/skill-check");

const GEN = path.join(__dirname, "..", "lib", "skill-check.gen.js");
const BIN = path.join(__dirname, "..", "bin", "spacesheep.js");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ss-skill-"));

const SKILL_MD = (name = "my-skill") =>
  `---\nname: ${name}\ndescription: Says hello. Use when someone asks for a hello.\n---\n\n# Hello\n\nSay hello. See [the example](references/example.md).\n`;

/** Files under a new folder: { "a/b.md": "text" }. */
function write(files, root = tmp()) {
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), text);
  }
  return root;
}
const skill = (name = "my-skill") => ({ [`${name}/SKILL.md`]: SKILL_MD(name), [`${name}/references/example.md`]: "Hello.\n" });

/** sha256sum's lines over the files, sorted by path: the version hash, worked out here. */
function hashOf(dir) {
  const walk = (rel) => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name]);
  const lines = walk("").sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((p) => `${crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, p))).digest("hex")}  ${p}\n`).join("");
  return crypto.createHash("sha256").update(lines).digest("hex");
}

test("the published file holds the format and none of the server's rules about what a skill may ask for or do", () => {
  const text = fs.readFileSync(GEN, "utf8");
  // Functions and lists of shared/skill-package.ts, skill-scopes.ts, outside-host.ts and
  // packages/app/src/skills-slice.ts, and words only they say.
  const forbidden = [
    "checkSkillFolder", "checkCeiling", "parseScope", "parseHost", "parseHosts", "cronProblem",
    "readTrigger", "readTools", "sliceProblems", "SKILL_SCOPES", "LEGACY_SETS", "TEAM_NEVER", "INTEGRATION_IDS",
    "SPACESHEEP_DOMAINS", "SPECIAL_USE_NAMES", "SKILL_TRIGGER_EVENTS", "SCHEDULE_SCOPE", "NOT_TONIGHT",
    "not in tonight's slice", "bad_host", "builtin tools are for official skills only", "spaces.read.private",
    "form.answered", "spacesheep.app",
  ];
  assert.deepStrictEqual(forbidden.filter((w) => text.includes(w)), []);
  // Nor any folder of the machine that built it: every path in it is relative.
  assert.doesNotMatch(text, /(^|[\s'"(])\/(Users|home|var|private|tmp|root)\//m);
  assert.deepStrictEqual([...new Set([...text.matchAll(/^\/\/ ((?:node_modules\/)?[a-z]+)\//gm)].map((m) => m[1]))].sort(), ["node_modules/yaml", "shared"]);
  const header = text.slice(0, text.indexOf("/* eslint-disable */"));
  assert.deepStrictEqual([...header.matchAll(/^\/\/ {3}(shared\/\S+|packages\/\S+)$/gm)].map((m) => m[1]), ["shared/skill-files.ts", "shared/skill-format.ts"]);
  const { BUILT_FROM } = require("../lib/skill-check.gen");
  assert.deepStrictEqual(BUILT_FROM.files, ["shared/skill-files.ts", "shared/skill-format.ts"]);
  assert.match(BUILT_FROM.commit, /^[0-9a-f]{40}$/);
});

test("the published file is the one the app's repo builds (where a checkout of it sits beside this one)", async (t) => {
  const { build, corePath, OUT } = await import("../scripts/skill-check-bundle.mjs");
  const core = corePath([], process.env);
  const rev = process.env.SPACESHEEP_CORE_REV || "origin/main";
  let has = false;
  try { execFileSync("git", ["-C", core, "cat-file", "-e", `${rev}:shared/skill-format.ts`], { stdio: "ignore" }); has = true; } catch (_) { /* no checkout, or not there yet */ }
  if (!has) return t.skip(`no app repo at ${core} with shared/skill-format.ts at ${rev} (set SPACESHEEP_CORE, SPACESHEEP_CORE_REV)`);
  assert.strictEqual(fs.readFileSync(OUT, "utf8"), await build(core, rev), "stale: run node scripts/skill-check-bundle.mjs");
});

test("a well-formed folder passes, with the hash worked out the same way here", () => {
  const root = write(skill());
  const c = check(path.join(root, "my-skill"));
  assert.strictEqual(c.ok, true, c.problems.join("; "));
  assert.strictEqual(c.name, "my-skill");
  assert.strictEqual(c.files, 2);
  assert.strictEqual(c.hash, hashOf(path.join(root, "my-skill")));
  assert.deepStrictEqual(c.declares, []);
});

test("a repo: the one top-level skill folder is checked, and the repo's own files never enter it", () => {
  const root = write({
    ...skill(),
    "README.md": "# My skill\n", "CHANGELOG.md": "## v1.0.0\n", "LICENSE": "MIT\n",
    ".github/workflows/check.yml": "on: pull_request\n", "notes/todo.txt": "later\n",
  });
  const c = check(root);
  assert.strictEqual(c.ok, true, c.problems.join("; "));
  assert.strictEqual(c.folder, path.relative(process.cwd(), path.join(root, "my-skill")));
  assert.strictEqual(c.hash, check(path.join(root, "my-skill")).hash);
});

test("the three refusals are the import's words, and refuse", () => {
  const none = check(write({ "README.md": "# Nothing\n", "docs/a.md": "a\n" }));
  assert.deepStrictEqual([none.ok, none.problems], [false, [SAID.none]]);
  assert.strictEqual(SAID.none, "No skill here: the repo needs one top-level folder with a SKILL.md.");

  const several = check(write({ ...skill("bravo"), ...skill("alpha") }));
  assert.deepStrictEqual(several.problems, ["More than one skill here (alpha, bravo): a repo holds one skill."]);

  const root = write({ "my-skill/SKILL.md": SKILL_MD("other-name") });
  assert.deepStrictEqual(check(root).problems, ['The folder "my-skill" and the skill\'s name "other-name" differ: they must match.']);
  let said = "";
  assert.strictEqual(run(root, {}, (s) => { said += s; }), 1);
  assert.match(said, /can't become a version: 1 problem\n {4}- The folder "my-skill"/);
});

test("the checker's own problems come through as it says them", () => {
  const c = check(write({ ...skill(), "my-skill/tool.exe": "MZ" }));
  assert.strictEqual(c.ok, false);
  assert.deepStrictEqual(c.problems, ["bad_path: tool.exe: this kind of file isn't accepted in a skill"]);
});

test("what spacesheep.yaml declares it may ask for is taken, and left to Spacesheep", () => {
  const root = write({ ...skill(), "my-skill/spacesheep.yaml": "title: Hello\nscopes:\n  any.scope: why\nsends_to:\n  - example.com\n" });
  const c = check(root);
  assert.strictEqual(c.ok, true, c.problems.join("; "));
  assert.deepStrictEqual(c.declares, ["scopes", "sends_to"]);
  let said = "";
  run(root, {}, (s) => { said += s; });
  assert.match(said, /declares scopes, sends_to: Spacesheep checks what it may ask for when it takes a release/);
  assert.match(said, /checks it again when it takes a release/);
});

test("in a git repo, files git ignores aren't checked: a release is read from the commit", () => {
  const root = write({ ...skill(), ".gitignore": ".DS_Store\n", "my-skill/.DS_Store": "junk" });
  execFileSync("git", ["init", "-q", root]);
  assert.strictEqual(check(root).ok, true);
  // Outside git, every file is read, as it would be uploaded.
  fs.rmSync(path.join(root, ".git"), { recursive: true });
  assert.deepStrictEqual(check(root).problems, ["bad_path: .DS_Store: this kind of file isn't accepted in a skill"]);
});

test("`spacesheep skills check` asks the server nothing, and exits 0 or 1", async () => {
  const asked = [];
  const server = http.createServer((req, res) => { asked.push(req.url); res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const env = {
    ...process.env, SPACESHEEP_ORIGIN: `http://127.0.0.1:${server.address().port}`, SPACESHEEP_CONFIG_DIR: tmp(),
    SPACESHEEP_NO_UPDATE_CHECK: "1", SPACESHEEP_KEY: "",
  };
  const exit = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env, stdio: "ignore" });
    p.on("exit", resolve);
  });
  try {
    const good = write(skill());
    assert.strictEqual(await exit(["skills", "check", good]), 0);
    assert.strictEqual(await exit(["skills", "check", write({ "README.md": "x\n" }), "--json"]), 1);
    assert.deepStrictEqual(asked, []);
  } finally {
    server.close();
  }
});
