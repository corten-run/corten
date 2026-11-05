// @ts-check
// WatchForm (home.rs): a watch or removal the runtime got no answer for (`corten:error` on the
// form) leaves the page as it was; this says so. The next answer replaces the form, and the note
// with it.

/**
 * Shows the note (`role="alert"`). One already showing from a failure before is hidden for a frame
 * first, so a screen reader says the new failure too.
 * @param {HTMLParagraphElement} note
 */
export function failed(note) {
  note.hidden = true;
  requestAnimationFrame(() => {
    note.hidden = false;
  });
}
