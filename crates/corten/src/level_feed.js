// @ts-check
// The script of the doctests of a feed's URL (script.rs): a handler that takes a FeedUrl<Level>.
import { subscribe } from "corten";
/** @import { FeedUrl } from "corten" */

/** @typedef {import("./types/app").Level} Level */

/** @param {HTMLTableSectionElement} body @param {FeedUrl<Level>} feed @param {AbortSignal} signal */
export function follow(body, feed, signal) {
  subscribe(feed, { snapshot: (levels) => (body.dataset.rows = String(levels.length)), patch() {} }, { signal });
}
