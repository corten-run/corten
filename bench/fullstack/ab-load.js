// Load for a before/after comparison of one app: like ssr-load.js, with the Accept-Encoding header
// from ENC ("identity", or what a browser sends) so compression is part of the measurement, and
// TARGET the item page ("page", unless set) or the item as JSON ("json").
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE;
const MODE = __ENV.MODE || "closed";
const ENC = __ENV.ENC || "identity";
const TARGET = __ENV.TARGET || "page";
if (TARGET !== "page" && TARGET !== "json") throw new Error(`TARGET is page or json, not ${TARGET}`);
const PATH = TARGET === "json" ? "/api/items/item_" : "/items/item_";
export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
  scenarios: MODE === "closed"
    ? { load: { executor: "constant-vus", vus: Number(__ENV.VUS || 64), duration: __ENV.DURATION || "45s" } }
    : { load: { executor: "constant-arrival-rate", rate: Number(__ENV.RATE || 300), timeUnit: "1s", duration: __ENV.DURATION || "45s", preAllocatedVUs: 200, maxVUs: 1000 } },
};

export default function () {
  const n = 1 + Math.floor(500 * Math.pow(Math.random(), 2));
  const res = http.get(`${BASE}${PATH}${n}`, { headers: { "Accept-Encoding": ENC } });
  check(res, { "status 200": (r) => r.status === 200 });
}
