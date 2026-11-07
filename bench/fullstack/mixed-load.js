// The mixed phase (#813): one app under the mix of requests a site gets, at a fixed rate, so its
// features that matter only together are under load at once: pages and JSON, the home page,
// form posts that meet its write limit, and a share of item pages whose upstream answers slower
// than a deadline. The same mix for every app, from run-ssr.mjs:
//   70% item pages (SLOW_SHARE of them, from the item API, ask for an item it answers late),
//   20% the item as JSON, 5% the home page, 5% the item page's price-alert form posted.
// Every request comes from k6's one address, so an app's per-client write limit is met, and asks
// for compression as a browser does (the other phases ask for none), so each answer is compressed
// as the app compresses it for a browser.
// Env: BASE, RATE, DURATION, ITEMS (500), SLOW_SHARE (0), TAIL (how long requests still waiting
// when the time is up are kept: mixed.mjs's tailSeconds, 65 s, past each request's timeout), and the
// form as run-ssr.mjs read it from
// the item page (mixed.mjs's formEnv): FORM_PATH, FORM_TYPE, FORM_BODY, FORM_COOKIE, FORM_HOST,
// ORIGIN (no FORM_PATH: the app's form is sent by its script, or there is none, and the posts'
// share asks for item pages instead). The kinds and classes are mixed.mjs's, which reads them.
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";

const BASE = __ENV.BASE;
const ITEMS = Number(__ENV.ITEMS || 500);
const SLOW_SHARE = Number(__ENV.SLOW_SHARE || 0);
const FORM = __ENV.FORM_PATH ? { path: __ENV.FORM_PATH, type: __ENV.FORM_TYPE, body: __ENV.FORM_BODY, cookie: __ENV.FORM_COOKIE || "", host: __ENV.FORM_HOST || "", origin: __ENV.ORIGIN } : null;

/** The kinds of request, each with its own latency and answers. */
const kinds = ["page", "slow", "json", "home", "post"];
const ms = Object.fromEntries(kinds.map((k) => [k, new Trend(`${k}_ms`, true)]));
// Answers by class: 2xx and 3xx (a post's redirect after it is taken), 429 (a write limit), other
// 4xx, 5xx (a deadline's 503 among them), and none (k6 got no answer).
const classes = ["ok", "limited", "refused", "failed", "none"];
const answers = Object.fromEntries(kinds.flatMap((k) => classes.map((c) => [`${k}_${c}`, new Counter(`${k}_${c}`)])));
const classOf = (/** @type {number} */ s) => (s === 0 ? "none" : s < 400 ? "ok" : s === 429 ? "limited" : s < 500 ? "refused" : "failed");

export const options = {
  discardResponseBodies: true,
  insecureSkipTLSVerify: BASE.startsWith("https:"),
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
  scenarios: {
    // A request still waiting when the time is up is kept until its answer or its timeout (TAIL,
    // past the timeout), so it is counted and not cut off.
    load: { executor: "constant-arrival-rate", rate: Number(__ENV.RATE || 150), timeUnit: "1s", duration: __ENV.DURATION || "60s", gracefulStop: __ENV.TAIL || "65s", preAllocatedVUs: 200, maxVUs: 2000 },
  },
};

const item = () => 1 + Math.floor(ITEMS * Math.pow(Math.random(), 2));
const encoding = "br, gzip";
// What a browser asks for a page it navigates to, and what a script asks for the JSON.
const navigate = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const page = { headers: { Accept: navigate, "Accept-Encoding": encoding }, redirects: 0, timeout: "60s" };
const json = { headers: { Accept: "application/json", "Accept-Encoding": encoding }, redirects: 0, timeout: "60s" };

export default function () {
  const r = Math.random();
  let kind;
  let res;
  if (r < 0.7 || (r >= 0.95 && !FORM)) {
    kind = Math.random() < SLOW_SHARE ? "slow" : "page";
    res = http.get(`${BASE}/items/item_${kind === "slow" ? "slow_" : ""}${item()}`, page);
  } else if (r < 0.9) {
    kind = "json";
    res = http.get(`${BASE}/api/items/item_${item()}`, json);
  } else if (r < 0.95) {
    kind = "home";
    res = http.get(`${BASE}/`, page);
  } else {
    kind = "post";
    const f = /** @type {NonNullable<typeof FORM>} */ (FORM);
    const headers = { "Content-Type": f.type, Accept: navigate, Origin: f.origin, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Accept-Encoding": encoding, ...(f.cookie ? { Cookie: f.cookie } : {}), ...(f.host ? { Host: f.host } : {}) };
    // An empty jar: k6 adds a VU's own cookies (from its GETs' answers) to a Cookie header given
    // here, and a second session cookie would not match the form's token.
    res = http.post(`${BASE}${f.path}`, f.body, { headers, jar: new http.CookieJar(), redirects: 0, timeout: "60s" });
  }
  ms[kind].add(res.timings.duration);
  answers[`${kind}_${classOf(res.status)}`].add(1);
}
