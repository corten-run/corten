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

/**
 * What a page's CSP allows a script to be: "strict" when only listed scripts run (no inline script
 * without a nonce or hash, no eval, no wildcard host or whole scheme), else what it lets through, or no CSP.
 */
export const scriptPolicyOf = (/** @type {Probe | null | undefined} */ p) => {
  const csp = String(p?.headers?.["content-security-policy"] ?? "");
  if (!csp) return "no CSP";
  // Only the first policy is read; none of the bench apps sends two.
  const directive = /(?:^|;)\s*script-src\s+([^;]*)/i.exec(csp)?.[1] ?? /(?:^|;)\s*default-src\s+([^;]*)/i.exec(csp)?.[1];
  if (directive === undefined) return "scripts unrestricted";
  const sources = directive.trim().split(/\s+/);
  if (sources.some((s) => s.includes("*") || /^[a-z][a-z0-9+.-]*:$/i.test(s))) return "any host or scheme";
  if (sources.includes("'unsafe-eval'")) return "eval allowed";
  return sources.includes("'unsafe-inline'") && !sources.some((s) => /^'(nonce|sha\d+)-/.test(s)) ? "inline allowed" : "strict";
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
/** Kept from shared caches (RFC 9111: `private` or `no-store`, and not `public`); `no-cache` alone lets a shared cache store it. */
const notShared = (/** @type {string} */ c) => /\b(private|no-store)\b/.test(c) && !/\bpublic\b/.test(c);
/**
 * A redirect that reports a failure: Leptos answers a server function called from a form without
 * its script with a 302 back to the page and the error in a `serverfnerror` header.
 */
const failedRedirect = (/** @type {Probe | null | undefined} */ p) => !!p?.status && p.status >= 300 && p.status < 400 && p.headers?.serverfnerror !== undefined;
/** A post the app took: a 2xx or a redirect that reports no failure. */
const took = (/** @type {Probe | null | undefined} */ p) => !!p?.status && p.status < 400 && !failedRedirect(p);
const postStatusOf = (/** @type {Probe | null | undefined} */ p) => statusOf(p) + (failedRedirect(p) ? " serverfnerror" : "");
/**
 * A form column's cell: why the form was not probed, or, when the page's own post (normal size,
 * same origin, its cookies) was not taken, why a refusal here says nothing, or this post's status.
 */
const formCell = (/** @type {Record<string, any>} */ o, /** @type {Probe | null | undefined} */ p) =>
  o.form ?? (o.ownPost && !took(o.ownPost) ? "n/a: its own post answered " + postStatusOf(o.ownPost) : postStatusOf(p));
/** The 3 MiB post's cell, and whether the app still served the page after it (a crash is not a refusal). */
const bigCell = (/** @type {Record<string, any>} */ o) => {
  const c = formCell(o, o.bigBody);
  return c.startsWith("n/a") || !o.afterBig || o.afterBig.status === 200 ? c : c + ", then the page " + statusOf(o.afterBig);
};
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
 * column for an app whose form its framework's script sends (no form post to probe) or that
 * refused the page's own post.
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
  // Refused is not taken: a 4xx, a 5xx or a redirect that reports a failure, counted only when the app took its own post.
  { key: "crossSite", label: "form posted from another site refused", pages: true, cell: (o) => formCell(o, o.crossSite), meets: (c) => /^([45]\d\d|3\d\d serverfnerror)$/.test(c) },
  // Or the connection closed while the body was still being sent: the app would not read it (its
  // answer, if it wrote one first, is lost when the close resets the connection).
  { key: "bigBody", label: "form with a 3 MiB field refused", pages: true, cell: bigCell, meets: (c) => /^([45]\d\d|3\d\d serverfnerror)$/.test(c) || /^error (EPIPE|ECONNRESET)$/.test(c) },
  { key: "page404", label: "missing page", pages: true, cell: (o) => errorOf(o.page404), meets: (c) => c === "404 html" },
  { key: "jsonHeaders", label: "JSON security headers", cell: (o) => securityOf(o.json), meets: (c) => c === "all" },
  { key: "jsonCache", label: "JSON kept from shared caches", cell: (o) => String(o.json?.headers?.["cache-control"] ?? "none"), meets: notShared },
  { key: "jsonCompression", label: "JSON compressed (br, gzip asked; gzip asked)", cell: (o) => encodingOf(o.jsonBr) + "; " + encodingOf(o.jsonGzip), meets: (c) => /^(br|gzip); gzip$/.test(c) },
  { key: "json404", label: "missing item JSON", cell: (o) => errorOf(o.json404), meets: (c) => c === "404 problem+json" || c === "404 json" },
  { key: "json405", label: "wrong method on the JSON", cell: (o) => errorOf(o.json405), meets: (c) => c === "405 problem+json" || c === "405 json" },
  { key: "head", label: "HEAD on the JSON", cell: (o) => statusOf(o.head), meets: (c) => c === "200" },
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
const has = (/** @type {string} */ tag, /** @type {string} */ name) => new RegExp("\\s" + name.replace(/[.:$]/g, "\\$&") + "(\\s|=|>|/|\\.)", "i").test(tag);

/**
 * The page's price-alert form: its first form that posts. An HTTP form gives the path it posts to
 * (resolved against the page's), its encoding and fields (a hidden field's value as given, the
 * others filled in, unchecked boxes and disabled fields left out as a browser leaves them); a form
 * its framework's script sends instead (Livewire's wire:submit, a JSON request to its update
 * endpoint; LiveView's phx-submit, over its websocket) gives `script`. Null when the page has no
 * form that posts.
 * @param {string} html
 * @param {string} pagePath
 */
export const formOf = (html, pagePath) => {
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const tag = "<form " + m[1] + ">";
    if (String(attr(tag, "method") ?? "get").toLowerCase() !== "post") continue;
    if (has(tag, "wire:submit") || has(tag, "phx-submit")) return { script: has(tag, "wire:submit") ? "wire:submit" : "phx-submit" };
    const url = new URL(attr(tag, "action") || pagePath, "http://app" + pagePath);
    /** @type {{ name: string, value: string, hidden: boolean }[]} */
    const fields = [];
    for (const f of m[2].matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>|<(input|textarea)\b([^>]*)>/gi)) {
      const isSelect = f[3] === undefined;
      const t = "<x " + (isSelect ? f[1] : f[4]) + ">";
      const name = attr(t, "name");
      const type = isSelect ? "select" : f[3].toLowerCase() === "input" ? String(attr(t, "type") ?? "text").toLowerCase() : "textarea";
      if (!name || has(t, "disabled") || ["submit", "button", "reset", "file", "image"].includes(type)) continue;
      if ((type === "checkbox" || type === "radio") && !has(t, "checked")) continue;
      const hidden = type === "hidden";
      const options = [...(isSelect ? f[2] : "").matchAll(/<option\b([^>]*)>([^<]*)/gi)].map((o) => ({ tag: "<x " + o[1] + ">", text: o[2].trim() }));
      const option = options.find((o) => has(o.tag, "selected")) ?? options[0];
      const value = hidden || type === "checkbox" || type === "radio" ? attr(t, "value") ?? (hidden ? "" : "on")
        : type === "select" ? (option ? attr(option.tag, "value") ?? option.text : "")
        : type === "email" || /mail/i.test(name) ? "a@example.com" : type === "number" || /price|amount/i.test(name) ? "1" : "a";
      fields.push({ name, value, hidden: hidden || type === "select" || type === "checkbox" || type === "radio" });
    }
    return { path: url.pathname + url.search, multipart: /multipart/i.test(attr(tag, "enctype") ?? ""), fields };
  }
  return null;
};

/**
 * The form's body as a browser would send it, with its first field the visitor types in (not
 * hidden, a box or a choice) set to `big` when given. Returns the body and its Content-Type.
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
