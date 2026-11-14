import assert from "node:assert/strict";

export function deadlineContract(response, api) {
  assert.ok([408, 503, 504].includes(response.status), `native deadline returned ${response.status}`);
  const media = response.headers?.["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (!api) {
    assert.ok(["text/html", "text/plain", "application/json", "application/problem+json"].includes(media), "deadline response has no contract content type");
    return null;
  }
  assert.ok(["application/json", "application/problem+json"].includes(media), "API deadline must have a JSON error media type");
  const payload = JSON.parse(response.text);
  assert.ok(payload && typeof payload === "object" && !Array.isArray(payload), "API deadline must contain an error object");
  if (media === "application/problem+json") {
    assert.equal(payload.status, response.status, "Problem Details status differs from HTTP status");
    assert.ok(typeof payload.title === "string" && payload.title.trim(), "Problem Details title is missing");
    return { status: payload.status, title: payload.title };
  }
  assert.ok(typeof payload.error === "string" && payload.error.trim(), "JSON error message is missing");
  return { error: payload.error };
}
