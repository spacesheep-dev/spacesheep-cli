"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { launchdArgv } = require("../lib/stream-service");
const bin = path.join(__dirname, "..", "bin", "spacesheep.js");

// Generate real files via --service, but never invoke this machine's supervisor
// or write its config. Platform and OS commands are stubbed only in the child.
function install(t, platform, video) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-stream-service-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ key: "ss_test_only" }));
  const preload = path.join(dir, "os.cjs");
  fs.writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
require('os').homedir = () => ${JSON.stringify(dir)};
require('child_process').spawnSync = () => ({status: 0, stdout: '', stderr: ''});
`);
  const r = spawnSync(process.execPath, ["--require", preload, bin, "stream", "lab/test", video ? "--camera" : "--system", "--service"], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, SPACESHEEP_CONFIG_DIR: dir, XDG_CONFIG_HOME: dir, SPACESHEEP_NO_UPDATE_CHECK: "1", SPACESHEEP_KEY: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  const file = platform === "darwin"
    ? path.join(dir, "Library", "LaunchAgents", "dev.spacesheep.stream.lab-test.plist")
    : path.join(dir, "systemd", "user", "spacesheep-stream-lab-test.service");
  return fs.readFileSync(file, "utf8");
}

for (const video of [false, true]) {
  test(`systemd ${video ? "camera" : "value"} service does not restart exit 4`, (t) => {
    const unit = install(t, "linux", video);
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, /^RestartPreventExitStatus=4$/m);
    assert.match(unit, new RegExp(`^ExecStart=.*"stream" "lab/test" "--${video ? "camera" : "system"}"$`, "m"));
    assert.doesNotMatch(unit, /SPACESHEEP_KEY|--service/);
  });

  test(`launchd ${video ? "camera" : "value"} service stops only on the translated plan exit`, (t) => {
    const plist = install(t, "darwin", video);
    assert.match(plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
    assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(plist, /<string>\/bin\/sh<\/string><string>-c<\/string>/);
    assert.match(plist, /-eq 4/);
    assert.match(plist, new RegExp(`<string>--${video ? "camera" : "system"}</string>`));
    assert.doesNotMatch(plist, /SPACESHEEP_KEY|--service/);
  });
}

test("launchd translates only exit 4, and passes arguments literally", () => {
  const args = ["a b", "$(exit 99)", "`exit 99`", "a'b\"c", "$HOME", "semi;colon", "<>&"];
  for (const status of [0, 1, 3, 4, 143]) {
    const argv = launchdArgv([process.execPath, "-e", `console.log(JSON.stringify(process.argv.slice(1))); process.exit(${status})`, ...args], 4);
    const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
    assert.equal(r.status, status === 4 ? 0 : 1);
    assert.deepEqual(JSON.parse(r.stdout), args);
  }
});

test("services without an excluded exit keep their original command", () => {
  const argv = [process.execPath, bin, "mirror", "run"];
  assert.deepEqual(launchdArgv(argv), argv);
});
