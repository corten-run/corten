// @ts-check
// A feed's rows declared by the script instead of imported from the generated declarations.
import { subscribe } from "corten";
/** @import { FeedUrl } from "corten" */
/** @typedef {{ id: string, invented: boolean }} Level */

/** @param {HTMLTableSectionElement} body @param {FeedUrl<Level>} feed @param {AbortSignal} signal */
export function follow(body, feed, signal) {
  subscribe(feed, { snapshot: (levels) => (body.dataset.rows = String(levels.length)), patch() {} }, { signal });
}
