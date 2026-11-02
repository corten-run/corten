import { Controller } from "@hotwired/stimulus"

// "Show all" is a button, as on Corten's page; it points its Turbo Frame at the page with every
// offer, and Turbo swaps the frame in.
export default class extends Controller {
  load({ params }) {
    this.element.src = params.url
  }
}
