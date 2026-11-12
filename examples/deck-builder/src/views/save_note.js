// @ts-check
// SaveNote (save_note.rs): the answer to a save, as it joins the page, told to the builder around
// it. The page as first loaded has no answer (`Loaded`), and tells nothing.
import { DeckAnswered } from "corten/events";

/**
 * @param {HTMLSpanElement} note @param {import("../../types/app").SaveOutcome} outcome
 * @param {number} version @param {number} draft @param {boolean} unsure
 */
export function answered(note, outcome, version, draft, unsure) {
  if (outcome !== "Loaded") note.dispatchEvent(new DeckAnswered({ outcome, version, draft, unsure }));
}
