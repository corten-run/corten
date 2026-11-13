// Apparatus controls. These execute emitted repository modules with a test JSX
// adapter, not a compiled Next deployment or a contender qualification.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { chromium } from "@playwright/test";
import { records } from "../marketplace/fixtures.mjs";
import { createBindingArtifact, bindingHash, validateBindingArtifact } from "./binding-artifact.mjs";
import { BindingLinkObserver } from "./binding-links.mjs";
import { checkBindingEffects } from "./binding-effects.mjs";
import { discoverReactEndpoint, replayBindingProof } from "./bindings.mjs";
import { nativeForm } from "./observe.mjs";

const compilerOptions = { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
function nativeScripts(mode = "native") {
  const emit = (name) => ts.transpileModule(readFileSync(new URL(`../fullstack/apps/nextjs/lib/${name}`, import.meta.url), "utf8"), { compilerOptions }).outputText;
  const component = emit("marketplace-page.tsx").replaceAll('"react/jsx-runtime"', '"/runtime.mjs"').replaceAll('"react"', '"/runtime.mjs"').replaceAll('"./marketplace"', '"/helpers.mjs"');
  let helpers = emit("marketplace.ts").replace('"./marketplace-labels.json" with { type: "json" }', '"/labels.mjs"');
  if (mode === "renamed") helpers = helpers.replaceAll("sortedListings", "aDifferentSafeSymbol") + "\nexport {aDifferentSafeSymbol as sortedListings};\n";
  if (mode === "substituted") helpers = helpers.replace("export function sortedListings(record, query) {", 'export function sortedListings(record, query) { document.addEventListener("submit",()=>{record.id="item_1"},{capture:true,once:true});');
  return [
    { path: "/component.mjs", source: component }, { path: "/helpers.mjs", source: helpers },
    { path: "/labels.mjs", source: "export default " + readFileSync(new URL("../fullstack/apps/nextjs/lib/marketplace-labels.json", import.meta.url), "utf8") + ";" },
    { path: "/runtime.mjs", source: 'export function jsx(tag,props,key){return {tag,props,key}} export const jsxs=jsx;export const Fragment="fragment";export function useState(value){return [value,message=>{document.querySelector("p").textContent=message}];}' },
  ];
}
const identity = { imageId: `sha256:${bindingHash("test-only-native-emitter-not-an-image")}`, sourceCommit: "0".repeat(40) };

test("binding artifact commits to exact emitted bytes and identity", () => {
  const artifact = createBindingArtifact({ ...identity, scripts: nativeScripts() });
  assert.equal(validateBindingArtifact(artifact), artifact);
  const changed = structuredClone(artifact); changed.scripts[0].source += " ";
  assert.throws(() => validateBindingArtifact(changed));
  const duplicate = [...artifact.scripts, artifact.scripts[0]];
  assert.throws(() => createBindingArtifact({ ...identity, scripts: duplicate }));
});

test("linked emitted Next helpers retain the native positive and reject effectful substitution", { timeout: 30000 }, async (t) => {
  let scripts = [], browser;
  const requests = [], captures = [], server = createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      requests.push({ path: req.url, method: req.method });
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ message: "native accepted" }));
    } else if (req.url.endsWith(".mjs")) {
      const script = scripts.find((s) => s.path === req.url);
      res.setHeader("content-type", "text/javascript"); res.end(script?.source ?? "throw new Error('missing module')");
    } else { res.setHeader("content-type", "text/html"); res.end('<section class="marketplace__alert"><form action="/marketplace/fr-FR/item_2"><input name="email" value="native@example.test"><input name="target_price" value="1,25"></form><p></p></section>'); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await chromium.launch({ headless: true });
    for (const mode of ["native", "renamed", "substituted"]) await t.test(mode, async () => {
      scripts = nativeScripts(mode); requests.length = 0;
      const artifact = createBindingArtifact({ ...identity, scripts }), context = await browser.newContext(), page = await context.newPage();
      const cdp = await context.newCDPSession(page), observer = new BindingLinkObserver(cdp, artifact); await observer.enable();
      try {
        await page.goto(base);
        await page.evaluate(async (record) => {
          const { Marketplace } = await import("/component.mjs");
          const props = { record, locale: "fr-FR", query: { seller: "", sort: "asc", allOffers: false } }, tree = Marketplace(props);
          const find = (node) => !node || typeof node !== "object" ? null : node.tag === "form" && node.props.onSubmit ? node.props.onSubmit
            : Array.isArray(node) ? node.map(find).find(Boolean) : find(node.props?.children);
          const form = document.querySelector("form"), handler = find(tree);
          form.__reactProps$control = { onSubmit: handler }; form.__reactFiber$control = { type: Marketplace, memoizedProps: props };
          form.addEventListener("submit", (event) => { globalThis.controlOutcome = handler(event); });
        }, records().item_2);
        const observed = await observer.capture("form", page.url());
        assert.equal(observed.outcome, "observed", observed.reason);
        captures.push(observed);
        const proof = checkBindingEffects(observed.candidate, artifact, observed.receipt);
        const discovered = discoverReactEndpoint([observed.candidate], observed.linked);
        await page.evaluate(() => { document.querySelector("form").requestSubmit(); return globalThis.controlOutcome; });
        assert.deepEqual(requests, [{ path: `/api/marketplace/${mode === "substituted" ? "item_1" : "item_2"}?locale=fr-FR`, method: "POST" }]);
        assert.equal(await page.locator("p").textContent(), "native accepted");
        assert.equal(proof.outcome, mode === "substituted" ? "unknown" : "proved", proof.reason);
        if (mode === "substituted") assert.equal(discovered, null);
        else {
          assert.equal(discovered?.path, "/api/marketplace/item_2", "Actual emitted Next handler requires successful linked discovery, not just effect checking");
          assert.equal(replayBindingProof(discovered, artifact), true);
          const altered = structuredClone(discovered);
          altered.bindingProof.links.frames.find((f) => f.function === altered.bindingProof.links.component).location.columnNumber += 100000;
          assert.equal(replayBindingProof(altered, artifact), false, "Moved native location cannot reuse a positive proof");
          const changed = structuredClone(artifact); changed.scripts.find((s) => s.path === "/helpers.mjs").source += " ";
          assert.equal(replayBindingProof(discovered, changed), false, "Changed emitted bytes cannot replay a positive proof");
          const unrelated = structuredClone(observed.receipt); unrelated.handler = unrelated.component;
          assert.equal(checkBindingEffects(observed.candidate, artifact, unrelated).outcome, "unknown", "Another callable cannot replace the mounted handler link");
        }
        if (mode === "substituted") assert.equal(observed.candidate.componentSource, captures[0].candidate.componentSource);
        if (mode === "native") {
          const form = await nativeForm(page, { form: { method: "POST", action: "/marketplace/fr-FR/item_2", fields: ["email", "target_price"] } }, "nextjs", true, cdp);
          assert.equal(form.bindingObservation.outcome, "proved", form.bindingObservation.reason);
          assert.equal(replayBindingProof(form.enhancement, artifact), true, "Production nativeForm integration must preserve the linked positive");
        }
      } finally { await observer.close(); await context.close(); }
    });
  } finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

test("linked whole-render effects reject sibling, initializer and callback retention", { timeout: 30000 }, async (t) => {
  const form = 'jsx("form",{onSubmit:submit})';
  const cases = [
    ["earlier sibling", `return jsx("article",{children:[retain(r),${form}]});`],
    ["later sibling", `return jsx("article",{children:[${form},retain(r)]});`],
    ["ancestor prop", `return jsx("article",{effect:retain(r),children:${form}});`],
    ["form prop", 'return jsx("form",{effect:retain(r),onSubmit:submit});'],
    ["initializer", `const retained=retain(r);return ${form};`],
    ["callback", `const rendered=[r].map(value=>retain(value));return ${form};`],
  ];
  let scripts, browser;
  const requests = [], server = createServer((req, res) => {
    const script = scripts.find((s) => s.path === req.url);
    if (script) { res.setHeader("content-type", "text/javascript"); res.end(script.source); }
    else if (req.url.startsWith("/api/")) { requests.push(req.url); res.end("accepted"); }
    else { res.setHeader("content-type", "text/html"); res.end('<form action="/marketplace/fr-FR/item_2"></form>'); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await chromium.launch({ headless: true });
    for (const [name, body] of cases) await t.test(name, async () => {
      scripts = [
        { path: "/component.mjs", source: `import {jsx,retain} from "/helper.mjs";export function M({record:r,locale:l}){const submit=async e=>{e.preventDefault();return fetch("/api/marketplace/"+r.id+"?locale="+l,{method:"POST"});};${body}}` },
        { path: "/helper.mjs", source: 'export function jsx(tag,props){return {tag,props}}export function retain(value){document.addEventListener("submit",()=>{value.id="item_1"},{capture:true,once:true});return null;}' },
      ];
      requests.length = 0;
      const artifact = createBindingArtifact({ ...identity, scripts }), context = await browser.newContext(), page = await context.newPage();
      const observer = new BindingLinkObserver(await context.newCDPSession(page), artifact); await observer.enable();
      try {
        await page.goto(base);
        await page.evaluate(async () => {
          const { M } = await import("/component.mjs"), props = { record: { id: "item_2" }, locale: "fr-FR" }, tree = M(props);
          const find = (node) => !node || typeof node !== "object" ? null : node.tag === "form" ? node.props.onSubmit
            : Array.isArray(node) ? node.map(find).find(Boolean) : find(node.props?.children);
          const handler = find(tree), form = document.querySelector("form");
          form.__reactProps$control = { onSubmit: handler }; form.__reactFiber$control = { type: M, memoizedProps: props };
          form.addEventListener("submit", (event) => { globalThis.controlOutcome = handler(event); });
        });
        const observed = await observer.capture("form", page.url());
        assert.equal(observed.outcome, "observed", observed.reason);
        const proof = checkBindingEffects(observed.candidate, artifact, observed.receipt);
        await page.evaluate(() => { document.querySelector("form").requestSubmit(); return globalThis.controlOutcome; });
        assert.deepEqual(requests, ["/api/marketplace/item_1?locale=fr-FR"]);
        assert.equal(proof.outcome, "unknown");
        assert.equal(discoverReactEndpoint([observed.candidate], observed.linked), null);
      } finally { await observer.close(); await context.close(); }
    });
  } finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});
