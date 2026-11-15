"use strict";
// `spacesheep skills pull`: GetSkill and ListInstalls through a stubbed table and fetch, one version for the whole
// pull, a file in parts, paths refused, and only a new or empty folder written to.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const doors = require("../lib/doors");
const { run } = require("../lib/skill-pull");

const at = (name, ref) => ({ name, at: [name === "skill_id" ? "skill" : name], ...(ref ? { ref } : {}) });
const TABLE = { services: [{ methods: [{
  method: "GetSkill", verb: "Get", http: "GET", path: "/v1/skills/{skill.id}", where: "query",
  cli: { command: "spacesheep skills get", args: ["skill"], flags: [] },
  inputs: [at("skill", "name"), at("skill_id", "id"), at("view"), at("path"), at("version"), at("offset")],
}, {
  method: "ListInstalls", verb: "List", http: "GET", path: "/v1/me/installs", where: "query",
  cli: { command: "spacesheep installs list", args: [], flags: [] },
  inputs: [at("after"), at("limit")],
}] }] };
// big.js is "héllo 🐑 " then "wörld": offsets in code points. img.bin is bytes 0-3 then 4-5.
const PARTS = { "SKILL.md": [["text", "# Hi\n"]], "assets/big.js": [["text", "héllo 🐑 ", 8], ["text", "wörld"]], "img.bin": [["data", Buffer.from([0, 1, 2, 255]).toString("base64"), 4], ["data", Buffer.from([7, 8]).toString("base64")]] };
const card = (number) => ({ name: "@me/hello", version: { number } });
// Two pages: a pending install of it and someone's other skill first, then its active install, pinned at 2.
const PINNED = [{ installs: [{ state: "pending", skill: card(3), pinned: { number: 1 } }, { state: "active", skill: { name: "@me/other" }, pinned: { number: 9 } }], page: { next: "2" } },
  { installs: [{ state: "active", skill: card(3), pinned: { number: 2 } }] }];

/** The table's commands against a fetch: `skills get` from `files` (`part(q)` for a file's parts), `installs list`
 *  from `pages`, keeping each request's path and query. */
function stub(files, { pages = [{ installs: [] }], part = (q) => PARTS[q.path], seen = [] } = {}) {
  const fetchImpl = async (url) => {
    const u = new URL(url), q = Object.fromEntries(u.searchParams);
    seen.push({ at: u.pathname, ...q });
    const reply = (status, body) => ({ ok: status === 200, status, text: async () => JSON.stringify(body) });
    if (u.pathname === "/v1/me/installs") return reply(200, pages[Number(q.after || 0) && 1]);
    if (q.skill !== "@me/hello") return reply(404, { code: "not_found", message: "No skill by that name or id that you can read." });
    if (!q.path) return reply(200, { skill: card(3), ...(q.view === "full" ? { files } : {}) });
    const parts = part(q), i = parts.findIndex((p, k) => (k ? parts[k - 1][2] : 0) === Number(q.offset));
    const [kind, value, next] = parts[i];
    return reply(200, { file: { path: q.path, [kind]: value }, next_offset: next || 0 });
  };
  return (command, inputs) => doors.call(TABLE, command, inputs, { origin: "http://x", key: () => "ss_test", version: "0", fetchImpl });
}
const pull = async (args, call, opts = { json: true }) => { const said = []; await run({ _: ["skills", "pull", ...args], ...opts }, call, (v) => said.push(v)); return said; };
const fresh = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ss-pull-")), "out");
const reads = (seen) => seen.filter((q) => q.at !== "/v1/me/installs");

test("pull writes each file whole, its parts joined, at the install's pinned version on every call", async () => {
  const dir = fresh(), seen = [];
  const [said] = await pull(["@me/hello", dir], stub(Object.keys(PARTS), { pages: PINNED, seen }));
  assert.deepStrictEqual(said, { dir, skill: "@me/hello", version: 2, files: [{ path: "SKILL.md", bytes: 5 }, { path: "assets/big.js", bytes: 18 }, { path: "img.bin", bytes: 6 }] });
  assert.strictEqual(fs.readFileSync(path.join(dir, "assets/big.js"), "utf8"), "héllo 🐑 wörld");
  assert.deepStrictEqual([...fs.readFileSync(path.join(dir, "img.bin"))], [0, 1, 2, 255, 7, 8]);
  assert.deepStrictEqual(seen.filter((q) => q.at === "/v1/me/installs").map((q) => q.after), [undefined, "2"], "both pages of installs read");
  const [first, ...rest] = reads(seen);
  assert.strictEqual(first.version, undefined, "only the card is read before the version is known");
  assert.ok(rest.length === 6 && rest.every((q) => q.version === "2"), "view full and every part name the pin");
  const latest = await pull(["@me/hello", fresh()], stub(["SKILL.md"]), {});
  assert.match(latest.at(-1), /\(@me\/hello v3\)$/, "no install: the card's latest approved");
  const named = [];
  const lines = await pull(["@me/hello", (dir + "-2")], stub(["SKILL.md"], { pages: PINNED, seen: named }), { version: "4" });
  assert.deepStrictEqual(lines, ["  ✓ SKILL.md  5 bytes", `Follow ${path.join(dir + "-2", "SKILL.md")} (@me/hello v4)`]);
  assert.ok(named.length === 2 && named.every((q) => q.version === "4"), "--version: no installs read, and named in every call");
});

test("pull writes one version's bytes when the unpinned answer moves between parts", async () => {
  // The server reading an unnumbered part again: a follow-latest install moves to version 3 after the first part.
  const bytes = { 2: "AAAA1111", 3: "BBBB2222" };
  let live = 2;
  const part = (q) => { const b = bytes[q.version || live]; live = 3; return [["text", b.slice(0, 4), 4], ["text", b.slice(4)]]; };
  const dir = fresh();
  await pull(["@me/hello", dir], stub(["run.js"], { pages: PINNED, part }));
  assert.strictEqual(fs.readFileSync(path.join(dir, "run.js"), "utf8"), "AAAA1111");
});

test("pull refuses a path outside the folder before writing anything, and says the server's words", async () => {
  const dir = fresh();
  for (const bad of ["../evil", "/etc/evil", "a\\evil"]) {
    await assert.rejects(pull(["@me/hello", dir], stub(["SKILL.md", bad])), (e) => e.message.startsWith(`refused ${JSON.stringify(bad)}:`));
  }
  assert.ok(!fs.existsSync(dir));
  await assert.rejects(pull(["@me/nope", dir], stub([])), /No skill by that name or id that you can read\. \(not_found\)/);
});

test("pull writes only into a new or empty folder: one with files, a link (with or without a trailing slash) or a file is refused before any file is read", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-pull-")), outside = path.join(root, "outside");
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
    await assert.rejects(pull(["@me/hello", dir], stub(Object.keys(PARTS), { seen })), { message: `pull writes into a new or empty folder: ${dir} ${why}` });
    assert.ok(reads(seen).every((q) => !q.path), "no file read");
  }
  assert.strictEqual(fs.readFileSync(path.join(outside, "big.js"), "utf8"), "theirs");
  assert.deepStrictEqual(fs.readdirSync(outside), ["big.js"]);
  assert.deepStrictEqual(fs.readdirSync(bare), [], "nothing written through the link");
  const empty = path.join(root, "empty");
  fs.mkdirSync(empty);
  await pull(["@me/hello", empty], stub(["SKILL.md"]));
  assert.strictEqual(fs.readFileSync(path.join(empty, "SKILL.md"), "utf8"), "# Hi\n");
});
