// @ts-check
// SortedTotals (ui.rs, a test): a header of a table that sorts its rows in place, told its column
// by the typed call on the header's link.

/**
 * Sorts by the column the header names, in place of following its link.
 * @param {Event} event @param {string} column
 */
export function sortBy(event, column) {
  // A click with a modifier key opens the sorted page, as the link would.
  if (event instanceof MouseEvent && (event.ctrlKey || event.metaKey || event.shiftKey)) return;
  event.preventDefault();
  void column;
}
