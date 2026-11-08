// @ts-check
import { ExportOpened } from "corten/events";

/** @param {HTMLTextAreaElement} field */
export function start(field) {
  field.dispatchEvent(new ExportOpened({}));
}
