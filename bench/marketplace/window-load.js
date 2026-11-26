// The convergence and soak load (#1851), separate from the timed load.js: the same requests and
// checks, with each answer counted in the window it completed in, by the k6 engine's clock. A
// fixed-rate load (a soak) also counts each iteration in the window it started in
// (window_N_arrivals), so a reader can check the rate per interval (steady-contract.mjs
// soakArrivals). steady-contract.mjs readWindows reads the windows from the summary export.
import http from "k6/http";
import exec from "k6/execution";
import { Counter, Trend } from "k6/metrics";
import { check } from "k6";
const target = __ENV.TARGET;
if (!["page", "json"].includes(target)) throw new Error("TARGET must be page or json");
const locales = ["en-US", "fr-FR", "de-DE"];
const mode = __ENV.MODE;
if (!["fixed", "closed"].includes(mode)) throw new Error("MODE must be fixed or closed");
const windows = Number(__ENV.WINDOWS), windowMs = Number(__ENV.WINDOW_SECONDS) * 1000;
if (!(Number.isSafeInteger(windows) && windows > 0 && windows <= 360 && Number.isSafeInteger(windowMs) && windowMs > 0)) throw new Error("WINDOWS and WINDOW_SECONDS must be positive integers");
const requests = [], failed = [], durations = [], arrivals = [];
for (let i = 0; i < windows; i++) {
  requests.push(new Counter(`window_${i}_requests`));
  failed.push(new Counter(`window_${i}_failed`));
  durations.push(new Trend(`window_${i}_duration`, true));
  if (mode === "fixed") arrivals.push(new Counter(`window_${i}_arrivals`));
}
const tail = new Counter("window_tail_requests");
const duration = `${(windows * windowMs) / 1000}s`;
export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
  scenarios: { steady: mode === "fixed"
    ? { executor: "constant-arrival-rate", rate: Number(__ENV.RATE), timeUnit: "1s", duration, preAllocatedVUs: 200, maxVUs: 1000, gracefulStop: "10s" }
    : { executor: "constant-vus", vus: Number(__ENV.VUS), duration, gracefulStop: "10s" } },
};
http.setResponseCallback(http.expectedStatuses(200));
export function handleSummary(data) {
  return { "/tmp/marketplace-clock.json": JSON.stringify({ testRunDurationMs: data.state.testRunDurationMs }) };
}
export default function () {
  // constant-arrival-rate starts no iteration after its duration, so a start read at or past the
  // end (the engine's own lag) belongs to the last window.
  if (mode === "fixed") arrivals[Math.min(Math.floor(exec.instance.currentTestRunDuration / windowMs), windows - 1)].add(1);
  const id = 1 + Math.floor(500 * Math.pow(Math.random(), 2));
  const slot = target === "page" ? exec.scenario.iterationInTest % locales.length : null;
  const path = slot === null ? "/api/marketplace/item_" : `/marketplace/${locales[slot]}/item_`;
  const response = http.get(`${__ENV.BASE}${path}${id}`, {
    headers: { "Accept-Encoding": "identity", Accept: target === "json" ? "application/json" : "text/html" },
    redirects: 0, timeout: "10s", tags: { name: target === "json" ? "/api/marketplace/:id" : "/marketplace/:id" },
  });
  const bucket = Math.floor(exec.instance.currentTestRunDuration / windowMs);
  if (bucket < windows) {
    requests[bucket].add(1);
    if (response.status !== 200) failed[bucket].add(1);
    durations[bucket].add(response.timings.duration);
  } else tail.add(1);
  check(response, { "marketplace status 200": (r) => r.status === 200,
    "marketplace content type": (r) => r.status !== 200 || (r.headers["Content-Type"] ?? "").includes(target === "json" ? "application/json" : "text/html") });
}