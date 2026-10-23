// User-scoped spacesheep plugins in one Claude home. Read through symlinks: a
// fleet can share settings.json and plugins/ while keeping account state apart.
"use strict";
const fs = require("fs");
const path = require("path");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`couldn't read ${file}: ${e.message}`);
  }
}

function plugins(dir) {
  const registry = readJson(path.join(dir, "plugins", "installed_plugins.json"));
  if (!registry) return [];
  const settingsFile = path.join(dir, "settings.json");
  const settings = readJson(settingsFile);
  const out = [];
  for (const [id, value] of Object.entries(registry.plugins || {})) {
    if (!id.startsWith("spacesheep@")) continue;
    // v1 stored one record; v2 stores installations by scope. A project-only
    // installation must not suppress a bridge for every project in this home.
    for (const record of Array.isArray(value) ? value : [value]) {
      if (!record || (record.scope && record.scope !== "user")) continue;
      const root = record.installPath || (record.version && path.join(dir, "plugins", "cache", id.split("@")[1], "spacesheep", record.version));
      out.push({ id, root, enabled: settings?.enabledPlugins?.[id] !== false, settingsFile });
    }
  }
  return out;
}

/** The plugin's actual servers, not entries in .claude.json. Never edit them. */
function pluginServers(dir, endpoint = "https://mcp.spacesheep.dev/mcp") {
  const expected = new URL(endpoint);
  const out = [];
  for (const p of plugins(dir).filter((p) => p.enabled && p.root)) {
    const file = path.join(p.root, ".mcp.json");
    const doc = readJson(file);
    if (!doc) continue;
    for (const [name, entry] of Object.entries(doc.mcpServers || doc)) {
      let url;
      try { url = new URL(entry.url); } catch (_) { continue; }
      if (url.origin !== expected.origin || url.pathname.replace(/\/$/, "") !== expected.pathname.replace(/\/$/, "") || url.search !== expected.search) continue;
      out.push({ plugin: p.id, name: `plugin:spacesheep:${name}`, file: fs.realpathSync(file),
        entry: doc.mcpServers ? `mcpServers.${name}` : name, settingsFile: fs.realpathSync(p.settingsFile) });
    }
  }
  return out;
}

function pluginNote(servers) {
  return `bridge skipped: enabled plugin already connects via ${servers.map((s) => `${s.file} entry "${s.entry}" (${s.name})`).join(", ")}`;
}

module.exports = { plugins, pluginServers, pluginNote };
