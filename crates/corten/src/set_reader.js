// @ts-check
// The script of the doctests of a screen's URL (script.rs): a handler that takes a ScreenUrl<SetListing>.
import { read } from "corten/read";
/** @import { ScreenUrl } from "corten/read" */

/** @typedef {{ name: string, products: string[] }} SetListing A set's listing. */

/** @param {HTMLOutputElement} out @param {ScreenUrl<SetListing>} set @param {AbortSignal} signal */
export async function show(out, set, signal) {
  const listing = await read(set, { signal });
  out.value = `${listing.name}: ${listing.products.length}`;
}
