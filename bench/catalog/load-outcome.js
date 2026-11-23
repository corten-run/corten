// Shared by the k6 producer and offline regressions. Each attempt has exactly one outcome. A
// success passes the first test; only a failure reaches the rest, which keep 429, 502, 503, other
// 5xx and k6 transport errors (status 0 with a k6 error code, not a timeout) apart. Unknown
// responses stay invalid. timed.mjs keeps its own copy of the names (a replay does not load this
// file); load.test.mjs checks the two agree.
export const outcomes = Object.freeze(["successes", "timeouts", "http_429", "http_502", "http_503", "http_5xx",
  "transport_errors", "invalid_responses"]);
export function requestOutcome(response, target) {
  const type = (response.headers["Content-Type"] ?? "").includes(target === "json" ? "application/json" : "text/html");
  if (response.status === 200 && type) return "successes";
  const status = response.status;
  if (status === 0) {
    const code = response.error_code;
    if (code === 1050) return "timeouts";
    return Number.isInteger(code) && code >= 1000 && code <= 1999 ? "transport_errors" : "invalid_responses";
  }
  if (status === 429) return "http_429";
  if (status === 502) return "http_502";
  if (status === 503) return "http_503";
  if (status >= 500 && status <= 599) return "http_5xx";
  return "invalid_responses";
}
