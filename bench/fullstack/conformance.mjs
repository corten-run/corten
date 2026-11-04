// What conform.mjs reads from its probes: one cell of the feature matrix each, and whether that
// cell does the thing the column names (bench/fullstack/README.md, "Feature matrix"). Pure, so
// conformance.test.mjs can check it, and re-score a round's stored probes, without Docker.

/**
 * One probe's answer as stored: status, headers, body length, time, or how it failed.
 * `body` is kept in memory only (the page, to find its form).
 * @typedef {{ status?: number, headers?: Record<string, string | string[] | undefined>, bodyLength?: number, body?: Buffer, ms: number, timedOut?: boolean, error?: string, didNotStart?: boolean, path?: string }} Probe
 */

/** The security headers Corten sends on every answer, by what each is for. */
const security = [
  ["csp", (/** @type {Probe} */ p) => !!p.headers?.["content-security-policy"]],
  ["nosniff", (/** @type {Probe} */ p) => p.headers?.["x-content-type-options"] === "nosniff"],
  ["referrer", (/** @type {Probe} */ p) => !!p.headers?.["referrer-policy"]],
  ["frame", (/** @type {Probe} */ p) => !!p.headers?.["x-frame-options"] || /frame-ancestors/.test(String(p.headers?.["content-security-policy"] ?? ""))],
  ["opener", (/** @type {Probe} */ p) => !!p.headers?.["cross-origin-opener-policy"]],
];

/** "all", "none" or the ones missing, for one answer. */
export const securityOf = (/** @type {Probe | null | undefined} */ p) => {
  if (!p?.status) return "no answer";
  const missing = security.filter(([, has]) => !has(/** @type {Probe} */ (p))).map(([name]) => name);
  return missing.length === 0 ? "all" : missing.length === security.length ? "none" : "missing " + missing.join(", ");
};

/** What a page's CSP allows a script to be: blocked unless listed ("strict"), inline allowed, or no CSP. */
export const scriptPolicyOf = (/** @type {Probe | null | undefined} */ p) => {
  const csp = String(p?.headers?.["content-security-policy"] ?? "");
  if (!csp) return "no CSP";
  const directive = /(?:^|;)\s*script-src\s+([^;]*)/.exec(csp)?.[1] ?? /(?:^|;)\s*default-src\s+([^;]*)/.exec(csp)?.[1];
  if (directive === undefined) return "scripts unrestricted";
  return /'unsafe-inline'/.test(directive) && !/'(nonce|sha\d+)-/.test(directive) ? "inline allowed" : "strict";
};

const lengthOf = (/** @type {Probe} */ p) => p.bodyLength ?? p.body?.length ?? 0;
const typeOf = (/** @type {Probe | null | undefined} */ p) => String(p?.headers?.["content-type"] ?? "").split(";")[0].trim();
const seconds = (/** @type {Probe} */ p) => (p.ms / 1000).toFixed(1) + " s";
/** The answer's status, or how it failed: held until the probe gave up, the connection's error, or an app that did not start. */
export const statusOf = (/** @type {Probe | null | undefined} */ p) =>
  !p ? "-" : p.didNotStart ? "did not start" : p.timedOut ? "held " + Math.round(p.ms / 1000) + " s" : p.error ? "error " + p.error : String(p.status ?? "-");
/** An error answer as "<status> <format>": problem+json, json, html, text, or empty. */
export const errorOf = (/** @type {Probe | null | undefined} */ p) => {
  if (!p?.status) return statusOf(p);
  const t = typeOf(p);
  const format = !lengthOf(p) ? "empty" : t === "application/problem+json" ? "problem+json" : t === "text/html" ? "html" : t.includes("json") ? "json" : t || "untyped";
  return p.status + " " + format;
};
const encodingOf = (/** @type {Probe | null | undefined} */ p) => String(p?.headers?.["content-encoding"] ?? "") || "none";
/** Kept from shared caches and revalidated (or not stored) by the browser. */
const notShared = (/** @type {string} */ c) => /no-cache|no-store/.test(c) && !/public/.test(c);
/** A status answered within `max` seconds, as "<status> in <s> s", or how it failed. */
const timed = (/** @type {Probe | null | undefined} */ p) => (p?.status ? p.status + " in " + seconds(p) : statusOf(p));
const within = (/** @type {string} */ c, /** @type {RegExp} */ status, /** @type {number} */ max) => {
  const m = /^(\d+) in ([\d.]+) s$/.exec(c);
  return !!m && status.test(m[1]) && Number(m[2]) <= max;
};

/** Where an app may answer that it is alive, and that it is ready for traffic, in the order tried. */
export const livePaths = ["/health/live", "/healthz", "/livez", "/up", "/health", "/actuator/health/liveness", "/actuator/health"];
export const readyPaths = ["/health/ready", "/readyz", "/actuator/health/readiness"];

/**
 * A cell that starts with "n/a" is not counted: a page column for an app without pages, or a form
 * column for an app whose form goes over a websocket (no HTTP request to probe).
 * The deadline is any 5xx within 35 seconds: Corten's default deadline is 30 (card-market sets 10),
 * gunicorn's worker timeout 30, and five seconds allow for the clock and the abort.
 * @type {{ key: string, label: string, pages?: boolean, cell: (o: Record<string, any>) => string, meets: (cell: string) => boolean }[]}
 */
export const features = [
  { key: "pageHeaders", label: "page security headers", pages: true, cell: (o) => securityOf(o.page), meets: (c) => c === "all" },
  { key: "pageScripts", label: "page CSP for scripts", pages: true, cell: (o) => scriptPolicyOf(o.page), meets: (c) => c === "strict" },
  { key: "permissions", label: "page Permissions-Policy", pages: true, cell: (o) => (o.page?.headers?.["permissions-policy"] ? "yes" : "no"), meets: (c) => c === "yes" },
  { key: "pageCache", label: "page kept from shared caches", pages: true, cell: (o) => String(o.page?.headers?.["cache-control"] ?? "none"), meets: notShared },
  { key: "etag", label: "page ETag, 304 when unchanged", pages: true, cell: (o) => (!(o.pageBr?.headers?.etag ?? o.page?.headers?.etag) ? "no ETag" : statusOf(o.pageAgain)), meets: (c) => c === "304" },
  { key: "pageCompression", label: "page compressed (br, gzip asked)", pages: true, cell: (o) => encodingOf(o.pageBr), meets: (c) => c === "br" || c === "gzip" },
  // Refused is not accepted: a 4xx, or a 5xx (Next.js answers a server action it refuses with 500).
  { key: "crossSite", label: "form posted from another site refused", pages: true, cell: (o) => o.form ?? statusOf(o.crossSite), meets: (c) => /^[45]\d\d$/.test(c) },
  { key: "bigBody", label: "form with a 3 MiB field refused", pages: true, cell: (o) => o.form ?? statusOf(o.bigBody), meets: (c) => /^[45]\d\d$/.test(c) },
  { key: "page404", label: "missing page", pages: true, cell: (o) => errorOf(o.page404), meets: (c) => c === "404 html" },
  { key: "jsonHeaders", label: "JSON security headers", cell: (o) => securityOf(o.json), meets: (c) => c === "all" },
  { key: "jsonCache", label: "JSON kept from shared caches", cell: (o) => String(o.json?.headers?.["cache-control"] ?? "none"), meets: notShared },
  { key: "jsonCompression", label: "JSON compressed (br, gzip asked; gzip asked)", cell: (o) => encodingOf(o.jsonBr) + "; " + encodingOf(o.jsonGzip), meets: (c) => /^(br|gzip|zstd); gzip$/.test(c) },
  { key: "json404", label: "missing item JSON", cell: (o) => errorOf(o.json404), meets: (c) => c === "404 problem+json" || c === "404 json" },
  { key: "json405", label: "wrong method on the JSON", cell: (o) => errorOf(o.json405), meets: (c) => c === "405 problem+json" || c === "405 json" },
  { key: "head", label: "HEAD on the JSON", cell: (o) => statusOf(o.head) + (o.head && lengthOf(o.head) ? " with a body" : ""), meets: (c) => c === "200" },
  { key: "host", label: "unknown Host refused", cell: (o) => statusOf(o.badHost), meets: (c) => /^4\d\d$/.test(c) },
  { key: "bigHead", label: "64 KiB request header (not counted)", cell: (o) => statusOf(o.bigHead), meets: () => true },
  { key: "live", label: "liveness endpoint", cell: (o) => (o.live ? o.live.path + " " + statusOf(o.live) : "none"), meets: (c) => / 200$/.test(c) },
  { key: "readyDown", label: "readiness, item API hung", cell: (o) => (!o.readyPath ? "no readiness endpoint" : o.readyPath + " " + timed(o.readyDown)), meets: (c) => within(c.replace(/^\S+ /, ""), /^[45]\d\d$/, 35) },
  { key: "deadline", label: "item API hung: page (JSON) answer", cell: (o) => timed(o.slow), meets: (c) => within(c, /^5\d\d$/, 35) },
];

/**
 * One app's row: each column's cell, and `unmet`, the counted columns whose cell does not do the
 * thing the column names.
 * @param {Record<string, any>} o the probes, `pages`, and `form` when the form is not probed
 */
export const rowOf = (o) => {
  /** @type {Record<string, any>} */
  const row = {};
  const unmet = [];
  for (const f of features) {
    const cell = f.pages && !o.pages ? "n/a" : f.cell(o);
    row[f.key] = cell;
    if (!cell.startsWith("n/a") && !f.meets(cell)) unmet.push(f.key);
  }
  row.unmet = unmet;
  return row;
};

const attr = (/** @type {string} */ tag, /** @type {string} */ name) => {
  const m = new RegExp("\\s" + name.replace(/[.:$]/g, "\\$&") + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'") : undefined;
};
const has = (/** @type {string} */ tag, /** @type {string} */ name) => new RegExp("\\s" + name.replace(/[.:$]/g, "\\$&") + "(\\s|=|>|/)", "i").test(tag);

/**
 * The page's price-alert form: its first form that posts. An HTTP form gives the path it posts to
 * (resolved against the page's), its encoding and fields (a hidden field's value as given, the
 * others filled in); a form that submits over a websocket (Livewire's wire:submit, LiveView's
 * phx-submit) gives `socket`. Null when the page has no form that posts.
 * @param {string} html
 * @param {string} pagePath
 */
export const formOf = (html, pagePath) => {
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const tag = "<form " + m[1] + ">";
    if (String(attr(tag, "method") ?? "get").toLowerCase() !== "post") continue;
    if (has(tag, "wire:submit") || has(tag, "phx-submit")) return { socket: has(tag, "wire:submit") ? "wire:submit" : "phx-submit" };
    const url = new URL(attr(tag, "action") || pagePath, "http://app" + pagePath);
    /** @type {{ name: string, value: string, hidden: boolean }[]} */
    const fields = [];
    for (const f of m[2].matchAll(/<(input|textarea)\b([^>]*)>/gi)) {
      const t = "<x " + f[2] + ">";
      const name = attr(t, "name");
      const type = String(attr(t, "type") ?? "text").toLowerCase();
      if (!name || ["submit", "button", "reset", "file"].includes(type)) continue;
      const hidden = type === "hidden";
      const value = hidden ? attr(t, "value") ?? "" : type === "email" || /mail/i.test(name) ? "a@example.com" : type === "number" || /price|amount/i.test(name) ? "1" : "a";
      fields.push({ name, value, hidden });
    }
    return { path: url.pathname + url.search, multipart: /multipart/i.test(attr(tag, "enctype") ?? ""), fields };
  }
  return null;
};

/**
 * The form's body as a browser would send it, with its first field that is not hidden set to
 * `big` when given. Returns the body and its Content-Type.
 * @param {{ multipart: boolean, fields: { name: string, value: string, hidden: boolean }[] }} form
 * @param {string} [big]
 */
export const formBody = (form, big) => {
  const target = big === undefined ? -1 : form.fields.findIndex((f) => !f.hidden);
  const fields = form.fields.map((f, i) => [f.name, i === target ? /** @type {string} */ (big) : f.value]);
  if (!form.multipart) return { type: "application/x-www-form-urlencoded", body: new URLSearchParams(fields).toString() };
  const boundary = "----conform" + "x".repeat(16);
  const body = fields.map(([n, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`).join("") + `--${boundary}--\r\n`;
  return { type: "multipart/form-data; boundary=" + boundary, body };
};

/**
 * The answer in raw bytes: its status, headers and the bytes after them (chunk framing included,
 * which only the form columns' status reads). Null when no status line arrived.
 */
export const parseAnswer = (/** @type {Buffer} */ raw) => {
  const end = raw.indexOf("\r\n\r\n");
  const head = (end < 0 ? raw : raw.subarray(0, end)).toString("latin1").split("\r\n");
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? "")?.[1];
  if (!status) return null;
  /** @type {Record<string, string | string[]>} */
  const headers = {};
  for (const line of head.slice(1)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    headers[k] = k in headers ? [headers[k]].flat().concat(v) : v;
  }
  return { status: Number(status), headers, bodyLength: end < 0 ? 0 : raw.length - end - 4 };
};
