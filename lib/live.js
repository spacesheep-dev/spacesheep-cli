// The live link from a shell: the link first, then the work. `live-link` is the
// server's live_link (a "Spacesheep is working on it" page, its URL back in about a
// second) and `live-status` is live_push's status, so an agent that reaches
// spacesheep only through this CLI can hand over the link before the page exists,
// as the /sheep skill's first call does. Such agents are common: a Remote Control or
// headless Claude Code session whose MCP connection can't sign in, a Claude config
// home without the plugin, Codex. 2026-10-13: one of them, asked for "a live
// spacesheep.dev link, which you give to me now", researched for eight minutes, was
// asked for the link twice, and sent its first one ten minutes in, after writing the
// whole page. `call live_link` could have done it; nothing such an agent reads said so.
"use strict";
const { refusalError } = require("./deploy");

const LINK_USAGE = 'usage: spacesheep live-link <title> [--emoji 📊] [--description "…"] [--status "first step"] [--visibility public|signed_in|members|private] [--email a@b.c ...] [--slug s] [--org o] [--json]';
const STATUS_USAGE = 'usage: spacesheep live-status <space> "<what you are doing now>" [--stopped]   ("" takes the card down)';

/** live_link's arguments: the title is the words (or --title). No --visibility and
 *  no --email means no `access`, so the account's own default for new pages applies,
 *  exactly as on a deploy. */
function liveLinkArgs(opts) {
  const title = String(opts.title || (opts._ || []).join(" ")).trim();
  if (!title) throw new Error(LINK_USAGE);
  const args = { title };
  if (opts.emoji) args.emoji = opts.emoji;
  if (opts.description) args.description = opts.description;
  if (opts.status) args.status = opts.status;
  if (opts.slug) args.slug = opts.slug;
  if (opts.org !== undefined) args.org = opts.org;
  const access = {};
  if (opts.visibility) access.visibility = opts.visibility;
  if (opts.emails && opts.emails.length) access.emails = opts.emails;
  if (Object.keys(access).length) args.access = access;
  return args;
}

/** live_link's answer, or its refusal as an error. A refusal comes back exactly as
 *  deploy's does (a rate limit, a plan cap, a bad org), so it is read the same way. */
function liveLinkResult(result) {
  const refused = refusalError(result, "live_link");
  if (refused) throw refused;
  if (!result || typeof result.uuid !== "string" || typeof result.url !== "string") {
    throw new Error(`live_link answered without a link, so it is unclear whether anything was published — run \`spacesheep list\` to check. Server said: ${JSON.stringify(result).slice(0, 400)}`);
  }
  return result;
}

/** What follows a live link: the link to send, then the two commands that carry the
 *  work to the finished page at the same address. */
function liveLinkLines(r) {
  const lines = [
    `  ✓ Live link${r.visibility ? ` (${r.visibility})` : ""}: ${r.url}`,
    "    Send it now: the page appears there when it's done.",
    `    Each step:  spacesheep live-status ${r.uuid} "Reading the sources"`,
    `    Finish:     spacesheep deploy <folder or .html> --space ${r.uuid}`,
  ];
  if (r.visibility === "private") lines.push(`    Private: only you can open it. For someone else: spacesheep share ${r.uuid} --visibility public`);
  return lines;
}

/** live_push's arguments for one step: the words after the space are the status. */
function liveStatusArgs(opts) {
  const [space, ...words] = opts._ || [];
  if (!space || !words.length) throw new Error(STATUS_USAGE);
  const args = { uuid: space, status: words.join(" ") };
  if (opts.stopped) args.stopped = true;
  return args;
}

module.exports = { liveLinkArgs, liveLinkResult, liveLinkLines, liveStatusArgs };
