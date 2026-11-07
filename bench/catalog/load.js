import http from "k6/http";
import { check } from "k6";
const target = __ENV.TARGET;
if (!["page", "json"].includes(target)) throw new Error("TARGET must be page or json");
const mode = __ENV.MODE;
if (!["fixed", "closed"].includes(mode)) throw new Error("MODE must be fixed or closed");
export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
  thresholds: { http_req_failed: ["rate==0"], checks: ["rate==1"], dropped_iterations: ["count==0"] },
  scenarios: { catalog: mode === "fixed"
    ? { executor: "constant-arrival-rate", rate: Number(__ENV.RATE), timeUnit: "1s", duration: __ENV.DURATION, preAllocatedVUs: 200, maxVUs: 1000, gracefulStop: "10s" }
    : { executor: "constant-vus", vus: Number(__ENV.VUS), duration: __ENV.DURATION, gracefulStop: "10s" } },
};
export default function () {
  const id = 1 + Math.floor(500 * Math.pow(Math.random(), 2));
  const path = target === "json" ? "/api/catalog/record_" : "/catalog/record_";
  const response = http.get(`${__ENV.BASE}${path}${id}`, {
    headers: { "Accept-Encoding": "identity", Accept: target === "json" ? "application/json" : "text/html" },
    redirects: 0, timeout: "10s", tags: { name: target === "json" ? "/api/catalog/:id" : "/catalog/:id" },
  });
  check(response, { "catalog status 200": (r) => r.status === 200,
    "catalog content type": (r) => (r.headers["Content-Type"] ?? "").includes(target === "json" ? "application/json" : "text/html") });
}
