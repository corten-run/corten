// @ts-check
// A feed's rows imported from another module than the generated declarations.
import { subscribe } from "corten";
/** @import { FeedUrl } from "corten" */
/** @import { Level } from "./local_feed.js" */

/** @param {HTMLTableSectionElement} body @param {FeedUrl<Level>} feed @param {AbortSignal} signal */
export function follow(body, feed, signal) {
  subscribe(feed, { snapshot: (levels) => (body.dataset.rows = String(levels.length)), patch() {} }, { signal });
}
