import execution from "k6/execution";
import { Counter, Gauge } from "k6/metrics";
import request, { options as originalOptions } from "./load.js";
import { classify } from "./load-outcome.js";

if (__ENV.MODE !== "fixed") throw new Error("fixed-only instrumentation prototype");
if (!__ENV.JSON_PROTOTYPE_OUTPUT) throw new Error("prototype output directory required");
export const options = originalOptions;
const started = new Counter("json_started"), capped = new Counter("json_start_capped");
const outcomes = Object.fromEntries(["ok", "timeout", "http_error", "invalid"].map((key) => [key, new Counter(`json_${key}`)]));
const clocks = Object.fromEntries(["before_ms", "after_ms", "progress_ns", "scenario_ms", "origin_lower_ns", "origin_upper_ns"]
  .map((key) => [key, new Gauge(`json_start_${key}`)]));
const requestedNs = Number(__ENV.DURATION.replace(/s$/, "")) * 1e9;
let initialized = false;
export default function () {
  const before = execution.instance.currentTestRunDuration;
  const progress = execution.scenario.progress;
  const after = execution.instance.currentTestRunDuration;
  if (!initialized) {
    for (const counter of Object.values(outcomes)) counter.add(0);
    capped.add(0); initialized = true;
  }
  started.add(1);
  clocks.before_ms.add(before); clocks.after_ms.add(after);
  clocks.progress_ns.add(progress * requestedNs); clocks.scenario_ms.add(execution.scenario.startTime);
  if (progress < 1) {
    clocks.origin_lower_ns.add(Math.floor(before * 1e6) - Math.ceil(progress * requestedNs) - 2);
    clocks.origin_upper_ns.add(Math.ceil(after * 1e6) - Math.floor(progress * requestedNs) + 2);
  } else capped.add(1);
  const response = request();
  outcomes[classify(response)].add(1, { status: String(response.status), error_code: String(response.error_code ?? 0) });
}
export function handleSummary(data) {
  return { [`${__ENV.JSON_PROTOTYPE_OUTPUT}/clock.json`]: JSON.stringify({ schema: "json-api-fixed-clock/v1", k6DurationMs: data.state.testRunDurationMs,
    metrics: Object.fromEntries(Object.entries(data.metrics).filter(([name]) => name.startsWith("json_"))) }) };
}
