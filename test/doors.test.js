"use strict";
// The generic door: the doors table → the command line → the request, and back.
// test/fixtures/doors.json is 16 calls cut from the server's shared/doors.json (sessions
// list, get and export from ssapi/picks 283cd22b, which says they replace today's three).
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
    assert.match(top.out, /From the server .*\n(.*\n)*\s+spacesheep spaces\s+get, update, screenshot/);
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
  assert.match(src, /HELD = new Set\(\["talk listen", "sessions export"\]\)/);
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
