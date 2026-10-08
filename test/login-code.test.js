// `spacesheep login --code ssc_…`: the code from the personal prompt on
// spacesheep.dev/start. What is pinned: a malformed code never reaches the network,
// spacesheep's own refusal is reported as one (used, expired), a refusal that isn't
// spacesheep's is a network problem, and the agent is named only from its own env.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { redeemCode, agentClient } = require("../lib/login");
const { redactSecrets } = require("../lib/redact");

const CODE = "ssc_" + "0123456789abcdef".repeat(2);
const quiet = () => {};

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve({ srv, origin: `http://127.0.0.1:${srv.address().port}` }));
  });
}
function body(req) {
  return new Promise((resolve) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => resolve(JSON.parse(b || "{}"))); });
}

test("redeem: trades the code for this machine's key, naming the machine and the agent", async () => {
  let seen;
  const { srv, origin } = await serve(async (req, res) => {
    seen = { path: req.url, body: await body(req) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ key: "ss_" + "a".repeat(48), username: "ann", name: "lab-1", key_prefix: "ss_aaaaaaaa" }));
  });
  try {
    const got = await redeemCode(origin, ` ${CODE}\n`, "lab-1", quiet, "claude-code");
    assert.deepStrictEqual(got, { key: "ss_" + "a".repeat(48), username: "ann", name: "lab-1" });
    assert.strictEqual(seen.path, "/api/cli/redeem");
    assert.deepStrictEqual(seen.body, { code: CODE, name: "lab-1", client: "claude-code" });
  } finally { srv.close(); }
});

test("redeem: a used or expired code is spacesheep's answer, said in its words", async () => {
  const { srv, origin } = await serve((req, res) => {
    res.writeHead(410, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "This code was already used: each one signs in one computer.", code: "code_used" }));
  });
  try {
    await assert.rejects(redeemCode(origin, CODE, "lab-1", quiet), (e) => e.code === "EAUTH" && /already used/.test(e.message));
  } finally { srv.close(); }
});

test("redeem: a refusal without spacesheep's JSON is the network, not the code", async () => {
  const { srv, origin } = await serve((req, res) => { res.writeHead(403); res.end("blocked by proxy"); });
  try {
    await assert.rejects(redeemCode(origin, CODE, "lab-1", quiet), (e) => e.code === "ENET");
  } finally { srv.close(); }
});

test("redeem: a malformed code never leaves the machine", async () => {
  await assert.rejects(redeemCode("http://127.0.0.1:9", "ss_" + "a".repeat(48), "x", quiet), /isn't a setup code/);
  await assert.rejects(redeemCode("http://127.0.0.1:9", "", "x", quiet), /isn't a setup code/);
});

test("agentClient names only agents that say so in their environment", () => {
  assert.strictEqual(agentClient({ CLAUDECODE: "1" }), "claude-code");
  assert.strictEqual(agentClient({ CODEX_SANDBOX: "seatbelt" }), "codex");
  assert.strictEqual(agentClient({ CURSOR_AGENT: "1" }), "cursor");
  assert.strictEqual(agentClient({ GEMINI_CLI: "1" }), "gemini-cli");
  assert.strictEqual(agentClient({ TERM_PROGRAM: "Apple_Terminal" }), undefined);
});

test("the code is redacted from what the session hooks send", () => {
  const said = redactSecrets(`run \`npx -y spacesheep@latest login --code ${CODE}\``);
  assert.ok(!said.includes(CODE));
});
