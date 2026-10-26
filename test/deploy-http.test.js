"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { stageAll } = require("../lib/deploy");

const TOKEN = "stage-capability-secret-93ab";
const RAY = "a50ab93ec90849ec-SJC";
const UA = `spacesheep-cli/${require("../package.json").version} (+https://github.com/spacesheep-dev/spacesheep-cli) Node/${process.versions.node}`;
const resume = "0 file(s) are staged and stay valid for 24h — running the same command again uploads only the rest.";

async function fixture(t, handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-stage-http-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const abs = path.join(dir, "index.html");
  fs.writeFileSync(abs, "<h1>Upload</h1>");
  const requests = [], calls = [], logs = [];
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) {} // Drain the PUT before answering.
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const uploadUrl = `http://127.0.0.1:${server.address().port}/stage/${TOKEN}`;
  const client = { call: async (name) => { calls.push(name); return { upload_url: uploadUrl }; } };
  return {
    requests, calls, logs, uploadUrl,
    run: (url = uploadUrl) => stageAll(client, [{ path: "index.html", abs }], (line) => logs.push(line), { upload_url: url }),
  };
}

function noCapability(text, url) {
  assert.ok(!text.includes(TOKEN), "the capability token must never be rendered");
  assert.ok(!text.includes(url), "the capability URL must never be rendered");
  assert.doesNotMatch(text, /\?path=|\?token=|\/stage\//);
}

test("staging: plaintext Cloudflare 1010 reports diagnostics once without a capability", async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(403, { "Content-Type": "text/plain; charset=UTF-8", "cf-ray": RAY });
    res.end("error code: 1010\n");
  });
  await assert.rejects(f.run(), (e) => {
    assert.match(e.message, /^upload of index\.html failed: HTTP 403 Forbidden/);
    assert.match(e.message, /Content-Type: text\/plain; charset=UTF-8/);
    assert.ok(e.message.includes(`cf-ray: ${RAY}`));
    assert.match(e.message, /error code: 1010/);
    assert.match(e.message, /Cloudflare edge refusal.*did not reach spacesheep/);
    assert.match(e.message, /refused for not identifying its client/);
    assert.match(e.message, /custom uploader must send its own User-Agent/);
    assert.match(e.message, /curl.*already does/);
    assert.ok(e.message.endsWith(resume));
    noCapability(e.message, f.uploadUrl);
    return true;
  });
  assert.equal(f.requests.length, 1, "403 is not retried");
  assert.deepEqual(f.calls, [], "no renewal or inline fallback");
  noCapability(f.logs.join("\n"), f.uploadUrl);
});

test("staging: the own-handler JSON 401 message and renewal policy stay unchanged", async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid or expired token" }));
  });
  await assert.rejects(f.run(), { message: `upload of index.html failed: invalid or expired token. ${resume}` });
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.calls, ["stage_begin", "stage_begin"]);
});

test("staging: PUT identifies the CLI and Node versions", async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sha: "abc123" }));
  });
  assert.deepEqual(await f.run(), [{ path: "index.html", staged_sha: "abc123" }]);
  assert.equal(f.requests[0].method, "PUT");
  assert.equal(f.requests[0].headers["user-agent"], UA);
  assert.equal(f.requests[0].headers["content-type"], "application/octet-stream");
});

test("staging: malformed JSON keeps a collapsed, bounded excerpt and response metadata", async (t) => {
  const body = '{"error":\n\t"upstream unavailable ' + "x".repeat(250);
  const f = await fixture(t, (_req, res) => {
    res.writeHead(502, { "Content-Type": "application/json", "cf-ray": RAY });
    res.end(body);
  });
  await assert.rejects(f.run(), (e) => {
    assert.match(e.message, /HTTP 502 Bad Gateway/);
    assert.match(e.message, /Content-Type: application\/json/);
    assert.ok(e.message.includes(`cf-ray: ${RAY}`));
    assert.ok(e.message.includes(body.replace(/\s+/g, " ").slice(0, 200)));
    assert.ok(!e.message.includes("x".repeat(201)));
    assert.doesNotMatch(e.message, /\n|\t|Cloudflare edge refusal/);
    return true;
  });
});

test("staging: other Cloudflare 1xxx refusals name the edge without diagnosing 1010", async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(403, { "Content-Type": "text/html" });
    res.end("<p>error code: 1020</p>");
  });
  await assert.rejects(f.run(), (e) => {
    assert.match(e.message, /error code: 1020/);
    assert.match(e.message, /Cloudflare edge refusal.*did not reach spacesheep/);
    assert.doesNotMatch(e.message, /User-Agent|cf-ray/);
    return true;
  });
  assert.equal(f.requests.length, 1);
});

test("staging: an empty non-JSON error still reports status and missing content type", async (t) => {
  const f = await fixture(t, (_req, res) => { res.writeHead(503); res.end(); });
  await assert.rejects(f.run(), (e) => {
    assert.match(e.message, /HTTP 503 Service Unavailable/);
    assert.match(e.message, /Content-Type:.*missing/);
    assert.doesNotMatch(e.message, /cf-ray|Cloudflare edge refusal/);
    return true;
  });
});

test("staging: a Cloudflare code is explained even when the refusal is wrapped in JSON", async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "error code: 1010" }));
  });
  await assert.rejects(f.run(), /error code: 1010\. Cloudflare edge refusal \(1010\).*custom uploader must send its own User-Agent/);
  assert.equal(f.requests.length, 1);
});

for (const json of [false, true]) {
  test(`staging: echoed capabilities are redacted from ${json ? "JSON" : "plaintext"} errors before truncation`, async (t) => {
    const f = await fixture(t, (req, res) => {
      const url = `http://${req.headers.host}${req.url}`;
      const message = `refused ${url} ${TOKEN} ${encodeURIComponent(url)} ${req.url}`;
      res.writeHead(403, { "Content-Type": json ? "application/json" : "text/plain", "cf-ray": RAY });
      res.end(json ? JSON.stringify({ error: message }) : message);
    });
    await assert.rejects(f.run(), (e) => {
      noCapability(e.message, f.uploadUrl);
      assert.doesNotMatch(e.message, /%3Fpath%3D|127\.0\.0\.1/);
      assert.match(e.message, /upload of index\.html failed:.*refused/);
      return true;
    });
    noCapability(f.logs.join("\n"), f.uploadUrl);
  });
}

test("staging: a query capability is redacted even when echoed by a proxy", async (t) => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end(`refused http://${req.headers.host}${req.url} ${TOKEN}`);
  });
  const url = f.uploadUrl.replace(`/stage/${TOKEN}`, `/stage?token=${TOKEN}`);
  await assert.rejects(f.run(url), (e) => { noCapability(e.message, url); return true; });
});

test("staging: transport errors cannot echo the capability URL or token", async (t) => {
  const f = await fixture(t, () => {});
  t.mock.method(globalThis, "fetch", async (url) => { throw new Error(`network failed for ${url} (${TOKEN})`); });
  await assert.rejects(f.run(), (e) => {
    noCapability(e.message, f.uploadUrl);
    assert.match(e.message, /upload of index\.html failed:.*network failed/);
    return true;
  });
});

test("staging: rate-limit log lines redact capabilities while retaining the existing wait", async (t) => {
  let limited = false;
  const f = await fixture(t, (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (!limited) {
      limited = true;
      res.writeHead(429);
      return res.end(JSON.stringify({ error: "rate_limited", message: `slow down: ${req.url} ${TOKEN}`, retry_after: 0.001 }));
    }
    res.end(JSON.stringify({ sha: "abc123" }));
  });
  await f.run();
  assert.equal(f.requests.length, 2);
  const rendered = f.logs.join("\n");
  assert.match(rendered, /upload rate limit.*slow down.*resuming/);
  noCapability(rendered, f.uploadUrl);
});

test("staging: errors also redact the old capability after a 401 renews it", async (t) => {
  const oldToken = "old-capability-before-renewal-84ba";
  const f = await fixture(t, (req, res) => {
    if (req.url.includes(oldToken)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid or expired token" }));
    }
    res.writeHead(403, { "Content-Type": "text/plain", "cf-ray": `${TOKEN}-${oldToken}` });
    res.end(`refused ${oldToken} ${TOKEN}`);
  });
  await assert.rejects(f.run(f.uploadUrl.replace(TOKEN, oldToken)), (e) => {
    noCapability(e.message, f.uploadUrl);
    assert.ok(!e.message.includes(oldToken));
    assert.match(e.message, /HTTP 403 Forbidden/);
    return true;
  });
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.calls, ["stage_begin"]);
});

test("staging: a non-JSON 200 cannot produce a successful upload with an undefined hash", async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html>proxy response</html>");
  });
  await assert.rejects(f.run(), /HTTP 200 OK; Content-Type: text\/html; body: <html>proxy response<\/html>/);
  assert.deepEqual(f.logs, []);
});
