// @ts-check
import { shortcut } from "corten/keys";

/** @param {KeyboardEvent} event @param {HTMLButtonElement} button */
export function press(event, button) {
  if (shortcut(event) === "p") button.click();
}