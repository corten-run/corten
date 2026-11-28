// @ts-check
// Only an autosave patch notifies the builder.
import { DeckAnswered } from "corten/events";

/**
 * @param {HTMLSpanElement} note @param {import("../../types/app").SaveOutcome} outcome
 * @param {number} version @param {number} draft @param {boolean} unsure
 */
export function answered(note, outcome, version, draft, unsure) {
  note.dispatchEvent(new DeckAnswered({ outcome, version, draft, unsure }));
}
