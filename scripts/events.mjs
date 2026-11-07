// Holds the interface each `on:` event is typed as (crates/corten-macros/src/dom.rs, `event()`)
// to TypeScript's lib.dom: every event lib.dom types more narrowly than `Event` on an element
// (`GlobalEventHandlersEventMap`, `ElementEventMap`, `HTMLElementEventMap`) has an arm, either
// lib.dom's interface or `Event` where an element fires a plain one (an arm that dom.rs explains);
// every interface an arm names is in `EVENTS` and has a `corten::script::ev` marker
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

const failures = [];
if (lib.size < 50) failures.push(`read only ${lib.size} events from ${libDom}`);
if (ours.size < 50) failures.push(`read only ${ours.size} event names from dom.rs's event()`);
for (const [name, iface] of lib) {
  if (iface === "Event") continue;
  const mapped = ours.get(name);
  if (mapped === undefined) failures.push(`${name}: lib.dom types it ${iface}, and event() has no arm for it (it is typed Event)`);
  else if (mapped !== iface && mapped !== "Event") failures.push(`${name}: lib.dom types it ${iface}, and event() ${mapped}`);
}
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
