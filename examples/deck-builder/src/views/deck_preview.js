// @ts-check
import { keep } from "corten";
import { CollectionRow, DeckEditor, DeckSummary, rows, view } from "corten/views";
import { DeckPreviewChanged } from "corten/events";
/** @import { Holds } from "corten/views" */
/** @import { DraftEdited, DraftOpened, ExportOpened } from "corten/events" */

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

/** Refresh the readouts without replacing preview owners or the collection's filtered,
 * sorted, potentially checked rows. A card absent from the saved deck has zero copies.
 * @param {HTMLTextAreaElement} field @param {HTMLElement[]} previews @param {number} total
 * @param {Holds<CollectionRow, HTMLTableSectionElement>} cards
 * @param {import("../../types/app").SavedCounts} counts
 */
export function refresh(field, previews, total, cards, counts) {
  if (counts === null) return;
  for (const row of rows(cards, CollectionRow)) {
    const count = Object.hasOwn(counts, row.id) ? (counts[row.id] ?? 0) : 0;
    if (row.in_deck !== count) row.in_deck = count;
  }
  for (const preview of previews) preview.dispatchEvent(new DeckPreviewChanged({ total, text: field.value }));
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
