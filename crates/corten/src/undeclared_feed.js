// @ts-check
// A feed's rows named by a type the script never declares.
import { subscribe } from "corten";
/** @import { FeedUrl } from "corten" */

// @ts-expect-error Level is declared nowhere: TypeScript refuses it too.
/** @param {HTMLTableSectionElement} body @param {FeedUrl<Level>} feed @param {AbortSignal} signal */
export function follow(body, feed, signal) {
  subscribe(feed, { snapshot: (levels) => (body.dataset.rows = String(levels.length)), patch() {} }, { signal });
}
