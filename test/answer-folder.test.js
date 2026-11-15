"use strict";
// A call whose answer is a folder (answer_folder, GetSkill's): `-o FOLDER` writes every file the answer lists, `--path X
// -o FILE` that one, through a stubbed fetch. One version for the whole folder, a file in parts, paths refused, and only
// a new or empty folder written to.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const doors = require("../lib/doors");

const at = (name, ref) => ({ name, type: name === "version" || name === "offset" ? "integer" : "text", at: [name === "skill_id" ? "skill" : name], ...(ref ? { ref, either: "skill" } : {}) });
const flag = (input, type = "text") => ({ flag: `--${input}`, input, type });
// GetSkill as the server's doors.json has it: answer_folder names its own fields, the file's and served's too.
const TABLE = { services: [{ methods: [{
  method: "GetSkill", verb: "Get", http: "GET", path: "/v1/skills/{skill.id}", where: "query", errors: ["forbidden", "invalid", "not_found"],
  cli: { command: "spacesheep skills get", usage: "spacesheep skills get <skill> [flags]", args: ["skill"], flags: [flag("view", "one of card, full"), flag("path"), flag("version", "integer"), flag("offset", "integer")] },
  inputs: [at("skill", "name"), at("skill_id", "id"), at("view"), at("path"), at("version"), at("offset")],
  answer_folder: { list: "files", list_with: { input: "view", value: "full" }, path: "path", file: "file", text: "text", bytes: "data", offset: "offset", next: "next_offset", served: "served", number: "number", label: "label", pin: "version" },
}] }] };
// big.js is "héllo 🐑 " then "wörld": offsets in code points. img.bin is bytes 0-3 then 4-5.
const PARTS = { "SKILL.md": [["text", "# Hi\n"]], "assets/big.js": [["text", "héllo 🐑 ", 8], ["text", "wörld"]], "img.bin": [["data", Buffer.from([0, 1, 2, 255]).toString("base64"), 4], ["data", Buffer.from([7, 8]).toString("base64")]] };
const LABELS = { 2: "v1.2.1", 3: "v1.3.0" };   // 4 has none

/** GetSkill against a fetch: the files listed with view full, `part(q)` for a file's parts, and `served` the version
 *  asked for, else `live()` (the server's pick: the install's pin, else the latest). Keeps each request's query. */
function stub(files, { live = () => 2, part = (q) => PARTS[q.path], seen = [] } = {}) {
  return async (url) => {
    const q = Object.fromEntries(new URL(url).searchParams);
    seen.push(q);
    const reply = (status, body) => ({ ok: status === 200, status, text: async () => JSON.stringify(body) });
    if (q.skill !== "@me/hello") return reply(404, { code: "not_found", message: "No skill by that name or id that you can read." });
    const v = Number(q.version) || live(), served = { number: v, ...(LABELS[v] ? { label: LABELS[v] } : {}) };
    if (!q.path) return reply(200, { skill: { name: "@me/hello", version: { number: 3 } }, served, ...(q.view === "full" ? { files } : {}) });
    const parts = part(q), i = parts.findIndex((p, k) => (k ? parts[k - 1][2] : 0) === Number(q.offset || 0));
    const [kind, value, next] = parts[i];
    return reply(200, { served, file: { path: q.path, [kind]: value, media_type: "text/plain" }, next_offset: next || 0 });
  };
}
/** `spacesheep skills get …` through the door: its exit code, what it printed and what it said on stderr. */
async function get(args, fetchImpl) {
  const said = [], errs = [], argv = ["skills", "get", ...args], found = doors.match(TABLE, argv);
  const code = await doors.run(found, argv.slice(found.used), { origin: "http://x", key: () => "ss_test", version: "0", fetchImpl, out: (s) => said.push(s), err: (s) => errs.push(s) });
  return { code, said, errs, json: () => JSON.parse(said[0]) };
}
const fresh = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ss-folder-")), "out");

test("-o FOLDER writes each file whole, its parts joined, at the version the first answer served on every call", async () => {
  const dir = fresh(), seen = [];
  const r = await get(["@me/hello", "-o", dir, "--json"], stub(Object.keys(PARTS), { seen }));
  assert.equal(r.code, 0, r.errs.join(""));
  assert.deepStrictEqual(r.json(), { dir, skill: "@me/hello", version: "v1.2.1", files: [{ path: "SKILL.md", bytes: 5 }, { path: "assets/big.js", bytes: 18 }, { path: "img.bin", bytes: 6 }] });
  assert.strictEqual(fs.readFileSync(path.join(dir, "assets/big.js"), "utf8"), "héllo 🐑 wörld");
  assert.deepStrictEqual([...fs.readFileSync(path.join(dir, "img.bin"))], [0, 1, 2, 255, 7, 8]);
  const [first, ...rest] = seen;
  assert.deepStrictEqual(first, { skill: "@me/hello", view: "full" }, "the list first, naming no version");
  assert.ok(rest.length === 5 && rest.every((q) => q.version === "2" && !q.view), "every part names the served version");
  const named = [];
  const lines = await get(["@me/hello", "-o", dir + "-2", "--version", "4"], stub(["SKILL.md"], { seen: named }));
  assert.deepStrictEqual(lines.said, ["  ✓ SKILL.md  5 bytes", `Follow ${path.join(dir + "-2", "SKILL.md")} (@me/hello v4)`], "the number only when there's no label");
  assert.ok(named.length === 2 && named.every((q) => q.version === "4"), "--version: named in every call");
});

test("-o FOLDER writes one version's bytes when the unpinned answer moves between parts", async () => {
  // The server reading an unnumbered call again: a follow-latest install moves to version 3 after the first answer.
  const bytes = { 2: "AAAA1111", 3: "BBBB2222" };
  let now = 2;
  const live = () => { const v = now; now = 3; return v; };
  const part = (q) => { const b = bytes[q.version || live()]; return [["text", b.slice(0, 4), 4], ["text", b.slice(4)]]; };
  const dir = fresh();
  assert.equal((await get(["@me/hello", "-o", dir], stub(["run.js"], { live, part }))).code, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, "run.js"), "utf8"), "AAAA1111");
});

test("--path X -o FILE joins that file's parts into FILE, the served version pinned after the first part", async () => {
  const file = path.join(path.dirname(fresh()), "big.js"), seen = [];
  const r = await get(["@me/hello", "--path", "assets/big.js", "-o", file, "--json"], stub([], { seen }));
  assert.deepStrictEqual(r.json(), { file, skill: "@me/hello", version: "v1.2.1", files: [{ path: "assets/big.js", bytes: 18 }] });
  assert.strictEqual(fs.readFileSync(file, "utf8"), "héllo 🐑 wörld");
  assert.deepStrictEqual(seen.map((q) => [q.offset, q.version]), [["0", undefined], ["8", "2"]]);
  const text = await get(["@me/hello", "--path", "SKILL.md", "-o", file], stub([]));
  assert.deepStrictEqual(text.said, [`  ✓ ${file}  5 bytes (@me/hello v1.2.1)`]);
  assert.strictEqual(fs.readFileSync(file, "utf8"), "# Hi\n", "a file named with -o is written over, as -o FILE does");
});

test("-o FOLDER refuses a path outside the folder before writing anything, and says the server's words", async () => {
  const dir = fresh();
  for (const bad of ["../evil", "/etc/evil", "a\\evil", "a/../../evil"]) {
    const r = await get(["@me/hello", "-o", dir], stub(["SKILL.md", bad]));
    assert.equal(r.code, 1);
    assert.equal(r.errs[0], `\n  ✗ refused ${JSON.stringify(bad)}: not a path inside the folder\n`);
  }
  assert.ok(!fs.existsSync(dir));
  const nope = await get(["@me/nope", "-o", dir], stub([]));
  assert.equal(nope.code, 1);
  assert.match(nope.errs[0], /No skill by that name or id that you can read\. \(not_found\)/);
  assert.equal((await get(["@me/nope", "-o", dir, "--json"], stub([]))).json().code, "not_found");
});

test("-o FOLDER writes only into a new or empty folder: one with files, a link (with or without a trailing slash) or a file is refused before any call", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-folder-")), outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "big.js"), "theirs");
  const full = path.join(root, "full"), link = path.join(root, "link"), file = path.join(root, "file");
  fs.mkdirSync(full);
  fs.symlinkSync(outside, path.join(full, "assets"));   // a link inside it would carry assets/big.js outside
  fs.symlinkSync(outside, link);
  fs.writeFileSync(file, "x");
  // A trailing slash makes lstat follow a link: `toEmpty/` would see an empty folder and write through the link.
  const bare = path.join(root, "bare"), toEmpty = path.join(root, "to-empty");
  fs.mkdirSync(bare);
  fs.symlinkSync(bare, toEmpty);
  for (const [dir, why] of [[full, "has files in it"], [link, "is a link"], [file, "is a file"], [toEmpty, "is a link"], [toEmpty + "/", "is a link"], [toEmpty + "/.", "is a link"]]) {
    const seen = [];
    const r = await get(["@me/hello", "-o", dir], stub(Object.keys(PARTS), { seen }));
    assert.deepStrictEqual([r.code, r.errs], [1, [`\n  ✗ -o writes into a new or empty folder: ${dir} ${why}\n`]]);
    assert.equal(seen.length, 0, "no call made");
  }
  assert.strictEqual(fs.readFileSync(path.join(outside, "big.js"), "utf8"), "theirs");
  assert.deepStrictEqual(fs.readdirSync(outside), ["big.js"]);
  assert.deepStrictEqual(fs.readdirSync(bare), [], "nothing written through the link");
  const empty = path.join(root, "empty");
  fs.mkdirSync(empty);
  assert.equal((await get(["@me/hello", "-o", empty], stub(["SKILL.md"]))).code, 0);
  assert.strictEqual(fs.readFileSync(path.join(empty, "SKILL.md"), "utf8"), "# Hi\n");
});

test("without -o the call is one request, its answer printed; --help names -o", async () => {
  const seen = [];
  const r = await get(["@me/hello", "--path", "SKILL.md"], stub([], { seen }));
  assert.equal(r.code, 0);
  assert.equal(seen.length, 1);
  assert.match(r.said[0], /file:\n\s+path: SKILL\.md\n\s+text: # Hi/);
  assert.match(doors.helpFor(doors.match(TABLE, ["skills", "get"])), /-o, --out <folder>\s+write every file to a new or empty folder \(with --path, that file to <file>\)/);
});

test("end to end: skills get -o reaches GetSkill's own --version, skills pull is gone, and --version is the CLI's", async () => {
  const seen = [], answer = stub(Object.keys(PARTS), { seen });
  const s = http.createServer(async (req, res) => {
    if (req.url === "/v1/doors.json") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(TABLE)); }
    const r = await answer(`http://x${req.url}`);
    res.writeHead(r.status, { "Content-Type": "application/json" });
    res.end(await r.text());
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const env = { PATH: process.env.PATH, SPACESHEEP_QUIET: "1", SPACESHEEP_ORIGIN: `http://127.0.0.1:${s.address().port}`, SPACESHEEP_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "ss-folder-")), SPACESHEEP_KEY: "ss_e2e" };
  const cli = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, "..", "bin", "spacesheep.js"), ...args], { env });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, out, err }));
  });
  try {
    const dir = fresh();
    const r = await cli(["skills", "get", "@me/hello", "-o", dir, "--version", "4"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.endsWith(`Follow ${path.join(dir, "SKILL.md")} (@me/hello v4)\n`), r.out);
    assert.ok(seen.length === 6 && seen.every((q) => q.version === "4"), "--version 4 on every call");
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ["SKILL.md", "assets", "img.bin"]);
    const pull = await cli(["skills", "pull", "@me/hello", fresh()]);
    assert.equal(pull.code, 2);
    assert.match(pull.out, /spacesheep skills get <skill>/);
    assert.equal((await cli(["--version"])).out, `${require("../package.json").version}\n`);
  } finally { s.close(); }
});
