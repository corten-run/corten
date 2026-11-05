// @ts-check
// WatchForm (home.rs): a watch or removal the runtime got no answer for (`corten:error` on the
// form) leaves the page as it was; this says so. The next answer replaces the form, and the note
// with it.

/** @param {HTMLParagraphElement} note */
export function failed(note) {
  note.hidden = false;
}
