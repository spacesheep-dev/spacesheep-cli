// A refusal is the server saying no on purpose: the same call again gets the same no.
// Production saw agents loop on them — one account's two Claude Code sessions published
// one space ~500 times a day for two weeks, each refused `conflict`, and 2,934 publishes
// refused because the space wasn't shared with the caller. So the CLI never retries one
// of these words by itself (rate_limited at most once, after its retry_after), and it
// exits non-zero with the server's words plus one line saying what has to change.
// `stop_retrying` is the server refusing a caller that sent the same refused call five
// times in ten minutes: its message is printed as it is, and the exit code is its own.
"use strict";

const NO_RETRY = new Set([
  "conflict", "error", "forbidden", "invalid", "would_drop_files", "index_shrunk",
  "placeholder_page", "stop_retrying", "rate_limited",
]);
/** The exit code for `stop_retrying`: 1 is any failure, 2 a wrong command line, 3 no sign-in. */
const EXIT_STOP_RETRYING = 4;
/** rate_limited waits once, for at most this long; a longer retry_after is the caller's to wait. */
const MAX_RATE_WAIT_S = 60;

/** The plain-text answer the deploy and edit tools give a caller who may not change the space. */
const PERMISSION = /^You can't change this space\b|only its owner (?:and people|can change one)/;

/** A refusal in any shape a tool answers with, as {code, message, retry_after?}, or null:
 *  today's JSON {error, message}, a door's ErrorInfo {code, message}, or the permission
 *  refusal's plain text. */
function refusalOf(x) {
  if (typeof x === "string") return PERMISSION.test(x) ? { code: "error", message: x, permission: true } : null;
  if (!x || typeof x !== "object") return null;
  const word = (v) => (typeof v === "string" && /^[a-z][a-z_]*$/.test(v) ? v : null);
  const code = word(x.error) || word(x.code);
  if (!code) return null;
  const message = typeof x.message === "string" ? x.message : "";
  const r = { code, message };
  const wait = Number(x.retry_after);
  if (wait > 0) r.retry_after = wait;
  if (PERMISSION.test(message) || code === "permission_denied") r.permission = true;
  return r;
}

const isFinal = (r) => !!r && (NO_RETRY.has(r.code) || !!r.permission);

/** The one line that says what the person (or their agent) must do instead of running
 *  the same command again. `space`: the space it was about, for the commands named. */
function nextStep(r, { space } = {}) {
  if (!r) return null;
  const sp = space || "<space>";
  if (r.permission || r.code === "forbidden") return `What to do: ask the space's owner to share it with you with "Can edit", or publish your own copy with --new. Running this again is refused the same way.`;
  switch (r.code) {
    case "stop_retrying": return "What to do: stop — the server refuses this call until something changes. Tell the person what was refused and wait for them.";
    case "conflict": return `What to do: merge first — spacesheep read ${sp} -o <folder>, put your changes in, deploy from that folder (or --base <sha> / --replace). The same deploy again is refused the same way.`;
    case "would_drop_files":
    case "index_shrunk": return "What to do: deploy the folder holding every file the space should keep (the built site, not a part of it). Removing them is the person's call: ask before publishing a smaller version.";
    case "placeholder_page": return "What to do: put the real page in index.html, then deploy once.";
    case "invalid": return "What to do: change what the message names; the same command again is refused the same way.";
    case "rate_limited": return `What to do: wait${r.retry_after ? ` ${Math.ceil(r.retry_after)} s` : ""}, then run it once more — not in a loop.`;
    case "error": return "What to do: read the message above and change what it names; the same command again is refused the same way.";
    default: return null;
  }
}

/** The exit code for an error the CLI is about to die of. */
const exitCodeFor = (e) => (e && e.refusal && e.refusal.code === "stop_retrying" ? EXIT_STOP_RETRYING : e && e.code === "EAUTH" ? 3 : 1);

/** What the CLI prints for an error: stop_retrying's message as the server wrote it; any
 *  other refusal, the error's own words and the line saying what to do. */
function errorWords(e, ctx = {}) {
  const r = e && e.refusal;
  if (e && e.space) ctx = { ...ctx, space: e.space };
  if (r && r.code === "stop_retrying") return `${r.message || e.message}\n  ${nextStep(r, ctx)}`;
  const step = r && isFinal(r) ? nextStep(r, ctx) : null;
  return step && !e.message.includes(step) ? `${e.message}\n  ${step}` : e.message;
}

module.exports = { NO_RETRY, EXIT_STOP_RETRYING, MAX_RATE_WAIT_S, refusalOf, isFinal, nextStep, exitCodeFor, errorWords };
