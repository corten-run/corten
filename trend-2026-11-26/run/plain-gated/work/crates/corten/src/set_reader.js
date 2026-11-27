// @ts-check
// The script of the doctests of a screen's URL (script.rs): a handler that takes a ScreenUrl<SetListing>.
import { read } from "corten/read";
/** @import { ScreenUrl } from "corten/read" */
/** @typedef {import("./types/app").SetListing} SetListing */

/** @param {HTMLOutputElement} out @param {ScreenUrl<SetListing>} set @param {AbortSignal} signal */
export async function show(out, set, signal) {
  try {
    const listing = await read(set, { signal });
    out.value = `${listing.name}: ${listing.products.length}`;
  } catch (error) {
    // The element left the page: nothing to show, and nothing went wrong.
    if (signal.aborted) return;
    throw error;
  }
}
