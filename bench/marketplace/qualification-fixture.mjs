// Synthetic capability evidence for contract/reporter tests, never measured results.
export function qualificationProbes() {
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
    ownPost: answer(), crossSite: answer(403), bigBody: answer(413), afterBig: answer(),
    page404: answer(404), page500: answer(503), json404: answer(404, "application/problem+json"),
    json405: answer(405, "application/problem+json"), json500: answer(503, "application/problem+json"),
    head: answer(), badHost: answer(400), bigHead: answer(431), live: { ...answer(), path: "/health" },
    slow: { ...answer(503), ms: 10000 }, unfinishedHead: { closedMs: 30000 },
    cap: { below: 950, belowHeld: 200, held: 1050, whileHeld: null, afterRelease: 200, releaseMs: 1, afterwards: 200 },
  };
  const html = '<form method="post"><input name="email"><input name="target_price"></form>';
  probes.page.body = Buffer.from(html).toString("base64"); probes.page.bodyLength = Buffer.byteLength(html);
  probes.live.path = "/health/live"; probes.liveness = [probes.live];
  probes.afterConnections = answer(); probes.afterUpstream = answer();
  return probes;
}
