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
const { read } = require("../lib/read");

const ORIGIN = "https://mcp.example/mcp";
function page(pin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-base-page-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html><head><title>Q3</title></head><body>q3</body></html>");
  if (pin) fs.writeFileSync(path.join(dir, ".spacesheep.json"), JSON.stringify(pin));
  return dir;
}

/** One deploy against a fake server. `answers` maps a tool to its answer (a function
 *  of the args, or a value); a thrown answer is thrown. */
async function run(dir, opts, answers, url = ORIGIN, upload = async () => ({ ok: true, json: async () => ({ sha: "staged1" }) })) {
  const calls = [];
  const client = { url, call: async (name, args) => {
    calls.push([name, args]);
    if (name === "stage_begin") return { upload_url: "https://stage.example/u", plan: "pro", limits: { max_files: 12000 } };
    const a = answers[name];
    return typeof a === "function" ? a(args) : a;
  } };
  const realFetch = global.fetch;
  global.fetch = upload;
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
const at = (dir) => ({ origin: ORIGIN, space: "sp-1", dir });

/** A space on a fake server that merges as main does: from the base a deploy names
 *  (none: the caller's own head, so a replacement), file by file, then line by line. */
function fakeSpace(start) {
  const blobs = new Map();
  const versions = new Map();
  let head = null;
  const put = (tree) => { head = `v${versions.size + 1}`; versions.set(head, tree); return head; };
  put(start);
  const CLASH = Symbol("clash");
  const pick = (x, o, t) => (o === t ? o : o === x ? t : t === x ? o : CLASH);
  const lines = (x, o, t, p) => {
    const [X, O, T] = [x, o, t].map((v) => (v === undefined ? null : v.split("\n")));
    if (!X || !O || !T || X.length !== O.length || X.length !== T.length) throw new Error(`fake server: ${p} can't be merged line by line`);
    return X.map((l, i) => { const v = pick(l, O[i], T[i]); if (v === CLASH) throw new Error(`fake server: ${p} line ${i + 1} clashes`); return v; }).join("\n");
  };
  return {
    get head() { return head; },
    files: () => versions.get(head),
    /** list_versions and read_space as main answers them (an editor's Discussion first). */
    versions: () => ({ versions: [...versions.keys()].reverse().map((sha, i) => ({ sha, latest: i === 0 })) }),
    read(args) {
      const sha = args.version || head;
      const files = Object.entries(versions.get(sha)).map(([p, c]) => `--- ${p} (${Buffer.byteLength(c)} bytes) ---\n${c}`);
      return `--- discussion ---\nB: working on the second paragraph\n--- end of discussion ---\n\n${args.version ? `Version "v" deployed now (sha ${sha})\n\n` : ""}${files.join("\n\n")}`;
    },
    /** Someone else's save, on the server. */
    edit(fn) { const t = { ...versions.get(head) }; fn(t); return put(t); },
    upload: async (url, init) => {
      const sha = `st${blobs.size + 1}`;
      blobs.set(sha, Buffer.from(init.body).toString("utf-8"));
      return { ok: true, json: async () => ({ sha }) };
    },
    deploy(args) {
      const ours = Object.fromEntries(args.files.map((f) => [f.path, blobs.get(f.staged_sha)]));
      const base = args.base_sha || head;
      if (base === head) return published(put(ours));
      const b = versions.get(base), h = versions.get(head), out = {}, merged = [], kept = [];
      for (const p of new Set([...Object.keys(b), ...Object.keys(h), ...Object.keys(ours)])) {
        const [x, o, t] = [b[p], ours[p], h[p]];
        let v = pick(x, o, t);
        if (v === CLASH) { v = lines(x, o, t, p); merged.push(p); } else if (o !== t && v === t) kept.push(p);
        if (v !== undefined) out[p] = v;
      }
      const was = head;
      return published(put(out), { merged: { base_sha: base, server_sha: was, merged, kept } });
    },
  };
}
const body = (dir, ps) => fs.writeFileSync(path.join(dir, "index.html"), `<html><head><title>Q3</title></head><body>\n${ps.map((p) => `<p>${p}</p>`).join("\n")}\n</body></html>\n`);

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
  assert.equal(savedBase(at(dir)), "new999", "not the merged sha: this folder lacks the save that landed");
});

test("a second deploy after a merge keeps the server's own file and lines", async () => {
  const space = fakeSpace({});
  const dir = page({ space: "sp-1" });
  const answers = { deploy: (a) => space.deploy(a) };
  const go = () => run(dir, {}, answers, ORIGIN, space.upload);
  body(dir, ["A", "B", "C"]);
  await go();
  const built = space.head;
  // Someone else, on the server: a file of their own, and a line of the page.
  space.edit((t) => { t["notes.html"] = "theirs"; t["index.html"] = t["index.html"].replace("<p>C</p>", "<p>C, theirs</p>"); });
  body(dir, ["A, mine", "B", "C"]);
  const two = await go();
  assert.deepEqual([two.sent.base_sha, two.r.merged.merged, two.r.merged.kept], [built, ["index.html"], ["notes.html"]]);
  // The next deploy from the same folder, which still lacks notes.html and their line.
  body(dir, ["A, mine", "B, mine", "C"]);
  const three = await go();
  const live = space.files();
  assert.equal(live["notes.html"], "theirs", "the server's own file survives the second deploy");
  assert.match(live["index.html"], /<p>A, mine<\/p>\n<p>B, mine<\/p>\n<p>C, theirs<\/p>/, "their line survives beside mine");
  assert.equal(three.sent.base_sha, built);
  assert.ok(three.r.merged, "merged again, not replaced");
  assert.equal(savedBase(at(dir)), built);
  // The server's part brought here with read -o, as the merge line says: the folder is
  // now what is live, so a plain deploy builds on that and publishes it as it is.
  const live9 = space.head;
  await read({ url: ORIGIN, call: async (n, a) => (n === "list_versions" ? space.versions() : space.read(a)) }, "sp-1", { dir });
  assert.equal(fs.readFileSync(path.join(dir, "notes.html"), "utf-8"), "theirs");
  assert.equal(savedBase(at(dir)), live9);
  const four = await go();
  assert.deepEqual([four.sent.base_sha, four.r.merged], [live9, undefined]);
  assert.deepEqual(space.files(), live);
  const five = await go();
  assert.equal(five.sent.base_sha, four.r.sha);
});

test("a second writer reads the page, changes it and deploys with no sha: merged with what landed", async () => {
  const space = fakeSpace({ "index.html": "<html><head><title>Q3</title></head><body>\n<p>A</p>\n<p>B</p>\n<p>C</p>\n</body></html>\n" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-base-read-"));
  const reader = { url: ORIGIN, call: async (n, a) => (n === "list_versions" ? space.versions() : space.read(a)) };
  const got = await read(reader, "sp-1", { dir });
  assert.equal(got.sha, "v1");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["index.html"], "the Discussion isn't a file");
  assert.equal(fs.readFileSync(path.join(dir, "index.html"), "utf-8"), space.files()["index.html"], "byte for byte, last newline too");
  // Meanwhile the first writer changes another line.
  space.edit((t) => { t["index.html"] = t["index.html"].replace("<p>A</p>", "<p>A, first</p>"); });
  body(dir, ["A", "B, second", "C"]);
  const { sent, r } = await run(dir, { space: "sp-1" }, { deploy: (a) => space.deploy(a) }, ORIGIN, space.upload);
  assert.equal(sent.base_sha, "v1");
  assert.ok(r.merged);
  assert.match(space.files()["index.html"], /<p>A, first<\/p>\n<p>B, second<\/p>\n<p>C<\/p>/);
});

test("read -o as a viewer reads the live page with no base: viewers can't list versions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-base-view-"));
  const calls = [];
  const viewer = { url: ORIGIN, call: async (n, a) => {
    calls.push([n, a]);
    return n === "list_versions" ? "This space's version history is readable only by its owner and editors." : "--- index.html (3 bytes) ---\nhi\n";
  } };
  const got = await read(viewer, "sp-1", { dir });
  assert.equal(got.sha, null);
  assert.deepEqual(calls[1], ["read_space", { uuid: "sp-1" }]);
  assert.equal(fs.readFileSync(path.join(dir, "index.html"), "utf-8"), "hi\n");
  assert.equal(savedBase(at(dir)), null);
});

test("after a kept-base merge, a clash says the folder lacks the merged part, keeping both first", async () => {
  const dir = page({ space: "sp-1" });
  await run(dir, {}, { deploy: published("one111") });
  await run(dir, {}, { deploy: published("two222", { merged: { base_sha: "one111", server_sha: "srv000", merged: ["index.html"], kept: [] } }) });
  const clash = { error: "conflict", message: "These parts changed on both sides.", conflicts: [{ path: "index.html", why: "both_changed", lines: [[3, 4]] }], base_sha: "one111", server_sha: "two222" };
  await assert.rejects(run(dir, {}, { deploy: clash }), (e) => {
    assert.match(e.message, /This folder's last deploy was merged with changes made on the server \(into two222\), and this folder doesn't have them/);
    assert.ok(e.message.indexOf("To keep both") < e.message.indexOf("--replace"), "keeping both comes first");
    return true;
  });
});

test("a merge on the server's own guess of the base keeps that base", async () => {
  const dir = page({ space: "sp-1" });
  const { sent } = await run(dir, {}, { deploy: published("mmm222", { base_inferred: { base_sha: "own111" }, merged: { base_sha: "own111", server_sha: "srv111", merged: [], kept: ["notes.html"] } }) });
  assert.equal(sent.base_sha, undefined);
  assert.equal(savedBase(at(dir)), "own111");
  const next = await run(dir, {}, { deploy: published("nnn333") });
  assert.equal(next.sent.base_sha, "own111");
});

test("a merge with no base known holds the folder: no deploy from it until it names one", async () => {
  const dir = page({ space: "sp-1" });
  await run(dir, {}, { deploy: published("ppp444", { merged: { merged: ["index.html"], kept: [] } }) });
  assert.equal(savedBase(at(dir)), null);
  await assert.rejects(run(dir, {}, { deploy: published("qqq555") }), (e) => {
    assert.match(e.message, /merged with changes made on the server, into version ppp444/);
    assert.match(e.message, /spacesheep read sp-1 -o <folder>, put your changes in, then spacesheep deploy <folder> --space sp-1/);
    assert.match(e.message, /erasing them: --replace\.$/);
    assert.equal(e.calls.length, 0, "nothing uploaded or deployed");
    return true;
  });
  const { sent } = await run(dir, { base: "ppp444" }, { deploy: published("rrr666") });
  assert.equal(sent.base_sha, "ppp444");
  const after = await run(dir, {}, { deploy: published("sss777") });
  assert.equal(after.sent.base_sha, "rrr666");
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
    assert.match(e.message, /To keep both: spacesheep read sp-1 -o <folder>, put your changes in, then spacesheep deploy <folder> --space sp-1\n/);
    assert.match(e.message, /To publish yours over the live version, erasing the changes made there: spacesheep deploy .* --replace$/);
    assert.ok(e.message.indexOf("To keep both") < e.message.indexOf("--replace"), "keeping both comes first");
    assert.doesNotMatch(e.message, /last deploy was merged/);
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
      assert.match(e.message, /erasing the changes made there: spacesheep deploy .* --replace/);
      assert.match(e.message, /then spacesheep deploy <folder> --space sp-1/);
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
