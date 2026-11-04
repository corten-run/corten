// What conform.mjs reads from its probes: one cell of the feature matrix each, and whether that
// cell does what card-market does (bench/fullstack/README.md, "Feature matrix"). Pure, so
// conformance.test.mjs can check it without Docker.

/** @typedef {{ status?: number, headers?: Record<string, string | string[] | undefined>, body?: Buffer, ms: number, timedOut?: boolean, error?: string }} Probe */

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
  const missing = security.filter(([, has]) => !has(p)).map(([name]) => name);
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

const typeOf = (/** @type {Probe | null | undefined} */ p) => String(p?.headers?.["content-type"] ?? "").split(";")[0].trim();
const statusOf = (/** @type {Probe | null | undefined} */ p) => (p?.timedOut ? "held " + Math.round(p.ms / 1000) + " s" : p?.error ? "error" : String(p?.status ?? "-"));
/** An error answer as "<status> <format>": problem+json, html, json, text, or empty. */
export const errorOf = (/** @type {Probe | null | undefined} */ p) => {
  if (!p?.status) return statusOf(p);
  const t = typeOf(p);
  const format = !p.body?.length ? "empty" : t === "application/problem+json" ? "problem+json" : t === "text/html" ? "html" : t.includes("json") ? "json" : t || "untyped";
  return p.status + " " + format;
};
const encodingOf = (/** @type {Probe | null | undefined} */ p) => String(p?.headers?.["content-encoding"] ?? "") || "none";

/**
 * The matrix's columns. Each reads the probes and gives a cell; `meets` says whether the cell does
 * what card-market does (the 64 KiB header: anything), `pages` marks a column that only an app
 * with pages has.
 * @type {{ key: string, label: string, pages?: boolean, cell: (o: Record<string, any>) => string, meets: (cell: string) => boolean }[]}
 */
export const features = [
  { key: "pageHeaders", label: "page security headers", pages: true, cell: (o) => securityOf(o.page), meets: (c) => c === "all" },
  { key: "pageScripts", label: "page CSP for scripts", pages: true, cell: (o) => scriptPolicyOf(o.page), meets: (c) => c === "strict" },
  { key: "permissions", label: "page Permissions-Policy", pages: true, cell: (o) => (o.page?.headers?.["permissions-policy"] ? "yes" : "no"), meets: (c) => c === "yes" },
  { key: "pageCache", label: "page Cache-Control", pages: true, cell: (o) => String(o.page?.headers?.["cache-control"] ?? "none"), meets: (c) => /private/.test(c) && /no-cache/.test(c) },
  { key: "etag", label: "page ETag, 304 when unchanged", pages: true, cell: (o) => (!(o.pageBr?.headers?.etag ?? o.page?.headers?.etag) ? "no ETag" : statusOf(o.pageAgain)), meets: (c) => c === "304" },
  { key: "pageCompression", label: "page compression (br, gzip asked)", pages: true, cell: (o) => encodingOf(o.pageBr), meets: (c) => c === "br" || c === "gzip" },
  { key: "crossSite", label: "form posted from another site", pages: true, cell: (o) => statusOf(o.crossSite), meets: (c) => /^4\d\d$/.test(c) },
  { key: "bigBody", label: "form with a 3 MiB body", pages: true, cell: (o) => statusOf(o.bigBody), meets: (c) => c === "413" },
  { key: "page404", label: "missing page", pages: true, cell: (o) => errorOf(o.page404), meets: (c) => c === "404 html" },
  { key: "jsonHeaders", label: "JSON security headers", cell: (o) => securityOf(o.json), meets: (c) => c === "all" },
  { key: "jsonCache", label: "JSON Cache-Control", cell: (o) => String(o.json?.headers?.["cache-control"] ?? "none"), meets: (c) => /private/.test(c) && /no-cache/.test(c) },
  { key: "jsonCompression", label: "JSON compression (br, gzip asked; gzip asked)", cell: (o) => encodingOf(o.jsonBr) + "; " + encodingOf(o.jsonGzip), meets: (c) => /^(br|gzip); gzip$/.test(c) },
  { key: "json404", label: "missing item JSON", cell: (o) => errorOf(o.json404) + (o.json404?.status && securityOf(o.json404) !== "all" ? ", headers " + securityOf(o.json404) : ""), meets: (c) => c === "404 problem+json" },
  { key: "json405", label: "wrong method", cell: (o) => errorOf(o.json405), meets: (c) => c === "405 problem+json" },
  { key: "head", label: "HEAD", cell: (o) => statusOf(o.head) + (o.head?.body?.length ? " with a body" : ""), meets: (c) => c === "200" },
  { key: "host", label: "unknown Host", cell: (o) => statusOf(o.badHost), meets: (c) => /^4\d\d$/.test(c) },
  { key: "bigHead", label: "64 KiB request header", cell: (o) => statusOf(o.bigHead), meets: () => true },
  { key: "health", label: "health live, ready", cell: (o) => statusOf(o.live) + ", " + statusOf(o.ready), meets: (c) => c === "200, 200" },
  { key: "readyDown", label: "ready, item API hung", cell: (o) => statusOf(o.readyDown) + (o.readyDown?.status ? " in " + (o.readyDown.ms / 1000).toFixed(1) + " s" : ""), meets: (c) => /^503 in ([0-9]|1[0-5])\.\d s$/.test(c) },
  { key: "deadline", label: "item API hung: answer", cell: (o) => statusOf(o.slow) + (o.slow?.status ? " in " + (o.slow.ms / 1000).toFixed(1) + " s" : ""), meets: (c) => /^503 in (9|10|11)\.\d s$/.test(c) },
];

/**
 * One app's row: each column's cell, and `unmet`, the columns that differ from card-market's
 * (a page column is not counted for an app without pages).
 * @param {Record<string, any>} o the probes, and `pages`
 */
export const rowOf = (o) => {
  /** @type {Record<string, string | string[]>} */
  const row = {};
  const unmet = [];
  for (const f of features) {
    if (f.pages && !o.pages) { row[f.key] = "n/a"; continue; }
    const cell = f.cell(o);
    row[f.key] = cell;
    if (!f.meets(cell)) unmet.push(f.key);
  }
  row.unmet = unmet;
  return row;
};
