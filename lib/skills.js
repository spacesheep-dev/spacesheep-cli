// The /sheep skill, put in every harness on this machine that reads skills.
//
// The text is fetched from the app (/skill/sheep.md), the one copy every surface
// serves, so nothing here can drift from it; only the frontmatter a skill folder
// needs is added (the same lines the Claude Code plugin adds, plugin-dist.ts
// skillMarkdown). A file is only ever overwritten when it is a copy of the skill.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { claudeDirs, claudeId } = require("./harnesses");
const { plugins } = require("./claude-plugins");

const MARK = "spacesheep-skill-version";
const PLUGIN_ID = "spacesheep@spacesheep";
const TALK_MARK = "<!-- spacesheep-installed-talk -->";
const FRONTMATTER = `---
name: sheep
description: Build and deploy a publication-quality single-page document to spacesheep — a shareable URL with comments, versions and access control. Use when asked to publish, deploy, share a page or report, update a space that already exists, or publish the full current Claude Code session transcript — and whenever the ask carries a spacesheep.dev link to read or act on (a plan, a spec, a doc), private ones included: it covers signing in to read one from a remote or headless machine.
---

`;

async function fetchSkill(appOrigin, doFetch = globalThis.fetch) {
  const r = await doFetch(`${appOrigin.replace(/\/$/, "")}/skill/sheep.md`);
  if (!r.ok) throw new Error(`couldn't fetch the skill (HTTP ${r.status})`);
  const text = await r.text();
  if (!text.includes(MARK)) throw new Error("the skill the server sent doesn't look like the skill");
  return text;
}
const versionOf = (text) => (new RegExp(`${MARK}:\\s*([\\d.]+)`).exec(text || "") || [])[1] || null;

/** Only an installed AND enabled plugin carries skills into this home. */
function hasPlugin(dir) {
  return plugins(dir).some((p) => p.enabled);
}

/**
 * Where the skill goes. Claude Code always reads skills; the others only once they
 * have made their skills folder, which is how we know a version that reads them.
 */
function skillTargets({ home = os.homedir(), env = process.env } = {}) {
  const out = [];
  const exists = (p) => { try { fs.statSync(p); return true; } catch (_) { return false; } };
  const tilde = (p) => (p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p);
  claudeDirs(home, env).forEach((dir, i) => {
    // The same homes the MCP entry goes to (harnesses.js): a second home only once
    // Claude Code has run in it.
    if (!exists(dir) || (i > 0 && !exists(path.join(dir, ".claude.json")))) return;
    const id = claudeId(dir, i === 0);
    const label = i === 0 ? "Claude Code" : `Claude Code (${tilde(dir)})`;
    let installed;
    try { installed = plugins(dir); }
    catch (e) { out.push({ id, harness: label, error: e.message }); return; }
    if (installed.some((p) => p.enabled)) return out.push({ id, harness: label, skip: "the enabled spacesheep plugin carries /sheep and talk" });
    // `npx spacesheep-skill` installed it as a command: keep it one /sheep, updated there.
    const command = path.join(dir, "commands", "sheep.md");
    out.push(exists(command) ? { id, harness: label, file: command, frontmatter: false }
      : { id, harness: label, file: path.join(dir, "skills", "sheep", "SKILL.md"), frontmatter: true });
    // A disabled plugin still has its authoritative talk command in the cache.
    if (installed.length) {
      const roots = installed.map((p) => p.root).filter(Boolean);
      const source = roots.map((root) => path.join(root, "commands", "talk.md")).find(exists);
      out.push({ id, harness: label, skill: "talk", source,
        file: path.join(dir, "commands", "talk.md"),
        error: source ? undefined : `couldn't restore talk: commands/talk.md is missing from ${roots.join(", ") || path.join(dir, "plugins")}; reinstall the plugin, then disable it and rerun install` });
    }
  });
  const others = [
    ["codex", "Codex", path.join(env.CODEX_HOME || path.join(home, ".codex"), "skills")],
    ["cursor", "Cursor", path.join(home, ".cursor", "skills")],
    ["gemini", "Gemini CLI", path.join(home, ".gemini", "skills")],
    ["antigravity", "Antigravity", path.join(home, ".gemini", "config", "skills")],
  ];
  for (const [id, harness, dir] of others) if (exists(dir)) out.push({ id, harness, file: path.join(dir, "sheep", "SKILL.md"), frontmatter: true });
  for (const t of out) if (t.file) t.shown = tilde(t.file);
  return out;
}

/** Writes the skill everywhere it goes. → [{ harness, file, action, version, error }] */
function installSkills(skill, targets, { dryRun = false } = {}) {
  return targets.map((t) => {
    const version = t.skill === "talk" ? null : versionOf(skill);
    if (t.error) return { harness: t.harness, file: t.shown, action: "skipped", error: t.error };
    if (t.skip) return { harness: t.harness, action: "skipped", note: t.skip };
    let body = t.frontmatter ? FRONTMATTER + skill : skill;
    if (t.skill === "talk") {
      try { body = fs.readFileSync(t.source, "utf8").trimEnd() + "\n\n" + TALK_MARK + "\n"; }
      catch (e) { return { harness: t.harness, file: t.shown, action: "skipped", error: e.message }; }
    }
    const mark = t.skill === "talk" ? TALK_MARK : MARK;
    let before = null;
    try { before = fs.readFileSync(t.file, "utf8"); } catch (_) {}
    if (before !== null && !before.includes(mark)) return { harness: t.harness, file: t.shown, action: "skipped", error: "a different file is already there" };
    if (before === body) return { harness: t.harness, file: t.shown, action: "unchanged", version };
    if (!dryRun) {
      try {
        fs.mkdirSync(path.dirname(t.file), { recursive: true });
        fs.writeFileSync(t.file, body);
      } catch (e) { return { harness: t.harness, file: t.shown, action: "skipped", error: e.message }; }
    }
    return { harness: t.harness, file: t.shown, action: before === null ? "added" : "updated", from: versionOf(before), version };
  });
}

/** Removes owned folder skills and our marked talk copy, never an existing command. */
function uninstallSkills(targets, { dryRun = false } = {}) {
  return targets.filter((t) => t.file && (t.frontmatter || t.skill === "talk")).map((t) => {
    let text = null;
    try { text = fs.readFileSync(t.file, "utf8"); } catch (_) {}
    if (text === null || !text.includes(t.skill === "talk" ? TALK_MARK : MARK)) return { harness: t.harness, file: t.shown, action: "unchanged" };
    if (!dryRun) {
      try { fs.unlinkSync(t.file); } catch (e) { return { harness: t.harness, file: t.shown, action: "skipped", error: e.message }; }
      try { fs.rmdirSync(path.dirname(t.file)); } catch (_) {} // only when nothing else is in it
    }
    return { harness: t.harness, file: t.shown, action: "removed" };
  });
}

module.exports = { fetchSkill, versionOf, skillTargets, installSkills, uninstallSkills, hasPlugin, pluginEnabled: hasPlugin, PLUGIN_ID, FRONTMATTER, MARK, TALK_MARK };
