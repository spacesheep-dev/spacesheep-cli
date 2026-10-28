"use strict";
const { version } = require("../package.json");

function userAgent() {
  return `spacesheep-cli/${version} (+https://github.com/spacesheep-dev/spacesheep-cli) Node/${process.versions.node}`;
}

// Keep all fetch callers on the same identity, including requests forwarded by
// the mirror. Resolve global fetch at call time so tests can still replace it.
function fetch(url, init = {}) {
  const headers = new Headers(init.headers ?? (url instanceof Request ? url.headers : undefined));
  headers.set("User-Agent", userAgent());
  return globalThis.fetch(url, { ...init, headers });
}

module.exports = { fetch, userAgent };
