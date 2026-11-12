// @ts-check
// Wall (surface.rs): puts the samples the server rendered in order by their reading, or scatters
// them, and says what that took: the script's own work, the time from the click to the next
// frame the browser drew, and the requests the browser recorded meanwhile. The page already has
// every reading: the markup keys each tile by its own, so a handler is given the tiles by their
// readings. A key is one element's alone, and so is a reading here (they are 0 to 999, each
// once); values two tiles could share would need another way. Its controls are links, which the
// server answers where this script does not run, so each handler stops the link being followed.
/** @import { Message, NumberFormat } from "corten" */

/** Each tile with its reading, in the order they stand. @param {Map<string, HTMLElement>} tiles */
function samples(tiles) {
  return Array.from(tiles, ([reading, tile]) => ({ tile, reading: Number(reading) }));
}

/** How many requests the browser has recorded for this page so far. */
function requests() {
  return performance.getEntriesByType("resource").length;
}

/**
 * Moves the tiles into `placed`'s order and writes the readout. The script's time is from
 * `began`, when its handler was called, to here; the frame's is from the click itself, so it
 * counts the runtime's work of handing the tiles over, to the next frame drawn.
 * @param {MouseEvent} event @param {HTMLDivElement} grid @param {HTMLOutputElement} readout
 * @param {{ tile: HTMLElement }[]} placed @param {number} began
 * @param {Message<"count" | "ms" | "frame" | "requests">} said @param {NumberFormat} number
 */
function place(event, grid, readout, placed, began, said, number) {
  const before = requests();
  grid.append(...placed.map((sample) => sample.tile));
  const took = performance.now() - began;
  // An event's time is on the page's clock, as `performance.now()` is; one a browser put ahead
  // of now is taken as now.
  const clicked = Math.min(event.timeStamp, began);
  // The frame after the one this click is handled in has the tiles where they now are.
  requestAnimationFrame(() =>
    requestAnimationFrame((drawn) => {
      readout.value = said({
        count: number(placed.length),
        ms: number(took.toFixed(1)),
        frame: number(Math.max(took, drawn - clicked).toFixed(0)),
        requests: number(requests() - before),
      });
    }),
  );
}

/**
 * @param {MouseEvent} event the click on the link, which is not followed
 * @param {HTMLDivElement} grid @param {HTMLOutputElement} readout
 * @param {Map<string, HTMLElement>} tiles each tile by its reading, the key the markup gives it
 * @param {Message<"count" | "ms" | "frame" | "requests">} said the readout's text, in the page's locale
 * @param {NumberFormat} number the page's number format
 */
export function order(event, grid, readout, tiles, said, number) {
  event.preventDefault();
  const began = performance.now();
  const sorted = samples(tiles).sort((a, b) => a.reading - b.reading);
  place(event, grid, readout, sorted, began, said, number);
}

/**
 * @param {MouseEvent} event the click on the link, which is not followed
 * @param {HTMLDivElement} grid @param {HTMLOutputElement} readout
 * @param {Map<string, HTMLElement>} tiles each tile by its reading
 * @param {Message<"count" | "ms" | "frame" | "requests">} said @param {NumberFormat} number
 */
export function scatter(event, grid, readout, tiles, said, number) {
  event.preventDefault();
  const began = performance.now();
  const mixed = samples(tiles);
  for (let last = mixed.length - 1; last > 0; last -= 1) {
    const pick = Math.floor(Math.random() * (last + 1));
    const [a, b] = [mixed[last], mixed[pick]];
    if (a && b) [mixed[last], mixed[pick]] = [b, a];
  }
  place(event, grid, readout, mixed, began, said, number);
}
