// The outline of a page's body that every app must share with Corten's: each element with its
// classes and the few attributes that change what it is, where it leads or what it sends, one per line, indented
// by depth. What a framework adds for its own use is left out, so each app keeps its usual way of
// working: a `<div>` without a class and any custom element (`<astro-island>`) stand for their
// children; scripts, templates, comments and hidden inputs are dropped, as is an element with the
// `hidden` attribute (Corten renders both sort labels and hides one); every other attribute
// (`data-*`, `hx-*`, `wire:*`, `phx-*`, ids, `on*`) is ignored, as are the state classes
// LiveView's client sets (`phx-connected`, `phx-*-loading`). Text is not part of it:
// parity.mjs compares the visible text. No side effects; outline.test.mjs tests it.

/** Attributes kept, by element. */
const kept = { a: ["href"], img: ["alt", "width", "height"], input: ["type", "name"], button: ["type", "name", "value"], form: ["method"], label: [], div: ["role", "aria-label"] };
const voids = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** Elements whose start closes an open one of these, as HTML lets an end tag be left out. */
const closes = { li: ["li"], dt: ["dt", "dd"], dd: ["dt", "dd"], tr: ["tr"], td: ["td", "th"], th: ["td", "th"] };
const dropped = /<(script|template|style|noscript)\b[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi;

/** @param {string} tag the attributes part of a start tag */
function attributes(tag) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const m of tag.matchAll(/([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

const unescape = (s) => s.replace(/&amp;|&#38;/g, "&").replace(/&quot;|&#34;/g, '"').replace(/&#x27;|&#39;/g, "'");

/**
 * The outline of the body of `html` (the whole document, or a fragment without a body).
 * @param {string} html
 * @returns {string[]}
 */
export function outline(html) {
  const start = html.search(/<body\b/i);
  let body = start < 0 ? html : html.slice(html.indexOf(">", start) + 1);
  const end = body.search(/<\/body>/i);
  if (end >= 0) body = body.slice(0, end);
  body = body.replace(dropped, "");
  /** @type {string[]} */
  const lines = [];
  /** Open elements: whether each is shown (a line of its own), and whether it is hidden. */
  /** @type {{ name: string, shown: boolean, hidden: boolean }[]} */
  const open = [];
  let depth = 0;
  let hiddenDepth = 0;
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g)) {
    const [, closing, rawName, rest] = m;
    const name = rawName.toLowerCase();
    if (closing) {
      // Close up to the matching element; HTML lets some end tags be left out.
      const at = open.map((e) => e.name).lastIndexOf(name);
      if (at < 0) continue;
      for (const e of open.splice(at)) {
        if (e.shown) depth -= 1;
        if (e.hidden) hiddenDepth -= 1;
      }
      continue;
    }
    const top = open.at(-1);
    if (top && (closes[name] ?? []).includes(top.name)) {
      open.pop();
      if (top.shown) depth -= 1;
      if (top.hidden) hiddenDepth -= 1;
    }
    const attrs = attributes(rest.replace(/\/$/, ""));
    const isVoid = voids.has(name) || /\/\s*$/.test(rest);
    const hidden = "hidden" in attrs || (name === "input" && (attrs.type ?? "").toLowerCase() === "hidden");
    const classes = (attrs.class ?? "").split(/\s+/).filter((c) => c && !c.startsWith("phx-"));
    const shown = !hidden && hiddenDepth === 0 && !(name === "div" && !classes.length && !attrs.role) && !name.includes("-");
    if (shown) {
      const extra = (kept[name] ?? []).filter((a) => a in attrs).map((a) => `${a}=${JSON.stringify(a === "method" ? attrs[a].toLowerCase() : unescape(attrs[a]))}`);
      lines.push("  ".repeat(depth) + name + classes.map((c) => "." + c).join("") + (extra.length ? ` [${extra.join(" ")}]` : ""));
    }
    if (isVoid) continue;
    open.push({ name, shown, hidden });
    if (shown) depth += 1;
    if (hidden) hiddenDepth += 1;
  }
  return lines;
}

/**
 * The first line where two outlines differ, with the lines around it, or null when they match.
 * @param {string[]} a @param {string[]} b
 */
export function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (i === a.length && i === b.length) return null;
  return { line: i + 1, expected: a.slice(Math.max(0, i - 2), i + 3), actual: b.slice(Math.max(0, i - 2), i + 3) };
}
