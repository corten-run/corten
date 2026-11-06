// @ts-check
import { keep } from "corten";
import { DeckEditor, DeckSummary, view } from "corten/views";
/** @import { Holds } from "corten/views" */
/** @import { DeckPreviewChanged, DraftEdited, DraftOpened, ExportOpened } from "corten/events" */

/**
 * @typedef {object} Parts
 * @property {HTMLDivElement} host
 * @property {Holds<DeckEditor, HTMLTemplateElement>} editor
 * @property {Holds<DeckSummary, HTMLTemplateElement>} summary
 * @property {HTMLDivElement} controls
 * @property {HTMLButtonElement} edit_button
 * @property {HTMLButtonElement} summary_button
 * @property {HTMLTextAreaElement[]} exports Zero or one active child field; empty after external removal.
 */
const draft = () => keep(() => ({ summary: false, loaded: false, total: 0, text: "", note: "" }));

/** @param {Parts} parts @param {number} total @param {string} text */
export function start(parts, total, text) {
  const s = draft();
  if (!s.loaded) {
    s.total = total;
    s.text = text;
    s.loaded = true;
  }
  parts.controls.hidden = false;
  draw(parts);
}

/** @param {Parts} parts */
function draw(parts) {
  const s = draft();
  if (s.summary) view(parts.host, DeckSummary, parts.summary).saved_total = s.total;
  else view(parts.host, DeckEditor, parts.editor).total = s.total;
  parts.edit_button.setAttribute("aria-pressed", String(!s.summary));
  parts.summary_button.setAttribute("aria-pressed", String(s.summary));
}

/** @param {Parts} parts */
export function edit(parts) {
  draft().summary = false;
  draw(parts);
}

/** @param {Parts} parts */
export function summarize(parts) {
  draft().summary = true;
  draw(parts);
}

/** @param {DeckPreviewChanged} event @param {Parts} parts */
export function changed(event, parts) {
  const s = draft();
  s.total = event.total;
  s.text = event.text;
  s.loaded = true;
  draw(parts);
  for (const field of parts.exports) field.value = s.text;
}

/** @param {DraftEdited} event */
export function edited(event) {
  draft().note = event.note;
}

/** @param {DraftOpened} event */
export function restoreNote(event) {
  if (event.target instanceof HTMLTextAreaElement) event.target.value = draft().note;
}

/** @param {ExportOpened} event */
export function restoreExport(event) {
  if (event.target instanceof HTMLTextAreaElement) event.target.value = draft().text;
}
