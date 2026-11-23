// @ts-check
// PictureUpload (account.rs): how much of the picture's form is sent, on the bar the form shows
// while it is busy.

/**
 * The share of the form's body sent so far. Once all of it is, the server is still reading and
 * keeping the picture, so the bar goes indeterminate until the answer is drawn.
 * @param {ProgressEvent} event @param {HTMLProgressElement} bar
 */
export function sending(event, bar) {
  if (event.lengthComputable && event.loaded < event.total) bar.value = event.loaded / event.total;
  else bar.removeAttribute("value");
}
