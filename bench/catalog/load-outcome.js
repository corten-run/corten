// Shared by the k6 producer and offline regressions. Unknown responses stay invalid.
export function requestOutcome(response, target) {
  const type = (response.headers["Content-Type"] ?? "").includes(target === "json" ? "application/json" : "text/html");
  if (response.status === 200 && type) return "successes";
  if (response.status === 0 && response.error_code === 1050) return "timeouts";
  if (response.status === 429 || response.status >= 500 && response.status <= 599) return "http_errors";
  return "invalid_responses";
}

// The class of a failed request, asked only after requestOutcome returned http_errors or
// invalid_responses, so a successful request is never classified here and a run without failures
// emits no class series: its samples and outcome classification are those from before the split.
// A success still pays one more comparison, and the class Counters are built once at init; their
// effect on CPU or timing is not measured. HTTP errors split into 429, 502, 503 and other 5xx. An
// invalid response is `transport` when k6 got no response for a network reason: a TCP, TLS or
// HTTP/2 error code, or a non-TCP network error (k6 v2.4.0, lib/netext/httpext/error_codes.go:
// 1010, 1200-1399, 1600-1699). Anything else is `other`: a generic (1000), invalid URL (1020),
// DNS or blocked-host (11xx) or response-decompression (1701) error code, an unknown code, another
// status, or a 200 with the wrong content type. Both stay invalid responses that fail the phase.
// timed.mjs keeps its own copy of the names (a replay does not load this file); load.test.mjs
// checks the two agree.
export const failureClasses = Object.freeze(["http_429", "http_502", "http_503", "http_5xx", "transport", "other"]);
export function failureClass(response) {
  const status = response.status, code = response.error_code;
  if (status === 429) return "http_429";
  if (status === 502) return "http_502";
  if (status === 503) return "http_503";
  if (status >= 500 && status <= 599) return "http_5xx";
  const network = Number.isInteger(code) && (code === 1010 || code >= 1200 && code <= 1399 || code >= 1600 && code <= 1699);
  return status === 0 && network ? "transport" : "other";
}
