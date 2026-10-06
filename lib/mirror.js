"use strict";
// `spacesheep mirror` — spacesheep.dev itself, at http://localhost:4280.
//
//   spacesheep mirror [--port N]   run here, in the foreground
//   spacesheep mirror on [--port N]   keep it running in the background (launchd / systemd)
//   spacesheep mirror off          stop the background copy
//   spacesheep mirror status       where it runs
//
// The dashboard, every space, comments, the Co-shepherd: all of it is spacesheep's cloud,
// answering through this machine. spacesheep.dev/@misha/plan is
// http://localhost:4280/@misha/plan, and a space's own origin <uuid>.spacesheep.app is
// http://<uuid>.localhost:4280. Nothing is stored here.
//
// Why it exists: spacesheep.dev refuses to be framed, and VS Code's Simple Browser is a
// frame. Through here the same pages can be framed.
//
// How it signs in: Google can't sign anyone in at localhost, so the key this CLI already
// holds is traded for a short spacesheep.dev session (POST /api/account/web-session). It
// stays in this process and is attached to each request on its way out; the browser never
// holds it. A session made this way never counts as a recent sign-in, so whatever asks
// for one still sends you to spacesheep.dev.
//
// What it changes on the way through: addresses (spacesheep.dev and spacesheep.app become
// localhost, in bodies and headers), the frame refusal (dropped), cookie domains (dropped).
// What it refuses: any Host but localhost (DNS rebinding), and any write or socket whose
// Origin isn't one of its own localhost origins (another website calling this port).
//
// File: <config>/mirror.json (where it runs, for `status` and `deploy`).

const fs = require("fs");
const path = require("path");
const http = require("http");
const tls = require("tls");
const { Readable } = require("stream");
const cfg = require("./config");

const DEFAULT_PORT = 4280;
const statusPath = () => path.join(cfg.configDir(), "mirror.json");
const LABEL = "dev.spacesheep.mirror", UNIT = "spacesheep-mirror.service";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REWRITE_TYPES = /^(text\/(html|css|javascript|plain)|application\/(javascript|json|manifest\+json|xml)|image\/svg\+xml)/i;
// Request headers that describe this hop, not the request: never forwarded.
const HOP = new Set(["host", "connection", "keep-alive", "upgrade", "proxy-connection", "transfer-encoding", "te", "trailer", "accept-encoding", "content-length", "cookie", "origin", "referer"]);

// ---------------------------------------------------------------- the address map

/** Both directions of the address map, for one port. `site` is spacesheep.dev's origin,
 *  `content` the content apex (spacesheep.app). */
function addressMap(site, content, port) {
  const s = new URL(site), c = new URL(content);
  const local = `http://localhost:${port}`;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const siteHost = esc(s.host), contentHost = esc(c.host);
  return {
    local,
    /** Upstream origin for a local Host, or null (we answer only at localhost). */
    upstream(hostHeader) {
      const host = String(hostHeader || "").toLowerCase().replace(/:\d+$/, "");
      if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "preview.localhost") return { kind: "site", origin: s.origin };
      if (host === "content.localhost") return { kind: "content", origin: c.origin };
      const m = /^([0-9a-f-]{36})\.localhost$/.exec(host);
      if (m && UUID_RE.test(m[1])) return { kind: "space", origin: `${c.protocol}//${m[1]}.${c.host}`, uuid: m[1] };
      return null;
    },
    /** Every origin this mirror answers for, as a browser sends it in Origin. */
    isOwnOrigin(origin) {
      if (!origin) return false;
      let u; try { u = new URL(origin); } catch { return false; }
      if (u.protocol !== "http:" || u.port !== String(port)) return false;
      return this.upstream(u.host) !== null;
    },
    /** Upstream → local, in a body or a header value. */
    toLocal(text) {
      return String(text)
        // a space's own origin: https://<uuid>.spacesheep.app (also wss:, and the bare //host form)
        .replace(new RegExp(`(https?:|wss?:)?//([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.${contentHost}(?![\\w.-])`, "gi"),
          (_, scheme, uuid) => `${scheme ? (/^ws/i.test(scheme) ? "ws:" : "http:") : ""}//${uuid}.localhost:${port}`)
        .replace(new RegExp(`(https?:|wss?:)?//${contentHost}(?![\\w.-])`, "gi"), (_, scheme) => `${scheme ? (/^ws/i.test(scheme) ? "ws:" : "http:") : ""}//content.localhost:${port}`)
        .replace(new RegExp(`(https?:|wss?:)?//${siteHost}(?![\\w.-])`, "gi"), (_, scheme) => `${scheme ? (/^ws/i.test(scheme) ? "ws:" : "http:") : ""}//localhost:${port}`);
    },
    /** Local → upstream, for the Origin and Referer a request carries out. */
    toUpstream(value) {
      if (!value) return value;
      let u; try { u = new URL(value); } catch { return value; }
      const up = this.upstream(u.host);
      if (!up || u.port !== String(port)) return value;
      return up.origin + (value.length > u.origin.length ? value.slice(u.origin.length) : "");
    },
  };
}

/** Rewrites a byte stream chunk by chunk. An address never contains whitespace, a quote,
 *  < > ( ) or a backtick, so text is only rewritten up to the last such character and the
 *  rest waits for the next chunk: no address is ever cut in two. */
function streamRewriter(rewrite, { hold = 64 * 1024 } = {}) {
  const decoder = new TextDecoder("utf-8");
  let carry = "";
  const cut = (text) => {
    let i = text.length - 1;
    while (i >= 0 && !/[\s"'<>()`]/.test(text[i])) i--;
    return i;
  };
  return {
    push(chunk) {
      const text = carry + decoder.decode(chunk, { stream: true });
      const i = cut(text);
      if (i < 0 && text.length < hold) { carry = text; return ""; }
      const at = i < 0 ? text.length : i + 1;
      carry = text.slice(at);
      return rewrite(text.slice(0, at));
    },
    end() { const text = carry + decoder.decode(); carry = ""; return rewrite(text); },
  };
}

/** spacesheep's own policy for a page, its origins made local and its frame rule dropped:
 *  the point of this mirror is that its pages can be framed. */
function localPolicy(csp, map) {
  return String(csp || "").split(";").map((d) => d.trim()).filter((d) => d && !/^frame-ancestors\b/i.test(d))
    .map((d) => map.toLocal(d)).join("; ");
}

/** A Set-Cookie as the browser should keep it here: no Domain (it would name spacesheep.dev),
 *  and never the session cookie, which this process keeps to itself. */
function localCookie(setCookie) {
  if (/^\s*ss_app=/i.test(setCookie)) return null;
  return setCookie.split(";").map((p) => p.trim()).filter((p) => p && !/^domain=/i.test(p)).join("; ");
}

// ---------------------------------------------------------------- the mirror

class Mirror {
  constructor(opts, log) {
    const k = cfg.resolveKey();
    if (!k) throw Object.assign(new Error("not signed in — run `spacesheep login` (or set SPACESHEEP_KEY)"), { code: "EAUTH" });
    this.key = k.key;
    this.site = cfg.appOrigin();
    this.content = (process.env.SPACESHEEP_CONTENT_ORIGIN || "https://spacesheep.app").replace(/\/$/, "");
    this.port = Number(opts.port || DEFAULT_PORT);
    this.map = addressMap(this.site, this.content, this.port);
    this.log = log;
    // A beta of the app answers the session trade when this names its version.
    this.appVersion = process.env.SPACESHEEP_APP_VERSION || null;
    this.web = null; // { token, until }
  }

  /** The spacesheep.dev session this mirror attaches, traded for the key and renewed early. */
  async session(fresh = false) {
    if (this.web && !fresh && this.web.until - Date.now() > 30 * 60_000) return this.web.token;
    const resp = await fetch(`${this.site}/api/account/web-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.key}`, "User-Agent": `spacesheep-cli/${require("../package.json").version} mirror`,
        ...(this.appVersion ? { "Cloudflare-Workers-Version-Overrides": `spacesheep-app="${this.appVersion}"` } : {}),
      },
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.status === 404) throw new Error(`${this.site} can't trade a key for a session yet (an older server)`);
    if (!resp.ok || !body.token) throw Object.assign(new Error(body.error || `${this.site} refused the key (${resp.status})`), { code: resp.status === 401 || resp.status === 403 ? "EAUTH" : undefined });
    this.web = { token: body.token, until: Date.now() + (body.expires_in || 3600) * 1000 };
    return this.web.token;
  }

  /** The request's own cookies (minus any session it brought) plus, for spacesheep.dev, ours. */
  async cookies(req, up) {
    const mine = String(req.headers.cookie || "").split(/;\s*/).filter((c) => c && !/^ss_app=/i.test(c));
    if (up.kind === "site") mine.push(`ss_app=${await this.session()}`);
    return mine.join("; ");
  }

  outHeaders(req, up, cookie) {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith("sec-websocket") && v !== undefined) h[k] = Array.isArray(v) ? v.join(", ") : v;
    if (cookie) h.cookie = cookie;
    if (req.headers.origin) h.origin = this.map.toUpstream(req.headers.origin);
    if (req.headers.referer) h.referer = this.map.toUpstream(req.headers.referer);
    return h;
  }

  async handle(req, res) {
    const up = this.map.upstream(req.headers.host);
    if (!up) { res.writeHead(421, { "Content-Type": "text/plain" }); return res.end("This mirror answers only at localhost.\n"); }
    const safe = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
    // A write must come from one of this mirror's own pages. Anything else — a website
    // that knows this port — is refused before it reaches spacesheep as you.
    if (!safe && !this.map.isOwnOrigin(req.headers.origin)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("Refused: a change through this mirror must come from one of its own pages.\n");
    }
    const send = async (fresh) => {
      if (fresh) await this.session(true);
      return fetch(up.origin + req.url, {
        method: req.method,
        headers: this.outHeaders(req, up, await this.cookies(req, up)),
        body: safe ? undefined : Readable.toWeb(req),
        duplex: safe ? undefined : "half",
        redirect: "manual",
      });
    };
    let r;
    try {
      r = await send(false);
      // Our session aged out early (an epoch bump: signed out everywhere): trade again, once.
      if (r.status === 401 && up.kind === "site" && safe) r = await send(true);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      return res.end(`spacesheep didn't answer: ${e.message}\n`);
    }

    const headers = {};
    for (const [k, v] of r.headers) {
      const key = k.toLowerCase();
      if (["content-encoding", "content-length", "transfer-encoding", "connection", "x-frame-options", "set-cookie", "strict-transport-security", "alt-svc"].includes(key)) continue;
      if (key === "content-security-policy" || key === "content-security-policy-report-only") { const p = localPolicy(v, this.map); if (p) headers[k] = p; continue; }
      headers[k] = ["location", "access-control-allow-origin", "link", "refresh"].includes(key) ? this.map.toLocal(v) : v;
    }
    const cookies = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(localCookie).filter(Boolean);
    if (cookies.length) headers["set-cookie"] = cookies;

    const type = r.headers.get("content-type") || "";
    if (req.method === "HEAD" || !r.body) { res.writeHead(r.status, headers); return res.end(); }
    if (REWRITE_TYPES.test(type)) {
      // Rewritten as it streams, so a page spacesheep flushes early (the viewer's head
      // goes out before the rest is ready) still paints early here.
      res.writeHead(r.status, headers);
      const rewrite = streamRewriter((t) => this.map.toLocal(t));
      try {
        for await (const chunk of r.body) { const out = rewrite.push(chunk); if (out) res.write(out); }
        res.end(rewrite.end());
      } catch { res.destroy(); }
      return;
    }
    // Everything else streams as it comes: images, fonts, event streams, downloads.
    res.writeHead(r.status, headers);
    Readable.fromWeb(r.body).on("error", () => res.destroy()).pipe(res);
  }

  /** A WebSocket (presence, inbox, streams): opened upstream with our session, then piped. */
  async upgrade(req, socket, head) {
    const up = this.map.upstream(req.headers.host);
    if (!up || !this.map.isOwnOrigin(req.headers.origin)) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    let cookie;
    try { cookie = await this.cookies(req, up); } catch { socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); return; }
    const u = new URL(up.origin);
    const headers = { ...this.outHeaders(req, up, cookie), host: u.host, connection: "Upgrade", upgrade: "websocket" };
    for (const [k, v] of Object.entries(req.headers)) if (k.startsWith("sec-websocket")) headers[k] = v;
    const out = tls.connect({ host: u.hostname, port: Number(u.port || 443), servername: u.hostname }, () => {
      out.write(`GET ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (head && head.length) out.write(head);
      out.pipe(socket); socket.pipe(out);
    });
    const close = () => { out.destroy(); socket.destroy(); };
    out.on("error", close); socket.on("error", close);
  }

  writeStatus() {
    try {
      fs.mkdirSync(cfg.configDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(statusPath(), JSON.stringify({ pid: process.pid, port: this.port, site: this.site, started_at: this.startedAt }, null, 2) + "\n");
    } catch {}
  }

  async run() {
    this.startedAt = new Date().toISOString();
    await this.session(); // fail now, with the reason, rather than on the first page
    const server = http.createServer((req, res) => this.handle(req, res).catch((e) => {
      try { res.writeHead(500, { "Content-Type": "text/plain" }); res.end(String(e.message || e)); } catch {}
    }));
    server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head).catch(() => socket.destroy()));
    await new Promise((resolve, reject) => {
      server.once("error", (e) => reject(e.code === "EADDRINUSE" ? new Error(`port ${this.port} is taken — is a mirror already running? (\`spacesheep mirror status\`), or pass --port`) : e));
      server.listen(this.port, "127.0.0.1", resolve);
    });
    this.log(`  ✓ ${this.map.local}/ — ${this.site.replace(/^https?:\/\//, "")} itself, signed in as you (nothing is stored here)`);
    this.writeStatus();
    const stop = () => { try { const s = JSON.parse(fs.readFileSync(statusPath(), "utf8")); if (s.pid === process.pid) fs.unlinkSync(statusPath()); } catch {} process.exit(0); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
  }
}

// ---------------------------------------------------------------- commands

function readStatus() {
  try {
    const s = JSON.parse(fs.readFileSync(statusPath(), "utf8"));
    try { process.kill(s.pid, 0); } catch { return null; }
    return s;
  } catch { return null; }
}

/** The local address of a just-published space, when a mirror runs here — `deploy` prints it. */
function localNote(spaceUrl) {
  const s = readStatus();
  let p = "";
  try { p = new URL(spaceUrl).pathname; } catch {}
  return s && /^\/@[^/]+\/[^/]+/.test(p) ? `Locally: http://localhost:${s.port}${p}` : null;
}

async function run(opts, log) {
  return new Mirror(opts, log).run();
}

function on(opts, log) {
  if (!cfg.readConfig().key) throw new Error("the background mirror uses the key saved in " + cfg.configPath() + " — run `spacesheep login` first (SPACESHEEP_KEY from this shell isn't passed to it)");
  const args = ["mirror", "run", ...(opts.port !== undefined ? ["--port", String(opts.port)] : [])];
  require("./stream-service").installService({ label: LABEL, unit: UNIT, description: "spacesheep mirror", args, logFile: path.join(cfg.configDir(), "mirror.log") }, log);
  log(`  ✓ Running in the background: http://localhost:${Number(opts.port || DEFAULT_PORT)}/`);
}

function off(opts, log) {
  require("./stream-service").removeService({ label: LABEL, unit: UNIT });
  log("  ✓ Background mirror stopped.");
}

function status(opts, out) {
  const s = readStatus();
  if (opts.json) return out(s || { running: false });
  if (!s) return out("Not running. `spacesheep mirror` runs it here; `spacesheep mirror on` keeps it running in the background.");
  out(`Running (pid ${s.pid}) at http://localhost:${s.port}/ — ${String(s.site || "").replace(/^https?:\/\//, "")} through this machine`);
}

module.exports = { run, on, off, status, localNote, Mirror, addressMap, localPolicy, localCookie, streamRewriter };
