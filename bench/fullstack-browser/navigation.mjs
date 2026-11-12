// Physical URLs remain in the ledger. Only observed native router requests get
// a logical destination; this never turns a document/fetch into a router request.
export function navigationDestination(request, { app, architecture, js }) {
  if (!js || request.method !== "GET" || request.transport !== "router" || request.status !== 200 || request.failure) return request.path;
  if (app === "nextjs" && architecture === "next-pages") {
    const match = /^\/_next\/data\/([^/]+)(\/marketplace\/[^/]+\/item_[1-9]\d*)\.json$/.exec(request.path);
    if (match && ![".", ".."].includes(match[1])) return match[2];
  }
  if (app === "sveltekit" && architecture === "sveltekit" && request.resource === "fetch"
    && /^application\/json\b/.test(request.type ?? "")) {
    const match = /^(\/marketplace\/(?:en-US|fr-FR|de-DE)\/item_[1-9]\d*)\/__data\.json$/.exec(request.path);
    if (match && request.nativeData?.framework === "sveltekit" && request.nativeData.type === "data"
      && Array.isArray(request.nativeData.nodes) && request.nativeData.nodes.includes("data")) return match[1];
  }
  return request.path;
}

// Applied to an already captured strict case by validateBrowserCapture's public
// normalization hook. Native payload evidence is mandatory, not an app-name waiver.
export function normalizeSvelteKitCase(record) {
  if (record.architecture !== "sveltekit" || !record.environment?.js) return record;
  for (const step of record.steps ?? []) for (const request of step.requests) {
    if (request.nativeData) {
      const { nativeData, resource, type, ...wire } = request;
      request.path = navigationDestination(request, { app: "sveltekit", architecture: record.architecture, js: true });
      delete request.nativeData; delete request.resource; delete request.type;
      // The hook receives a clone. The raw capture's physical path is immutable.
      if (Object.keys(wire).length !== Object.keys(request).length) throw new Error("unexpected native request normalization fields");
    }
  }
  return record;
}
