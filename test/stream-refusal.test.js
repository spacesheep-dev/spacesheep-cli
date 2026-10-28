"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const bin = path.join(__dirname, "..", "bin", "spacesheep.js");
const plans = "https://spacesheep.dev/plans";

// Exercise the actual command with a local endpoint and disposable credentials.
// stdin stays open, like a live collector; a timeout kills a looping regression.
async function command(t, args, respond, { timeout = false, launchd = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-stream-refusal-"));
  const ffmpeg = path.join(dir, "ffmpeg");
  fs.writeFileSync(ffmpeg, `#!${process.execPath}\nif (process.argv.includes('-version')) process.exit(0);
process.stdout.on('error', () => process.exit(0));
const jpg = Buffer.from([255,216,255,192,0,17,8,1,104,2,128,3,1,34,0,2,17,1,3,17,1,255,217]);
setInterval(() => process.stdout.write(jpg), 10);
`, { mode: 0o755 });
  const preload = path.join(dir, "timeout.cjs");
  fs.writeFileSync(preload, `const realFetch = global.fetch; let first = true;
global.fetch = (...args) => { if (first) { first = false; return Promise.reject(new DOMException('timed out', 'TimeoutError')); } return realFetch(...args); };
`);
  let child;
  const requests = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (d) => { data += d; });
    req.on("end", () => {
      requests.push({ url: req.url, data });
      respond(req, res, child, requests);
    });
  });
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let argv = [process.execPath, ...(timeout ? ["--require", preload] : []), bin, "stream", "lab/test", ...args];
  if (launchd) argv = require("../lib/stream-service").launchdArgv(argv, 4);
  child = spawn(argv[0], argv.slice(1), {
    env: { ...process.env, SPACESHEEP_CONFIG_DIR: dir, SPACESHEEP_KEY: "ss_test_only", SPACESHEEP_NO_UPDATE_CHECK: "1", SPACESHEEP_APP_ORIGIN: `http://127.0.0.1:${server.address().port}`, SPACESHEEP_FFMPEG: ffmpeg },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdin.on("error", () => {});
  const timer = setTimeout(() => child.kill("SIGKILL"), 6000);
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, requests }); });
  });
  return { child, done };
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function planExit(result, code = 4) {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, code, result.stderr);
  const output = result.stdout + result.stderr;
  assert.equal(output.split(plans).length - 1, 1, output);
  assert.match(output, /plan_required:.*Max.*will not be retried/);
}

for (const status of [402, 403, 404, 500, 200]) {
  for (const field of ["code", "error"]) {
    test(`plan_required in ${field}, HTTP ${status}: exits 4 after one push with queued values`, async (t) => {
      const { child, done } = await command(t, [], (req, res, child, requests) => {
        if (requests.length === 1) child.stdin.write("2\n3\n");
        json(res, status, { [field]: "plan_required" });
        if (requests.length > 1) child.kill("SIGKILL");
      });
      child.stdin.write("1\n");
      const result = await done;
      planExit(result);
      assert.equal(result.requests.length, 1);
    });
  }
}

test("the observed server body prints the plans URL once, without repeating its human error", async (t) => {
  const { child, done } = await command(t, [], (req, res) => json(res, 403, {
    code: "plan_required", error: `Streaming into a space is part of Max ($9 a month): ${plans}. Anyone can watch a stream; sending one needs Max.`,
  }));
  child.stdin.write("1\n2\n3\n");
  planExit(await done);
});

for (const status of [401, 403]) {
  test(`HTTP ${status} without a plan code stays fatal with exit 3, even with non-JSON`, async (t) => {
    const { child, done } = await command(t, [], (req, res) => { res.writeHead(status); res.end("upstream denied"); });
    child.stdin.write("1\n");
    const result = await done;
    assert.equal(result.code, 3);
    assert.equal(result.requests.length, 1);
    assert.match(result.stderr, new RegExp(`HTTP ${status}`));
    assert.ok(!result.stderr.includes(plans));
  });
}

for (const status of [429, 500, "network", "timeout"]) {
  test(`${status} keeps the value producer alive and accepts a later push`, async (t) => {
    const { child, done } = await command(t, [], (req, res, child, requests) => {
      if (requests.length === 1 && status !== "timeout") {
        child.stdin.write("2\n");
        if (status === "network") return req.socket.destroy();
        // Mentioning a plan code in prose must never turn a rate limit fatal.
        return json(res, status, { error: status === 429 ? "rate" : "unavailable", message: "not plan_required", retry_ms: 10 });
      }
      json(res, 200, { ok: true });
      child.kill("SIGTERM");
    }, { timeout: status === "timeout" });
    child.stdin.write("1\n");
    const result = await done;
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, status === "timeout" ? 1 : 2);
    assert.ok(!(result.stdout + result.stderr).includes(plans));
    if (status === 429 || status === "network") {
      assert.deepEqual(JSON.parse(result.requests[1].data).map((p) => p.v), [1, 2]);
    } else if (status === 500) assert.equal(result.requests[1].data, "2");
  });
}

for (const source of [["--system", "--every", "50ms"], ["--every", "50ms", "--", process.execPath, "-e", "console.log(1)"], ["--run", "printf '1\\n'; exec sleep 30"]]) {
  test(`plan refusal stops producer ${source[0]}`, async (t) => {
    const { done } = await command(t, source, (req, res) => json(res, 402, { code: "plan_required" }));
    const result = await done;
    planExit(result);
    assert.equal(result.requests.length, 1);
  });
}

for (const endpoint of ["events", "ack"]) {
  test(`plan refusal on button ${endpoint} stops the stream`, async (t) => {
    let polls = 0;
    const { done } = await command(t, ["--on", "run=true"], (req, res) => {
      if (req.url.includes(`/-/${endpoint}`)) return json(res, 402, { code: "plan_required" });
      json(res, 200, { cursor: ++polls, events: polls === 2 ? [{ seq: 2, name: "run" }] : [] });
    });
    planExit(await done);
  });
}

for (const endpoint of ["publish", "still", "beat"]) {
  test(`filming ${endpoint} stops on a plan refusal with exit 4`, async (t) => {
    const { done } = await command(t, ["--test"], (req, res) => {
      if (req.url.startsWith(`/api/video/${endpoint}`)) return json(res, 402, { code: "plan_required" });
      json(res, 200, { cam: "test-cam", since: 1 });
    });
    const result = await done;
    planExit(result);
    assert.equal(result.requests.filter((r) => r.url.startsWith(`/api/video/${endpoint}`)).length, 1);
    assert.ok(!result.requests.some((r) => r.url.startsWith("/api/video/stop")));
    assert.match(result.stdout + result.stderr, /filming requires Pro/);
  });
}

for (const status of [429, 500]) {
  test(`filming keeps sending after HTTP ${status}`, async (t) => {
    let stills = 0;
    const { done } = await command(t, ["--test"], (req, res, child) => {
      if (req.url.startsWith("/api/video/still")) {
        if (++stills === 1) return json(res, status, { error: "rate", retry_ms: 10 });
        json(res, 200, { ok: true });
        child.kill("SIGTERM");
      } else json(res, 200, { cam: "test-cam", since: 1 });
    });
    const result = await done;
    assert.equal(result.code, 0, result.stderr);
    assert.ok(stills >= 2);
  });
}

test("the launchd wrapper exits after a real stream plan refusal, with no further pushes", async (t) => {
  const { done } = await command(t, ["--system", "--every", "50ms"], (req, res) => json(res, 403, { code: "plan_required" }), { launchd: true });
  const result = await done;
  planExit(result, 0); // launchd's SuccessfulExit=false prevents another launch.
  assert.equal(result.requests.length, 1);
});
