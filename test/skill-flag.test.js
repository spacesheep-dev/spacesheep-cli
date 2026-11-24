"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { deploy } = require("../lib/deploy");

// --skill names the skill a page was made with, so the skill counts it. A server from before the
// field refuses it; the page still goes out, without it, and the answer says so.

function page() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-skill-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html><head><title>S</title></head><body>s</body></html>");
  return dir;
}

async function run(opts, answer) {
  const sent = [];
  const client = { call: async (name, args) => {
    if (name === "stage_begin") return { upload_url: "https://stage.example/u", plan: "pro", limits: { max_files: 12000 } };
    sent.push({ ...args });
    return answer(args);
  } };
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ sha: "s1" }) });
  const prev = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  try { return { r: await deploy(client, page(), { noManifest: true, ...opts }, () => {}), sent }; }
  finally { global.fetch = realFetch; if (prev !== undefined) process.env.GITHUB_ACTIONS = prev; }
}
const ok = { uuid: "s-id", url: "https://spacesheep.dev/@y/s", sha: "v1" };

test("--skill is sent as skill", async () => {
  const { r, sent } = await run({ skill: " @spacesheep/docs " }, () => ok);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].skill, "@spacesheep/docs");
  assert.equal(r.skill_missed, undefined);
});

test("no --skill sends none", async () => {
  const { sent } = await run({}, () => ok);
  assert.equal("skill" in sent[0], false);
});

test("a server that refuses the field gets the deploy again without it, and the answer says so", async () => {
  const { r, sent } = await run({ skill: "@spacesheep/docs" }, (args) => {
    if (!("skill" in args)) return ok;
    const err = new Error("create_space takes no skill");
    err.info = { code: "invalid", message: "create_space takes no skill", violations: [{ field: "skill", message: "create_space takes no skill" }] };
    throw err;
  });
  assert.equal(sent.length, 2);
  assert.equal("skill" in sent[1], false);
  assert.match(r.skill_missed, /older than this CLI/);
});

test("any other refusal is the deploy's, not retried", async () => {
  await assert.rejects(run({ skill: "@spacesheep/docs" }, () => {
    const err = new Error("nope"); err.info = { code: "invalid", violations: [{ field: "title", message: "too long" }] }; throw err;
  }), /nope/);
});
