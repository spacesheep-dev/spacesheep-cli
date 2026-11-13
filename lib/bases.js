// The version a folder's files were last published as, so the next deploy from that
// folder names it as its base_sha. The server merges a deploy built on an older
// version with what landed since, and refuses one whose base it can't place: with no
// base_sha it guesses from who wrote the live version (by session, else account and
// machine), so a new agent session redeploying its own folder read as someone else
// and was refused `no_base`.
//
// Only a version that IS this folder's files is saved. A merged deploy published the
// folder plus what landed on the server, so its sha would make the next deploy from
// here look like a replacement of it, erasing what was merged. After a merge the
// folder keeps the version the merge was built on (the next deploy merges the same
// edits in again), or, with that unknown, is held until the person reconciles it.
//
// Kept on this machine, not in .spacesheep.json: that file is committed with a site on
// purpose (GitHub Actions deploys from it), and a sha written there would be stale on
// every other checkout, so a later CI deploy would merge against an old version and
// could refuse an edit that touched a line twice. A machine with nothing saved (a
// fresh CI runner) sends no base, and the server's guess applies as before.
"use strict";
const fs = require("fs");
const path = require("path");
const cfg = require("./config");

const KEEP = 500;
const file = () => path.join(cfg.configDir(), "bases.json");
const keyOf = ({ origin, space, dir }) => `${origin || ""} ${space} ${path.resolve(dir)}`;
/** One spelling of a space's name: its link and its @handle/slug are one name, with or
 *  without the host, a slash at either end, a query or a fragment. An id stays as it is. */
const bareName = (s) => String(s).trim().replace(/^https?:\/\/[^/]+/i, "").replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "");
const spellings = (where, as) => [...new Set([].concat(where.space).filter(Boolean).map(as).filter(Boolean))].map((space) => keyOf({ ...where, space }));
// `space` is one name or several: a space goes by its id, its link and its @handle/slug.
const keysOf = (where) => spellings(where, bareName);
// A record from before names were spelt one way is under the name as it was typed.
const oldKeysOf = (where) => spellings(where, String);

function readAll() {
  try {
    const all = JSON.parse(fs.readFileSync(file(), "utf-8"));
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch { return {}; }
}

/** The newest record read or saved under any of the space's names. */
function hitOf(where) {
  const all = readAll();
  const hits = [...new Set([...keysOf(where), ...oldKeysOf(where)])].map((k) => all[k]).filter(Boolean);
  return hits.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0] || null;
}

/** The sha this machine last published `space` as from `dir`, or null. */
function savedBase(where) {
  const hit = hitOf(where);
  return hit && typeof hit.sha === "string" && hit.sha ? hit.sha : null;
}

/** The merged version a deploy from `dir` made when no base for it was known, or null:
 *  the folder lacks part of what is live, and nothing says what it is built on. */
function heldBase(where) {
  const hit = hitOf(where);
  return hit && !hit.sha && typeof hit.held === "string" && hit.held ? hit.held : null;
}

/** The version this machine's last deploy from `dir` merged into while keeping its
 *  base, or null: the folder lacks what that merge took from the server. */
function mergedInto(where) {
  const hit = hitOf(where);
  return hit && hit.sha && typeof hit.merged === "string" && hit.merged ? hit.merged : null;
}

/** Remember `sha` as what `dir`'s files are built on (`merged`: the version a merge
 *  made from them). Never fails a deploy. */
const saveBase = (where, sha, merged) => sha && write(where, merged ? { sha, merged } : { sha });
/** Remember that `dir` was merged into `sha` with no known base. */
const holdBase = (where, sha) => sha && write(where, { held: sha });

function write(where, rec) {
  const mine = keysOf(where);
  if (!mine.length) return;
  try {
    const all = readAll();
    const at = new Date().toISOString();
    for (const k of mine) all[k] = { ...rec, at };
    const keys = Object.keys(all);
    if (keys.length > KEEP) {
      keys.sort((a, b) => String(all[a].at || "").localeCompare(String(all[b].at || "")));
      for (const k of keys.slice(0, keys.length - KEEP)) delete all[k];
    }
    fs.mkdirSync(cfg.configDir(), { recursive: true, mode: 0o700 });
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file());
  } catch {}
}

module.exports = { savedBase, saveBase, heldBase, holdBase, mergedInto, bareName };
