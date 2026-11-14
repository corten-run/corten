// Physical URLs remain in the ledger. Only observed native router requests get
// a logical destination; this never turns a document/fetch into a router request.
export function navigationDestination(request, { app, architecture, js, form }) {
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
  if (app === "react-router" && architecture === "react-router" && routerProof(request, form, "loader")) {
    const match = /^(\/marketplace\/(?:en-US|fr-FR|de-DE)\/item_[1-9]\d*)\.data$/.exec(request.path);
    if (match) return match[1];
  }
  return request.path;
}

export function singleFetchData(body, method) {
  try {
    const pool = JSON.parse(body.toString("utf8").split("\n", 1)[0]);
    const keys = (value) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length
      && Object.keys(value).every((key) => /^_\d+$/.test(key) && typeof pool[Number(key.slice(1))] === "string")
      ? Object.keys(value).map((key) => pool[Number(key.slice(1))]) : null;
    if (!Array.isArray(pool)) return null;
    const root = keys(pool[0]);
    if (!root || new Set(root).size !== root.length) return null;
    if (method === "POST" && root.length === 1 && root[0] === "data" && keys(pool[Object.values(pool[0])[0]])) return { framework: "react-router", type: "single-fetch", kind: "action", routes: [] };
    if (method !== "GET" || !root.every((key) => key === "root" || /^routes\/[\w./$-]+$/.test(key))) return null;
    if (!Object.values(pool[0]).every((index) => Number.isInteger(index) && keys(pool[index])?.some((key) => ["data", "error"].includes(key)))) return null;
    return { framework: "react-router", type: "single-fetch", kind: "loader", routes: root };
  } catch { return null; }
}
function routerProof(request, form, kind) {
  return form?.router?.basis === "mounted-react-router-Form" && request.resource === "fetch" && /^text\/x-script\b/.test(request.type ?? "")
    && request.nativeData?.framework === "react-router" && request.nativeData.type === "single-fetch" && request.nativeData.kind === kind
    && (kind === "action" || request.nativeData.routes.length > 0 && request.nativeData.routes.every((id) => form.router.routes.includes(id)));
}
export function writeDestination(request, { app, architecture, js, form }) {
  if (app === "react-router" && architecture === "react-router" && js && request.method === "POST" && request.transport === "router"
    && [200, 400, 422].includes(request.status) && !request.failure && request.completed && routerProof(request, form, "action")
    && request.path === form.router.wirePath && form.enhancement?.path === form.action && form.enhancement.transport === "router") return form.action;
  return request.path;
}

export function normalizeReactRouterCase(record) {
  if (record.architecture !== "react-router" || !record.environment?.js) return record;
  for (const step of record.steps ?? []) for (const request of step.requests) if (request.nativeProtocol?.framework === "react-router") {
    if (request.failure || request.completed !== true) throw new Error("Failed/unfinished native Single Fetch requests cannot be normalized into success");
    const env = { app: "react-router", architecture: record.architecture, js: true, form: request.nativeProtocol.form };
    request.path = request.method === "POST" ? writeDestination(request, env) : navigationDestination(request, env);
    for (const key of ["nativeData", "nativeProtocol", "resource", "type", "completed", "failure"]) delete request[key];
  }
  return record;
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
