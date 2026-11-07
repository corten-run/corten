// Holds the interface each `on:` event is typed as (crates/corten-macros/src/dom.rs, `event()`)
// to TypeScript's lib.dom both ways: every event lib.dom types more narrowly than `Event` on an
// element (`GlobalEventHandlersEventMap`, `ElementEventMap`, `HTMLElementEventMap`) has an arm with
// lib.dom's interface, or is one of `plain` below, which an element fires as an `Event`; no arm
// names an interface for an event lib.dom types otherwise (the runtime's own `corten:` names
// aside); and every interface an arm names is in `EVENTS` and has a `corten::script::ev` marker
// (crates/corten/src/script.rs). Run by npm run check.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const read = (/** @type {string} */ path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const dom = read("crates/corten-macros/src/dom.rs");
const markers = read("crates/corten/src/script.rs");

/** lib.dom's event maps, read with TypeScript's parser: event name to interface. */
const libDom = createRequire(import.meta.url).resolve("typescript/lib/lib.dom.d.ts");
const file = ts.createSourceFile(libDom, readFileSync(libDom, "utf8"), ts.ScriptTarget.Latest);
/** @type {Map<string, string>} */
const lib = new Map();
for (const statement of file.statements) {
  if (!ts.isInterfaceDeclaration(statement)) continue;
  if (!["GlobalEventHandlersEventMap", "ElementEventMap", "HTMLElementEventMap"].includes(statement.name.text)) continue;
  for (const member of statement.members) {
    if (!ts.isPropertySignature(member) || !member.type || !ts.isTypeReferenceNode(member.type)) continue;
    if (!ts.isStringLiteral(/** @type {ts.Node} */ (member.name))) continue;
    lib.set(/** @type {ts.StringLiteral} */ (member.name).text, member.type.typeName.getText(file));
  }
}

/** dom.rs's `event()`: each name an arm lists, to the interface it returns. */
const body = dom.slice(dom.indexOf("pub fn event(name: &str)"), dom.indexOf("pub fn is_runtime_event"));
/** @type {Map<string, string>} */
const ours = new Map();
for (const [, names, iface] of body.matchAll(/((?:\|?\s*"[^"]+"\s*)+)=>\s*\{?\s*"(\w+)"/g)) {
  for (const [, name] of names.matchAll(/"([^"]+)"/g)) ours.set(name, iface);
}
const listed = new Set([...dom.slice(dom.indexOf("pub const EVENTS")).matchAll(/^\s*"(\w+)",$/gm)].map(([, n]) => n));
const marked = new Set([...markers.matchAll(/^\s*events!\((\w+):/gm)].map(([, n]) => n));

/**
 * Events lib.dom types as the window's (`ErrorEvent`, `UIEvent`) or as XMLHttpRequest's
 * (`ProgressEvent`), which an image, media or other element fires as a plain `Event`: dom.rs's
 * `Event` arm for them says so. Probed for `error` (an image's, a video's), `abort` and
 * `progress`; `resize` is a media element's, an `Event` in the HTML standard's event table.
 */
const plain = new Set(["error", "abort", "progress", "resize"]);
const failures = [];
if (lib.size < 50) failures.push(`read only ${lib.size} events from ${libDom}`);
if (ours.size < 50) failures.push(`read only ${ours.size} event names from dom.rs's event()`);
for (const [name, iface] of lib) {
  if (iface === "Event") continue;
  const mapped = ours.get(name) ?? "Event";
  if (plain.has(name)) {
    if (mapped !== "Event") failures.push(`${name}: an element fires it as a plain Event, and event() types it ${mapped}`);
  } else if (mapped !== iface) failures.push(`${name}: lib.dom types it ${iface}, and event() ${ours.has(name) ? mapped : "has no arm for it (it is typed Event)"}`);
}
for (const [name, mapped] of ours) {
  if (mapped === "Event" || name.startsWith("corten:")) continue;
  const iface = lib.get(name) ?? "Event";
  if (iface !== mapped) failures.push(`${name}: event() types it ${mapped}, and lib.dom ${iface}, so a handler for what the browser does not send would compile`);
}
for (const name of plain) if (ours.get(name) !== "Event") failures.push(`${name}: event() needs its explicit Event arm`);
for (const iface of new Set(ours.values())) {
  if (!listed.has(iface)) failures.push(`${iface}: event() returns it, and EVENTS does not list it`);
}
for (const iface of listed) {
  if (!marked.has(iface)) failures.push(`${iface}: EVENTS lists it, and corten::script::ev has no marker for it`);
}
for (const iface of marked) {
  if (!listed.has(iface)) failures.push(`${iface}: corten::script::ev has a marker for it, and EVENTS does not list it`);
}
for (const failure of failures) console.error(`events: ${failure}`);
const narrow = [...lib.values()].filter((i) => i !== "Event").length;
console.log(`events: ${narrow} lib.dom events typed narrower than Event, ${listed.size} interfaces, ${failures.length} problems`);
process.exit(failures.length ? 1 : 0);
