"use strict";

const MAX_PAGES = 1000;

function integer(value, flag, min, max, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`--${flag} must be an integer between ${min} and ${max}`);
  return n;
}

/** Collect before printing: a failed later page must not look like a complete list. */
async function listSpaces(opts, call) {
  const all = opts.json || opts.all;
  const limit = integer(opts.limit, "limit", 1, 200, all ? 200 : 50);
  let offset = integer(opts.offset, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
  const rows = [];
  let total;
  for (let request = 0; request < MAX_PAGES; request++) {
    const r = await call({ limit, offset });
    const page = Array.isArray(r) ? r : r && r.spaces;
    if (!Array.isArray(page)) throw new Error("list_spaces returned an invalid spaces list");
    rows.push(...page);
    if (Number.isSafeInteger(r.total) && r.total >= 0) total = r.total;
    const next = r.next_offset;
    if (!all) return { rows, total, hasMore: next != null };
    // Older servers return a bare array or omit pagination. Never guess an offset.
    if (next == null) {
      if (total !== undefined && offset + page.length < total)
        throw new Error(`list_spaces returned an incomplete list (${rows.length} of ${total}) without next_offset`);
      return { rows, total, hasMore: false };
    }
    if (!Number.isSafeInteger(next) || next <= offset)
      throw new Error("list_spaces returned an invalid next_offset; cannot retrieve the complete list");
    if (!page.length) throw new Error("list_spaces returned an empty page with next_offset; cannot retrieve the complete list");
    offset = next;
  }
  throw new Error("list_spaces exceeded 1,000 requests; refusing to print an incomplete list");
}

module.exports = { listSpaces };
