"use strict";
// Agents looped on publish refusals: two Claude Code sessions on two Macs published one
// space ~500 times a day, each refused `conflict` (no base, someone else's live version),
// and 2,934 publishes were refused for a space never shared with the caller. A deploy with
// no base now looks before it uploads, and no refusal is ever sent again by the CLI.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const conf = fs.mkdtempSync(path.join(os.tmpdir(), "ss-loop-conf-"));
process.env.SPACESHEEP_CONFIG_DIR = conf;
const { deploy, stagedSha, writerOf } = require("../lib/deploy");
const { savedBase } = require("../lib/bases");
const { McpClient } = require("../lib/mcp");
const refusals = require("../lib/refusals");

const ORIGIN = "https://mcp.example/mcp";
const SPACE = "11111111-2222-4333-8444-555555555555";
const HTML = "<html><head><title>Q3</title></head><body>q3</body></html>";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ss-loop-"));
function page(pin, html = HTML) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "index.html"), html);
  if (pin) fs.writeFileSync(path.join(dir, ".spacesheep.json"), JSON.stringify(pin));
  return dir;
}
const pinOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, ".spacesheep.json"), "utf-8"));

/** A deploy against a fake client: `answers` maps a tool to its answer (a function of the args, or a value). */
async function run(dir, opts, answers, env = {}) {
  const calls = [];
  const client = { url: ORIGIN, call: async (name, args) => {
    calls.push([name, args]);
    if (name === "stage_begin") return { upload_url: "https://stage.example/u", plan: "pro", limits: { max_files: 12000 } };
    const a = answers[name];
    if (a === undefined) throw new Error(`Tool ${name} not found`);
    return typeof a === "function" ? a(args) : a;
  } };
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ sha: "staged1" }) });
  const saved = {};
  for (const k of ["GITHUB_ACTIONS", "CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "CODEX_SESSION_ID", "CODEX_HOME", "CODEX_SANDBOX", ...Object.keys(env)]) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  const names = () => calls.map(([n]) => n);
  try {
    const r = await deploy(client, dir, opts, () => {});
    return { r, calls, names: names(), sent: (calls.find(([n]) => n === "deploy") || [])[1] };
  } catch (e) {
    e.calls = calls;
    e.names = names();
    throw e;
  } finally {
    global.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const published = (sha, extra = {}) => ({ uuid: SPACE, url: "https://spacesheep.dev/@y/q3", sha, is_update: true, ...extra });
const ME = { CLAUDE_CODE_SESSION_ID: "sess-me" };
/** list_versions as today's tool answers it: the head pushed by another Claude Code session on mac-2. */
const byOther = (more = []) => ({ space: { uuid: SPACE, title: "Q3" }, versions: [
  { number: 2, name: "Edit", sha: "live22222222", latest: true, via: "mcp", pushed_by: { label: "Claude Code", machine: "mac-2", session_id: "sess-other" } },
  ...more,
] });
const filesOf = (entries) => ({ files: entries.map(([p, c]) => ({ path: p, staged_sha: stagedSha(p, Buffer.from(c)) })), version: { id: "live22222222" }, page: {} });

test("no base, live version by another session, different files: stops before any upload, naming who and the three ways on", async () => {
  const dir = page();
  await assert.rejects(run(dir, { space: SPACE }, { list_versions: byOther(), list_files: filesOf([["index.html", "<html>theirs</html>"]]) }, ME), (e) => {
    assert.deepEqual(e.names, ["list_versions", "list_files"], "no stage_begin, no upload, no deploy");
    assert.match(e.message, /^The live version \(live22222222\) was published by another session \(Claude Code on mac-2, session sess-other\)/);
    assert.match(e.message, /Pull it first with `spacesheep read 11111111-2222-4333-8444-555555555555 -o <dir>` and merge/);
    assert.match(e.message, /--base <sha>/);
    assert.match(e.message, /--replace/);
    assert.equal(e.refusal.code, "conflict");
    assert.equal(refusals.exitCodeFor(e), 1);
    assert.match(refusals.errorWords(e), /\n  What to do: merge first — spacesheep read 11111111-2222-4333-8444-555555555555 -o <folder>/);
    return true;
  });
  assert.equal(savedBase({ origin: ORIGIN, space: SPACE, dir }), null);
});

test("another account's or the browser's version counts as someone else too", async () => {
  for (const [row, who] of [
    [{ sha: "live22222222", latest: true, via: "mcp" }, "someone else (another account)"],
    [{ sha: "live22222222", latest: true, via: "viewer" }, "Shepherd"],
  ]) {
    await assert.rejects(run(page(), { space: SPACE }, { list_versions: { versions: [row] }, list_files: filesOf([["index.html", "x"]]) }, ME),
      (e) => e.message.includes(`published by ${who},`) && !e.names.includes("deploy"));
  }
});

test("no base, and the same files are live: nothing is deployed, and the folder builds on that version from now on", async () => {
  const dir = page({ uuid: SPACE, slug: "q3", deployed_sha: "old000000000" });
  // The pin's deployed_sha is the base when it has one, so this folder names none: no pin.
  fs.rmSync(path.join(dir, ".spacesheep.json"));
  const { r, names } = await run(dir, { space: SPACE }, { list_versions: byOther(), list_files: filesOf([["index.html", HTML]]) }, ME);
  assert.deepEqual(names, ["list_versions", "list_files"]);
  assert.equal(r.unchanged, true);
  assert.equal(r.sha, "live22222222");
  assert.equal(savedBase({ origin: ORIGIN, space: SPACE, dir }), "live22222222");
  assert.equal(pinOf(dir).space, SPACE);
  // The next deploy (changed files) names it, with no look first.
  fs.writeFileSync(path.join(dir, "index.html"), HTML.replace("q3", "q3, again"));
  const next = await run(dir, {}, { deploy: published("next33333333") }, ME);
  assert.equal(next.sent.base_sha, "live22222222");
  assert.ok(!next.names.includes("list_versions"));
});

test("the same files with new metadata go out, built on the live version", async () => {
  const { sent } = await run(page(), { space: SPACE, title: "Q3 final" }, { list_versions: byOther(), list_files: filesOf([["index.html", HTML]]), deploy: published("meta44444444") }, ME);
  assert.equal(sent.base_sha, "live22222222");
  assert.equal(sent.title, "Q3 final");
});

test("the server's own guess goes on as before: this session wrote the head or an older version, or nothing can be told", async () => {
  const mine = { sha: "mine11111111", via: "mcp", pushed_by: { label: "Claude Code", machine: "mac-1", session_id: "sess-me" } };
  for (const versions of [
    { versions: [{ ...mine, latest: true }] },
    byOther([mine]),
    // No session to compare on one side: the server decides.
    { versions: [{ sha: "live22222222", latest: true, via: "mcp", pushed_by: { label: "Codex", machine: "mac-1" } }] },
    // A live link's placeholder, and a blank starter: nothing to lose.
    { versions: [{ sha: "live22222222", latest: true, via: "mcp", name: "Live link started" }] },
    { versions: [{ sha: "live22222222", latest: true, via: "blank" }] },
    // Versions a viewer can't list; a server whose rows don't say who.
    "This space's version history is readable only by its owner and editors.",
    { versions: [{ id: "live22222222" }] },
  ]) {
    const { sent, names } = await run(page(), { space: SPACE }, { list_versions: versions, list_files: filesOf([["index.html", "<html>theirs</html>"]]), deploy: published("go5555555555") }, ME);
    assert.equal(sent.base_sha, undefined, JSON.stringify(versions));
    assert.ok(!names.includes("list_files"), "no file listing when the writer can't be told apart");
  }
  // The live files can't be listed (an older server): the server decides.
  const { sent } = await run(page(), { space: SPACE }, { list_versions: byOther(), deploy: published("go6666666666") }, ME);
  assert.equal(sent.base_sha, undefined);
});

test("writerOf goes by the session, the server's way", () => {
  const me = { session_id: "S" };
  assert.equal(writerOf({ via: "mcp", pushed_by: { session_id: "s" } }, me), "mine");
  assert.equal(writerOf({ via: "automation", pushed_by: { session_id: "t" } }, me), "other");
  assert.equal(writerOf({ via: "edit", pushed_by: { session_id: "s" } }, me), "other");
  assert.equal(writerOf({ via: "mcp" }, me), "other");
  assert.equal(writerOf({ via: "mcp", pushed_by: { machine: "m" } }, me), "unsure");
});

test("a pin's deployed_sha (the /sheep skill's .spacesheep.json) is the base, and is kept current", async () => {
  const dir = page({ uuid: SPACE, slug: "q3", org: null, deployed_sha: "5c111111111a", deployed_at: "2026-11-01T00:00:00Z" });
  const one = await run(dir, {}, { deploy: published("c2222222222a") }, ME);
  assert.equal(one.sent.uuid, SPACE, "the skill's uuid pins the space");
  assert.equal(one.sent.base_sha, "5c111111111a");
  assert.ok(!one.names.includes("list_versions"), "a base is named: no look first");
  assert.equal(pinOf(dir).deployed_sha, "c2222222222a");
  assert.equal(pinOf(dir).uuid, SPACE);
  // The skill publishes again later and writes a newer deployed_sha: that one is the base.
  fs.writeFileSync(path.join(dir, ".spacesheep.json"), JSON.stringify({ ...pinOf(dir), deployed_sha: "5c333333333a", deployed_at: "2099-01-01T00:00:00Z" }));
  const two = await run(dir, {}, { deploy: published("c4444444444a") }, ME);
  assert.equal(two.sent.base_sha, "5c333333333a");
  // Merged: the pin keeps the version the merge was built on, as bases.json does.
  const three = await run(dir, {}, { deploy: published("e5555555555a", { merged: { base_sha: "c4444444444a", server_sha: "x", merged: ["index.html"], kept: [] } }) }, ME);
  assert.equal(three.sent.base_sha, "c4444444444a");
  assert.equal(pinOf(dir).deployed_sha, "c4444444444a");
  // --space naming another space: the pin's sha is not its base.
  const other = await run(dir, { space: "99999999-2222-4333-8444-555555555555" }, { deploy: published("06666666666a") }, ME);
  assert.equal(other.sent.base_sha, undefined);
});

test("--base latest names the live version just read: the files replace it, said as such", async () => {
  const dir = page({ space: SPACE });
  const { sent, r, names } = await run(dir, { base: "latest" }, { list_versions: byOther(), deploy: published("rep777777777") }, ME);
  assert.equal(sent.base_sha, "live22222222");
  assert.equal(r.replaced, "live22222222");
  assert.equal(r.base_latest, true);
  assert.ok(!names.includes("list_files"));
  await assert.rejects(run(page(), { base: "latest" }, {}), (e) => /^--base latest is for updating a space/.test(e.message));
});

test("refusal words: what to do in one line, stop_retrying as the server wrote it with exit code 4", () => {
  assert.deepEqual(refusals.refusalOf({ error: "conflict", message: "m" }), { code: "conflict", message: "m" });
  assert.deepEqual(refusals.refusalOf({ code: "invalid", message: "m", violations: [] }), { code: "invalid", message: "m" });
  assert.equal(refusals.refusalOf({ error: "Space not found." }), null);
  const perm = refusals.refusalOf(`You can't change this space: only its owner, @ana, and people it was shared with as editors can. Ask @ana to share it with you with "Can edit". Nothing was changed.`);
  assert.equal(perm.permission, true);
  assert.match(refusals.nextStep(perm), /share it with you with "Can edit", or publish your own copy with --new/);
  for (const code of refusals.NO_RETRY) assert.ok(refusals.nextStep({ code }), code);
  const stop = Object.assign(new Error("x"), { refusal: { code: "stop_retrying", message: "Refused 5 times in 10 minutes: stop." } });
  assert.equal(refusals.exitCodeFor(stop), 4);
  assert.match(refusals.errorWords(stop), /^Refused 5 times in 10 minutes: stop\.\n  What to do: stop/);
  assert.equal(refusals.exitCodeFor(new Error("x")), 1);
});

test("the client never sends a refusal again; rate_limited once, after its retry_after", async () => {
  const answers = [];
  const c = new McpClient("http://x", "k");
  const waits = [];
  c.sleep = async (ms) => { waits.push(ms); };
  let n = 0;
  c.callRaw = async () => { n++; return answers.shift(); };
  const text = (o, isError) => ({ isError, content: [{ type: "text", text: JSON.stringify(o) }] });

  for (const code of ["conflict", "error", "forbidden", "invalid", "would_drop_files", "index_shrunk", "placeholder_page", "stop_retrying"]) {
    n = 0;
    answers.push(text({ error: code, message: `no (${code})` }, true));
    await assert.rejects(c.call("deploy", {}), (e) => e.refusal.code === code && e.message === `${code}: no (${code})`);
    assert.equal(n, 1, code);
    // The same word as an answer (deploy's refusals aren't isError): handed back, not retried.
    n = 0;
    answers.push(text({ error: code, message: "no" }, false));
    assert.equal((await c.call("deploy", {})).error, code);
    assert.equal(n, 1);
  }
  n = 0;
  answers.push(text({ error: "rate_limited", message: "slow down", retry_after: 3 }, true), text({ error: "rate_limited", message: "slow down", retry_after: 3 }, true));
  await assert.rejects(c.call("deploy", {}), (e) => e.refusal.code === "rate_limited");
  assert.equal(n, 2, "one retry, then the refusal");
  assert.deepEqual(waits, [3000]);
  n = 0;
  answers.push(text({ error: "rate_limited", message: "tomorrow", retry_after: 3600 }, true));
  await assert.rejects(c.call("deploy", {}), (e) => e.refusal.retry_after === 3600);
  assert.equal(n, 1, "a long wait is not waited out");
  answers.push(text({ error: "rate_limited", retry_after: 1 }, false), text({ uuid: "u", url: "x" }, false));
  assert.equal((await c.call("deploy", {})).uuid, "u");
});

// ---------------------------------------------------------------- end to end, through bin/spacesheep.js

function server(answer) {
  const deploys = [];
  const s = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const send = (status, o) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(o === undefined ? "" : JSON.stringify(o)); };
      if (req.method === "PUT") return send(200, { sha: "abcabcabcabc" });
      if (req.url === "/v1/doors.json") return send(404, { code: "not_found", message: "none" });
      if (req.url !== "/mcp") return send(404, { code: "not_found", message: "no route" });
      const m = JSON.parse(body);
      if (m.method === "notifications/initialized") return send(202);
      if (m.method === "initialize") return send(200, { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "t", version: "0" } } });
      const { name } = m.params;
      if (name === "stage_begin") return send(200, { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ upload_url: `http://127.0.0.1:${s.address().port}/up`, plan: "pro", limits: { max_files: 12000 } }) }] } });
      if (name === "deploy") deploys.push(m.params.arguments);
      return send(200, { jsonrpc: "2.0", id: m.id, result: answer(name) });
    });
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r({ s, deploys, origin: `http://127.0.0.1:${s.address().port}` })));
}
function cli(args, env, cwd) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, "..", "bin", "spacesheep.js"), ...args], { cwd, env: { PATH: process.env.PATH, SPACESHEEP_QUIET: "1", ...env } });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

test("end to end: stop_retrying prints the server's message as it is and exits 4; a permission refusal exits 1 with what to do; neither is sent twice", async () => {
  let answer;
  const { s, deploys, origin } = await server(() => answer);
  const env = { SPACESHEEP_ORIGIN: origin, SPACESHEEP_KEY: "ss_test", SPACESHEEP_CONFIG_DIR: tmp(), HOME: tmp() };
  try {
    const said = "This deploy was refused 5 times in 10 minutes with the same answer, so the server stops taking it. Nothing was deployed.";
    answer = { content: [{ type: "text", text: JSON.stringify({ error: "stop_retrying", message: said }) }] };
    const dir = page();
    const stop = await cli(["deploy", dir], env, dir);
    assert.equal(stop.code, 4, stop.err);
    assert.ok(stop.err.includes(`✗ ${said}\n  What to do: stop`), stop.err);
    assert.equal(deploys.length, 1);

    answer = { isError: true, content: [{ type: "text", text: `You can't change this space: only its owner, @ana, and people it was shared with as editors can. Ask @ana to share it with you with "Can edit". Nothing was changed.` }] };
    const perm = await cli(["deploy", page(), "--space", "https://spacesheep.dev/@ana/plan"], env, dir);
    assert.equal(perm.code, 1, perm.err);
    assert.match(perm.err, /You can't change this space/);
    assert.match(perm.err, /What to do: ask the space's owner to share it with you with "Can edit", or publish your own copy with --new/);
    assert.equal(deploys.length, 2);
  } finally { s.close(); }
});
