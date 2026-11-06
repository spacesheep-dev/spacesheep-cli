"use strict";
// The generic door: the doors table → the command line → the request, and back.
// test/fixtures/doors.json is 23 calls cut from the server's shared/doors.json (sessions
// list, get and export from ssapi/picks 283cd22b, which says they replace today's three;
// spaces list/create/share/delete, versions create and files list/get from ssapi/picks
// 674b4413, with the replaces lines it gave spaces update and versions list too).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const doors = require("../lib/doors");

const FIXTURE = path.join(__dirname, "fixtures", "doors.json");
const TABLE = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const ORIGIN = "http://127.0.0.1:8911";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ss-doors-"));

/** A command line → the request it sends (or the UsageError it throws). */
async function request(line, env = {}) {
  const argv = line.split(" ");
  const found = doors.match(TABLE, argv);
  assert.ok(found, `no door for ${line}`);
  const first = Array.isArray(found) ? found[0] : found;
  const { found: chosen, parsed } = await doors.resolve(found, argv.slice(first.used), { env });
  return doors.buildRequest(chosen.method, parsed.inputs, { origin: ORIGIN, key: "ss_test", version: "0.0.0" });
}
const usage = async (line, re, env = {}) => assert.rejects(request(line, env), (e) => e.code === "EUSAGE" && re.test(e.message));

test("a read: the name fills {space.id} and goes as its own input too, the saved key as Bearer", async () => {
  const r = await request("spaces get @james/plan");
  assert.equal(r.method, "GET");
  assert.equal(r.url, `${ORIGIN}/v1/spaces/%40james%2Fplan?space=%40james%2Fplan`);
  assert.equal(r.headers.Authorization, "Bearer ss_test");
  assert.equal(r.body, undefined);
});

test("an update: the item in the path, the rest a JSON body, typed by the table", async () => {
  const r = await request("spaces update 0b7c1a52-7f3e-4f6e-9d1a-0c1d2e3f4a5b --title Plan --listed --visibility PUBLIC");
  assert.equal(r.method, "PATCH");
  assert.equal(r.url, `${ORIGIN}/v1/spaces/0b7c1a52-7f3e-4f6e-9d1a-0c1d2e3f4a5b`);
  assert.equal(r.headers["Content-Type"], "application/json");
  // <space> is the name input (a link, @handle/slug or uuid): it goes as `space` too
  assert.deepEqual(JSON.parse(r.body), { space: "0b7c1a52-7f3e-4f6e-9d1a-0c1d2e3f4a5b", title: "Plan", listed: true, visibility: "public" });
  assert.deepEqual(JSON.parse((await request("spaces update x --listed false")).body), { space: "x", listed: false });
});

test("query inputs: integers and true/false as words, --flag=value too", async () => {
  const r = await request("streams list --limit=5 --health --prefix lab/");
  assert.equal(r.url, `${ORIGIN}/v1/me/streams?limit=5&health=true&prefix=lab%2F`);
});

test("a plain {var} path, and a JSON flag parsed", async () => {
  const r = await request("streams push lab/cpu --value {\"load\":0.4}");
  assert.equal(r.method, "POST");
  assert.equal(r.url, `${ORIGIN}/v1/me/streams/lab%2Fcpu:push`);
  assert.deepEqual(JSON.parse(r.body), { value: { load: 0.4 } });
});

test("a name/id pair given as a flag: the id wins the path, and stays out of the query", async () => {
  const r = await request("versions list --space-id 0b7c1a52-7f3e-4f6e-9d1a-0c1d2e3f4a5b --limit 2");
  assert.match(r.url, /\/v1\/spaces\/0b7c1a52-7f3e-4f6e-9d1a-0c1d2e3f4a5b\/versions\?limit=2$/);
  const byName = await request("versions list --space plan --limit 2");
  assert.match(byName.url, /\/v1\/spaces\/plan\/versions\?space=plan&limit=2$/);
});

test("old names keep working: talk reply <text> --to N, talk on, bare talk", async () => {
  const r = await request("talk reply all done --to 12 --session s-1");
  assert.equal(r.method, "POST");
  assert.equal(r.url, `${ORIGIN}/v1/me/talkMessages`);
  // today's `talk reply` joins its words into the text; so does the door
  // reply_to is an int64: sent as a string, protobuf JSON's form, so a strict codec takes it too
  assert.deepStrictEqual(JSON.parse(r.body), { text: "all done", reply_to: "12", session: "s-1" });
  // the table's own command doesn't: one word per arg
  await usage("talk-messages create all done", /takes no words after it/);
  const on = await request("talk on");
  assert.equal(on.method, "PATCH");
  assert.deepEqual(JSON.parse(on.body), { enabled: true });
  assert.deepEqual(JSON.parse((await request("talk off")).body), { enabled: false });
  assert.equal((await request("talk")).url, `${ORIGIN}/v1/me/talkSettings`);
  assert.equal((await request("talk status")).url, `${ORIGIN}/v1/me/talkSettings`);
});

test("set fills what an old command left out; a value it gave stays", async () => {
  assert.deepStrictEqual(JSON.parse((await request("talk on")).body), { enabled: true });
  assert.deepStrictEqual(JSON.parse((await request("talk on --enabled false")).body), { enabled: false });
  assert.deepStrictEqual(JSON.parse((await request("talk off --enabled=true")).body), { enabled: true });
});

/** An old command with the forms the MCP door's forwards use: picked by value, by a flag, or neither. */
function oldForms() {
  const call = (command, inputs, replaces) => ({
    noun: "Team", cli: { command: `spacesheep ${command}`, usage: command, args: [], flags: inputs.map((d) => ({ input: d.name, flag: `--${d.name.replace(/_/g, "-")}`, type: d.type })), replaces },
    inputs,
  });
  const member = { name: "member", type: "text" }, team = { name: "team", type: "text" }, role = { name: "role", type: "text" };
  const action = { name: "action", type: "text" }, labels = { name: "labels", type: "list of text" };
  return { services: [{ methods: [
    call("team-members create", [team, member, role], [{ command: "spacesheep crew", when: "action=add", renamed: ["1=team"], set: ["role=member"] }]),
    call("team-members delete", [team, member], [{ command: "spacesheep crew", when: "action=remove", renamed: ["action=", "1=team"], set: ["member=@me"] }]),
    call("team-logs list", [team, action], [{ command: "spacesheep crew", when: "action=log", renamed: ["1=team"], set: [] }]),
    call("teams delete", [team], [{ command: "spacesheep crew", when: "yes=true", renamed: ["1=team"], set: [] }]),
    call("team-labels update", [team, labels], [{ command: "spacesheep crew", when: "labels", renamed: ["1=team"], set: ["labels=a, b"] }]),
    call("teams get", [team], [{ command: "spacesheep crew", when: "", renamed: ["1=team"], set: [] }]),
    call("team-words create", [team, member], [{ command: "spacesheep word", when: "2=add", renamed: ["1=team", "2=", "3=member"], set: [] }]),
    call("team-words delete", [team, member], [{ command: "spacesheep word", when: "2=remove", renamed: ["1=team", "3=member"], set: [] }]),
  ] }] };
}
async function pick(line) {
  const table = oldForms(), argv = line.split(" ");
  const found = doors.match(table, argv);
  const { found: chosen, parsed } = await doors.resolve(found, argv.slice(found[0].used), { env: {} });
  return [chosen.method.cli.command.replace("spacesheep ", ""), parsed.inputs];
}

test("when field=value: given and equal as text picks that form, and the flag goes where the call has no such input", async () => {
  assert.deepStrictEqual(await pick("crew flock --action add --member @b"), ["team-members create", { team: "flock", member: "@b", role: "member" }]);
  assert.deepStrictEqual(await pick("crew flock --action=remove --member @b"), ["team-members delete", { team: "flock", member: "@b" }]);
  // a call that takes the input keeps it
  assert.deepStrictEqual(await pick("crew flock --action log"), ["team-logs list", { team: "flock", action: "log" }]);
  // a word by its number; a word dropped by the pick doesn't move the others
  assert.deepStrictEqual(await pick("word flock add @b"), ["team-words create", { team: "flock", member: "@b" }]);
  assert.deepStrictEqual(await pick("word flock remove @b"), ["team-words delete", { team: "flock", member: "@b" }]);
  // a bare flag reads as true
  assert.deepStrictEqual(await pick("crew flock --yes"), ["teams delete", { team: "flock" }]);
  assert.deepStrictEqual(await pick("crew flock --yes=true"), ["teams delete", { team: "flock" }]);
});

test("when field=value: another value, none, or the flag twice doesn't pick it", async () => {
  await assert.rejects(pick("crew flock --action nope"), (e) => e.code === "EUSAGE");
  await assert.rejects(pick("crew flock --action add --action remove --member @b"), (e) => e.code === "EUSAGE");
  await assert.rejects(pick("word flock nope @b"), (e) => e.code === "EUSAGE");
  assert.deepStrictEqual(await pick("crew flock"), ["teams get", { team: "flock" }]);
});

test("when field: an old flag or word the line gave, not an input that came from elsewhere", async () => {
  assert.deepStrictEqual(await pick("crew flock --labels x"), ["team-labels update", { team: "flock", labels: ["x"] }]);
  // today's tables: old flags and an old word
  assert.equal((await request("share x --visibility public")).method, "PATCH");
  assert.match((await request("read x index.html")).url, /\/files\/index\.html/);
  assert.match((await request("read x")).url, /\/files(\?|$)/);
});

test("set: an empty value counts as left out, in a list too; a @ word only a lookup knows is refused, not sent", async () => {
  assert.deepStrictEqual(await pick("crew flock --labels="), ["team-labels update", { team: "flock", labels: ["a", "b"] }]);
  await assert.rejects(pick("crew flock --action remove"), (e) => e.code === "EUSAGE" && /crew needs --member: this CLI can't work out @me/.test(e.message));
  // the refusal is the picked form's: no other form runs instead
  assert.deepStrictEqual(await pick("crew flock --action remove --member @b"), ["team-members delete", { team: "flock", member: "@b" }]);
});

test("a form its `when` picked keeps its refusal in any flag order, by a flag or a word; no other form runs", async () => {
  const text = (name) => ({ name, type: "text" });
  const call = (command, inputs, replaces) => ({ noun: "T", cli: { command: `spacesheep ${command}`, usage: command, args: [], flags: inputs.map((d) => ({ input: d.name, flag: `--${d.name}`, type: d.type })), replaces }, inputs });
  const table = { services: [{ methods: [
    call("t delete", [text("team")], [{ command: "spacesheep crew", when: "action=remove", renamed: ["1=team"], set: [] }]),
    // no `when`, and it takes everything: the one that would run if the refusal were lost
    call("t list", [text("team"), text("action"), text("label")], [{ command: "spacesheep crew", when: "", renamed: ["1=team"], set: [] }]),
    call("w get", [text("team"), text("file")], [{ command: "spacesheep rd", when: "2", renamed: ["1=team", "2=file"], set: [] }]),
    call("w list", [text("team"), text("note"), text("label")], [{ command: "spacesheep rd", when: "", renamed: ["1=team", "2=note"], set: [] }]),
  ] }] };
  const run = async (line) => {
    const argv = line.split(" "), found = doors.match(table, argv);
    const { found: chosen, parsed } = await doors.resolve(found, argv.slice(found[0].used), { env: {} });
    return [chosen.method.cli.command.replace("spacesheep ", ""), parsed.inputs];
  };
  const refused = (line) => assert.rejects(run(line), (e) => e.code === "EUSAGE" && /takes no --label/.test(e.message), line);
  await refused("crew f --action remove --label z");
  await refused("crew f --label z --action remove");
  await refused("crew --label z f --action remove");
  await refused("rd f a --label z");
  await refused("rd f --label z a");
  await refused("rd --label=z f a");
  // not picked: the form with no `when` still takes the line, the flag's value not a word
  assert.deepStrictEqual(await run("crew f --label z --action keep"), ["t list", { team: "f", label: "z", action: "keep" }]);
  assert.deepStrictEqual(await run("rd f --label z"), ["w list", { team: "f", label: "z" }]);
  // picked with nothing to refuse
  assert.deepStrictEqual(await run("crew f --action remove"), ["t delete", { team: "f" }]);
  assert.deepStrictEqual(await run("rd f a"), ["w get", { team: "f", file: "a" }]);
});

test("today's old commands: the same flags in either order run the same call", async () => {
  const outcome = async (line) => {
    try {
      const argv = line.split(" "), found = doors.match(TABLE, argv), first = Array.isArray(found) ? found[0] : found;
      const { found: chosen } = await doors.resolve(found, argv.slice(first.used), { env: {} });
      return chosen.method.cli.command;
    } catch (e) { assert.equal(e.code, "EUSAGE", line); return "refused"; }
  };
  const flags = ["--visibility public", "--email a@b.c", "--space s", "--message m", "--title t", "--limit 2", "--nope 1"];
  let pairs = 0;
  for (const start of ["share x", "deploy", "deploy d", "read x", "read x y", "talk on", "talk off"]) {
    for (const a of flags) for (const b of flags) {
      if (a >= b) continue;
      pairs++;
      assert.equal(await outcome(`${start} ${a} ${b}`), await outcome(`${start} ${b} ${a}`), `${start} ${a} ${b}`);
    }
  }
  assert.equal(pairs, 147);
});

test("end to end: talk on and off send what the line says, over a real request", async () => {
  const { s, seen, origin } = await server((req) => {
    if (req.url.startsWith("/v1/doors.json")) return [200, JSON.stringify(TABLE)];
    if (req.method === "PATCH") return [200, "{}"];
  });
  const env = { SPACESHEEP_ORIGIN: origin, SPACESHEEP_KEY: "ss_test", SPACESHEEP_CONFIG_DIR: tmp(), HOME: tmp() };
  try {
    for (const [args, enabled] of [[["talk", "on"], true], [["talk", "off"], false], [["talk", "on", "--enabled", "false"], false], [["talk", "off", "--enabled=true"], true]]) {
      seen.length = 0;
      assert.equal((await cli(args, env)).code, 0, args.join(" "));
      const sent = seen.filter((r) => r.method === "PATCH");
      assert.equal(sent.length, 1, args.join(" "));
      assert.deepStrictEqual(JSON.parse(sent[0].body), { enabled }, args.join(" "));
    }
  } finally { s.close(); }
});

test("a session flag left out comes from the harness", async () => {
  const r = await request("talk-messages create --text hi", { CLAUDE_CODE_SESSION_ID: "11b51bc8" });
  assert.deepEqual(JSON.parse(r.body), { text: "hi", session: "11b51bc8" });
});

test("a wrong command line is refused before any request", async () => {
  await usage("spaces get x --nope 1", /takes no --nope/);
  await usage("spaces get", /needs <space>/);
  await usage("spaces get a b", /takes only <space>/);
  await usage("streams list --limit five", /whole number/);
  await usage("spaces update x --visibility everyone", /one of private, members, signed_in, public/);
  await usage("versions list", /needs --space or --space-id/);
  await usage("streams push lab --value {nope", /takes JSON/);
  await usage("talk-messages create --text hi", /needs --session/);
  await usage("talk listen --once", /talk listen takes no --once/);
});

test("ErrorInfo: top level or under error; anything else gets one", () => {
  assert.deepEqual(doors.errorInfo(400, '{"code":"invalid","message":"Check the title.","violations":[{"field":"title","message":"at most 200 characters"}]}'),
    { code: "invalid", message: "Check the title.", violations: [{ field: "title", message: "at most 200 characters" }] });
  assert.equal(doors.errorInfo(404, '{"error":{"code":"not_found","message":"No such space."}}').code, "not_found");
  assert.equal(doors.errorInfo(502, "<html>bad gateway</html>").code, "http_502");
});

test("an answer as text lines", () => {
  assert.deepEqual(doors.plain({ space: { title: "Plan", tags: ["a", "b"], empty: "", owner: { handle: "james" } }, versions: [{ sha: "abc" }, "x"] }),
    ["space:", "  title: Plan", "  tags: a, b", "  owner:", "    handle: james", "versions:", "  - sha: abc", "  - x"]);
  assert.deepEqual(doors.plain({ files: [{ path: "index.html" }], page: { next: "" } }), ["files:", "  - path: index.html"]);
});

test("bytes in an answer go to -o, never the terminal", () => {
  const m = doors.match(TABLE, ["spaces", "screenshot"]).method;
  let written = null;
  const shown = doors.takeBytes(m, { png: Buffer.from("PNGDATA").toString("base64"), width: 390 }, "/x/shot.png", (f, b) => { written = [f, b.toString()]; });
  assert.deepEqual(written, ["/x/shot.png", "PNGDATA"]);
  assert.equal(shown.png, "7 bytes → /x/shot.png");
});

test("the table: cached per origin, revalidated by ETag, a 404 remembered for a while", async () => {
  const dir = tmp();
  const calls = [];
  let reply = { status: 200, etag: '"v1"', body: JSON.stringify(TABLE) };
  const fetchImpl = async (url, init) => {
    calls.push({ url, inm: init.headers["If-None-Match"] });
    if (reply === "down") throw new Error("ECONNREFUSED");
    return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: { get: (h) => (h === "etag" ? reply.etag : null) }, text: async () => reply.body || "" };
  };
  const at = (now) => ({ origin: ORIGIN, configDir: dir, fetchImpl, now, env: {} });
  assert.equal((await doors.loadTable(at(1))).services.length, TABLE.services.length);
  assert.equal(calls[0].url, `${ORIGIN}/v1/doors.json`);
  assert.equal(calls[0].inm, undefined);
  assert.ok(fs.existsSync(doors.cachePath(dir, ORIGIN)));
  reply = { status: 304 };
  assert.ok(await doors.loadTable(at(2)));
  assert.equal(calls[1].inm, '"v1"');
  reply = "down";
  assert.ok(await doors.loadTable(at(3)), "network trouble: the cached table");
  assert.ok(await doors.loadTable({ ...at(4), offline: true }));
  assert.equal(calls.length, 3, "offline never fetches");
  reply = { status: 404 };
  assert.equal(await doors.loadTable(at(5)), null);
  assert.equal(await doors.loadTable(at(6)), null);
  assert.equal(calls.length, 4, "a 404 is remembered");
  assert.equal(await doors.loadTable({ ...at(7), offline: true }), null);
  reply = { status: 200, etag: '"v2"', body: JSON.stringify(TABLE) };
  assert.ok(await doors.loadTable(at(6 + doors.MISSING_TTL)), "asked again once it's old");
  assert.notEqual(doors.cachePath(dir, ORIGIN), doors.cachePath(dir, "https://mcp.spacesheep.dev"));
});

// A fetch that never answers: it rejects when its signal times out, as fetch does. The
// timeout's own timer doesn't hold the event loop open (a real fetch's socket does), so
// this one holds it until then.
const hang = (init) => new Promise((_, reject) => {
  const hold = setInterval(() => {}, 1000);
  init.signal.addEventListener("abort", () => { clearInterval(hold); reject(init.signal.reason); });
});

test("the table: with none cached, `trouble` hears why there is none (a 404 isn't trouble)", async () => {
  const dir = tmp();
  let reply, asked = 0;
  const fetchImpl = async (url, init) => {
    asked++;
    if (reply === "hang") return hang(init);
    if (reply === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return { status: reply, ok: reply < 300, headers: { get: () => null }, text: async () => "<html>login</html>" };
  };
  const heard = [];
  const at = (extra = {}) => ({ origin: ORIGIN, configDir: dir, fetchImpl, now: 1, env: {}, trouble: (t) => heard.push(t), ...extra });
  reply = "hang"; assert.equal(await doors.loadTable(at({ timeout: 50 })), null);
  reply = "refused"; assert.equal(await doors.loadTable(at()), null);
  reply = 503; assert.equal(await doors.loadTable(at()), null);
  reply = 200; assert.equal(await doors.loadTable(at()), null);
  assert.deepEqual(heard.map((t) => t.why), ["no answer in 0.05 s", "couldn't connect (ECONNREFUSED)", "HTTP 503", "an answer that isn't JSON"]);
  assert.equal(heard[0].url, `${ORIGIN}/v1/doors.json`);
  assert.equal(asked, 4);
  // A server without the table, each on a fresh config (a 404 is cached, and would answer the next).
  for (const status of [404, 401, 403]) {
    reply = status;
    const before = asked;
    assert.equal(await doors.loadTable(at({ configDir: tmp() })), null, `HTTP ${status}`);
    assert.equal(asked, before + 1, `HTTP ${status}: asked the server`);
  }
  assert.equal(heard.length, 4, "a 404, 401 or 403 is a server without the table, not trouble");
});

test("the table: a cached copy that can't run the line is asked for in full (a call added since)", async () => {
  const dir = tmp();
  let mode = "ok", asked = 0;
  const get = (h) => (h === "cache-control" ? "public, max-age=60" : h === "etag" ? '"c1"' : null);
  const fetchImpl = async (url, init) => {
    asked++;
    if (mode === "hang") return hang(init);
    if (mode === "slow") await new Promise((resolve, reject) => {   // past the short revalidation
      const t = setTimeout(resolve, doors.REVALIDATE_TIMEOUT + 500);
      init.signal.addEventListener("abort", () => { clearTimeout(t); reject(init.signal.reason); });
    });
    return { status: 200, ok: true, headers: { get }, text: async () => JSON.stringify(TABLE) };
  };
  const heard = [];
  const at = (now, extra = {}) => ({ origin: ORIGIN, configDir: dir, fetchImpl, now, env: {}, timeout: doors.NEED_TIMEOUT, trouble: (t) => heard.push(t), ...extra });
  assert.ok(await doors.loadTable(at(0)));
  assert.ok(await doors.loadTable(at(1000, { can: () => true })));
  assert.equal(asked, 1, "a copy that runs the line: fresh for its max-age");
  const fetchedAt = () => JSON.parse(fs.readFileSync(doors.cachePath(dir, ORIGIN), "utf8")).fetched_at;
  mode = "slow";
  assert.ok(await doors.loadTable(at(2000, { can: () => false })));
  assert.equal(asked, 2, "one that can't, still fresh: asked anyway");
  assert.equal(fetchedAt(), 2000, "and the slow answer was waited for");
  assert.ok(await doors.loadTable(at(2000 + 61000, { can: () => false })));
  assert.equal(asked, 3, "one that can't, expired: asked");
  assert.equal(fetchedAt(), 63000, "and the slow answer was waited for");
  // One that can run the line, expired, and a server that never answers: the short wait, then it runs.
  mode = "hang";
  const t0 = Date.now();
  assert.ok(await doors.loadTable(at(63000 + 61000, { can: () => true })));
  assert.equal(asked, 4);
  assert.ok(Date.now() - t0 < doors.REVALIDATE_TIMEOUT + 1000, `waited ${Date.now() - t0} ms`);
  assert.deepEqual(heard, [], "nothing to report: the cached copy ran");
  assert.ok(await doors.loadTable(at(200000, { can: () => false, timeout: 50 })), "can't, and no answer: still the old copy");
  assert.deepEqual(heard.map((t) => t.why), ["no answer in 0.05 s"], "and why the new one didn't come");
});

test("the table: used as it is for the server's max-age; a revalidation waits only briefly", async () => {
  const dir = tmp();
  const calls = [];
  let mode = "ok";
  const fetchImpl = async (url, init) => {
    calls.push(init.headers["If-None-Match"] || null);
    if (mode === "hang") return hang(init);
    const get = (h) => (h === "cache-control" ? "public, max-age=60" : h === "etag" ? '"m1"' : null);
    if (mode === "304") return { status: 304, ok: false, headers: { get }, text: async () => "" };
    return { status: 200, ok: true, headers: { get }, text: async () => JSON.stringify(TABLE) };
  };
  const at = (now, extra = {}) => ({ origin: ORIGIN, configDir: dir, fetchImpl, now, env: {}, ...extra });
  assert.ok(await doors.loadTable(at(0)));
  assert.ok(await doors.loadTable(at(59000)));
  assert.equal(calls.length, 1, "fresh for its max-age: no request");
  mode = "304";
  assert.ok(await doors.loadTable(at(61000)));
  assert.deepEqual(calls, [null, '"m1"'], "then revalidated by ETag");
  assert.ok(await doors.loadTable(at(100000)));
  assert.equal(calls.length, 2, "a 304 starts its max-age again");
  mode = "hang";
  let heard = null;
  const t0 = Date.now();
  assert.ok(await doors.loadTable(at(200000, { timeout: doors.NEED_TIMEOUT, trouble: (t) => { heard = t; } })), "the cached table runs");
  assert.ok(Date.now() - t0 < doors.REVALIDATE_TIMEOUT + 1000, `waited ${Date.now() - t0} ms`);
  assert.equal(heard, null, "with a table to run, nothing to report");
});

// ---------------------------------------------------------------- end to end: the CLI against a local server

function server(routes) {
  const seen = [];
  const s = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const [status, text, headers] = routes(req, body) || [404, '{"code":"not_found","message":"no such route"}'];
      res.writeHead(status, { "Content-Type": "application/json", ...(headers || {}) });
      res.end(text);
    });
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r({ s, seen, origin: `http://127.0.0.1:${s.address().port}` })));
}
function cli(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, "..", "bin", "spacesheep.js"), ...args], { env: { PATH: process.env.PATH, SPACESHEEP_QUIET: "1", ...env } });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

test("end to end: spacesheep <noun> <verb> against a server that serves the table", async () => {
  const { s, seen, origin } = await server((req) => {
    if (req.url === "/v1/doors.json") return [200, JSON.stringify(TABLE), { ETag: '"t1"' }];
    if (req.method === "GET" && req.url === "/v1/me") return [200, '{"account":{"handle":"james","plan":"pro"}}'];
    if (req.method === "PATCH" && req.url.startsWith("/v1/spaces/")) return [400, '{"code":"invalid","message":"Check the title.","violations":[{"field":"title","message":"at most 200 characters"}]}'];
    if (req.method === "POST" && req.url === "/v1/me/talkMessages") return [200, '{"talk_message":{"id":"13"}}'];
    if (req.method === "POST" && req.url === "/v1/me/talkListeners") {
      const link = `http://${req.headers.host}/api/talk/listen/sst_${"a".repeat(43)}`;
      return [200, JSON.stringify({ talk_listener: { id: "l1", session: { id: "s-1" }, monitor_command: `while :; do curl -sS '${link}?by=agent'; done` } })];
    }
    if (req.method === "GET" && req.url.startsWith("/api/talk/listen/sst_")) return [200, '{"id":7,"text":"hello"}\n'];
    if (req.method === "GET" && req.url.startsWith("/v1/spaces/")) return [400, '{"code":"invalid","message":"size: takes a whole number","violations":[{"field":"size","message":"takes a whole number"},{"field":"path","message":"is required"}]}'];
  });
  const env = { SPACESHEEP_ORIGIN: origin, SPACESHEEP_CONFIG_DIR: tmp(), SPACESHEEP_KEY: "ss_e2e" };
  try {
    const me = await cli(["me", "get"], env);
    assert.equal(me.code, 0, me.err);
    assert.equal(me.out, "account:\n  handle: james\n  plan: pro\n");
    const raw = await cli(["me", "get", "--json"], env);
    assert.equal(raw.out, '{"account":{"handle":"james","plan":"pro"}}\n');
    assert.equal(seen.find((x) => x.url === "/v1/me").auth, "Bearer ss_e2e");

    const bad = await cli(["spaces", "update", "@james/plan", "--title", "x"], env);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /Check the title\.\n\s+title: at most 200 characters/);
    const badJson = await cli(["spaces", "update", "@james/plan", "--title", "x", "--json"], env);
    assert.equal(badJson.code, 1);
    assert.equal(JSON.parse(badJson.out).code, "invalid");
    // A message that is one of its violations isn't printed twice; the others still are.
    const one = await cli(["spaces", "get", "@james/plan"], env);
    assert.equal(one.code, 1);
    assert.equal(one.err, "\n  ✗ size: takes a whole number\n    path: is required\n\n");

    const before = seen.length;
    const wrong = await cli(["spaces", "get", "--nope"], env);
    assert.equal(wrong.code, 2);
    assert.match(wrong.err, /takes no --nope/);
    assert.ok(seen.slice(before).every((x) => x.url === "/v1/doors.json"), "exit 2 sends no call");

    // The table is cached now, so the old name goes through the door too.
    const reply = await cli(["talk", "reply", "done", "--to", "12", "--session", "s-1"], env);
    assert.equal(reply.code, 0, reply.err);
    assert.deepStrictEqual(JSON.parse(seen.at(-1).body), { text: "done", reply_to: "12", session: "s-1" });

    // `talk listen` keeps today's loop, now on the new call: one create, then it polls
    // the link that answers, printing each message line as it came.
    const listen = await cli(["talk", "listen", "--once", "--session", "s-1"], env);
    assert.equal(listen.code, 0, listen.err);
    assert.equal(listen.out, '{"id":7,"text":"hello"}\n');
    const minted = seen.filter((x) => x.url === "/v1/me/talkListeners");
    assert.equal(minted.length, 1);
    assert.deepStrictEqual(JSON.parse(minted[0].body), { session: "s-1" });
    assert.equal(minted[0].auth, "Bearer ss_e2e");
    assert.ok(seen.some((x) => x.url === `/api/talk/listen/sst_${"a".repeat(43)}`), "polled bare, as today");

    const help = await cli(["spaces", "update", "--help"], env);
    assert.equal(help.code, 0);
    assert.match(help.out, /spacesheep spaces update <space> \[flags\]/);
    assert.match(help.out, /--visibility <word>/);
    const verbs = await cli(["spaces"], env);
    assert.equal(verbs.code, 2);
    assert.match(verbs.out, /spacesheep spaces get <space>/);
    const top = await cli(["--help"], env);
    assert.match(top.out, /From the server .*\n(.*\n)*\s+spacesheep spaces\s+get, update, list, create, share, delete, screenshot/);
  } finally { s.close(); }
});

test("end to end: a server with no /v1/doors.json runs today's commands, unchanged", async () => {
  const { s, seen, origin } = await server(() => null);
  const env = { SPACESHEEP_ORIGIN: origin, SPACESHEEP_CONFIG_DIR: tmp(), SPACESHEEP_KEY: "ss_e2e" };
  try {
    const r = await cli(["spaces", "get", "x"], env);
    assert.equal(r.code, 1);                      // today: not a command, so the help
    assert.match(r.out, /publish web pages to spacesheep\.dev/);
    assert.deepEqual(seen.map((x) => x.url), ["/v1/doors.json"]);
    await cli(["spaces", "get", "x"], env);
    assert.equal(seen.length, 1, "the 404 is remembered");
    const w = await cli(["whoami"], env);
    assert.equal(w.code, 0);
    assert.match(w.out, /SPACESHEEP_KEY/);
    assert.equal(seen.length, 1, "today's commands don't ask again while the 404 is remembered");
  } finally { s.close(); }
});

test("end to end: a fresh config asks for the table once, even for one of today's command words", async () => {
  // `versions` is one of today's commands (`versions <space>`) and a noun in the table.
  const { s, seen, origin } = await server((req) => {
    if (req.url === "/v1/doors.json") return [200, JSON.stringify(TABLE), { ETag: '"t1"' }];
    if (req.method === "GET" && req.url.includes("versions")) return [200, '{"versions":[]}'];
  });
  const env = { SPACESHEEP_ORIGIN: origin, SPACESHEEP_CONFIG_DIR: tmp(), SPACESHEEP_KEY: "ss_e2e" };
  try {
    const r = await cli(["versions", "list", "--space", "@james/plan"], env);
    assert.equal(r.code, 0, r.err);
    assert.equal(seen[0].url, "/v1/doors.json");
    assert.ok(seen[1] && seen[1].url.includes("versions") && seen[1].auth === "Bearer ss_e2e", "the door's call, not today's");
    const n = seen.length;
    const w = await cli(["whoami"], env);
    assert.equal(w.code, 0);
    assert.equal(seen.length, n, "a cached table that doesn't name the word: no request");

    // Today's command word first, on another fresh config: one fetch, then today's command.
    const env2 = { ...env, SPACESHEEP_CONFIG_DIR: tmp() };
    const before = seen.length;
    const w2 = await cli(["whoami"], env2);
    assert.equal(w2.code, 0);
    assert.match(w2.out, /SPACESHEEP_KEY/);
    assert.deepEqual(seen.slice(before).map((x) => x.url), ["/v1/doors.json"]);
    await cli(["whoami"], env2);
    assert.equal(seen.length, before + 1, "asked once");
  } finally { s.close(); }
});

test("end to end: with no answer from the server, today's command waits only the short probe", async () => {
  const s = http.createServer(() => { /* never answers */ });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const env = { SPACESHEEP_ORIGIN: `http://127.0.0.1:${s.address().port}`, SPACESHEEP_CONFIG_DIR: tmp(), SPACESHEEP_KEY: "ss_e2e" };
  try {
    const t0 = Date.now();
    const w = await cli(["whoami"], env);
    assert.equal(w.code, 0, w.err);
    assert.ok(Date.now() - t0 < doors.PROBE_TIMEOUT + 2000, `took ${Date.now() - t0} ms`);
  } finally { s.closeAllConnections(); s.close(); }
});

test("end to end: today's command word and a verb (`versions list`) waits out a slow first table", async () => {
  // On a fresh config, the 1.5 s probe ran today's `versions <space>` for a space called
  // "list" when the server's first table took longer (staging, 6 Nov).
  const seen = [];
  const s = http.createServer((req, res) => {
    seen.push(req.url);
    const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(body); };
    if (req.url === "/v1/doors.json") setTimeout(() => send(200, JSON.stringify(TABLE)), doors.PROBE_TIMEOUT + 1000);
    else if (req.url.includes("/versions")) send(200, '{"versions":[]}');
    else send(404, '{"code":"not_found","message":"no such route"}');
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const env = { SPACESHEEP_ORIGIN: `http://127.0.0.1:${s.address().port}`, SPACESHEEP_KEY: "ss_e2e" };
  try {
    const r = await cli(["versions", "list", "--space", "@james/plan"], { ...env, SPACESHEEP_CONFIG_DIR: tmp() });
    assert.equal(r.code, 0, r.err);
    assert.ok(seen.some((u) => u.startsWith("/v1/spaces/") && u.includes("/versions")), "the door's call, not today's");
    // A space after the word (not a verb) keeps the short probe.
    const t0 = Date.now();
    await cli(["versions", "@james/plan"], { ...env, SPACESHEEP_CONFIG_DIR: tmp() });
    assert.ok(Date.now() - t0 < doors.PROBE_TIMEOUT + 900, `took ${Date.now() - t0} ms`);
  } finally { s.closeAllConnections(); s.close(); }
});

test("end to end: a new command waits out a slow first answer of the table (a cold server)", async () => {
  // Staging's first /v1/doors.json on a fresh worker took 5 to 7 s (6 Nov): past the 5 s
  // a fetch waited, so `spaces list` printed today's help and exited 1.
  const seen = [];
  const s = http.createServer((req, res) => {
    seen.push(req.url);
    const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(body); };
    if (req.url === "/v1/doors.json") setTimeout(() => send(200, JSON.stringify(TABLE)), 6000);
    else if (req.url.startsWith("/v1/spaces")) send(200, "{}");
    else send(404, '{"code":"not_found","message":"no such route"}');
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const env = { SPACESHEEP_ORIGIN: `http://127.0.0.1:${s.address().port}`, SPACESHEEP_CONFIG_DIR: tmp(), SPACESHEEP_KEY: "ss_e2e" };
  try {
    const r = await cli(["spaces", "list"], env);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(seen, ["/v1/doors.json", "/v1/spaces"]);
    assert.equal(r.out, "");
    assert.equal(r.err, "  No spaces.\n", "an empty list says so, not just done");
  } finally { s.closeAllConnections(); s.close(); }
});

test("end to end: a call the server added since the cached table still runs on a slow server", async () => {
  // The cached table (fresh for its max-age) has no `me get`; the server's new one takes 2.5 s.
  const OLD = { ...TABLE, services: TABLE.services.map((sv) => ({ ...sv, methods: (sv.methods || []).filter((m) => !(m.cli && /\bme get$/.test(m.cli.command))) })) };
  let asked = 0;
  const seen = [];
  const s = http.createServer((req, res) => {
    seen.push(req.url);
    const send = (status, body, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(body); };
    const cache = { "Cache-Control": "public, max-age=60" };
    if (req.url === "/v1/doors.json") {
      asked++;
      if (asked === 1) return send(200, JSON.stringify(OLD), { ...cache, ETag: '"old"' });
      if (asked === 2) return setTimeout(() => send(200, JSON.stringify(TABLE), { ...cache, ETag: '"new"' }), 2500);
      return send(503, "<html>busy</html>");
    }
    if (req.url.startsWith("/v1/spaces")) return send(200, "{}");
    if (req.url === "/v1/me") return send(200, '{"account":{"handle":"james"}}');
    send(404, '{"code":"not_found","message":"no such route"}');
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const env = { SPACESHEEP_ORIGIN: `http://127.0.0.1:${s.address().port}`, SPACESHEEP_CONFIG_DIR: tmp(), SPACESHEEP_KEY: "ss_e2e" };
  try {
    assert.equal((await cli(["spaces", "list"], env)).code, 0);
    const me = await cli(["me", "get"], env);
    assert.equal(me.code, 0, me.err);
    assert.equal(me.out, "account:\n  handle: james\n");
    assert.deepEqual(seen, ["/v1/doors.json", "/v1/spaces", "/v1/doors.json", "/v1/me"]);
    // A word no cached table has, and the server can't say: why, not today's help.
    const notes = await cli(["notes", "list"], env);
    assert.equal(notes.code, 1);
    assert.equal(notes.out, "");
    assert.match(notes.err, /didn't come: HTTP 503/);
  } finally { s.closeAllConnections(); s.close(); }
});

test("end to end: a new command says the table didn't come, instead of today's help", async () => {
  const { s, origin } = await server((req) => (req.url === "/v1/doors.json" ? [503, "<html>busy</html>"] : null));
  const env = { SPACESHEEP_ORIGIN: origin, SPACESHEEP_CONFIG_DIR: tmp(), SPACESHEEP_KEY: "ss_e2e" };
  try {
    const r = await cli(["spaces", "list"], env);
    assert.equal(r.code, 1);
    assert.equal(r.out, "", "not today's help");
    assert.match(r.err, /The server's list of commands didn't come: HTTP 503, from http:\/\/127\.0\.0\.1:\d+\/v1\/doors\.json\./);
    assert.match(r.err, /"spaces" isn't one of this CLI's own commands/);
    const w = await cli(["whoami"], env);
    assert.equal(w.code, 0, "today's commands still run");
  } finally { s.close(); }
});

// A server with the new calls and no MCP: any fall-back to today's tools is a 404 here.
function newCallsOnly() {
  return server((req) => {
    if (req.url === "/v1/doors.json") return [200, JSON.stringify(TABLE), { ETag: '"t2"' }];
    if (req.method === "POST" && req.url === "/v1/me/talkListeners") {
      const link = `http://${req.headers.host}/api/talk/listen/sst_${"b".repeat(43)}`;
      return [200, JSON.stringify({ talk_listener: { id: "l2", session: { id: "s-2" }, monitor_command: `while :; do curl -sS '${link}?by=agent'; done` } })];
    }
    if (req.method === "GET" && req.url.startsWith("/api/talk/listen/sst_")) return [200, '{"id":8,"text":"hi"}\n'];
    if (req.method === "GET" && req.url.startsWith("/v1/me/sessions:export")) return [200, JSON.stringify({ download_url: `http://${req.headers.host}/dl/sse_z`, curl_command: "curl …", expires_at: "2026-11-05T12:00:00Z" })];
    if (req.method === "GET" && req.url === "/dl/sse_z") return [200, "zip-bytes"];
  });
}
async function heldOnNewCalls(env, seen, before = () => {}) {
  before();
  const listen = await cli(["talk", "listen", "--once", "--session", "s-2"], env);
  assert.equal(listen.code, 0, listen.err);
  assert.equal(listen.out, '{"id":8,"text":"hi"}\n');
  assert.equal(seen.filter((x) => x.url === "/v1/me/talkListeners").length, 1);
  const zip = path.join(tmp(), "s.zip");
  before();
  const ex = await cli(["sessions", "export", "--zip", zip], env);
  assert.equal(ex.code, 0, ex.err);
  assert.equal(fs.readFileSync(zip, "utf8"), "zip-bytes");
  assert.ok(seen.some((x) => x.url.startsWith("/v1/me/sessions:export")), "export's link from the new call");
  assert.deepEqual(seen.filter((x) => x.url.startsWith("/mcp")), [], "no fall-back to today's tools");
}

test("end to end: talk listen and sessions export use the table just fetched, where it can't be cached", async () => {
  const { s, seen, origin } = await newCallsOnly();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "doors"), "");   // a file where the cache folder goes: every write fails
  const env = { SPACESHEEP_ORIGIN: origin, SPACESHEEP_CONFIG_DIR: dir, SPACESHEEP_KEY: "ss_e2e" };
  try {
    await heldOnNewCalls(env, seen);
    assert.ok(!fs.existsSync(doors.cachePath(dir, origin)), "nothing was cached");
  } finally { s.close(); }
});

test("end to end: a cached table older than the server's doesn't hide the new calls", async () => {
  // Cached before the server had Talk or sessions: door() leaves `talk` and `sessions` to today's
  // commands without asking, so the new call fetches the table itself.
  const { s, seen, origin } = await newCallsOnly();
  const dir = tmp();
  const named = (m) => [m.cli && m.cli.command, ...((m.cli && m.cli.replaces) || []).map((r) => r.command)].some((c) => /^spacesheep (talk|sessions)\b/.test(c || ""));
  const old = { ...TABLE, services: TABLE.services.map((sv) => ({ ...sv, methods: (sv.methods || []).filter((m) => !named(m)) })) };
  assert.ok(!doors.namesWord(old, "talk") && !doors.namesWord(old, "sessions"));
  fs.mkdirSync(path.join(dir, "doors"));
  // Before each command: the old table again (the one before it fetched and cached the new one).
  const stale = () => fs.writeFileSync(doors.cachePath(dir, origin), JSON.stringify({ origin, etag: '"t1"', fetched_at: Date.now(), table: old }));
  const env = { SPACESHEEP_ORIGIN: origin, SPACESHEEP_CONFIG_DIR: dir, SPACESHEEP_KEY: "ss_e2e" };
  try {
    await heldOnNewCalls(env, seen, stale);
  } finally { s.close(); }
});

test("a command that replaces today's of the same name: today's flags map, its own work too", async () => {
  // ssapi/picks 283cd22b: sessions list|get|export each replace today's command of that name.
  const found = doors.match(TABLE, ["sessions", "list"]);
  assert.ok(found.via && found.via.command === "spacesheep sessions list");
  assert.equal((await request("sessions list --offset 5 --state done")).url, `${ORIGIN}/v1/me/sessions?after=5&state=done`);
  assert.equal((await request("sessions list --since 1730000000000")).url, `${ORIGIN}/v1/me/sessions?since=1730000000000`);
  assert.equal((await request("sessions list --after 5 --limit 3")).url, `${ORIGIN}/v1/me/sessions?after=5&limit=3`);
  // today's `get <id> --source codex`: word 1 is the session, --source is dropped
  assert.equal((await request("sessions get 019a-77 --source codex --limit 4")).url, `${ORIGIN}/v1/me/sessions/019a-77?limit=4`);
  assert.equal((await request("sessions get codex:019a-77")).url, `${ORIGIN}/v1/me/sessions/codex%3A019a-77`);
  await usage("sessions list --zip x.zip", /sessions list takes no --zip/);
  // its help is its own: no "(spacesheep sessions list runs this)" for itself
  const help = doors.helpFor(found);
  assert.match(help, /spacesheep sessions list \[flags\]/);
  assert.doesNotMatch(help, /runs this/);
  assert.doesNotMatch(help, /→/);
});

test("today's commands the table names: here until it replaces them; talk listen and sessions export stay", async () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "bin", "spacesheep.js"), "utf8");
  assert.match(src, /SAME = new Set\(\["sessions list", "sessions get", "sessions export"\]\)/);
  assert.match(src, /HELD = new Set\(\["talk listen", "sessions export", "deploy", "read", "share", "delete"\]\)/);
  assert.match(src, /HELD\.has\(said\) \|\| \(SAME\.has\(said\) && !first\.via\)/);
  // `talk listen` comes in by an old name; HELD keeps it here, on the new call.
  assert.ok(doors.match(TABLE, ["talk", "listen"])[0].via);
});

test("end to end: sessions list goes to the door once the table replaces it, and stays here until then", async () => {
  const noReplace = JSON.parse(JSON.stringify(TABLE));
  for (const svc of noReplace.services) for (const m of svc.methods) if (/^Sessions?$/.test(m.noun)) m.cli.replaces = [];
  let table = TABLE;
  const { s, seen, origin } = await server((req) => {
    if (req.url === "/v1/doors.json") return [200, JSON.stringify(table)];
    if (req.method === "GET" && req.url.startsWith("/v1/me/sessions")) return [200, '{"sessions":[{"id":"s1","title":"Plan","machine":"mac"}],"page":{"next":""}}'];
  });
  try {
    const env = { SPACESHEEP_ORIGIN: origin, SPACESHEEP_CONFIG_DIR: tmp(), SPACESHEEP_KEY: "ss_e2e" };
    const r = await cli(["sessions", "list", "--offset", "5"], env);
    assert.equal(r.code, 0, r.err);
    assert.equal(seen.at(-1).url, "/v1/me/sessions?after=5");
    assert.equal(r.out, "sessions:\n  - id: s1\n    title: Plan\n    machine: mac\n");

    // A table that names it without replacing it: today's command runs (over MCP here).
    table = noReplace;
    const env2 = { ...env, SPACESHEEP_CONFIG_DIR: tmp() };
    const before = seen.length;
    await cli(["sessions", "list", "--offset", "5"], env2);
    assert.ok(seen.slice(before).every((x) => !x.url.startsWith("/v1/me/sessions")), "today's, not the door's");
  } finally { s.close(); }
});

test("today's list and versions <space> come in by the table's new lines; versions list|create stay the new commands", async () => {
  // ssapi/picks 674b4413: list → spaces list, versions <space> → versions list (1=space).
  const list = doors.match(TABLE, ["list"]);
  assert.equal(list[0].method.cli.command, "spacesheep spaces list");
  assert.equal(list[0].via.command, "spacesheep list");
  assert.equal((await request("list")).url, `${ORIGIN}/v1/spaces`);
  assert.equal((await request("list --include-archived")).url, `${ORIGIN}/v1/spaces?include_archived=true`);
  const v = await request("versions @james/plan --limit 3");
  assert.equal(v.method, "GET");
  assert.equal(v.url, `${ORIGIN}/v1/spaces/%40james%2Fplan/versions?limit=3&space=%40james%2Fplan`);
  await usage("versions", /spacesheep versions needs <space>/);
  // `versions list` and `versions create` are the new commands, never a space called "list".
  const vl = doors.match(TABLE, ["versions", "list", "--space", "x"]);
  assert.equal(vl.method.cli.command, "spacesheep versions list");
  assert.equal(vl.via, null);
  assert.equal(doors.match(TABLE, ["versions", "create", "--space", "x"]).method.cli.command, "spacesheep versions create");
  assert.equal((await request("versions list --space x")).url, `${ORIGIN}/v1/spaces/x/versions?space=x`);
  assert.deepStrictEqual(JSON.parse((await request("versions create --space x --label v2")).body), { space: "x", label: "v2" });
  await usage("versions list", /versions list needs --space or --space-id/);
  // The four that stay hand-written are named too: the CLI holds them (HELD), not the table.
  for (const w of ["deploy", "read", "share", "delete"]) assert.ok(doors.match(TABLE, [w, "x"]), `${w} is in the table`);
});

test("end to end: list and versions <space> run on the door; deploy, read, share and delete stay today's", async () => {
  const { s, seen, origin } = await server((req) => {
    if (req.url === "/v1/doors.json") return [200, JSON.stringify(TABLE), { ETag: '"t3"' }];
    if (req.method === "GET" && req.url === "/v1/spaces") return [200, '{"spaces":[{"id":"u1","title":"Plan"}],"page":{"next":""}}'];
    if (req.method === "GET" && req.url.startsWith("/v1/spaces/%40james%2Fplan/versions")) return [200, '{"versions":[{"id":"v1","label":"first"}],"page":{"next":""}}'];
  });
  const env = { SPACESHEEP_ORIGIN: origin, SPACESHEEP_CONFIG_DIR: tmp(), SPACESHEEP_KEY: "ss_e2e" };
  try {
    const list = await cli(["list"], env);
    assert.equal(list.code, 0, list.err);
    assert.equal(seen.at(-1).url, "/v1/spaces");
    assert.equal(seen.at(-1).auth, "Bearer ss_e2e");
    assert.equal(list.out, `·  ${"Plan".padEnd(42)} ${"".padEnd(10)} u1\n`);
    const json = await cli(["list", "--json"], env);
    assert.equal(json.out, '{"spaces":[{"id":"u1","title":"Plan"}],"page":{"next":""}}\n');
    const v = await cli(["versions", "@james/plan"], env);
    assert.equal(v.code, 0, v.err);
    assert.equal(seen.at(-1).url, "/v1/spaces/%40james%2Fplan/versions?space=%40james%2Fplan");
    assert.equal(v.out, `${"v1".padEnd(13)} ${"".padEnd(17)} first\n`);
    assert.deepEqual(seen.filter((x) => x.url.startsWith("/mcp")), [], "the door's calls, not today's tools");

    // The held four on a fresh config: no table, no door call, straight to today's tools
    // (this server has no MCP, so each fails there, at exit 1 rather than the door's 2).
    const site = tmp();
    fs.writeFileSync(path.join(site, "index.html"), "<h1>hi</h1>");
    for (const args of [["deploy", site], ["read", "x"], ["read", "x", "index.html", "-o", tmp()], ["share", "x", "--visibility", "public"], ["delete", "x", "--yes"]]) {
      const before = seen.length;
      const r = await cli(args, { ...env, SPACESHEEP_CONFIG_DIR: tmp() });
      assert.equal(r.code, 1, `${args.join(" ")}: ${r.err}`);
      const urls = seen.slice(before).map((x) => x.url);
      assert.ok(urls.length && urls.every((u) => u.startsWith("/mcp")), `${args[0]} asked ${JSON.stringify(urls)}`);
    }
  } finally { s.close(); }
});

test("today's list and versions <space> print today's one line a row; --json and the new commands keep theirs", async () => {
  const space = { id: "u1", name: "@james/plan", title: "Plan", emoji: "📄", visibility: "private", url: "https://spacesheep.dev/@james/plan" };
  const version = { id: "c21e11581f5b", label: "first", author: { name: "james" }, created_at: "2026-11-05T16:10:26.037Z" };
  let spaces = JSON.stringify({ spaces: [space], page: { next: "" } });
  const versions = JSON.stringify({ versions: [version], page: { next: "" } });
  const { s, origin } = await server((req) => {
    if (req.url === "/v1/doors.json") return [200, JSON.stringify(TABLE)];
    if (req.url.startsWith("/v1/spaces/plan/versions")) return [200, versions];
    if (req.url === "/v1/spaces") return [200, spaces];
  });
  const env = { SPACESHEEP_ORIGIN: origin, SPACESHEEP_CONFIG_DIR: tmp(), SPACESHEEP_KEY: "ss_e2e" };
  try {
    assert.equal((await cli(["list"], env)).out, `📄 ${"Plan".padEnd(42)} ${"private".padEnd(10)} https://spacesheep.dev/@james/plan\n`);
    assert.equal((await cli(["versions", "plan"], env)).out, `${"c21e11581f5b".padEnd(13)} ${"2026-11-05T16:10".padEnd(17)} first\n`);
    assert.equal((await cli(["list", "--json"], env)).out, `${spaces}\n`);
    assert.equal((await cli(["versions", "plan", "--json"], env)).out, `${versions}\n`);
    assert.match((await cli(["spaces", "list"], env)).out, /^spaces:\n  - id: u1\n/);
    assert.match((await cli(["versions", "list", "--space", "plan"], env)).out, /^versions:\n  - id: c21e11581f5b\n/);
    // Nothing to list says nothing, as today.
    spaces = '{"spaces":[],"page":{"next":""}}';
    const none = await cli(["list"], env);
    assert.deepEqual([none.code, none.out, none.err], [0, "", ""]);
  } finally { s.close(); }
});

test("end to end: talk on and off write this machine's flag on the new call; talk and talk status say it", async () => {
  let enabled = false;
  const answer = () => ({ enabled, allowed: true, settings_url: "https://spacesheep.dev/settings" });
  const { s, seen, origin } = await server((req, body) => {
    if (req.url === "/v1/doors.json") return [200, JSON.stringify(TABLE)];
    if (req.url === "/v1/me/talkSettings") {
      if (req.method === "PATCH") ({ enabled } = JSON.parse(body));
      return [200, JSON.stringify({ talk_settings: answer() })];
    }
    if (req.method === "POST" && req.url === "/v1/me/talkMessages") return [200, '{"talk_message":{"id":"7"}}'];
  });
  const config = tmp();
  const env = { SPACESHEEP_ORIGIN: origin, SPACESHEEP_KEY: "ss_test", SPACESHEEP_CONFIG_DIR: config, HOME: tmp() };
  const flag = () => { try { return JSON.parse(fs.readFileSync(path.join(config, "config.json"), "utf8")).talk; } catch { return undefined; } };
  const printed = async (args) => { const r = await cli(args, env); assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}`); return JSON.parse(r.out); };
  try {
    assert.deepStrictEqual(await printed(["talk", "on"]), answer());
    assert.equal(enabled, true);
    assert.equal(flag(), true);
    for (const args of [["talk"], ["talk", "status"]]) assert.deepStrictEqual(await printed(args), { ...answer(), this_machine: true });

    assert.deepStrictEqual(await printed(["talk", "off"]), answer());
    assert.equal(enabled, false);
    assert.equal(flag(), undefined);
    assert.deepStrictEqual(await printed(["talk", "status"]), { ...answer(), this_machine: false });

    // What the line says wins over the word, and the flag follows what was sent.
    await printed(["talk", "off", "--enabled=true"]);
    assert.deepEqual([enabled, flag()], [true, true]);
    await printed(["talk", "on", "--enabled", "false"]);
    assert.deepEqual([enabled, flag()], [false, undefined]);
    const bad = await cli(["talk", "on", "--enabled", "maybe"], env);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /--enabled takes true or false/);
    assert.equal(flag(), undefined);

    // `talk reply` isn't held: it runs on the door.
    assert.equal((await cli(["talk", "reply", "done", "--session", "s-1"], env)).code, 0);
    assert.equal(seen.at(-1).url, "/v1/me/talkMessages");
    assert.deepEqual(seen.filter((x) => x.url.startsWith("/mcp")), [], "the new calls, not today's tools");
  } finally { s.close(); }
});

test("end to end: a refused talk on writes no flag, and a refused key exits 3", async () => {
  let refusal = [403, '{"code":"forbidden","message":"Talking to sessions is part of Pro and Team.","violations":[]}'];
  const { s, origin } = await server((req) => {
    if (req.url === "/v1/doors.json") return [200, JSON.stringify(TABLE)];
    if (req.url === "/v1/me/talkSettings") return refusal;
  });
  const config = tmp();
  const env = { SPACESHEEP_ORIGIN: origin, SPACESHEEP_KEY: "ss_test", SPACESHEEP_CONFIG_DIR: config, HOME: tmp() };
  try {
    const off = await cli(["talk", "on"], env);
    assert.equal(off.code, 1);
    assert.match(off.err, /✗ Talking to sessions is part of Pro and Team\./);
    assert.ok(!fs.existsSync(path.join(config, "config.json")), "no flag for a switch that didn't move");
    refusal = [401, '{"code":"unauthenticated","message":"Unknown or revoked API key","violations":[]}'];
    assert.equal((await cli(["talk", "on"], env)).code, 3);
    assert.equal((await cli(["talk", "status"], env)).code, 3);
  } finally { s.close(); }
});

/** One MCP exchange on a local server: `answer(name, args)` is a tool's whole result. */
function mcpExchange(body, answer) {
  const m = JSON.parse(body);
  if (m.method === "notifications/initialized") return [202, ""];
  if (m.method === "initialize") return [200, JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "0" } } })];
  return [200, JSON.stringify({ jsonrpc: "2.0", id: m.id, result: answer(m.params.name, m.params.arguments) })];
}
const toolError = (text) => ({ isError: true, content: [{ type: "text", text }] });

test("end to end: where the server has no table, talk on and status use today's tool and still write the flag", async () => {
  const calls = [];
  const { s, origin } = await server((req, body) => {
    if (req.url === "/mcp") return mcpExchange(body, (name, args) => { calls.push([name, args]); return { content: [{ type: "text", text: JSON.stringify({ enabled: true, allowed: true }) }] }; });
  });
  const config = tmp();
  const env = { SPACESHEEP_ORIGIN: origin, SPACESHEEP_KEY: "ss_test", SPACESHEEP_CONFIG_DIR: config, HOME: tmp() };
  try {
    assert.deepEqual(JSON.parse((await cli(["talk", "on"], env)).out), { enabled: true, allowed: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(config, "config.json"), "utf8")).talk, true);
    assert.deepEqual(JSON.parse((await cli(["talk", "status"], env)).out), { enabled: true, allowed: true, this_machine: true });
    assert.deepEqual(calls, [["talk_settings", { enabled: true }], ["talk_settings", {}]]);
  } finally { s.close(); }
});

test("end to end: a tool's refusal prints its sentence, in either server's words; talk listen still goes by its code", async () => {
  let refusal;
  const { s, origin } = await server((req, body) => {
    if (req.url === "/mcp") return mcpExchange(body, () => toolError(refusal));
  });
  const env = { SPACESHEEP_ORIGIN: origin, SPACESHEEP_KEY: "ss_test", SPACESHEEP_CONFIG_DIR: tmp(), HOME: tmp() };
  const said = async (text) => {
    refusal = text;
    const r = await cli(["read", "x"], env);
    assert.equal(r.code, 1, text);
    assert.ok(!r.err.includes('"code"'), r.err);
    return r.err.trim();
  };
  try {
    // ErrorInfo as the MCP door sends it (pretty-printed JSON), with what each violation adds.
    assert.equal(await said(JSON.stringify({ code: "not_found", message: "No such space.", violations: [] }, null, 2)), "✗ No such space.");
    assert.equal(await said(JSON.stringify({ code: "invalid", message: "Check the request.", violations: [{ field: "path", message: "at most 300 characters" }] }, null, 2)), "✗ Check the request.\n    path: at most 300 characters");
    assert.equal(await said(JSON.stringify({ code: "invalid", message: "path: at most 300 characters", violations: [{ field: "path", message: "at most 300 characters" }] })), "✗ path: at most 300 characters");
    // Today's tools: {error}, or plain words.
    assert.equal(await said('{"error":"Space not found."}'), "✗ Space not found.");
    assert.equal(await said("Space not found."), "✗ Space not found.");

    // talk_listen forwarded to the new call: its forbidden is the stopped line, exit 0, through the real client.
    refusal = JSON.stringify({ code: "forbidden", message: "Talking to sessions is part of Pro and Team.", violations: [] }, null, 2);
    const listen = await cli(["talk", "listen", "--session", "s-1"], env);
    assert.equal(listen.code, 0, listen.err);
    assert.deepEqual(JSON.parse(listen.out), { spacesheep_talk: false, stopped: "Talking to sessions is part of Pro and Team." });
  } finally { s.close(); }
});
