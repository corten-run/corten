// @ts-check
// Wall (surface.rs): puts the samples the server rendered in order by their reading, or scatters
// them, and says what that took: the script's own work, the time from the click to the next
// frame the browser drew, and the requests the browser recorded meanwhile. The page already has
// every reading, as each tile's data-reading. Its controls are links, which the server answers
// where this script does not run, so each handler stops the link being followed.
/** @import { Message, NumberFormat } from "corten" */

/** The grid's tiles with their readings. @param {HTMLDivElement} grid */
function samples(grid) {
  const tiles = [];
  for (const tile of grid.children) {
    if (tile instanceof HTMLElement) tiles.push({ tile, reading: Number(tile.dataset.reading) });
  }
  return tiles;
}

/** How many requests the browser has recorded for this page so far. */
function requests() {
  return performance.getEntriesByType("resource").length;
}

/**
 * Moves the tiles into `tiles`' order and writes the readout: `began` is when the click was
 * handled, the script's time is to here, the frame's to the next one drawn.
 * @param {HTMLDivElement} grid @param {HTMLOutputElement} readout
 * @param {{ tile: HTMLElement }[]} tiles @param {number} began
 * @param {Message<"count" | "ms" | "frame" | "requests">} said @param {NumberFormat} number
 */
function place(grid, readout, tiles, began, said, number) {
  const before = requests();
  grid.append(...tiles.map((sample) => sample.tile));
  const took = performance.now() - began;
  // The frame after the one this click is handled in has the tiles where they now are.
  requestAnimationFrame(() =>
    requestAnimationFrame((drawn) => {
      readout.value = said({
        count: number(tiles.length),
        ms: number(took.toFixed(1)),
        frame: number(Math.max(took, drawn - began).toFixed(0)),
        requests: number(requests() - before),
      });
    }),
  );
}

/**
 * @param {MouseEvent} event the click on the link, which is not followed
 * @param {HTMLDivElement} grid @param {HTMLOutputElement} readout
 * @param {Message<"count" | "ms" | "frame" | "requests">} said the readout's text, in the page's locale
 * @param {NumberFormat} number the page's number format
 */
export function order(event, grid, readout, said, number) {
  event.preventDefault();
  const began = performance.now();
  const tiles = samples(grid);
  tiles.sort((a, b) => a.reading - b.reading);
  place(grid, readout, tiles, began, said, number);
}

/**
 * @param {MouseEvent} event the click on the link, which is not followed
 * @param {HTMLDivElement} grid @param {HTMLOutputElement} readout
 * @param {Message<"count" | "ms" | "frame" | "requests">} said @param {NumberFormat} number
 */
export function scatter(event, grid, readout, said, number) {
  event.preventDefault();
  const began = performance.now();
  const tiles = samples(grid);
  for (let last = tiles.length - 1; last > 0; last -= 1) {
    const pick = Math.floor(Math.random() * (last + 1));
    const [a, b] = [tiles[last], tiles[pick]];
    if (a && b) [tiles[last], tiles[pick]] = [b, a];
  }
  place(grid, readout, tiles, began, said, number);
}
