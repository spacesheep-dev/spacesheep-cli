"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const tls = require("node:tls");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fetch, userAgent } = require("../lib/http");
const { McpClient } = require("../lib/mcp");
const { connectWithKey } = require("../lib/login");
const { Mirror, addressMap } = require("../lib/mirror");
const { fetchSkill } = require("../lib/skills");
const { listenLoop } = require("../lib/talk");
const { run: exportSessions } = require("../lib/session-export");

const UA = `spacesheep-cli/${require("../package.json").version} (+https://github.com/spacesheep-dev/spacesheep-cli) Node/${process.versions.node}`;

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("HTTP: the identity uses the package version, project URL and running Node version", () => {
  assert.equal(userAgent(), UA);
});

test("HTTP: all header forms identify the CLI without losing request options or caller headers", async (t) => {
  const seen = [];
  const origin = await serve(t, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    seen.push({ headers: req.headers, method: req.method, body });
    res.end("ok");
  });
  for (const headers of [
    { Authorization: "Bearer test", "uSeR-aGeNt": "browser" },
    [["Authorization", "Bearer test"], ["User-Agent", "curl"]],
    new Headers({ Authorization: "Bearer test", "User-Agent": "node" }),
  ]) {
    const before = [...new Headers(headers)];
    const r = await fetch(origin, { method: "PUT", body: "bytes", headers });
    assert.equal(await r.text(), "ok");
    assert.deepEqual([...new Headers(headers)], before);
    assert.equal(seen.at(-1).headers["user-agent"], UA);
    assert.equal(seen.at(-1).headers.authorization, "Bearer test");
    assert.equal(seen.at(-1).method, "PUT");
    assert.equal(seen.at(-1).body, "bytes");
  }
  await (await fetch(origin)).text();
  assert.equal(seen.at(-1).headers["user-agent"], UA);
  await (await fetch(new Request(origin, { headers: { "X-Test": "request" } }))).text();
  assert.equal(seen.at(-1).headers["user-agent"], UA);
  assert.equal(seen.at(-1).headers["x-test"], "request");
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(fetch(origin, { signal: ctl.signal }), { name: "AbortError" });
});

test("HTTP: MCP initialization, tool calls and key connection all identify the CLI", async (t) => {
  const agents = [];
  const origin = await serve(t, async (req, res) => {
    agents.push(req.headers["user-agent"]);
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/account/keys/connect") return res.end(JSON.stringify({ key: "ss_test" }));
    if (!body.id) { res.writeHead(202); return res.end(); }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "{}" }] } }));
  });
  await new McpClient(origin, "ss_test").call("whoami");
  await connectWithKey(origin, "ss_test", "test", () => {});
  assert.deepEqual(agents, [UA, UA, UA, UA]);
});

test("HTTP: the mirror's raw WebSocket handshake identifies the CLI, replacing the browser UA", async (t) => {
  const writes = [];
  const out = { write: (s) => writes.push(s), pipe() {}, on() {}, destroy() {} };
  t.mock.method(tls, "connect", (_opts, connected) => { queueMicrotask(connected); return out; });
  const mirror = Object.create(Mirror.prototype);
  mirror.map = addressMap("https://spacesheep.dev", "https://spacesheep.app", 4280);
  mirror.cookies = async () => "ss_app=test";
  const req = { url: "/api/inbox/ws", headers: {
    host: "localhost:4280", origin: "http://localhost:4280", "user-agent": "Mozilla/5.0",
    "sec-websocket-key": "test", "sec-websocket-version": "13",
  } };
  await mirror.upgrade(req, { pipe() {}, on() {}, destroy() {} }, Buffer.alloc(0));
  assert.equal(writes.length, 1);
  assert.ok(writes[0].includes(`\r\nuser-agent: ${UA}\r\n`));
  assert.ok(writes[0].includes("\r\nsec-websocket-key: test\r\n"));
  assert.doesNotMatch(writes[0], /Mozilla/);
});

test("HTTP: skill downloads identify the CLI", async (t) => {
  let ua;
  const origin = await serve(t, (req, res) => {
    ua = req.headers["user-agent"];
    res.end("<!-- spacesheep-skill-version: 1.0.0 -->");
  });
  await fetchSkill(origin);
  assert.equal(ua, UA);
});

test("HTTP: Talk polling and session export downloads identify the CLI", async (t) => {
  const agents = [];
  const origin = await serve(t, (req, res) => {
    agents.push(req.headers["user-agent"]);
    res.end("fixture");
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-http-export-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(await listenLoop(origin, { once: true, write() {} }), "delivered");
  await exportSessions({ _: ["export"], zip: path.join(dir, "sessions.zip") },
    async () => ({ download_url: origin, sessions: 1 }), () => {}, () => {});
  assert.deepEqual(agents, [UA, UA]);
});
