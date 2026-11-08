// @ts-check
/** @import { RowToggled } from "corten/events" */

/** A typed event imported for its type alone. @param {RowToggled} event @param {HTMLElement} note */
export function toggled(event, note) {
  note.textContent = event.id;
}
