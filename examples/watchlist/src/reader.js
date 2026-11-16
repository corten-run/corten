// @ts-check
// Reader (smoke.rs): reads a screen's data with read() and writes what it got, for the browser test.
import { read } from "corten/read";
/** @import { ScreenUrl } from "corten/read" */
/** @typedef {import("../types/app").Reading} Reading */

/** @param {HTMLOutputElement} out @param {ScreenUrl<Reading>} reading @param {AbortSignal} signal */
export async function show(out, reading, signal) {
  try {
    const data = await read(reading, { signal });
    out.value = `${data.name} ${data.rows.length}`;
  } catch (error) {
    // The element left the page: nothing to show, and nothing went wrong.
    if (signal.aborted) return;
    throw error;
  }
}
