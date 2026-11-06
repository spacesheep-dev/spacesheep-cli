"use strict";
// A deploy names the version its files are built on (base_sha), so the server merges
// what was published since instead of guessing whose the live version is.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const conf = fs.mkdtempSync(path.join(os.tmpdir(), "ss-base-conf-"));
process.env.SPACESHEEP_CONFIG_DIR = conf;
const { deploy, clashWords } = require("../lib/deploy");
const { savedBase } = require("../lib/bases");

const ORIGIN = "https://mcp.example/mcp";
function page(pin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-base-page-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html><head><title>Q3</title></head><body>q3</body></html>");
  if (pin) fs.writeFileSync(path.join(dir, ".spacesheep.json"), JSON.stringify(pin));
  return dir;
}

/** One deploy against a fake server. `answers` maps a tool to its answer (a function
 *  of the args, or a value); a thrown answer is thrown. */
async function run(dir, opts, answers, url = ORIGIN) {
  const calls = [];
  const client = { url, call: async (name, args) => {
    calls.push([name, args]);
    if (name === "stage_begin") return { upload_url: "https://stage.example/u", plan: "pro", limits: { max_files: 12000 } };
    const a = answers[name];
    return typeof a === "function" ? a(args) : a;
  } };
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ sha: "staged1" }) });
  const prev = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  try {
    const r = await deploy(client, dir, opts, () => {});
    return { r, calls, sent: (calls.find(([n]) => n === "deploy") || [])[1] };
  } catch (e) {
    e.calls = calls;
    throw e;
  } finally { global.fetch = realFetch; if (prev !== undefined) process.env.GITHUB_ACTIONS = prev; }
}
const published = (sha, extra = {}) => ({ uuid: "sp-1", url: "https://spacesheep.dev/@y/q3", sha, is_update: true, ...extra });

test("the first update sends no base; the next sends the sha the first was published as", async () => {
  const dir = page({ space: "sp-1" });
  const one = await run(dir, {}, { deploy: published("aaa111") });
  assert.equal(one.sent.base_sha, undefined);
  assert.equal(savedBase({ origin: ORIGIN, space: "sp-1", dir }), "aaa111");
  const two = await run(dir, {}, { deploy: published("bbb222") });
  assert.equal(two.sent.base_sha, "aaa111");
  assert.equal(savedBase({ origin: ORIGIN, space: "sp-1", dir }), "bbb222");
});

test("the saved base is this folder's on this server: another folder or server sends none", async () => {
  const dir = page({ space: "sp-1" });
  await run(dir, {}, { deploy: published("ccc333") });
  const other = await run(page({ space: "sp-1" }), {}, { deploy: published("ddd444") });
  assert.equal(other.sent.base_sha, undefined);
  const elsewhere = await run(dir, {}, { deploy: published("eee555") }, "http://127.0.0.1:8918/mcp");
  assert.equal(elsewhere.sent.base_sha, undefined);
});

test("a new space is made with no base, and its sha is saved for the next update", async () => {
  const dir = page();
  const { sent } = await run(dir, {}, { deploy: { uuid: "sp-new", url: "https://spacesheep.dev/@y/q3", sha: "fff666" } });
  assert.equal(sent.base_sha, undefined);
  assert.equal(sent.uuid, undefined);
  assert.equal(savedBase({ origin: ORIGIN, space: "sp-new", dir }), "fff666");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".spacesheep.json"), "utf-8")).base_sha, undefined, "the committed pin holds no sha");
});

test("--replace builds on the newest version, read just before, from today's tool or the new call", async () => {
  for (const versions of [
    [{ sha: "new999", latest: true }, { sha: "old111", latest: false }],
    [{ id: "new999", label: "Edited in the browser" }, { id: "old111" }],
  ]) {
    const dir = page({ space: "sp-1" });
    const { r, sent, calls } = await run(dir, { replace: true }, { list_versions: { versions }, deploy: published("ggg777") });
    assert.equal(sent.base_sha, "new999");
    assert.deepEqual(calls.find(([n]) => n === "list_versions")[1], { uuid: "sp-1" });
    assert.ok(calls.findIndex(([n]) => n === "list_versions") > calls.findIndex(([n]) => n === "stage_begin"), "read after the uploads, just before the deploy");
    assert.equal(r.replaced, "new999");
  }
});

test("--replace that merged a save landing in between says merged, not replaced", async () => {
  const dir = page({ space: "sp-1" });
  const { r } = await run(dir, { replace: true }, {
    list_versions: { versions: [{ sha: "new999", latest: true }] },
    deploy: published("hhh888", { merged: { base_sha: "new999", server_sha: "late000", merged: ["index.html"], kept: [] } }),
  });
  assert.equal(r.replaced, undefined);
});

test("--replace with no version to read, or on a new space, deploys nothing", async () => {
  await assert.rejects(run(page({ space: "sp-1" }), { replace: true }, { list_versions: "This space's version history is readable only by its owner and editors." }),
    (e) => /none came back: This space's version history/.test(e.message) && !e.calls.some(([n]) => n === "deploy"));
  await assert.rejects(run(page(), { replace: true }, {}), (e) => /--replace is for updating a space/.test(e.message) && e.calls.length === 0);
  await assert.rejects(run(page({ space: "sp-1" }), { replace: true, base: "abc" }, {}), (e) => /pass one/.test(e.message) && e.calls.length === 0);
});

test("--base sends that sha, over the saved one", async () => {
  const dir = page({ space: "sp-1" });
  await run(dir, {}, { deploy: published("iii999") });
  const { sent } = await run(dir, { base: "live123" }, { deploy: published("jjj000") });
  assert.equal(sent.base_sha, "live123");
});

test("a clash says the live sha, the parts, and how to go on, and saves nothing", async () => {
  const dir = page({ space: "sp-1" });
  await run(dir, {}, { deploy: published("kkk111") });
  const clash = {
    error: "conflict",
    message: "This space was updated on the server since your base version, and these parts changed on both sides, so nothing was deployed.",
    conflicts: [{ path: "index.html", why: "both_changed", lines: [[3, 3], [7, 9]] }, { path: "logo.png", why: "not_text" }],
    base_sha: "kkk111",
    server_sha: "srv222",
  };
  await assert.rejects(run(dir, {}, { deploy: clash }), (e) => {
    assert.match(e.message, /deploy refused — conflict: This space was updated/);
    assert.match(e.message, /live version: srv222 \(yours was built on kkk111\)/);
    assert.match(e.message, /index\.html: changed on both sides \(lines 3, 7-9\)/);
    assert.match(e.message, /logo\.png: can't be merged \(not text\)/);
    assert.match(e.message, /on purpose: spacesheep deploy .* --replace/);
    assert.match(e.message, /To keep both: spacesheep read sp-1 -o <folder>, put your changes in, then spacesheep deploy .* --base srv222/);
    return true;
  });
  assert.equal(savedBase({ origin: ORIGIN, space: "sp-1", dir }), "kkk111");
});

test("no_base, today's JSON and a door's ErrorInfo alike, says how to go on", async () => {
  const today = clashWords({ error: "conflict", reason: "no_base", message: "published by ana@x.com, not by you", server_sha: "srv333" }, "spacesheep deploy .", "sp-1");
  assert.match(today, /live version: srv333\n/);
  assert.match(today, /--replace/);
  const dir = page({ space: "sp-1" });
  // A door's shapes (ssapi/picks-base): code `conflict`, a violation on `parent`.
  for (const why of ["no_base", "conflict"]) {
    const door = Object.assign(new Error("A save needs its parent: the live version was published by ana@x.com (srv333)."), {
      code: "ETOOL", info: { code: "conflict", message: "…", violations: [{ field: "parent", message: why }] },
    });
    await assert.rejects(run(dir, {}, { deploy: () => { throw door; } }), (e) => {
      assert.match(e.message, /^A save needs its parent/);
      assert.match(e.message, /on purpose: spacesheep deploy .* --replace/);
      assert.match(e.message, /--base <its sha>/);
      return true;
    });
  }
  for (const info of [
    { code: "resource_exhausted", message: "over quota", violations: [] },
    { code: "aborted", message: "over quota", violations: [{ field: "files", message: "too_many" }] },
  ]) {
    const other = Object.assign(new Error("over quota"), { code: "ETOOL", info });
    await assert.rejects(run(dir, {}, { deploy: () => { throw other; } }), (e) => e.message === "over quota");
  }
});
