// Device-code login against the server's /cli/start + /cli/poll (the same flow
// `npx spacesheep-skill` uses). Approval happens in the browser on spacesheep.dev;
// the key is delivered once through KV and never typed.
"use strict";
const { spawn } = require("child_process");

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch { return false; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deviceLogin(origin, log, ask) {
  // `ask` = { scope: "stream", name } for a streams-only key; the approval page says so.
  const resp = await fetch(`${origin}/cli/start`, ask ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ask) } : { method: "POST" });
  if (!resp.ok) throw new Error(`could not start login (HTTP ${resp.status})`);
  const { user_code, device_code, authorize_url, interval, expires_in } = await resp.json();
  log(`\n  Verification code:  ${user_code}`);
  log(`  Opening your browser to approve…`);
  if (!openBrowser(authorize_url)) log(`  Couldn't open a browser.`);
  log(`  If it doesn't open, visit:\n    ${authorize_url}\n`);
  log(`  Waiting for approval…`);
  const deadline = Date.now() + (expires_in || 600) * 1000;
  const pollMs = Math.max(1, interval || 2) * 1000;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let data;
    try {
      const r = await fetch(`${origin}/cli/poll?code=${encodeURIComponent(user_code)}&device=${encodeURIComponent(device_code)}`);
      data = await r.json();
      if (process.env.SPACESHEEP_DEBUG) log(`  poll: ${JSON.stringify(data)}`);
    } catch { continue; }
    if (data.status === "authorized") return { key: data.key, username: data.username || null };
    if (data.status === "expired") throw new Error("the login request expired before it was approved");
    if (data.status === "denied") throw new Error("the login request was denied");
    if (data.status === "failed") throw new Error(data.error || "approval failed");
  }
  throw new Error("timed out waiting for approval");
}


// `spacesheep connect <ss_key> [name]` — sign a machine in without a browser.
// The pasted key is used ONCE, to ask the app for a child key named after this
// machine; the child is what gets stored. The pasted key never lands on disk, so
// the person can revoke it after the rollout and every machine keeps working, and
// the Settings list shows one row per machine, revocable on its own.
async function connectWithKey(appOrigin, parentKey, name, log, scope) {
  const resp = await fetch(`${appOrigin.replace(/\/$/, "")}/api/account/keys/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${parentKey}` },
    // scope: undefined = a full key, "ingest" = sessions-only, "stream" = streams-only.
    body: JSON.stringify(scope ? { name, scope } : { name }),
  });
  let data = {};
  try { data = await resp.json(); } catch {}
  if (resp.status === 401 || resp.status === 403) {
    // Only spacesheep's own JSON (it carries a `code`) is a verdict on the key; a
    // bare 401/403 is a proxy or a network allowlist in the way.
    if (!data.code) {
      const e = new Error(`got HTTP ${resp.status} from ${appOrigin}, but not from spacesheep — something between this machine and the server (a proxy or a network allowlist) refused the request; allow spacesheep.dev and mcp.spacesheep.dev, then try again`);
      e.code = "ENET"; throw e;
    }
    const e = new Error(data.error || "the server rejected that key — create one at https://spacesheep.dev/settings/api-keys#create");
    e.code = "EAUTH"; throw e;
  }
  if (!resp.ok || !data.key) throw new Error(data.error || `could not connect (HTTP ${resp.status})`);
  log(`  Key for ${name} created${data.username ? ` for @${data.username}` : ""}.`);
  return { key: data.key, username: data.username || null };
}

// `spacesheep login --code ssc_…` — the code from the personal prompt on
// spacesheep.dev/start. The person approved it by being signed in when they copied
// it, so there is nothing to open and nothing to wait for: the code is traded for a
// key of this machine's own, once. The code itself is never stored.
const SETUP_CODE_RE = /^ssc_[a-f0-9]{32}$/;

// Which agent ran the command, from the environment each one sets for the commands
// it runs, so the page can say "Connected · Claude Code on <machine>". A guess the
// server checks against its own list; nothing else is read or sent.
function agentClient(env) {
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED || env.CODEX_THREAD_ID) return "codex";
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID) return "cursor";
  if (env.GEMINI_CLI) return "gemini-cli";
  if (env.ANTIGRAVITY_AGENT || env.TERM_PROGRAM === "Antigravity") return "antigravity";
  return undefined;
}

async function redeemCode(appOrigin, code, name, log, client) {
  const clean = String(code || "").trim();
  if (!SETUP_CODE_RE.test(clean)) {
    throw new Error("that isn't a setup code (they look like ssc_ and 32 letters and digits) — copy the prompt again at https://spacesheep.dev/start, or run `spacesheep login`");
  }
  let resp;
  try {
    resp = await fetch(`${appOrigin.replace(/\/$/, "")}/api/cli/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(client ? { code: clean, name, client } : { code: clean, name }),
    });
  } catch (err) {
    const e = new Error(`could not reach ${appOrigin} (${err.cause?.code || err.message}) — allow spacesheep.dev and mcp.spacesheep.dev on this network, then run the same command again`);
    e.code = "ENET"; throw e;
  }
  let data = {};
  try { data = await resp.json(); } catch {}
  if (!resp.ok || !data.key) {
    // Only spacesheep's own JSON (it carries a `code`) is a verdict on the code; a
    // bare error is a proxy or a network allowlist in the way.
    if (!data.code) {
      const e = new Error(`got HTTP ${resp.status} from ${appOrigin}, but not from spacesheep — something between this machine and the server (a proxy or a network allowlist) refused the request; allow spacesheep.dev and mcp.spacesheep.dev, then try again`);
      e.code = "ENET"; throw e;
    }
    const e = new Error(data.error || `could not sign in with that code (HTTP ${resp.status})`);
    e.code = data.code === "key_cap" ? "EKEYCAP" : "EAUTH"; throw e;
  }
  log(`  Key for ${data.name || name} created${data.username ? ` for @${data.username}` : ""}.`);
  return { key: data.key, username: data.username || null, name: data.name || name };
}

module.exports = { deviceLogin, connectWithKey, redeemCode, agentClient, openBrowser, SETUP_CODE_RE };
