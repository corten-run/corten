// Every app must render the same pages as Corten: for the same items, the home page and a missing
// item, the same status, the same visible text and the same outline of elements and classes
// (outline.mjs). How each looks in a browser is look.mjs.
// Usage: node parity.mjs [apps=all] [reference=first]  (apps running on their catalog ports)
// Elements with the `hidden` attribute are not visible text (Corten renders both sort labels and
// hides one). The table rows a response carries are counted with any `<template>`'s included, so
// an app cannot send rows the page does not show (the item page's offers past the first five).
import { pageApps as apps } from "./apps.mjs";
import { firstDifference, outline } from "./outline.mjs";

const paths = [1, 2, 3, 5, 17, 99, 250, 777, 1500, 1999, 2000, 2500, 3000, 12345, 49999, "does-not-exist"].map((n) => `/items/${typeof n === "number" ? `item_${n}` : n}`).concat(["/"]);
/** Table rows in a response, a `<template>`'s included; a script's are not markup. */
const rows = (html) => (html.replace(/<script[\s\S]*?<\/script>/g, " ").match(/<tr\b/gi) ?? []).length;
const visible = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<template[\s\S]*?<\/template>/g, " ")
    .replace(/<head[\s\S]*?<\/head>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(span|p|div)\b[^>]*\shidden(?:="[^"]*")?[^>]*>[\s\S]*?<\/\1>/g, " ")
    // A tag ends at the first `>` outside a quoted attribute value (Topcoat's handlers hold `=>`).
    .replace(/<(?:"[^"]*"|'[^']*'|[^'">])*>/g, " ")
    .replace(/&amp;|&#38;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;|&#34;/g, '"').replace(/&lt;|&#60;/g, "<").replace(/&gt;|&#62;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
// Next.js 16 sends an empty error document for a page that calls notFound() and renders the
// not-found UI only after hydration (https://github.com/vercel/next.js/issues/99793), so its
// missing item is compared by status here and by look.mjs in a browser.
const clientOnly404 = new Set(["nextjs"]);
const names = Object.keys(apps).filter((n) => !process.argv[2] || process.argv[2].split(",").includes(n));
const reference = process.argv[3] ?? names[0];
const others = names.filter((n) => n !== reference);
/** Once more on a reset connection alone (Docker Desktop's port proxy drops some on a busy machine). */
const get = async (/** @type {string} */ url) => {
  try {
    return await fetch(url, { headers: { accept: "text/html" } });
  } catch (error) {
    const code = error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause ? error.cause.code : undefined;
    if (code !== "ECONNRESET" && code !== "UND_ERR_SOCKET") throw error;
    console.log(JSON.stringify({ url, retry: code }));
    return fetch(url, { headers: { accept: "text/html" } });
  }
};
let failures = 0;
for (const path of paths) {
  const pages = await Promise.all([reference, ...others].map(async (n) => {
    const res = await get(`http://localhost:${apps[n].port}${path}`);
    const html = await res.text();
    return { n, status: res.status, text: visible(html), outline: outline(html), rows: rows(html) };
  }));
  const ref = pages.find((p) => p.n === reference);
  for (const page of pages.filter((p) => others.includes(p.n))) {
    if (ref.status === 404 && clientOnly404.has(page.n) && page.status === 404 && !page.text) continue;
    if (page.status !== ref.status || page.text !== ref.text) {
      failures += 1;
      let i = 0;
      while (i < ref.text.length && ref.text[i] === page.text[i]) i += 1;
      console.log(JSON.stringify({ path, app: page.n, status: [ref.status, page.status], [reference]: ref.text.slice(Math.max(0, i - 50), i + 70), [page.n]: page.text.slice(Math.max(0, i - 50), i + 70) }));
      continue;
    }
    if (page.rows !== ref.rows) {
      failures += 1;
      console.log(JSON.stringify({ path, app: page.n, rows: [ref.rows, page.rows] }));
      continue;
    }
    const difference = firstDifference(ref.outline, page.outline);
    if (difference) {
      failures += 1;
      console.log(JSON.stringify({ path, app: page.n, outline: difference }));
    }
  }
}
console.log(JSON.stringify({ reference, compared: others, pages: paths.length, failures }));
process.exit(failures ? 1 : 0);
