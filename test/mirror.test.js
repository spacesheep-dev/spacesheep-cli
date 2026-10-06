"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { Mirror, addressMap, localPolicy, localCookie, streamRewriter } = require("../lib/mirror");

const U = "8798812f-8f6f-4b3a-8a9e-c1a40424a4d7";
const map = addressMap("https://spacesheep.dev", "https://spacesheep.app", 4280);

test("only localhost hosts are answered, each mapped to the origin it stands for", () => {
  assert.deepEqual(map.upstream("localhost:4280"), { kind: "site", origin: "https://spacesheep.dev" });
  assert.deepEqual(map.upstream("preview.localhost:4280"), { kind: "site", origin: "https://spacesheep.dev" });
  assert.deepEqual(map.upstream(`${U}.localhost:4280`), { kind: "space", origin: `https://${U}.spacesheep.app`, uuid: U });
  assert.deepEqual(map.upstream("content.localhost:4280"), { kind: "content", origin: "https://spacesheep.app" });
  assert.equal(map.upstream("evil.example:4280"), null);          // a rebinding page's Host
  assert.equal(map.upstream("plan.localhost:4280"), null);
});

test("addresses in bodies and headers become local, in every spelling a page uses", () => {
  assert.equal(map.toLocal('<a href="https://spacesheep.dev/@misha/plan">'), '<a href="http://localhost:4280/@misha/plan">');
  assert.equal(map.toLocal(`<iframe src="https://${U}.spacesheep.app/">`), `<iframe src="http://${U}.localhost:4280/">`);
  assert.equal(map.toLocal("new WebSocket('wss://spacesheep.dev/api/inbox/ws')"), "new WebSocket('ws://localhost:4280/api/inbox/ws')");
  assert.equal(map.toLocal("//spacesheep.app/anchor.js"), "//content.localhost:4280/anchor.js");
  assert.equal(map.toLocal("mail me at hi@spacesheep.dev or see spacesheep.dev"), "mail me at hi@spacesheep.dev or see spacesheep.dev");
  assert.equal(map.toLocal("https://spacesheep.dev.evil.com/x"), "https://spacesheep.dev.evil.com/x");
});

test("a request's Origin and Referer go out as the upstream origin they stand for", () => {
  assert.equal(map.toUpstream("http://localhost:4280"), "https://spacesheep.dev");
  assert.equal(map.toUpstream("http://localhost:4280/@misha/plan?x=1"), "https://spacesheep.dev/@misha/plan?x=1");
  assert.equal(map.toUpstream(`http://${U}.localhost:4280`), `https://${U}.spacesheep.app`);
  assert.equal(map.toUpstream("https://evil.example"), "https://evil.example");
  assert.ok(map.isOwnOrigin("http://localhost:4280"));
  assert.ok(map.isOwnOrigin(`http://${U}.localhost:4280`));
  assert.ok(!map.isOwnOrigin("http://localhost:9999"));
  assert.ok(!map.isOwnOrigin("https://evil.example"));
  assert.ok(!map.isOwnOrigin(undefined));
});

test("a streamed page is rewritten piece by piece without cutting an address — even mid-character", () => {
  const page = `<p>é</p><a href="https://spacesheep.dev/@misha/plan">x</a><iframe src="https://${U}.spacesheep.app/"></iframe>`;
  const whole = map.toLocal(page);
  const bytes = Buffer.from(page);
  for (let size = 1; size <= 40; size++) {
    const r = streamRewriter((t) => map.toLocal(t));
    let out = "";
    for (let i = 0; i < bytes.length; i += size) out += r.push(bytes.subarray(i, i + size));
    out += r.end();
    assert.equal(out, whole, `chunks of ${size}`);
  }
  // Text already complete goes out at once (here: everything up to the last delimiter).
  assert.equal(streamRewriter((t) => t.toUpperCase()).push(Buffer.from("<b>early</b> rest")), "<B>EARLY</B> ");
});

test("the page's policy keeps everything but its frame rule, with local origins", () => {
  assert.equal(localPolicy(`default-src 'self'; frame-ancestors 'none'; frame-src https://${U}.spacesheep.app`, map), `default-src 'self'; frame-src http://${U}.localhost:4280`);
  assert.equal(localPolicy("frame-ancestors 'none'", map), "");
});

test("cookies lose their domain, and the session cookie never reaches the browser", () => {
  assert.equal(localCookie("ss_theme=dark; Domain=.spacesheep.dev; Path=/; Max-Age=100"), "ss_theme=dark; Path=/; Max-Age=100");
  assert.equal(localCookie("ss_app=abc; Path=/; HttpOnly; Secure"), null);
});

// ---- end to end against a stand-in spacesheep.dev

test("mirror: pages come from spacesheep signed in, framable, local; foreign writes are refused", async () => {
  const seen = [];
  let trades = 0, expireNext = false;
  const upstream = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie || "", origin: req.headers.origin || "", body });
    const origin = `http://127.0.0.1:${upstream.address().port}`;
    if (req.url === "/api/account/web-session") {
      if (req.headers.authorization !== "Bearer ss_test") { res.writeHead(401); return res.end("{}"); }
      trades++;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ cookie: "ss_app", token: `tok${trades}`, expires_in: 43200 }));
    }
    const signedIn = /(?:^|; )ss_app=tok\d/.test(req.headers.cookie || "");
    if (req.url === "/@misha/plan") {
      if (expireNext) { expireNext = false; res.writeHead(401); return res.end(); }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
        "Set-Cookie": ["ss_theme=dark; Domain=.spacesheep.dev; Path=/", "ss_app=fresh; Path=/; HttpOnly"],
      });
      return res.end(`<p>${signedIn ? "signed in" : "anonymous"}</p><a href="${origin}/@misha/other">other</a>`);
    }
    if (req.url === "/api/comments" && req.method === "POST") { res.writeHead(201, { "Content-Type": "application/json" }); return res.end("{\"ok\":true}"); }
    if (req.url === "/img.png") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(Buffer.from([0x89, 0x50, 0, 255])); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const env = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-mirror-"));
  process.env.SPACESHEEP_KEY = "ss_test";
  process.env.SPACESHEEP_APP_ORIGIN = `http://127.0.0.1:${upstream.address().port}`;
  process.env.SPACESHEEP_CONFIG_DIR = dir;
  const m = new Mirror({ port: 0 }, () => {});
  const local = http.createServer((req, res) => m.handle(req, res));
  await new Promise((r) => local.listen(0, "127.0.0.1", r));
  const port = local.address().port;
  m.port = port; m.map = addressMap(m.site, m.content, port);
  const call = (p, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const q = http.request({ host: "127.0.0.1", port, path: p, method, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    q.on("error", reject); if (body) q.write(body); q.end();
  });
  try {
    const page = await call("/@misha/plan", { headers: { Cookie: "ss_app=forged; ss_theme=light" } });
    assert.equal(page.status, 200);
    assert.equal(page.body.toString(), `<p>signed in</p><a href="http://localhost:${port}/@misha/other">other</a>`);
    assert.equal(page.headers["x-frame-options"], undefined);
    assert.equal(page.headers["content-security-policy"], "default-src 'self'");
    assert.deepEqual(page.headers["set-cookie"], ["ss_theme=dark; Path=/"]);
    // Upstream saw our session, never the one the browser sent, and kept its other cookies.
    assert.equal(seen.at(-1).cookie, "ss_theme=light; ss_app=tok1");

    const img = await call("/img.png");
    assert.deepEqual([...img.body], [0x89, 0x50, 0, 255]);

    // Writes: only from this mirror's own pages, and they leave with the upstream Origin.
    const foreign = await call("/api/comments", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(foreign.status, 403);
    const none = await call("/api/comments", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(none.status, 403);
    const own = await call("/api/comments", { method: "POST", headers: { Origin: `http://localhost:${port}`, "Content-Type": "application/json" }, body: "{\"text\":\"hi\"}" });
    assert.equal(own.status, 201);
    assert.equal(seen.at(-1).origin, process.env.SPACESHEEP_APP_ORIGIN);
    assert.equal(seen.at(-1).body, "{\"text\":\"hi\"}");

    // A session that stopped working is traded again, once.
    expireNext = true;
    assert.match((await call("/@misha/plan")).body.toString(), /signed in/);
    assert.equal(trades, 2);

    assert.equal((await call("/", { headers: { Host: `evil.example:${port}` } })).status, 421);
  } finally {
    upstream.close(); local.close();
    for (const k of ["SPACESHEEP_KEY", "SPACESHEEP_APP_ORIGIN", "SPACESHEEP_CONFIG_DIR"]) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
