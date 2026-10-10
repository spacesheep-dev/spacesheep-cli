"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { sourceOf, inputArgs, outputArgs, jpegSplitter, jpegSize } = require("../lib/video");

// A minimal JPEG: SOI, an SOF0 header saying 640×360, EOI.
function fakeJpeg(w, h, fill = 0) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(20, fill), Buffer.from([0xff, 0xd9])]);
}

test("the source comes from the flag", () => {
  assert.equal(sourceOf({ camera: true }), "camera");
  assert.equal(sourceOf({ rtsp: "rtsp://x" }), "rtsp");
  assert.equal(sourceOf({ system: true }), null);
});

test("ffmpeg input per platform", () => {
  assert.deepEqual(inputArgs("camera", {}, "darwin", null).slice(-2), ["-i", "0:none"]);
  assert.deepEqual(inputArgs("screen", {}, "darwin", "3").slice(-2), ["-i", "3:none"]);
  assert.throws(() => inputArgs("screen", {}, "darwin", null), /--device/);
  assert.deepEqual(inputArgs("camera", {}, "linux", null), ["-f", "v4l2", "-i", "/dev/video0"]);
  assert.deepEqual(inputArgs("camera", { device: "/dev/video2" }, "linux", null).slice(-1), ["/dev/video2"]);
  assert.throws(() => inputArgs("camera", {}, "win32", null), /--device/);
  assert.deepEqual(inputArgs("rtsp", { rtsp: "rtsp://cam/live" }, "linux", null), ["-rtsp_transport", "tcp", "-i", "rtsp://cam/live"]);
  assert.ok(inputArgs("test", {}, "darwin", null).includes("lavfi"));
});

test("three JPEGs a second, at most 960 wide", () => {
  const a = outputArgs(4);
  assert.ok(a.includes("fps=3,scale='min(960,iw)':-2"));
  assert.ok(a.includes("mjpeg") && a.includes("pipe:1"));
});

test("splits a byte stream into whole JPEGs, across chunk edges", () => {
  const frames = [];
  const feed = jpegSplitter((f) => frames.push(Buffer.from(f)));
  const one = fakeJpeg(640, 360, 1), two = fakeJpeg(1280, 720, 2);
  const all = Buffer.concat([one, two]);
  feed(all.subarray(0, 10));
  feed(all.subarray(10, one.length + 5));
  feed(all.subarray(one.length + 5));
  assert.equal(frames.length, 2);
  assert.deepEqual(jpegSize(frames[0]), { w: 640, h: 360 });
  assert.deepEqual(jpegSize(frames[1]), { w: 1280, h: 720 });
});
