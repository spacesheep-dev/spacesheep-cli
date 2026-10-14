"use strict";
// `live-link` and `live-status`: the live link from a shell. What is pinned: the
// URL alone on stdout and the next two commands beside it, the account's own
// default when no access is asked for, the version stamped like a deploy's, a
// refusal that never reads as a link, and a step sent as live_push's status.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { liveLinkArgs, liveLinkLines, liveStatusArgs } = require("../lib/live");
const bin = path.resolve(__dirname, "../bin/spacesheep.js");

const UUID = "5b1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const URL = "https://spacesheep.dev/@ann/q3-pricing-review";

function cli(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, ...args], { env: { ...process.env, SPACESHEEP_NO_UPDATE_CHECK: "1", SPACESHEEP_QUIET: "", ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (b) => (stdout += b)); p.stderr.on("data", (b) => (stderr += b));
    p.stdin.end();
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] });

/** A stand-in MCP server: every tools/call is recorded and answered by `answer`. */
async function fakeServer(t, answer) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let input = ""; for await (const part of req) input += part;
    const body = JSON.parse(input);
    res.setHeader("Content-Type", "application/json");
    if (!body.id) { res.writeHead(202); return res.end(); }
    let result = {};
    if (body.method === "tools/call") { calls.push(body.params); result = answer(body.params); }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ss-live-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return { calls, env: { SPACESHEEP_ORIGIN: `http://127.0.0.1:${server.address().port}`, SPACESHEEP_KEY: "ss_test_only", SPACESHEEP_CONFIG_DIR: tmp } };
}

test("live-link arguments: the title is the words or --title; access only when asked", () => {
  assert.deepEqual(liveLinkArgs({ _: ["Q3", "pricing", "review"], emails: [] }), { title: "Q3 pricing review" });
  assert.deepEqual(
    liveLinkArgs({ _: [], title: "Q3 pricing review", emoji: "📊", description: "Plans side by side", status: "Reading the pricing pages", visibility: "private", emails: ["a@b.c"] }),
    { title: "Q3 pricing review", emoji: "📊", description: "Plans side by side", status: "Reading the pricing pages", access: { visibility: "private", emails: ["a@b.c"] } },
  );
  assert.throws(() => liveLinkArgs({ _: [], emails: [] }), /usage: spacesheep live-link <title>/);
  assert.throws(() => liveLinkArgs({ _: ["  "], emails: [] }), /usage: spacesheep live-link <title>/);
});

test("live-link lines: the link, then how to say each step and how to finish", () => {
  const lines = liveLinkLines({ uuid: UUID, url: URL, visibility: "public" }).join("\n");
  assert.match(lines, /✓ Live link \(public\): https:\/\/spacesheep\.dev\/@ann\/q3-pricing-review/);
  assert.match(lines, new RegExp(`spacesheep live-status ${UUID} "`));
  assert.match(lines, new RegExp(`spacesheep deploy <folder or \\.html> --space ${UUID}`));
  assert.doesNotMatch(lines, /Private/);
  assert.match(liveLinkLines({ uuid: UUID, url: URL, visibility: "private" }).join("\n"), /Private: only you can open it/);
});

test("live-status arguments: the words are the step; an empty one takes the card down", () => {
  assert.deepEqual(liveStatusArgs({ _: [UUID, "Reading", "the", "sources"] }), { uuid: UUID, status: "Reading the sources" });
  assert.deepEqual(liveStatusArgs({ _: [UUID, "Blocked on a sign-in"], stopped: true }), { uuid: UUID, status: "Blocked on a sign-in", stopped: true });
  assert.deepEqual(liveStatusArgs({ _: [UUID, ""] }), { uuid: UUID, status: "" });
  assert.throws(() => liveStatusArgs({ _: [UUID] }), /usage: spacesheep live-status/);
  assert.throws(() => liveStatusArgs({ _: [] }), /usage: spacesheep live-status/);
});

test("live-link: the URL alone on stdout, the next commands on stderr, stamped like a deploy", async (t) => {
  const s = await fakeServer(t, () => text({ uuid: UUID, url: URL, visibility: "public", do_now: "Send the person this link NOW", ms: 840 }));
  const r = await cli(["live-link", "Q3 pricing review", "--emoji", "📊", "--description", "Plans side by side"], s.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, URL + "\n");
  assert.match(r.stderr, /✓ Live link \(public\): /);
  assert.match(r.stderr, new RegExp(`--space ${UUID}`));
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].name, "live_link");
  const a = s.calls[0].arguments;
  assert.equal(a.title, "Q3 pricing review");
  assert.equal(a.emoji, "📊");
  assert.equal(a.description, "Plans side by side");
  assert.equal(a.access, undefined, "no --visibility: the account's own default for new pages applies");
  assert.ok(a.session && a.session.machine, "the version records what made it, as a deploy's does");
});

test("live-link --json: the server's whole answer, for an agent that wants do_now and looks", async (t) => {
  const answer = { uuid: UUID, url: URL, visibility: "private", do_now: "Send the person this link NOW", looks: { registers: {} } };
  const s = await fakeServer(t, () => text(answer));
  const r = await cli(["live-link", "Q3", "--visibility", "private", "--json"], s.env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), answer);
  assert.deepEqual(s.calls[0].arguments.access, { visibility: "private" });
});

test("live-link: a refusal is a failure in the server's words, never a link", async (t) => {
  const s = await fakeServer(t, () => text({ error: "rate_limited", message: "Too many new spaces this hour", retry_after: 120 }));
  const r = await cli(["live-link", "Q3"], s.env);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /live_link refused — rate_limited: Too many new spaces this hour \(retry in 120s\)/);
  assert.doesNotMatch(r.stderr, /✓/);
});

test("live-link: an answer with no link says nothing was confirmed", async (t) => {
  const s = await fakeServer(t, () => text({ ok: true }));
  const r = await cli(["live-link", "Q3"], s.env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /live_link answered without a link/);
});

test("live-status: the step goes to live_push, and where it showed comes back", async (t) => {
  const s = await fakeServer(t, () => text({ ok: true, space: UUID, seq: 3, tabs: 1, note: "Shown in 1 open tab(s). Nothing was published." }));
  const r = await cli(["live-status", UUID, "Writing the comparison table"], s.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "Shown in 1 open tab(s). Nothing was published.\n");
  assert.deepEqual(s.calls, [{ name: "live_push", arguments: { uuid: UUID, status: "Writing the comparison table" } }]);
});

test("live-status --stopped: the page says the work stopped, and why", async (t) => {
  const s = await fakeServer(t, () => text({ ok: true, space: UUID, seq: 4, tabs: 0, note: "Nobody has the space open right now." }));
  const r = await cli(["live-status", UUID, "Waiting for your answer", "--stopped"], s.env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(s.calls[0].arguments, { uuid: UUID, status: "Waiting for your answer", stopped: true });
});

test("live-status: a refused push is an error, not a step that showed", async (t) => {
  const s = await fakeServer(t, () => ({ ...text("The room refused the status: not_found"), isError: true }));
  const r = await cli(["live-status", UUID, "Reading"], s.env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /The room refused the status: not_found/);
});

test("help names both commands next to deploy", async () => {
  const r = await cli(["--help"], {});
  assert.equal(r.code, 0);
  assert.match(r.stdout, /spacesheep live-link <title> \[opts\]\s+the link first/);
  assert.match(r.stdout, /spacesheep live-status <space> <words> \[--stopped\]/);
});
