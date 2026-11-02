import { Controller } from "@hotwired/stimulus"

// The server renders the listings cheapest first; "high to low" is the same rows reversed, which
// is the order sortListings gives. The button holds both labels and shows one, as Corten's does.
export default class extends Controller {
  static targets = ["ascending", "descending", "rows"]

  toggle() {
    this.rowsTarget.append(...[...this.rowsTarget.rows].reverse())
    const down = this.descendingTarget.hidden
    this.ascendingTarget.hidden = down
    this.descendingTarget.hidden = !down
  }
}
