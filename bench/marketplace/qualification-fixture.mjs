// Synthetic capability evidence for contract/reporter tests, never measured results.
export function boundedQualificationProbes(source) {
  const answer = (status = 200, type = "text/html") => ({ status, ms: 1, bodyLength: 1, headers: { "content-type": type } });
  const secure = (type) => ({ ...answer(200, type), headers: {
    "content-type": type, "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=()", "cache-control": "private, no-store",
  } });
  const compressed = (type) => ({ ...answer(200, type), headers: { "content-type": type, "content-encoding": "gzip" } });
  const probes = {
    page: secure("text/html"), json: secure("application/json"), pageBr: compressed("text/html"),
    jsonBr: compressed("application/json"), jsonGzip: compressed("application/json"),
    ownPost: answer(), crossSite: answer(403),
    page404: answer(404), json404: answer(404, "application/problem+json"),
    json405: answer(405, "application/problem+json"),
    head: answer(), badHost: answer(400), live: { ...answer(), path: "/health/live" },
  };
  const html = '<form method="post"><input name="email"><input name="target_price"></form>';
  probes.page.body = Buffer.from(html).toString("base64"); probes.page.bodyLength = Buffer.byteLength(html);
  probes.liveness = [probes.live];
  if (source === "api") {
    probes.page500 = answer(503); probes.json500 = answer(503, "application/problem+json"); probes.afterUpstream = answer();
  }
  return probes;
}

// Archived v1 shape for offline validation only.
export function qualificationProbes() {
  const ordinary = boundedQualificationProbes("api");
  const answer = (status = 200) => ({ status, ms: 1, bodyLength: 1, headers: { "content-type": "text/html" } });
  return { ...ordinary, bigBody: answer(413), afterBig: answer(), bigHead: answer(431),
    slow: { ...answer(503), ms: 10000 }, unfinishedHead: { closedMs: 30000 },
    cap: { below: 950, belowHeld: 200, held: 1050, whileHeld: null, afterRelease: 200, releaseMs: 1, afterwards: 200 },
    afterConnections: answer() };
}
