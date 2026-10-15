"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const SKILL = "<!-- spacesheep-skill-version: 1.110.0 -->\n# Sheep fixture\n";
const TALK = "---\ndescription: Listen for spacesheep messages\n---\nCall talk_listen.\n";
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === "string" ? text : JSON.stringify(text, null, 2) + "\n");
}
function fleet(home, enabled = true, wrapped = false) {
  const shared = path.join(home, ".claude");
  const cache = path.join(shared, "plugins", "cache", "spacesheep", "spacesheep", "1.110.0");
  const servers = { spacesheep: { type: "http", url: "https://mcp.spacesheep.dev/mcp" } };
  write(path.join(cache, ".mcp.json"), wrapped ? { mcpServers: servers } : servers);
  write(path.join(cache, "commands", "talk.md"), TALK);
  write(path.join(shared, "plugins", "installed_plugins.json"), { version: 2, plugins: {
    "spacesheep@spacesheep": [{ scope: "user", installPath: cache, version: "1.110.0" }],
  } });
  write(path.join(shared, "settings.json"), { enabledPlugins: { "spacesheep@spacesheep": enabled } });
  const homes = [".claude-key1", ".claude-key2", ".claude-key3", ".claude-key4", ".claude-key5", ".claude-placeholder"];
  for (const name of homes) {
    const dir = path.join(home, name);
    fs.mkdirSync(path.join(dir, "projects"), { recursive: true });
    if (name !== ".claude-placeholder") write(path.join(dir, ".claude.json"), {});
    fs.symlinkSync(path.join(shared, "settings.json"), path.join(dir, "settings.json"));
    fs.symlinkSync(path.join(shared, "plugins"), path.join(dir, "plugins"));
  }
  return { shared, cache, homes };
}
module.exports = { fleet, write, SKILL, TALK };

// Offline, repeatable plan: real discovery/writers, stand-ins only for the remote
// key check and skill download. Pass either checkout to compare the same fleet.
if (require.main === module) {
  const root = path.resolve(process.argv[2]);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ss-fleet-"));
  fleet(home);
  os.homedir = () => home;
  const cfg = require(path.join(root, "lib/config"));
  cfg.resolveKey = () => ({ key: "ss_fixture", source: "env" });
  cfg.readConfig = () => ({ username: "fixture", machine: "fleet" });
  cfg.configDir = () => path.join(home, ".config", "spacesheep");
  require(path.join(root, "lib/mcp")).McpClient.prototype.listTools = async () => Array(107).fill({});
  require(path.join(root, "lib/skills")).fetchSkill = async () => SKILL;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude-key1");
  process.argv[1] = path.join(home, ".npm", "_npx", "fixture", "node_modules", "spacesheep", "bin", "spacesheep.js");
  require(path.join(root, "lib/install")).run({ dryRun: true, only: "claude-code", except: "claude-code:.claude-placeholder" },
    (line) => console.log(line.replaceAll(home, "~")), console.log).finally(() => fs.rmSync(home, { recursive: true, force: true }));
}
