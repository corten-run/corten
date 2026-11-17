// @ts-check
// A feed's rows named by a type the script never declares: the compile_fail doctest in script.rs
// refuses it, and TypeScript does too (TS2304), which scripts/compile-fail-scripts.test.mjs holds;
// jsconfig.json leaves it out for that reason.
import { subscribe } from "corten";
/** @import { FeedUrl } from "corten" */

/** @param {HTMLTableSectionElement} body @param {FeedUrl<Level>} feed @param {AbortSignal} signal */
export function follow(body, feed, signal) {
  subscribe(feed, { snapshot: (levels) => (body.dataset.rows = String(levels.length)), patch() {} }, { signal });
}
