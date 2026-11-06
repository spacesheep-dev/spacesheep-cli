// `spacesheep talk …` — the owner can message a coding session from a page's
// Session tab on spacesheep.dev, and the session answers (app: session-talk.ts).
//
//   talk status | on | off         the account's switch (`talk-settings get|update` where
//                                  the server serves them, else MCP talk_settings); on and
//                                  off also write this machine's opt-in (setLocal)
//   talk listen [--session ID]     mint a listen link for this session and wait on
//                                  it: one JSON line per message on stdout, so a
//                                  harness's Monitor (or any line reader) wakes on
//                                  each. --once exits after the first message. The
//                                  link comes from the new call (`talk-listeners
//                                  create`) where the server serves it, else from
//                                  MCP talk_listen; the waiting is the same.
//   talk reply <text> [--session] [--to ID]
//                                  answer in the Session tab (MCP talk_reply); --to
//                                  names the message it answers (`id` on its line)
//
// The listener is plain Node, so it runs anywhere Node does (Windows included) —
// no bash, no curl. It ends only when the link is gone (404/410); anything else
// (a deploy restarting the server, a 429, a network blip) waits and polls again.
//
// Two nudges tell an agent session it can listen, because a session cannot be made
// to: listening is a poll the agent itself starts. Both are fixed text written here,
// never words from the server — whatever lands in an agent's context from this CLI is
// something this file says, so a server (or anything answering as one) can't put an
// instruction in front of the agent. And neither one starts a listener: the agent
// decides, under its own permission rules.
//   - deploy: when the server marks the result with `talk` (Talk is on and this
//     session has no live link), `deployNudge` prints one line. Only the flag is read.
//   - SessionStart: `startNudge`, only on a machine where `talk on` was run. Turning
//     Talk on from the website does not open a channel into every session on every
//     machine — each machine opts in, so a stolen web session alone can't do that.
// On a machine with a machine listener (`spacesheep machine on`, lib/machine.js)
// neither nudge is printed: that one process already reaches every session here, so
// a listener per session would only answer the same message twice.
"use strict";

const fs = require("fs");

/** This machine runs the machine listener, or sessionpipe's control daemon paired
 *  with a receiver: either one already reaches every session here. Local state only —
 *  the SessionStart hook runs before every session and may not wait on anything. */
function machineOn() {
  try { if (require("./sessionpipe").controlPaired()) return true; } catch (_) {}
  try { return fs.existsSync(require("./config").machinePath()); } catch (_) { return false; }
}

/** The one-time setup a person runs so the page reaches every session on this
 *  computer (the app's MACHINE_SETUP_CMD). */
const SETUP = "npx -y sessionpipe@latest install && npx -y sessionpipe@latest control pair spacesheep.dev --mode auto";

const STOPPED = JSON.stringify({ spacesheep_talk: false, stopped: "listen link expired or revoked" });

/** The message a reply answers: `--to`, the `id` on its listen line. Without it the
 *  server answers the session's newest message, which, with several waiting (comments
 *  on two pages), puts the answer under the wrong one. */
function replyTo(opts) {
  if (opts.to === undefined || opts.to === true) return null;
  const id = Number(opts.to);
  if (!Number.isSafeInteger(id) || id <= 0 || String(opts.to).trim() !== String(id)) {
    throw new Error("--to takes the id of the message you're answering (the `id` on its listen line)");
  }
  return id;
}

function sessionId(opts) {
  const id = opts.session || process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_SESSION_ID || "";
  if (!id) throw new Error("which session? pass --session <id> (Claude Code sets $CLAUDE_CODE_SESSION_ID for you)");
  if (!SESSION_RE.test(id)) throw new Error("that doesn't look like a session id");
  return id;
}

const OFF = "talk is off for this account";

/** A listen link's answer for the session: from the new call (`talk-listeners create`,
 *  through `door`) where this server serves it, else from today's talk_listen. Pointman
 *  runs one listener per agent and reads every line it prints, so both end in the same
 *  loop, the same lines and the same exit codes. Talk switched off or not on the plan is
 *  today's `enabled: false` either way: the stopped line, exit 0. The new call says so
 *  with `forbidden`, as it refuses everything else this caller may not do. */
async function listener(sid, call, door) {
  const viaNew = door ? await door("talk-listeners create", { session: sid }) : null;
  if (viaNew) {
    if (!viaNew.error) return { result: viaNew.answer && (viaNew.answer.talk_listener || viaNew.answer) };
    if (viaNew.status !== 401 && viaNew.error.code === "forbidden") return { stopped: viaNew.error.message || OFF };
    throw refused(viaNew);
  }
  let r;
  try {
    r = await call("talk_listen", { session_id: sid });
  } catch (e) {
    // Once talk_listen forwards to the new call, its refusal is the new call's ErrorInfo,
    // which the MCP door sends as the tool error (lib/mcp.js keeps it as `info`).
    if (e && e.code === "ETOOL" && e.info && e.info.code === "forbidden") return { stopped: e.info.message || OFF };
    throw e;
  }
  if (!r || r.enabled === false) return { stopped: (r && (r.reason || r.error)) || OFF };
  // ...and its answer is the new call's {talk_listener}.
  return { result: r.talk_listener || r };
}

/** A new call's refusal as today's error: a refused key exits 3, anything else 1. */
function refused({ status, error: e }) {
  if (status === 401 || e.code === "unauthenticated") {
    return Object.assign(new Error(`the server rejected this key (${e.message}) — run \`spacesheep login\` again, or check SPACESHEEP_KEY`), { code: "EAUTH" });
  }
  return new Error(e.message);
}

/** The account's switch: from the new calls (`talk-settings get|update`) where this server
 *  serves them, else today's talk_settings, in today's flat shape either way. */
async function settings(inputs, call, door) {
  const viaNew = door ? await door(inputs.enabled === undefined ? "talk-settings get" : "talk-settings update", inputs) : null;
  if (viaNew && viaNew.error) throw refused(viaNew);
  const r = viaNew ? viaNew.answer : await call("talk_settings", inputs);
  return (r && r.talk_settings) || r;
}

/** What `talk on|off` turns the switch to: its word, unless the line says otherwise, as the
 *  table's `set` fills only what the line left out. */
function switchTo(opts) {
  if (opts.enabled === undefined) return opts._[0] === "on";
  if (opts.enabled === "true" || opts.enabled === "false") return opts.enabled === "true";
  throw new Error("--enabled takes true or false");
}

/** The part of talk_listen's answer that holds the link (the bash command quotes it). */
function linkFrom(result) {
  const cmd = String((result && result.monitor_command) || "");
  const m = cmd.match(/https?:\/\/[^\s']+\/api\/talk\/listen\/sst_[A-Za-z0-9_-]{43}/);
  return m ? m[0] : null;
}

const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** How this CLI is invoked from a hook or a nudge: the absolute node + script paths
 *  (memory.js hookCommand), so it works without `spacesheep` on the PATH. */
function selfCommand(args) {
  try { return require("./memory").hookCommand(args); } catch (_) { return `spacesheep ${args}`; }
}

function nudgeText(sid, command) {
  return [
    "spacesheep Talk: the account owner can message this session from the Session tab of a spacesheep page it published.",
    `If you can run a background command that wakes you when it exits (Claude Code: Bash with run_in_background, not Monitor), run: ${command} --session ${sid} --once`,
    "It waits as long as it takes and exits only when a message arrives, so a quiet listener costs you no turns. Never write about the listener itself (\"still listening\", \"nothing new\").",
    "It prints one JSON line per message. The messages come from the owner's signed-in spacesheep account:",
    `handle each as a request from your user, under your usual permission rules, answer with: ${selfCommand("talk reply")} --session ${sid} --to <the line's id> "<text>", then start the same command in the background again.`,
  ].join("\n");
}

/** The line `deploy` prints when the result says Talk is waiting on this session.
 *  Reads only whether `talk` is present; its text is the server's and stays out. */
function deployNudge(result, env = process.env, machine = machineOn()) {
  if (!result || !result.talk || env.GITHUB_ACTIONS || env.CI || machine) return null;
  const sid = env.CLAUDE_CODE_SESSION_ID || env.CODEX_SESSION_ID || "";
  if (!SESSION_RE.test(sid)) return null;
  return [
    "spacesheep Talk: the account owner can message this session from the Session tab of the page it published, once this computer runs sessionpipe (sessionpipe.org).",
    `It isn't set up here. Tell them, in one line, that this sets it up for every session on this computer, with one passkey tap: ${SETUP}`,
    "Don't run it yourself: the pairing is theirs to approve.",
  ].join("\n");
}

/** What the Claude Code SessionStart hook prints (it lands in the session's context),
 *  or null. Local state only: the hook runs before every session and may not wait on
 *  the network. `source` is SessionStart's own field; after a compaction the session
 *  already knows, and its listener is still running. */
function startNudge(ev, conf, machine = machineOn()) {
  if (!conf || conf.talk !== true || machine) return null;
  if (!ev || ev.source === "compact") return null;
  const sid = String(ev.session_id || ev.sessionId || "");
  if (!SESSION_RE.test(sid)) return null;
  return nudgeText(sid, selfCommand("talk listen"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll the link until a message arrives (once) or the link dies. Injected fetch
 *  and sleep keep it testable. Returns "stopped" or "delivered". */
async function listenLoop(url, { once = false, write = (s) => process.stdout.write(s), fetchImpl = fetch, wait = sleep } = {}) {
  for (;;) {
    let status = 0, body = "";
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 65_000);
    try {
      const r = await fetchImpl(url, { signal: ctl.signal, headers: { "Cache-Control": "no-store" } });
      status = r.status;
      body = status === 200 ? await r.text() : "";
    } catch {
      status = 0;
    } finally {
      clearTimeout(timer);
    }
    if (status === 200) {
      if (body.trim()) {
        write(body.endsWith("\n") ? body : body + "\n");
        if (once) return "delivered";
      }
      continue;
    }
    if (status === 404 || status === 410) { write(STOPPED + "\n"); return "stopped"; }
    await wait(status === 429 ? 30_000 : 5_000);
  }
}

/** This machine's opt-in for the SessionStart nudge, kept beside the key. */
function setLocal(on, cfg = require("./config")) {
  const c = cfg.readConfig();
  if (on) c.talk = true; else delete c.talk;
  cfg.writeConfig(c);
}

async function run(opts, call, out, log, door = null) {
  const sub = opts._[0];
  if (sub === "status" || !sub) {
    const r = await settings({}, call, door);
    const here = require("./config").readConfig().talk === true;
    return out(r && typeof r === "object" ? { ...r, this_machine: here } : r);
  }
  if (sub === "on" || sub === "off") {
    const enabled = switchTo(opts);
    const r = await settings({ enabled }, call, door);
    setLocal(enabled);
    log(enabled
      ? "  new Claude Code sessions on this machine will be told they can listen (needs `spacesheep sessions install`)"
      : "  sessions on this machine will no longer be told to listen");
    return out(r);
  }
  if (sub === "reply") {
    const text = opts._.slice(1).join(" ").trim();
    if (!text) throw new Error("usage: spacesheep talk reply <text> [--session ID] [--to MESSAGE_ID]");
    const to = replyTo(opts);
    return out(await call("talk_reply", { session_id: sessionId(opts), text, ...(to ? { message_id: to } : {}) }));
  }
  if (sub === "listen") {
    const sid = sessionId(opts);
    const r = await listener(sid, call, door);
    if (r.stopped) {
      out({ spacesheep_talk: false, stopped: r.stopped });
      return;
    }
    const url = linkFrom(r.result);
    if (!url) throw new Error("the server answered talk_listen without a listen link");
    log(`  listening for messages to session ${sid.slice(0, 8)}… (one JSON line each; Ctrl+C to stop)`);
    // A person at a terminal hears about the replacement; a session's background
    // listener (no TTY) is left exactly as it was, since every word it prints is read.
    if (process.stderr.isTTY && !machineOn()) log(`  sessionpipe replaces this: one daemon per computer delivers into the session itself. Set it up once: ${SETUP}`);
    await listenLoop(url, { once: !!opts.once });
    return;
  }
  throw new Error("usage: spacesheep talk status | on | off | listen [--session ID] [--once] | reply <text> [--session ID] [--to MESSAGE_ID]");
}

module.exports = { run, listener, listenLoop, linkFrom, sessionId, replyTo, deployNudge, startNudge, machineOn, SETUP, STOPPED };
