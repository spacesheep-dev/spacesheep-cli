"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { callArgs, render, toolLine, toolHelp, unpin } = require("../lib/tools");
const bin = path.resolve(__dirname, "../bin/spacesheep.js");

function cli(args, env, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, ...args], { cwd: opts.cwd, env: { ...process.env, SPACESHEEP_NO_UPDATE_CHECK: "1", ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", b => stdout += b); p.stderr.on("data", b => stderr += b);
    if (opts.stdin !== undefined) p.stdin.end(opts.stdin); else p.stdin.end();
    p.on("close", code => resolve({ code, stdout, stderr }));
  });
}

const UUID = "0f4e2f86-8a51-4c43-9d3c-2b6f1d1e7a11";
const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
const TOOLS = [
  { name: "delete_space", description: "Delete a space and all its files. Only the owner can delete.", annotations: { destructiveHint: true },
    inputSchema: { type: "object", properties: { uuid: { type: "string", description: "Space UUID" } }, required: ["uuid"] } },
  { name: "screenshot", description: "Render a deployed space in a headless browser and return a PNG.", annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { uuid: { type: "string" }, width: { type: "integer" }, full_page: { type: "boolean" } }, required: ["uuid"] } },
];

/** A stand-in MCP server: answers tools/list from TOOLS and tools/call from `answer`. */
async function fakeServer(t, answer) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let input = ""; for await (const part of req) input += part;
    const body = JSON.parse(input);
    res.setHeader("Content-Type", "application/json");
    if (!body.id) { res.writeHead(202); return res.end(); }
    let result = {};
    if (body.method === "tools/list") result = body.params && body.params.cursor ? { tools: [TOOLS[1]] } : { tools: [TOOLS[0]], nextCursor: "p2" };
    if (body.method === "tools/call") { calls.push(body.params); result = answer(body.params); }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ss-tools-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return { calls, tmp, env: { SPACESHEEP_ORIGIN: `http://127.0.0.1:${server.address().port}`, SPACESHEEP_KEY: "ss_test_only", SPACESHEEP_CONFIG_DIR: tmp } };
}

test("call arguments: one JSON object, or key=value strings and key:=json values", () => {
  assert.deepEqual(callArgs([]), {});
  assert.deepEqual(callArgs(['{"uuid":"x","width":390}']), { uuid: "x", width: 390 });
  assert.deepEqual(callArgs(["uuid=@me/a-b", "width:=390", "full_page:=false", "emails:=[\"a@b.c\"]", "note=a=b"]),
    { uuid: "@me/a-b", width: 390, full_page: false, emails: ["a@b.c"], note: "a=b" });
  assert.deepEqual(callArgs(["id=123"]), { id: "123" }, "a bare = stays a string");
  assert.throws(() => callArgs(["nope"]), /key=value/);
  assert.throws(() => callArgs(["width:=wide"]), /width:= takes JSON/);
  assert.throws(() => callArgs(["[1,2]"]), /key=value/);
  assert.throws(() => callArgs(["{bad"]), /valid JSON/);
});

test("render prints text and writes pictures to files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-render-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = render("screenshot", { content: [{ type: "text", text: '{"ok":true}' }, { type: "image", data: PNG, mimeType: "image/png" }] }, { out: dir });
  const file = path.join(dir, "screenshot-1.png");
  assert.equal(r.text, `{\n  "ok": true\n}\npicture: ${file}`);
  assert.equal(fs.readFileSync(file).toString("hex"), "89504e470d0a1a0a");
  assert.deepEqual(r.json.content[1], { type: "image", mimeType: "image/png", file }, "--json carries the path, never the base64");
});

test("tools: one line each, and one tool's arguments with a line to run it", () => {
  assert.match(toolLine(TOOLS[0]), /^delete_space\s+destructive\s+Delete a space and all its files\.$/);
  assert.match(toolLine(TOOLS[1]), /^screenshot\s+reads\s+/);
  const help = toolHelp(TOOLS[1]);
  assert.match(help, /uuid: string/);
  assert.match(help, /width\?: integer/);
  assert.match(help, /Run: spacesheep call screenshot uuid=…$/);
});

test("unpin drops only the deleted space's pin and keeps other defaults", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-unpin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".spacesheep.json");
  fs.writeFileSync(file, JSON.stringify({ space: UUID, url: "https://spacesheep.dev/@me/x", page_title: "X", emoji: "🐑" }));
  assert.equal(unpin(dir, "11111111-1111-1111-1111-111111111111"), false);
  assert.equal(unpin(dir, UUID), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { emoji: "🐑" });
  fs.writeFileSync(file, JSON.stringify({ space: UUID, url: "u" }));
  assert.equal(unpin(dir, UUID), true);
  assert.equal(fs.existsSync(file), false, "a pin with nothing else in it goes away");
});

test("delete calls delete_space, unpins the folder, and fails on a refusal", async (t) => {
  let answer = { content: [{ type: "text", text: `Deleted space ${UUID}.` }] };
  const s = await fakeServer(t, () => answer);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ss-folder-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, ".spacesheep.json"), JSON.stringify({ space: UUID, url: "https://spacesheep.dev/@me/oops" }));

  let r = await cli(["delete", "https://spacesheep.dev/@me/oops"], s.env, { cwd: folder });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(s.calls.at(-1), { name: "delete_space", arguments: { uuid: "https://spacesheep.dev/@me/oops" } });
  assert.match(r.stderr, /Deleted space/);
  assert.match(r.stderr, /next deploy here makes a new space/);
  assert.equal(fs.existsSync(path.join(folder, ".spacesheep.json")), false);

  // Today's server marks a refusal as an error…
  answer = { content: [{ type: "text", text: "Only the owner can delete a space." }], isError: true };
  r = await cli(["delete", UUID], s.env, { cwd: folder });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Only the owner/);
  // …and an older one answered it as plain text, which is still not a deletion.
  answer = { content: [{ type: "text", text: "Space not found." }] };
  r = await cli(["delete", UUID, "--json"], s.env, { cwd: folder });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Space not found/);

  r = await cli(["delete"], s.env, { cwd: folder });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: spacesheep delete/);
});

test("tools lists every page; call runs any tool and saves its pictures", async (t) => {
  const s = await fakeServer(t, (p) => p.name === "screenshot"
    ? { content: [{ type: "text", text: '{"final_url":"x"}' }, { type: "image", data: PNG, mimeType: "image/png" }] }
    : { content: [{ type: "text", text: "no such tool" }], isError: true });

  let r = await cli(["tools"], s.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^delete_space\s+destructive/m);
  assert.match(r.stdout, /^screenshot\s+reads/m, "the second page of tools/list is read too");

  r = await cli(["tools", "screenshot"], s.env);
  assert.match(r.stdout, /Run: spacesheep call screenshot uuid=…/);
  r = await cli(["tools", "nope"], s.env);
  assert.equal(r.code, 1);

  const out = path.join(s.tmp, "shots");
  r = await cli(["call", "screenshot", `uuid=${UUID}`, "width:=390", "-o", out], s.env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(s.calls.at(-1), { name: "screenshot", arguments: { uuid: UUID, width: 390 } });
  assert.match(r.stdout, /"final_url": "x"/);
  assert.match(r.stdout, new RegExp(`picture: ${path.join(out, "screenshot-1.png").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.ok(fs.existsSync(path.join(out, "screenshot-1.png")));

  r = await cli(["call", "screenshot", "-"], s.env, { stdin: JSON.stringify({ uuid: UUID, full_page: false }) });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(s.calls.at(-1).arguments, { uuid: UUID, full_page: false });

  r = await cli(["call", "other"], s.env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no such tool/);
  r = await cli(["call", "other", "--json"], s.env);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stdout).isError, true);
});
