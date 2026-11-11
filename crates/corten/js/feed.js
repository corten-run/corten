// The envelope of what a feed sends, checked where it arrives (subscribe() in corten.js), as
// corten-protocol writes it: `{"epoch","seq","rows"}` for a snapshot and
// `{"seq","changes":[{"op":"upsert","id","value"} | {"op":"remove","id"}]}` for a patch. The rows
// are not checked: each is the server's `Row`, whose type the script's JSDoc names and the browser
// never sees (docs/design.md#choice-script-boundaries). Tested by scripts/feed.test.mjs.

/** A feed's write count: a whole number, 0 or more. @param {unknown} n @returns {n is number} */
const isSeq = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;

/**
 * The snapshot in a feed's answer, or null when it has none: its envelope as `corten-protocol`
 * writes it, checked. The rows are not: each is the server's `Row`, whose type the script's
 * JSDoc names and the browser never sees. (`Object(json)` is `json`, or an object with none of
 * these for null or a string.)
 * @param {unknown} json
 * @returns {{ epoch: string, seq: number, rows: unknown[] } | null}
 */
export function snapshotOf(json) {
  const s = /** @type {{ epoch?: unknown, seq?: unknown, rows?: unknown }} */ (Object(json));
  return typeof s.epoch === "string" && isSeq(s.seq) && Array.isArray(s.rows) ? /** @type {{ epoch: string, seq: number, rows: unknown[] }} */ (s) : null;
}

/**
 * The patch in a feed event's data, or null when it holds none: its envelope and each change's
 * `op` and `id` checked, as {@link snapshotOf}; an upsert's value is the server's row.
 * @param {string} data
 * @returns {{ seq: number, changes: unknown[] } | null}
 */
export function patchOf(data) {
  try {
    const p = /** @type {{ seq?: unknown, changes?: unknown }} */ (Object(JSON.parse(data)));
    const ok = (/** @type {unknown} */ change) => {
      const c = /** @type {{ op?: unknown, id?: unknown }} */ (Object(change));
      return typeof c.id === "string" && (c.op === "remove" || (c.op === "upsert" && "value" in c));
    };
    if (isSeq(p.seq) && Array.isArray(p.changes) && p.changes.every(ok)) return /** @type {{ seq: number, changes: unknown[] }} */ (p);
  } catch {}
  return null;
}
