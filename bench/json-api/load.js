import http from "k6/http";
import { check } from "k6";
const payload = __ENV.PAYLOAD;
if (!["catalog-v1", "marketplace-v2"].includes(payload)) throw new Error("explicit JSON payload required");
const prefix = payload === "catalog-v1" ? "/api/catalog/record_" : "/api/marketplace/item_";
export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
  thresholds: { http_req_failed: ["rate==0"], checks: ["rate==1"], dropped_iterations: ["count==0"] },
  scenarios: { json: __ENV.MODE === "fixed"
    ? { executor: "constant-arrival-rate", rate: Number(__ENV.RATE), timeUnit: "1s", duration: __ENV.DURATION, preAllocatedVUs: 200, maxVUs: 1000, gracefulStop: "10s" }
    : { executor: "constant-vus", vus: Number(__ENV.VUS), duration: __ENV.DURATION, gracefulStop: "10s" } },
};
export default function () {
  const id = 1 + Math.floor(500 * Math.pow(Math.random(), 2));
  const response = http.get(`${__ENV.BASE}${prefix}${id}`, { headers: { "Accept-Encoding": "identity", Accept: "application/json" },
    redirects: 0, timeout: "10s", tags: { name: prefix + ":id" } });
  check(response, { "JSON status 200": (r) => r.status === 200,
    "JSON content type": (r) => (r.headers["Content-Type"] ?? "").split(";")[0].trim().toLowerCase() === "application/json" });
}
// Preserve k6's measured clock independently of the legacy --summary-export format.
export function handleSummary(data) {
  return { "/tmp/json-clock.json": JSON.stringify({ k6DurationMs: data.state.testRunDurationMs }) };
}
