"use strict";
// `spacesheep skills pull`: GetSkill through a stubbed table and fetch, a file in parts, and paths refused.
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
}] }] };
// big.js is "héllo 🐑 " then "wörld": offsets in code points. img.bin is bytes 0-3 then 4-5.
const PARTS = { "SKILL.md": [["text", "# Hi\n"]], "assets/big.js": [["text", "héllo 🐑 ", 8], ["text", "wörld"]], "img.bin": [["data", Buffer.from([0, 1, 2, 255]).toString("base64"), 4], ["data", Buffer.from([7, 8]).toString("base64")]] };

/** The table's `skills get` against a fetch that answers from `files`, keeping each request's query. */
function stub(files, seen = []) {
  const fetchImpl = async (url) => {
    const q = Object.fromEntries(new URL(url).searchParams);
    seen.push(q);
    const reply = (status, body) => ({ ok: status === 200, status, text: async () => JSON.stringify(body) });
    if (q.skill !== "@me/hello") return reply(404, { code: "not_found", message: "No skill by that name or id that you can read." });
    if (q.view === "full") return reply(200, { skill: { name: "@me/hello", version: { number: 3 } }, files });
    const parts = PARTS[q.path], i = parts.findIndex((p, k) => (k ? parts[k - 1][2] : 0) === Number(q.offset));
    const [kind, value, next] = parts[i];
    return reply(200, { file: { path: q.path, [kind]: value }, next_offset: next || 0 });
  };
  return (inputs) => doors.call(TABLE, "skills get", inputs, { origin: "http://x", key: () => "ss_test", version: "0", fetchImpl });
}
const pull = async (args, get, opts = { json: true }) => { const said = []; await run({ _: ["skills", "pull", ...args], ...opts }, get, (v) => said.push(v)); return said; };

test("pull writes each file whole, its parts joined, and says where to start", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-pull-"));
  fs.writeFileSync(path.join(dir, "keep.txt"), "mine");
  const seen = [];
  const [said] = await pull(["@me/hello", dir], stub(Object.keys(PARTS), seen));
  assert.deepStrictEqual(said, { dir, skill: "@me/hello", version: null, files: [{ path: "SKILL.md", bytes: 5 }, { path: "assets/big.js", bytes: 18 }, { path: "img.bin", bytes: 6 }] });
  assert.strictEqual(fs.readFileSync(path.join(dir, "assets/big.js"), "utf8"), "héllo 🐑 wörld");
  assert.deepStrictEqual([...fs.readFileSync(path.join(dir, "img.bin"))], [0, 1, 2, 255, 7, 8]);
  assert.strictEqual(fs.readFileSync(path.join(dir, "keep.txt"), "utf8"), "mine");
  assert.ok(seen.every((q) => q.version === undefined), "the server picks the version");
  const unnamed = await pull(["@me/hello", dir], stub(["SKILL.md"]), {});
  assert.strictEqual(unnamed.at(-1), `Follow ${path.join(dir, "SKILL.md")} (@me/hello)`, "no version named when none was asked for");
  const named = [];
  const lines = await pull(["@me/hello", dir], stub(["SKILL.md"], named), { version: "2" });
  assert.deepStrictEqual(lines, ["  ✓ SKILL.md  5 bytes", `Follow ${path.join(dir, "SKILL.md")} (@me/hello v2)`]);
  assert.ok(named.every((q) => q.version === "2"), "--version names it in every call");
});

test("pull refuses a path outside the folder before writing anything, and says the server's words", async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ss-pull-")), "out");
  for (const bad of ["../evil", "/etc/evil", "a\\evil"]) {
    await assert.rejects(pull(["@me/hello", dir], stub(["SKILL.md", bad])), (e) => e.message.startsWith(`refused ${JSON.stringify(bad)}:`));
  }
  assert.ok(!fs.existsSync(dir));
  await assert.rejects(pull(["@me/nope", dir], stub([])), /No skill by that name or id that you can read\. \(not_found\)/);
});
