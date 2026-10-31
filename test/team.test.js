"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { deploy, teamFor } = require("../lib/deploy");

// Which team a page goes to (spacesheep.dev space-team.ts). A team is an audience,
// so it is only ever one that was named: --team, the folder's pin, or a repo's
// .spacesheep.json above it — never a default, and never from outside the repo.

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `ss-team-${name}-`));
const write = (dir, file, body) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), typeof body === "string" ? body : JSON.stringify(body)); };

test("--team wins, then the folder's pin, then the repo's root", () => {
  const repo = tmp("repo");
  fs.mkdirSync(path.join(repo, ".git"));
  write(repo, ".spacesheep.json", { team: "Acme" });
  const page = path.join(repo, "reports", "q3");
  write(page, ".spacesheep.json", {});
  assert.deepEqual(teamFor(page, {}, {}), { ref: "Acme", from: path.join(repo, ".spacesheep.json") });
  assert.deepEqual(teamFor(page, { team: { id: "t-1", name: "Ops" } }, {}), { ref: "t-1", from: path.join(page, ".spacesheep.json") });
  assert.deepEqual(teamFor(page, { team: "Ops" }, { team: "Design" }), { ref: "Design", from: "--team" });
  assert.equal(teamFor(page, { team: "Ops" }, { noTeam: true }), null);
});

test("nothing above the repository's root counts", () => {
  const outside = tmp("outside");
  write(outside, ".spacesheep.json", { team: "Somewhere else" });
  const repo = path.join(outside, "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  assert.equal(teamFor(path.join(repo, "page"), {}, {}), null);
});

test("no team anywhere is personal", () => {
  assert.equal(teamFor(tmp("none"), {}, {}), null);
});

async function run(dir, opts, answer) {
  const calls = [];
  const client = { call: async (name, args) => {
    calls.push([name, args]);
    if (name === "stage_begin") return { upload_url: "https://stage.example/u", plan: "pro", limits: { max_files: 12000 } };
    return answer;
  } };
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ sha: "s1" }) });
  const prev = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  try { const r = await deploy(client, dir, opts, () => {}); return { r, sent: calls.find(([n]) => n === "deploy")[1] }; }
  finally { global.fetch = realFetch; if (prev !== undefined) process.env.GITHUB_ACTIONS = prev; }
}

test("a new page from a repo with a team is sent with it, and the pin keeps where it lives", async () => {
  const repo = tmp("deploy");
  fs.mkdirSync(path.join(repo, ".git"));
  write(repo, ".spacesheep.json", { team: "Acme" });
  const page = path.join(repo, "page");
  write(page, "index.html", "<html><head><title>Q3</title></head><body>q3</body></html>");
  const { r, sent } = await run(page, { teamAccess: "edit" }, {
    uuid: "new-id", url: "https://spacesheep.dev/@y/q3", team: { id: "team-acme", name: "Acme", slug: "t-acme", access: "edit" },
    lives_in: "Acme: its 4 members can view and edit it.",
  });
  assert.equal(sent.team, "Acme");
  assert.equal(sent.team_access, "edit");
  assert.equal(r.team_from, path.join(repo, ".spacesheep.json"));
  const pin = JSON.parse(fs.readFileSync(path.join(page, ".spacesheep.json"), "utf-8"));
  assert.deepEqual(pin.team, { id: "team-acme", name: "Acme" });
  assert.equal(pin.space, "new-id");
});

test("--no-team sends none, and a personal answer leaves no team in the pin", async () => {
  const page = tmp("personal");
  write(page, "index.html", "<html><head><title>P</title></head><body>p</body></html>");
  write(page, ".spacesheep.json", { team: { id: "team-acme", name: "Acme" } });
  const { sent } = await run(page, { noTeam: true, new: true }, { uuid: "p-id", url: "https://spacesheep.dev/@y/p", team: null, lives_in: "Personal: in no team." });
  assert.equal(sent.team, undefined);
  const pin = JSON.parse(fs.readFileSync(path.join(page, ".spacesheep.json"), "utf-8"));
  assert.equal(pin.team, undefined);
});

test("a server that doesn't know team is caught, not trusted", async () => {
  const page = tmp("old-server");
  write(page, "index.html", "<html><head><title>O</title></head><body>o</body></html>");
  const { r } = await run(page, { team: "Acme" }, { uuid: "o-id", url: "https://spacesheep.dev/@y/o" });
  assert.match(r.team_missed, /published as a personal space, not for "Acme"/);
});
