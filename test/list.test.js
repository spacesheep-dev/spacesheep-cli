"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const bin = path.resolve(__dirname, "../bin/spacesheep.js");
const spaces = Array.from({ length: 469 }, (_, i) => ({
  id: `space-${i}`, title: `Space ${i}`, emoji: "·", visibility: "private",
  url: `https://spacesheep.dev/@test/space-${i}`,
}));
const table = rows => rows.map(s => `${s.emoji.padEnd(2)} ${s.title.padEnd(42)} ${s.visibility.padEnd(10)} ${s.url}\n`).join("");
function page(rows, { limit = 50, offset = 0 }) {
  const end = offset + limit;
  return { spaces: rows.slice(offset, end), total: rows.length, offset, next_offset: end < rows.length ? end : null };
}
async function fixture(t, reply = args => page(spaces, args), extraEnv = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let input = ""; for await (const part of req) input += part;
    const body = JSON.parse(input);
    res.setHeader("Content-Type", "application/json");
    if (!body.id) { res.writeHead(202); return res.end(); }
    let result = {};
    if (body.method === "tools/call") {
      calls.push(body.params);
      try {
        result = { content: [{ type: "text", text: JSON.stringify(reply(body.params.arguments)) }] };
      } catch (e) {
        result = { isError: true, content: [{ type: "text", text: e.message }] };
      }
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => server.close(r)));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ss-list-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  function cli(args) {
    return new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [bin, "list", ...args], { env: {
        ...process.env, SPACESHEEP_NO_UPDATE_CHECK: "1", SPACESHEEP_QUIET: "",
        SPACESHEEP_ORIGIN: `http://127.0.0.1:${server.address().port}`,
        SPACESHEEP_KEY: "ss_test_only", SPACESHEEP_CONFIG_DIR: tmp, ...extraEnv,
      } });
      const timeout = setTimeout(() => { p.kill(); reject(new Error("list did not terminate")); }, 15000);
      let stdout = "", stderr = "";
      p.stdout.on("data", b => stdout += b); p.stderr.on("data", b => stderr += b);
      p.on("error", e => { clearTimeout(timeout); reject(e); });
      p.on("close", code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    });
  }
  return { cli, calls };
}

test("list --json returns all 469 spaces by default", async t => {
  const { cli, calls } = await fixture(t);
  const r = await cli(["--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).length, 469);
  assert.deepEqual(JSON.parse(r.stdout), spaces);
  assert.equal(r.stderr, "");
  assert.deepEqual(calls, [0, 200, 400].map(offset => ({ name: "list_spaces", arguments: { limit: 200, offset } })));
});

test("list table reports showing 50 of 469 only on stderr, even in quiet mode", async t => {
  const { cli, calls } = await fixture(t, undefined, { SPACESHEEP_QUIET: "1" });
  const r = await cli([]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, table(spaces.slice(0, 50)));
  assert.equal(r.stderr, "showing 50 of 469 — spacesheep list --all for the rest\n");
  assert.deepEqual(calls, [{ name: "list_spaces", arguments: { limit: 50, offset: 0 } }]);
});

test("--all fetches every table row with no notice", async t => {
  const { cli, calls } = await fixture(t);
  const r = await cli(["--all"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, table(spaces));
  assert.equal(r.stderr, "");
  assert.deepEqual(calls.map(c => c.arguments), [0, 200, 400].map(offset => ({ limit: 200, offset })));
});

test("--limit and --offset select one table page; --all and JSON keep paging from that offset", async t => {
  const { cli, calls } = await fixture(t);
  let r = await cli(["--limit", "75", "--offset", "20"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, table(spaces.slice(20, 95)));
  assert.equal(r.stderr, "showing 75 of 469 — spacesheep list --all for the rest\n");
  assert.deepEqual(calls.map(c => c.arguments), [{ limit: 75, offset: 20 }]);
  for (const mode of [["--all"], ["--json"], ["--all", "--json"]]) {
    calls.length = 0;
    r = await cli([...mode, "--limit=75", "--offset=20"]);
    assert.equal(r.code, 0, r.stderr);
    if (mode.includes("--json")) {
      assert.deepEqual(JSON.parse(r.stdout), spaces.slice(20));
      assert.equal(r.stderr, "");
    } else {
      assert.equal(r.stdout, table(spaces.slice(20)));
      assert.equal(r.stderr, "showing 449 of 469 — spacesheep list --all for the rest\n");
    }
    assert.deepEqual(calls.map(c => c.arguments), [20, 95, 170, 245, 320, 395].map(offset => ({ limit: 75, offset })));
  }
});

test("small, exactly one-page and empty accounts print no notice", async t => {
  for (const rows of [spaces.slice(0, 7), spaces.slice(0, 50), []]) {
    const { cli, calls } = await fixture(t, args => page(rows, args));
    for (const mode of [[], ["--json"], ["--all"]]) {
      calls.length = 0;
      const r = await cli(mode);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, mode.includes("--json") ? JSON.stringify(rows, null, 2) + "\n" : table(rows));
      assert.equal(r.stderr, "");
      assert.equal(calls.length, 1);
    }
  }
});

test("JSON respects an offset beyond the last row", async t => {
  const { cli, calls } = await fixture(t);
  const r = await cli(["--json", "--offset", "500"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), []);
  assert.equal(r.stderr, "");
  assert.equal(calls.length, 1);
});

test("legacy bare arrays and objects without pagination end after one request", async t => {
  const rows = spaces.slice(0, 50);
  for (const response of [rows, { spaces: rows }, { spaces: rows, total: 50 }]) {
    const { cli, calls } = await fixture(t, () => response);
    const r = await cli(["--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), rows);
    assert.equal(r.stderr, "");
    assert.equal(calls.length, 1);
  }
});

test("follows the server cursor without total, even when pages are shorter than requested", async t => {
  const { cli, calls } = await fixture(t, ({ offset }) => {
    const r = page(spaces, { offset, limit: 100 });
    delete r.total;
    return r;
  });
  const r = await cli(["--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), spaces);
  assert.equal(r.stderr, "");
  assert.deepEqual(calls.map(c => c.arguments.offset), [0, 100, 200, 300, 400]);
});

test("table warns about a remaining cursor even when total is unavailable", async t => {
  const { cli } = await fixture(t, args => {
    const r = page(spaces, args);
    delete r.total;
    return r;
  });
  const r = await cli([]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, table(spaces.slice(0, 50)));
  assert.equal(r.stderr, "showing 50 spaces — spacesheep list --all for the rest\n");
});

test("known incomplete replies without a cursor fail with empty stdout", async t => {
  for (const next_offset of [undefined, null]) {
    const { cli, calls } = await fixture(t, () => ({ spaces: spaces.slice(0, 50), total: 469, next_offset }));
    const r = await cli(["--json"]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /incomplete.*50 of 469/);
    assert.equal(calls.length, 1);
  }
});

test("a later page failure emits no partial JSON or table", async t => {
  const { cli } = await fixture(t, args => {
    if (args.offset) throw new Error("page unavailable");
    return page(spaces, args);
  });
  for (const mode of ["--json", "--all"]) {
    const r = await cli([mode]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /page unavailable/);
  }
});

test("invalid paging options fail before an MCP request", async t => {
  const { cli, calls } = await fixture(t);
  for (const [flag, value] of [["--limit", "0"], ["--limit", "201"], ["--limit", "1.5"], ["--limit", "no"], ["--offset", "-1"], ["--offset", "9007199254740992"], ["--offset", ""]]) {
    const r = await cli([flag, value, "--json"]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, new RegExp(flag));
  }
  assert.deepEqual(calls, []);
});

test("list help documents pagination and the request bound", async t => {
  const { cli, calls } = await fixture(t);
  const r = await cli(["--help"]);
  assert.equal(r.code, 0, r.stderr);
  for (const text of ["--all", "--limit", "--offset", "200", "1,000", "stderr"]) assert.ok(r.stdout.includes(text), text);
  assert.deepEqual(calls, []);
});

test("pagination rejects invalid or stalled cursors and empty advancing pages", async () => {
  const { listSpaces } = require("../lib/list-spaces");
  for (const next_offset of [0, -1, 0.5, "50", Number.MAX_SAFE_INTEGER + 1]) {
    let calls = 0;
    await assert.rejects(listSpaces({ json: true }, async () => {
      calls++;
      return { spaces: spaces.slice(0, 1), next_offset };
    }), /invalid next_offset/);
    assert.equal(calls, 1);
  }
  await assert.rejects(listSpaces({ all: true }, async () => ({ spaces: [], next_offset: 50 })), /empty page/);
  await assert.rejects(listSpaces({ json: true }, async ({ offset }) => ({ spaces: spaces.slice(0, 1), next_offset: offset ? 10 : 20 })), /invalid next_offset/);
});

test("pagination stops after 1,000 requests instead of returning a partial list", async () => {
  const { listSpaces } = require("../lib/list-spaces");
  let calls = 0;
  await assert.rejects(listSpaces({ json: true }, async ({ offset }) => {
    calls++;
    return { spaces: [spaces[0]], next_offset: offset + 1 };
  }), /1,000.*requests/);
  assert.equal(calls, 1000);
});

test("an invalid list response cannot masquerade as an empty account", async () => {
  const { listSpaces } = require("../lib/list-spaces");
  for (const response of [null, "not a list", {}, { spaces: {} }]) {
    await assert.rejects(listSpaces({ json: true }, async () => response), /invalid spaces list/);
  }
});
