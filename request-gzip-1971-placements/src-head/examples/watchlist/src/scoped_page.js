import { patchRoots } from "corten";

const [patchRoot] = patchRoots();

/** @param {HTMLOutputElement} ready @param {AbortSignal} signal */
export function ready(ready, signal) {
  ready.value = document.compatMode;
  signal.addEventListener("abort", () => {
    const root = patchRoot(ready);
    ready.dataset.patchRoot = root === null ? "removed" : root?.id ?? "none";
  }, { once: true });
}
