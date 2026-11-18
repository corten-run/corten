// JSON timed wire outcomes. Body/source correctness requires the independent gates.
export function classify(response) {
  const json = (response.headers?.["Content-Type"] ?? "").split(";")[0].trim().toLowerCase() === "application/json";
  if (response.status === 200 && json && !response.error_code) return "ok";
  if (response.status === 0 && response.error_code === 1050) return "timeout";
  if ((response.status === 429 || Number.isInteger(response.status) && response.status >= 500 && response.status <= 599)
    && response.error_code === 1000 + response.status) return "http_error";
  return "invalid";
}
