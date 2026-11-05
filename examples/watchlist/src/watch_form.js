// @ts-check
// WatchForm (home.rs): a watch or removal the runtime got no answer for (`corten:error` on the
// form) leaves the page as it was; this says so. The next answer replaces the form, and the note
// with it.

/**
 * Shows the note (`role="alert"`). One already showing from a failure before is hidden for a
 * frame that is drawn first (two animation frames), so a screen reader says the new failure too.
 * @param {HTMLParagraphElement} note
 */
export function failed(note) {
  if (note.hidden) {
    note.hidden = false;
    return;
  }
  note.hidden = true;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      note.hidden = false;
    }),
  );
}
