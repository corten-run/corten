// Closed phases only. Fixed phases retain the separate full stock-output experiment.
import { Counter } from "k6/metrics";
import request, { options as originalOptions } from "./load.js";
import { classify } from "./load-outcome.js";

if (__ENV.MODE !== "closed") throw new Error("closed timed JSON load required");
export const options = originalOptions;
const counts = Object.fromEntries(["started", "ok", "timeout", "http_error", "invalid", "rate_limited", "server_error"]
  .map((key) => [key, new Counter(`json_${key}`)]));
let initialized = false;
export default function () {
  if (!initialized) {
    for (const counter of Object.values(counts)) counter.add(0);
    initialized = true;
  }
  counts.started.add(1);
  const response = request(), outcome = classify(response);
  counts[outcome].add(1);
  if (outcome === "http_error") counts[response.status === 429 ? "rate_limited" : "server_error"].add(1);
}
export function handleSummary(data) {
  return { "/tmp/json-clock.json": JSON.stringify({ schema: "json-api-closed-clock/v1", k6DurationMs: data.state.testRunDurationMs,
    metrics: Object.fromEntries(Object.entries(data.metrics).filter(([name]) => name.startsWith("json_"))) }) };
}
