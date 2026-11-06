"use strict";
// `spacesheep read`'s parser: read_space's text back into the files, byte for byte, with
// an editor's Discussion and a version line left out.
const test = require("node:test");
const assert = require("node:assert");
const { parseRead } = require("../lib/read");

const as = (files) => files.map((f) => [f.path, f.content.toString("utf-8")]);
const part = (p, c) => `--- ${p} (${Buffer.byteLength(c)} bytes) ---\n${c}`;

test("a whole space: each file exactly, trailing newlines as they are", () => {
  const files = [["index.html", "<h1>Q3</h1>\n"], ["notes.md", "no newline"], ["a/b.css", "p{}\n\n"], ["é.txt", "naïve — ok\n"]];
  assert.deepEqual(as(parseRead(files.map(([p, c]) => part(p, c)).join("\n\n"))), files);
});

test("a file the server decoded as text is not exact: its size, or a replaced byte, says so", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
  const sameLength = Buffer.from([0xf0, 0x90, 0x80, 0x41]);
  const wire = (p, b) => `--- ${p} (${b.length} bytes) ---\n${new TextDecoder().decode(b)}`;
  const files = parseRead([wire("index.html", Buffer.from("hi\n")), wire("logo.png", png), wire("a.bin", sameLength), wire("z.txt", Buffer.from("z"))].join("\n\n"));
  assert.deepEqual(files.map((f) => [f.path, f.exact]), [["index.html", true], ["logo.png", false], ["a.bin", false], ["z.txt", true]]);
  assert.equal(files[3].content.toString(), "z", "the file after a damaged one is still found");
});

test("the Discussion and a version line are not files", () => {
  const text = `--- discussion ---\nana: I'm on the chart\n--- end of discussion ---\n\nVersion "Deploy from CLI" deployed 2026-11-06 (sha abc123)\n\n${part("index.html", "hi\n")}`;
  assert.deepEqual(as(parseRead(text)), [["index.html", "hi\n"]]);
});

test("a file whose text looks like a header stays inside its file", () => {
  const tricky = "line\n\n--- fake.html (3 bytes) ---\nxyz";
  assert.deepEqual(as(parseRead([part("index.html", tricky), part("b.txt", "b")].join("\n\n"))), [["index.html", tricky], ["b.txt", "b"]]);
});

test("one path: the rest of the answer, after any Discussion", () => {
  assert.deepEqual(as(parseRead("--- discussion ---\nx\n--- end of discussion ---\n\n--- index.html ---\n<p>hi</p>\n")), [["index.html", "<p>hi</p>\n"]]);
  assert.deepEqual(as(parseRead("--- index.html (characters 0–60000 of 90000) ---\n<p>")), [], "one part of a long file is not the file");
  assert.deepEqual(as(parseRead("Space not found.")), []);
});
