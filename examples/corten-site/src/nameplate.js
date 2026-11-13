// @ts-check
// Nameplate (seam.rs): a plate that arrived as a patch says so to the page around it, once it
// has joined the page. The plate drawn with the page says nothing.
import { PlateStruck } from "corten/events";

/** @param {HTMLParagraphElement} struck the name struck on the plate @param {number} number which plate this is */
export function landed(struck, number) {
  struck.dispatchEvent(new PlateStruck({ number }));
}
