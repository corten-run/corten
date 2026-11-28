// @ts-check
import { DeckAnswered } from "corten/events";

/**
 * Tell the builder what became of its scripted save. Already-open tabs know this binding.
 * @param {HTMLSpanElement} note @param {import("../../types/app").SaveOutcome} outcome
 * @param {number} version @param {number} draft @param {boolean} unsure
 */
export function answered(note, outcome, version, draft, unsure) {
  note.dispatchEvent(new DeckAnswered({ outcome, version, draft, unsure }));
}
