import "phoenix_html"
import {Socket} from "phoenix"
import {LiveSocket} from "phoenix_live_view"
import {hooks as colocatedHooks} from "phoenix-colocated/item_page"
import topbar from "../vendor/topbar"

const csrfToken = document.querySelector("meta[name='csrf-token']").getAttribute("content")
const mountedAlertForms = new WeakSet()
const initialAlertEdits = new WeakSet()
const liveSocket = new LiveSocket("/live", Socket, {
  longPollFallbackMs: 2500,
  params: {_csrf_token: csrfToken},
  hooks: {...colocatedHooks, MarketplaceAlert: {
    mounted() {
      mountedAlertForms.add(this.el)
      if (initialAlertEdits.delete(this.el)) {
        const fields = new FormData(this.el)
        this.pushEvent("change", {email: fields.get("email"), target_price: fields.get("target_price")})
      }
    },
  }},
  dom: {
    onBeforeElUpdated(from, to) {
      // LiveView recovers forms on rejoin, but not on the initial join patch.
      // Preserve only initial dirty values; subsequent server updates remain authoritative.
      if (from instanceof HTMLInputElement && from.form?.id === "marketplace-alert-form" &&
          !mountedAlertForms.has(from.form) && ["email", "target_price"].includes(from.name) &&
          from.value !== from.defaultValue) {
        to.value = from.value
        to.setAttribute("value", from.value)
        initialAlertEdits.add(from.form)
      }
    },
  },
})

topbar.config({barColors: {0: "#29d"}, shadowColor: "rgba(0, 0, 0, .3)"})
window.addEventListener("phx:page-loading-start", _info => topbar.show(300))
window.addEventListener("phx:page-loading-stop", _info => topbar.hide())
// The browser benchmark reads this mark: the LiveView has joined, so its events work.
window.addEventListener("phx:page-loading-stop", () => { window.__hydratedAt ??= performance.now() })

liveSocket.connect()

window.liveSocket = liveSocket
