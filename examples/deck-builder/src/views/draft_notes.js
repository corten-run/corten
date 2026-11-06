// @ts-check
import { keep } from "corten";
import { DraftEdited, DraftOpened } from "corten/events";

const feedback = () => keep(() => ({ timer: 0 }));

/** @param {HTMLTextAreaElement} field @param {HTMLParagraphElement} editing @param {HTMLParagraphElement} ready @param {AbortSignal} signal */
export function start(field, editing, ready, signal) {
  const s = feedback();
  editing.hidden = ready.hidden = true;
  signal.addEventListener("abort", () => clearTimeout(s.timer));
  field.dispatchEvent(new DraftOpened({}));
}

/** @param {HTMLTextAreaElement} field @param {HTMLParagraphElement} editing @param {HTMLParagraphElement} ready @param {AbortSignal} signal */
export function edited(field, editing, ready, signal) {
  const s = feedback();
  field.dispatchEvent(new DraftEdited({ note: field.value }));
  clearTimeout(s.timer);
  editing.hidden = false;
  ready.hidden = true;
  s.timer = setTimeout(() => {
    if (signal.aborted) return;
    editing.hidden = true;
    ready.hidden = false;
  }, 250);
}
