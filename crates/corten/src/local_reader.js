// @ts-check
// The script of a doctest of a screen's URL (script.rs): a ScreenUrl of a type the script declares
// itself, which does not compile, since it would match the Rust type by name whatever its shape.
import { read } from "corten/read";
/** @import { ScreenUrl } from "corten/read" */
/** @typedef {{ name: string, products: string[] }} SetListing */

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
