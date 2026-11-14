// @ts-check
// Ledger (ledger.rs): the strip at the bottom of the page. It reads the browser's own timings:
// how long the server said it took (Server-Timing on the page's response), what the load cost,
// and every request since. It counts again each time the browser records a request, so the
// strip moves when the page sends one and stays when it does not.
/** @import { Message, NumberFormat } from "corten" */

/**
 * @param {HTMLOutputElement} drew @param {HTMLOutputElement} load
 * @param {HTMLOutputElement} since @param {HTMLOutputElement} last
 * @param {Message<"micros">} drewSaid @param {Message<"count" | "kb" | "ms">} loadSaid
 * @param {Message<"count" | "kb">} sinceSaid @param {Message<"path" | "kb" | "ms">} lastSaid
 * @param {NumberFormat} number the page's number format @param {AbortSignal} signal
 */
export function keep(drew, load, since, last, drewSaid, loadSaid, sinceSaid, lastSaid, number, signal) {
  const [page] = performance.getEntriesByType("navigation");
  if (!(page instanceof PerformanceNavigationTiming)) return;
  const timed = page.serverTiming.find((timing) => timing.name === "app");
  if (timed) drew.value = drewSaid({ micros: number(Math.round(timed.duration * 1000)) });

  /** @param {number} bytes */
  const kb = (bytes) => number((bytes / 1024).toFixed(1));
  const read = () => {
    const loaded = page.loadEventEnd;
    if (loaded === 0) return;
    const first = { requests: 1, bytes: page.transferSize };
    const later = { requests: 0, bytes: 0 };
    /** @type {PerformanceResourceTiming | undefined} */
    let latest;
    for (const entry of performance.getEntriesByType("resource")) {
      // The live stream stays open, so it is no request that came and went.
      if (!(entry instanceof PerformanceResourceTiming) || entry.initiatorType === "eventsource") continue;
      // The load is what was asked for by a second after the load event: the icon the browser
      // fetches last is part of it. Everything after is counted apart.
      const part = entry.startTime <= loaded + 1000 ? first : later;
      part.requests += 1;
      part.bytes += entry.transferSize;
      if (part === later) latest = entry;
    }
    load.value = loadSaid({
      count: first.requests,
      kb: kb(first.bytes),
      ms: number(Math.round(page.domInteractive)),
    });
    since.value = sinceSaid({ count: later.requests, kb: kb(later.bytes) });
    if (latest) {
      last.value = lastSaid({
        path: new URL(latest.name).pathname,
        kb: kb(latest.transferSize),
        ms: number(Math.round(latest.duration)),
      });
    }
  };

  if (document.readyState === "complete") read();
  else window.addEventListener("load", () => setTimeout(read, 0), { once: true, signal });
  const watch = new PerformanceObserver(read);
  watch.observe({ type: "resource" });
  signal.addEventListener("abort", () => watch.disconnect(), { once: true });
}
