// Shared by the k6 producer and offline regressions. Unknown responses stay invalid.
export function requestOutcome(response, target) {
  const type = (response.headers["Content-Type"] ?? "").includes(target === "json" ? "application/json" : "text/html");
  if (response.status === 200 && type) return "successes";
  if (response.status === 0 && response.error_code === 1050) return "timeouts";
  if (response.status === 429 || response.status >= 500 && response.status <= 599) return "http_errors";
  return "invalid_responses";
}
