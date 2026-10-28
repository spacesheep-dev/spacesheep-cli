// `spacesheep mcp`: the spacesheep MCP server as a local stdio server.
//
// Every harness on a machine (Claude Code, Codex, Gemini CLI, Cursor, …) runs this
// one command instead of connecting to mcp.spacesheep.dev itself. Each harness
// connecting on its own is one sign-in per harness per machine: eleven machines
// with five harnesses was fifty OAuth flows (2026-10-14). The bridge reads the key
// this machine already holds (`spacesheep login` / `connect` / `install`), so a
// machine signs in once and every harness on it is connected.
//
// It is a pipe, nothing more: each JSON-RPC line on stdin is POSTed to the remote
// server and every message that comes back (a JSON body, or each event of an SSE
// body, progress notifications included) is written to stdout as one line. The
// tool list is the server's, read live, so a new tool needs no new bridge.
//
// stdout is the protocol. Nothing else may ever be written there: messages for a
// person go to stderr, which harnesses keep as the server's log.
"use strict";

const readline = require("readline");
const cfg = require("./config");

const { fetch } = require("./http");
const SETUP = "npx -y spacesheep@latest install";

/** A JSON-RPC error answer for a request. */
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Splits an SSE body into the JSON messages its `data:` lines carry, as they arrive. */
async function* sseMessages(body) {
  const decoder = new TextDecoder();
  let buf = "";
  const flush = function* (block) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return;
    try { yield JSON.parse(data); } catch (_) {}
  };
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, at);
      buf = buf.slice(at).replace(/^\r?\n\r?\n/, "");
      yield* flush(block);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield* flush(buf);
}

/**
 * Runs the bridge until stdin closes. Everything is injectable for the tests:
 * `input`/`output`/`errors` streams, `fetch`, and `key()` / `origin()` — read on
 * every request, so a `spacesheep login` while a harness is open takes effect on
 * the next call without restarting anything.
 */
function runBridge({
  input = process.stdin,
  output = process.stdout,
  errors = process.stderr,
  fetch: doFetch = fetch,
  key = () => { const k = cfg.resolveKey(); return k && k.key; },
  origin = () => cfg.origin(),
} = {}) {
  let session = null;
  let protocol = null;
  let initParams = null;
  let initializing = null; // the in-flight initialize; other messages wait for it
  const inflight = new Set();

  const write = (msg) => { output.write(JSON.stringify(msg) + "\n"); };
  const warn = (line) => { errors.write(`[spacesheep] ${line}\n`); };

  async function post(msg) {
    const k = key();
    if (!k) {
      const e = new Error(`this machine isn't signed in to spacesheep — run \`${SETUP}\` in a terminal on it, then reconnect`);
      e.code = "EAUTH";
      throw e;
    }
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${k}`,
    };
    if (protocol) headers["MCP-Protocol-Version"] = protocol;
    if (session) headers["Mcp-Session-Id"] = session;
    const url = `${String(origin()).replace(/\/$/, "")}/mcp`;
    const resp = await doFetch(url, { method: "POST", headers, body: JSON.stringify(msg) });
    const sid = resp.headers.get("mcp-session-id");
    if (sid) session = sid;
    return resp;
  }

  /** Writes every message a response carries; returns how many it wrote. */
  async function relay(resp) {
    const ctype = resp.headers.get("content-type") || "";
    let n = 0;
    if (ctype.includes("text/event-stream") && resp.body) {
      for await (const m of sseMessages(resp.body)) { write(m); n++; }
      return n;
    }
    const text = await resp.text();
    if (!text.trim()) return 0;
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { return 0; }
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) { write(m); n++; }
    return n;
  }

  /** Why a refused response was refused, in words a person can act on. */
  async function refusal(resp) {
    let detail = "";
    try { const t = await resp.text(); try { const j = JSON.parse(t); detail = j.error_description || (j.error && (j.error.message || j.error)) || t; } catch (_) { detail = t; } } catch (_) {}
    detail = String(detail || "").slice(0, 300);
    if (resp.status === 401) {
      const ours = /resource_metadata/i.test(resp.headers.get("www-authenticate") || "");
      return ours
        ? `spacesheep refused this machine's key (${detail || "revoked or unknown"}) — run \`${SETUP}\` again`
        : `HTTP 401 from something between this machine and mcp.spacesheep.dev (a proxy or network allowlist), not from spacesheep`;
    }
    if (resp.status === 403) return `spacesheep refused this machine's key: ${detail || "forbidden"} — a streams-only or sessions-only key can't use the tools; run \`${SETUP}\``;
    return `spacesheep answered HTTP ${resp.status}${detail ? `: ${detail}` : ""}`;
  }

  /** A session the server forgot (404 on a known session id): start a new one the
   *  way the harness started the first, so a long-open harness never has to. */
  async function reinitialize() {
    session = null;
    if (!initParams) return false;
    const r = await post({ jsonrpc: "2.0", id: "spacesheep-reinit", method: "initialize", params: initParams });
    if (!r.ok) return false;
    await r.text().catch(() => {});
    const n = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    await n.text().catch(() => {});
    warn("the server's session ended; started a new one");
    return true;
  }

  async function forward(msg) {
    const isRequest = msg && msg.id !== undefined && msg.id !== null && typeof msg.method === "string";
    try {
      let resp = await post(msg);
      if (resp.status === 404 && initParams && msg.method !== "initialize") {
        await resp.text().catch(() => {});
        if (await reinitialize()) resp = await post(msg);
      }
      if (resp.status === 202 || resp.status === 204) return;
      if (!resp.ok) {
        const why = await refusal(resp);
        warn(why);
        if (isRequest) write(rpcError(msg.id, -32001, why));
        return;
      }
      if (msg.method === "initialize") {
        // Read the negotiated version off the answer before passing it on.
        const text = await resp.text();
        let parsed = null;
        const ctype = resp.headers.get("content-type") || "";
        if (ctype.includes("text/event-stream")) {
          for (const block of text.split(/\r?\n\r?\n/)) {
            const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
            if (!data) continue;
            try { const m = JSON.parse(data); if (m.id === msg.id) parsed = m; else write(m); } catch (_) {}
          }
        } else {
          try { parsed = JSON.parse(text); } catch (_) {}
        }
        if (parsed && parsed.result && parsed.result.protocolVersion) protocol = parsed.result.protocolVersion;
        if (parsed) write(parsed);
        else if (isRequest) write(rpcError(msg.id, -32002, "spacesheep sent an initialize answer the bridge couldn't read"));
        return;
      }
      const n = await relay(resp);
      if (n === 0 && isRequest) write(rpcError(msg.id, -32002, `no answer from spacesheep to ${msg.method}`));
    } catch (e) {
      const why = e && e.code === "EAUTH" ? e.message : `couldn't reach spacesheep (${e && e.message || e}) — check this machine's network`;
      warn(why);
      if (isRequest) write(rpcError(msg.id, -32001, why));
    }
  }

  function handle(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { warn("ignored a line that isn't JSON"); return; }
    let job;
    if (msg && msg.method === "initialize") {
      initParams = msg.params || {};
      protocol = null;
      session = null;
      job = initializing = forward(msg);
    } else {
      // Nothing may overtake the initialize: its answer carries the session id.
      const before = initializing;
      job = (before ? before.then(() => forward(msg)) : forward(msg));
    }
    inflight.add(job);
    job.finally(() => inflight.delete(job));
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    rl.on("line", handle);
    rl.on("close", async () => {
      while (inflight.size) await Promise.allSettled([...inflight]);
      resolve();
    });
  });
}

module.exports = { runBridge, sseMessages, SETUP };
