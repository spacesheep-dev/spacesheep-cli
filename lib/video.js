// `spacesheep stream <name> --camera | --screen | --rtsp URL | --file PATH | --test`
// — film into a camera stream (spacesheep's video streams).
//
// A camera is a stream name (`lab/cam-1`). A page shows it with
// <video data-ss-stream="lab/cam-1"> and the name in its ss-streams meta. ffmpeg reads
// the source here and writes three JPEGs a second to this process; each one goes up as the
// camera's still, which is what every page that names the camera shows. (Live WebRTC
// video is the browser's filming page for now; from a terminal it's three pictures a
// second.)
//
// --space <link|uuid>  film into the camera of a page you can edit: its owner's camera,
//                      on the owner's plan. Without it, the camera is your own.
// --device <id>        which camera or screen (macOS: the avfoundation index, Linux:
//                      /dev/videoN, Windows: the dshow name)
//
// The server side is spacesheep's /api/video routes (publish, still, beat, stop). They
// take this machine's key; a streams-only key is enough.
"use strict";
const { spawn, spawnSync } = require("child_process");

const BEAT_MS = 10_000;
const STILL_GAP_MS = 200;
const STILL_MAX = 160 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Which source the options ask for, or null when this isn't a video stream. */
function sourceOf(opts) {
  if (opts.camera) return "camera";
  if (opts.screen) return "screen";
  if (opts.rtsp) return "rtsp";
  if (opts.file) return "file";
  if (opts.test) return "test";
  return null;
}

/** macOS: avfoundation's index of the first "Capture screen" device. */
function macScreenIndex(ffmpeg) {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], { encoding: "utf8" });
  const m = /\[(\d+)\] Capture screen/.exec(String(r.stderr || ""));
  return m ? m[1] : null;
}

/** ffmpeg's input arguments for a source on a platform. Pure, so it's tested per platform. */
function inputArgs(source, opts, platform, screenIndex) {
  const device = opts.device != null ? String(opts.device) : null;
  if (source === "rtsp") return ["-rtsp_transport", "tcp", "-i", String(opts.rtsp)];
  if (source === "file") return ["-stream_loop", "-1", "-re", "-i", String(opts.file)];
  if (source === "test") return ["-re", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=10"];
  if (platform === "darwin") {
    if (source === "screen") {
      const idx = device || screenIndex;
      if (!idx) throw new Error("couldn't find a screen to capture: list them with `ffmpeg -f avfoundation -list_devices true -i \"\"` and pass --device <index>");
      return ["-f", "avfoundation", "-capture_cursor", "1", "-framerate", "10", "-i", `${idx}:none`];
    }
    return ["-f", "avfoundation", "-framerate", "30", "-i", `${device || "0"}:none`];
  }
  if (platform === "win32") {
    if (source === "screen") return ["-f", "gdigrab", "-framerate", "10", "-i", "desktop"];
    if (!device) throw new Error("on Windows, name the camera: --device \"Integrated Camera\" (list them: ffmpeg -list_devices true -f dshow -i dummy)");
    return ["-f", "dshow", "-i", `video=${device}`];
  }
  if (source === "screen") return ["-f", "x11grab", "-framerate", "10", "-i", device || process.env.DISPLAY || ":0.0"];
  return ["-f", "v4l2", "-i", device || "/dev/video0"];
}

/** Three JPEGs a second, at most 960 wide, to stdout. */
function outputArgs(quality) {
  return ["-an", "-vf", "fps=3,scale='min(960,iw)':-2", "-q:v", String(quality), "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"];
}

/** Splits ffmpeg's MJPEG byte stream into whole JPEGs (SOI … EOI). Feed it chunks; it
 *  calls onFrame for each complete image and keeps the rest. */
function jpegSplitter(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const soi = buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (soi < 0) { buf = Buffer.alloc(0); return; }
      const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
      if (eoi < 0) { if (soi > 0) buf = buf.subarray(soi); if (buf.length > 4 * 1024 * 1024) buf = Buffer.alloc(0); return; }
      onFrame(buf.subarray(soi, eoi + 2));
      buf = buf.subarray(eoi + 2);
    }
  };
}

/** A JPEG's width and height, from its frame header (SOF0–SOF2). */
function jpegSize(jpg) {
  let i = 2;
  while (i + 9 < jpg.length) {
    if (jpg[i] !== 0xff) { i++; continue; }
    const marker = jpg[i + 1];
    const len = jpg.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return { h: jpg.readUInt16BE(i + 5), w: jpg.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return { w: 0, h: 0 };
}

async function run(opts, cfg, log) {
  const source = sourceOf(opts);
  const name = String(opts._[0] || "").trim().toLowerCase();
  if (!name || name.includes("*")) throw new Error("usage: spacesheep stream <name> --camera | --screen | --rtsp <url> | --file <video> | --test [--space <page link>] [--device <id>]");
  const k = cfg.resolveKey();
  if (!k) throw Object.assign(new Error("not signed in — run `spacesheep login --scope stream` (a key that can only push to your streams), or set SPACESHEEP_KEY"), { code: "EAUTH" });
  const ffmpeg = process.env.SPACESHEEP_FFMPEG || "ffmpeg";
  if (spawnSync(ffmpeg, ["-version"]).status !== 0) {
    throw new Error(`filming needs ffmpeg: ${process.platform === "darwin" ? "brew install ffmpeg" : process.platform === "win32" ? "winget install ffmpeg" : "sudo apt install ffmpeg"}`);
  }
  const origin = cfg.appOrigin();
  const space = opts.space ? String(opts.space) : null;
  // Until video reaches production, its routes answer on beta: the routing cookie (a
  // hint, not a permission) asks for main's code. Used when production says 404.
  let beta = !!opts.beta || process.env.SPACESHEEP_BETA === "1";
  const headers = (extra) => ({ Authorization: `Bearer ${k.key}`, ...(beta ? { Cookie: "ss_beta=1" } : {}), ...extra });
  const post = async (path, body) => {
    const res = await fetch(`${origin}${path}`, { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(body) });
    return { res, body: await res.json().catch(() => ({})) };
  };
  const say = (s) => log(`  ${new Date().toTimeString().slice(0, 8)} ${s}`);
  const kind = source === "screen" ? "screen" : source === "test" ? "test" : "camera";

  let r = await post("/api/video/publish", { path: name, space, source: kind, audio: false, w: 0, h: 0 });
  if (r.res.status === 404 && !beta) { beta = true; r = await post("/api/video/publish", { path: name, space, source: kind, audio: false, w: 0, h: 0 }); }
  if (r.res.status === 401) throw Object.assign(new Error(r.body.error || "the server refused this machine's key"), { code: "EAUTH" });
  if (!r.res.ok || !r.body.cam) throw new Error(r.body.error || `couldn't start (HTTP ${r.res.status})`);
  const cam = r.body.cam;
  const since = Number(r.body.since) || Date.now();

  let stopping = false;
  let watching = 0;
  let size = { w: 0, h: 0 };
  let quality = 4;
  let lastSent = 0;
  let sending = false;
  let pending = null;
  let sent = 0;
  let lastViewers = null;
  let child = null;
  const errTail = [];

  async function stop(why, code) {
    if (stopping) return;
    stopping = true;
    clearInterval(beatT);
    if (child) { try { child.kill("SIGTERM"); } catch {} }
    await post("/api/video/stop", { path: name, cam, space }).catch(() => {});
    if (why) say(why);
    process.exit(code || 0);
  }

  async function send(jpg) {
    sending = true;
    try {
      size = jpegSize(jpg);
      const q = new URLSearchParams({ path: name, cam, since: String(since), webrtc: "0", audio: "0", w: String(size.w), h: String(size.h), watching: String(watching), source: kind });
      if (space) q.set("space", space);
      const res = await fetch(`${origin}/api/video/still?${q}`, { method: "POST", headers: headers({ "Content-Type": "image/jpeg" }), body: jpg });
      if (res.status === 410) return stop("✗ stopped: this camera was started again somewhere else", 1);
      if (res.status === 401 || res.status === 403) {
        const b = await res.json().catch(() => ({}));
        return stop(`✗ ${b.error || `the server refused the picture (HTTP ${res.status})`}`, 1);
      }
      if (res.status === 413) { quality = Math.min(quality + 3, 20); say(`! pictures too big; lowering quality (restart to apply)`); }
      if (res.ok) { sent++; if (sent === 1) say(`● live: ${name} (3 pictures a second, ${size.w}×${size.h})`); }
    } catch (e) {
      say(`! sending a picture failed (${e.message}); trying the next one`);
    } finally {
      sending = false;
      lastSent = Date.now();
    }
  }

  function onFrame(jpg) {
    if (stopping || jpg.length > STILL_MAX) return;
    if (sending || Date.now() - lastSent < STILL_GAP_MS) { pending = Buffer.from(jpg); return; }
    send(Buffer.from(jpg));
  }
  // A frame that arrived while one was in flight goes as soon as the gap allows.
  const drain = setInterval(() => { if (pending && !sending && Date.now() - lastSent >= STILL_GAP_MS) { const p = pending; pending = null; send(p); } }, 200);
  drain.unref();

  async function beat() {
    const b = await post("/api/video/beat", { path: name, cam, space }).catch(() => null);
    if (!b || stopping) return;
    if (b.res.status === 410) return stop("✗ stopped: this camera was started again somewhere else", 1);
    if (!b.res.ok) return;
    watching = Number(b.body.watching) || 0;
    const who = Array.isArray(b.body.viewers) ? b.body.viewers.join(", ") : "";
    if (who !== lastViewers) { lastViewers = who; say(watching ? `  ${watching} watching: ${who}` : "  nobody is watching yet"); }
  }
  const beatT = setInterval(beat, BEAT_MS);

  const screenIndex = source === "screen" && process.platform === "darwin" && opts.device == null ? macScreenIndex(ffmpeg) : null;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", ...inputArgs(source, opts, process.platform, screenIndex), ...outputArgs(quality)];
  log(`\n  Filming ${source === "rtsp" ? opts.rtsp : source === "file" ? opts.file : source} into ${name}${space ? ` (the page ${space})` : ""}${beta ? " · beta" : ""}`);
  log(`  Pages that name it show it: <meta name="ss-streams" content="${name}"> + <video data-ss-stream="${name}">`);
  log(`  Ctrl-C to stop.\n`);
  child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", jpegSplitter(onFrame));
  child.stderr.on("data", (d) => { for (const l of String(d).split("\n")) if (l.trim()) { errTail.push(l.trim()); if (errTail.length > 8) errTail.shift(); } });
  child.on("exit", (code) => {
    child = null;
    if (stopping) return;
    const hint = process.platform === "darwin" && source === "camera" ? "\n  (macOS: allow this terminal to use the camera in System Settings → Privacy & Security → Camera)" : "";
    stop(`✗ ffmpeg stopped (exit ${code})${errTail.length ? ":\n    " + errTail.join("\n    ") : ""}${hint}`, 1);
  });
  process.on("SIGINT", () => stop("■ stopped. Viewers see the last picture."));
  process.on("SIGTERM", () => stop("■ stopped."));
  setTimeout(beat, 2500);
  // Keep the process alive while ffmpeg runs.
  for (;;) { await sleep(60_000); if (stopping) return; }
}

module.exports = { run, sourceOf, inputArgs, outputArgs, jpegSplitter, jpegSize };
