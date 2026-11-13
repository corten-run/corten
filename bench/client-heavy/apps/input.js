// Shared input transport only. State reduction and rendering belong to each app.
export const fixture = JSON.parse(document.getElementById("fixture").textContent);
export const source = new EventTarget();
export const controls = ["update-tenth", "swap", "patch-one", "patch-many", "append", "clear", "create-small", "replace-small", "create-large"];
export function tick(count) {
  source.dispatchEvent(new CustomEvent("tick", { detail: count }));
}
export function subscribe(callback, signal) {
  source.addEventListener("tick", callback, { signal });
}
export function unsubscribe(callback) {
  source.removeEventListener("tick", callback);
}
// The harness independently observes this target's listener registrations.
window.clientSource = source;
window.clientProbe = tick;
