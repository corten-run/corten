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
import { BindingLinkObserver, observeFormConstruction } from "./binding-links.mjs";
import { checkBindingEffects } from "./binding-effects.mjs";
import { discoverReactEndpoint, replayBindingProof } from "./bindings.mjs";
import { nativeForm } from "./observe.mjs";
import { requiredBindingIdentities } from "./binding-intrinsics.mjs";

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

test("native FormData absence inventory includes synchronous property, ancestor and window callbacks", { timeout: 30000 }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const mode of ["absent", "form property", "form attribute", "ancestor", "document", "window"]) await t.test(mode, async () => {
      const context = await browser.newContext(), page = await context.newPage();
      try {
        await page.setContent('<article><form><input name="email" value="safe"></form></article>');
        await page.evaluate((mode) => {
          globalThis.formDataCalls = 0;
          const callback = () => { globalThis.formDataCalls++; };
          if (mode === "form property") document.querySelector("form").onformdata = callback;
          if (mode === "form attribute") document.querySelector("form").setAttribute("onformdata", "globalThis.formDataCalls++");
          if (mode === "ancestor") document.querySelector("article").addEventListener("formdata", callback);
          if (mode === "document") document.addEventListener("formdata", callback);
          if (mode === "window") window.addEventListener("formdata", callback);
        }, mode);
        const cdp = await context.newCDPSession(page), group = "form-construction-control";
        try {
          const document = await cdp.send("DOM.getDocument", { depth: 0 });
          const window = (await cdp.send("Runtime.evaluate", { expression: "globalThis", objectGroup: group })).result;
          const observed = await observeFormConstruction(cdp, document.root.nodeId, window, group);
          assert.equal(observed.outcome, mode === "absent" ? "absent" : "present");
          assert.equal(await page.evaluate(() => globalThis.formDataCalls), 0, "Native listener inventory never executes callbacks");
          const calls = await page.evaluate(() => { new FormData(document.querySelector("form")); return globalThis.formDataCalls; });
          assert.equal(calls, mode === "absent" ? 0 : 1, "The native constructor invokes formdata callbacks synchronously");
        } finally { await cdp.send("Runtime.releaseObjectGroup", { objectGroup: group }); await cdp.detach(); }
      } finally { await context.close(); }
    });
  } finally { await browser.close(); }
});

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
          const props = { record, locale: "fr-FR", query: { seller: "", sort: "asc", allOffers: false }, message: "" }, tree = Marketplace(props);
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
          const missingIntrinsics = structuredClone(discovered); missingIntrinsics.bindingProof.links.intrinsicIdentities = [];
          assert.equal(replayBindingProof(missingIntrinsics, artifact), false, "Deleting the native identity evidence must invalidate replay");
          const movedRealm = structuredClone(discovered);
          movedRealm.bindingProof.links.scripts.forEach((s) => { s.executionContextId += 1000; });
          assert.equal(replayBindingProof(movedRealm, artifact), false, "Executed script realm cannot be relabeled");
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

test("linked native transport and array allocation controls cannot borrow intrinsic identity", { timeout: 30000 }, async (t) => {
  let mode, scripts, browser;
  const requests = [], server = createServer((req, res) => {
    const script = scripts.find((s) => s.path === req.url);
    if (script) { res.setHeader("content-type", "text/javascript"); res.end(script.source); }
    else if (req.url.startsWith("/api/")) { requests.push(req.url); res.end("accepted"); }
    else { res.setHeader("content-type", "text/html"); res.end('<form action="/marketplace/fr-FR/item_2"></form>'); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await chromium.launch({ headless: true });
    for (mode of ["redirecting-fetch", "array-species", "species-accessor", "array-iterator", "ordinary"]) await t.test(mode, async () => {
      const transport = mode === "redirecting-fetch" ? 'import {fetch} from "/network.mjs";' : "";
      scripts = [
        { path: "/component.mjs", source: `${transport}import {jsx} from "/runtime.mjs";export function M({record:r,locale:l}){const [head]=r.rows;const rows=r.rows.slice(0);return jsx("form",{onSubmit:async e=>{e.preventDefault();return fetch("/api/marketplace/"+r.id+"?locale="+l,{method:"POST"});}});}` },
        { path: "/runtime.mjs", source: 'export function jsx(tag,props){return {tag,props}}' },
        { path: "/network.mjs", source: 'export function fetch(path,options){return globalThis.fetch(path.replace("item_2","item_1"),options)}' },
      ];
      requests.length = 0;
      const artifact = createBindingArtifact({ ...identity, scripts }), context = await browser.newContext(), page = await context.newPage();
      const observer = new BindingLinkObserver(await context.newCDPSession(page), artifact); await observer.enable();
      try {
        await page.goto(base);
        await page.evaluate(async (mode) => {
          const { M } = await import("/component.mjs"), props = { record: { id: "item_2", rows: [1] }, locale: "fr-FR" };
          if (mode === "array-species") Array.prototype.constructor = {
            [Symbol.species]: class extends Array { constructor(length) { super(length); document.addEventListener("submit", () => { props.record.id = "item_1"; }, { capture: true, once: true }); } },
          };
          if (mode === "species-accessor") Object.defineProperty(Array, Symbol.species, { configurable: true, get() {
            globalThis.speciesReads = (globalThis.speciesReads ?? 0) + 1;
            document.addEventListener("submit", () => { props.record.id = "item_1"; }, { capture: true, once: true }); return Array;
          } });
          if (mode === "array-iterator") {
            const original = Array.prototype[Symbol.iterator];
            Array.prototype[Symbol.iterator] = function* () {
              document.addEventListener("submit", () => { props.record.id = "item_1"; }, { capture: true, once: true });
              yield* original.call(this);
            };
          }
          const tree = M(props), form = document.querySelector("form"), handler = tree.props.onSubmit;
          form.__reactProps$control = { onSubmit: handler }; form.__reactFiber$control = { type: M, memoizedProps: props };
          form.addEventListener("submit", (event) => { globalThis.controlOutcome = handler(event); });
        }, mode);
        const speciesCount = async () => (await observer.cdp.send("Runtime.evaluate", { expression: "globalThis.speciesReads", returnByValue: true })).result.value;
        const beforeSpecies = mode === "species-accessor" ? await speciesCount() : null;
        const observed = await observer.capture("form", page.url());
        if (mode === "species-accessor") assert.equal(await speciesCount(), beforeSpecies, "Observation must not invoke the replaced allocation getter");
        const discovered = observed.outcome === "observed" ? discoverReactEndpoint([observed.candidate], observed.linked) : null;
        await page.evaluate(() => { document.querySelector("form").requestSubmit(); return globalThis.controlOutcome; });
        assert.deepEqual(requests, [`/api/marketplace/${mode === "ordinary" ? "item_2" : "item_1"}?locale=fr-FR`]);
        if (mode === "ordinary") {
          assert.equal(observed.outcome, "observed", observed.reason);
          assert.equal(discovered?.path, "/api/marketplace/item_2"); assert.equal(replayBindingProof(discovered, artifact), true);
          const mutate = (change, reason) => {
            const saved = structuredClone(discovered); change(saved.bindingProof.links); assert.equal(replayBindingProof(saved, artifact), false, reason);
          };
          mutate((links) => { links.intrinsicIdentities = []; }, "Deleting every native intrinsic identity invalidates the simple positive");
          for (const label of requiredBindingIdentities)
            mutate((links) => { links.intrinsicIdentities = links.intrinsicIdentities.filter((r) => r.label !== label); }, `Missing mandatory identity ${label}`);
          mutate((links) => { links.scripts.forEach((s) => { s.executionContextId += 1; }); }, "Relabeled native contexts");
          mutate((links) => { links.frames.forEach((f) => { f.location.columnNumber += 1; }); }, "Shifted native function locations");
          mutate((links) => { delete links.realmObjectId; }, "Missing native realm anchor");
          mutate((links) => { links.frames.find((f) => f.function === links.handler).bindings.fetch.identity = 0; }, "Wrong lexical transport identity edge");
        } else {
          assert.equal(discovered, null, `${mode} must not attest the native endpoint`);
          if (observed.outcome === "observed") assert.equal(checkBindingEffects(observed.candidate, artifact, observed.receipt).outcome, "unknown");
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

test("native dispatch evaluation rejects unmodeled option work and sparse props without executing them", { timeout: 60000 }, async (t) => {
  const cases = ["body call", "body await", "option accessor", "extra argument", "nested field", "file field", "changed form get", "dictionary iterator",
    "formdata property", "formdata ancestor", "formdata window", "formdata body", "custom control", "native form", "native body", "sparse leading", "sparse trailing", "sparse all holes", "dense"];
  let scripts, browser;
  const requests = [], server = createServer((req, res) => {
    const script = scripts.find((s) => s.path === req.url);
    if (script) { res.setHeader("content-type", "text/javascript"); res.end(script.source); }
    else if (req.url.startsWith("/api/")) { requests.push(req.url); res.end("accepted"); }
    else { res.setHeader("content-type", "text/html"); res.end('<form action="/marketplace/fr-FR/item_2"><input name="email" value="safe"><input name="target_price" value="1"></form>'); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await chromium.launch({ headless: true });
    for (const mode of cases) await t.test(mode, async () => {
      const options = mode === "body call" ? '{method:"POST",body:stop()}'
        : mode === "body await" ? '{method:"POST",body:await stop()}'
        : mode === "option accessor" ? '{method:"POST",headers:({get value(){return stop()}}).value}'
        : mode === "nested field" ? '{method:"POST",body:new URLSearchParams({email:stop()})}'
        : mode === "dictionary iterator" ? '{method:"POST",body:new URLSearchParams({email:"safe"})}'
        : ["formdata body", "native body"].includes(mode) ? '{method:"POST",body:new FormData(e.currentTarget)}'
        : ["file field", "changed form get", "custom control", "native form"].includes(mode) || mode.startsWith("formdata ") ? '{method:"POST",body:new URLSearchParams({email:String(form.get("email")??"")})}' : '{method:"POST"}';
      const prefix = mode !== "formdata body" && (["file field", "changed form get", "custom control", "native form"].includes(mode) || mode.startsWith("formdata ")) ? "const form=new FormData(e.currentTarget);" : "";
      scripts = [
        { path: "/component.mjs", source: `import {jsx} from "/runtime.mjs";const stop=()=>{globalThis.argumentCalls++;throw Error("local control stopped before dispatch")};export function M({record:r,locale:l}){const rows=r.rows.map(value=>value);return jsx("form",{onSubmit:async e=>{e.preventDefault();${prefix}return fetch("/api/marketplace/"+r.id+"?locale="+l,${options}${mode === "extra argument" ? ",stop()" : ""});}});}` },
        { path: "/runtime.mjs", source: 'export function jsx(tag,props){return {tag,props}}' },
      ];
      requests.length = 0;
      const artifact = createBindingArtifact({ ...identity, scripts }), context = await browser.newContext(), page = await context.newPage();
      const observer = new BindingLinkObserver(await context.newCDPSession(page), artifact); await observer.enable();
      try {
        await page.goto(base);
        await page.evaluate(async (mode) => {
          globalThis.argumentCalls = 0;
          if (mode === "file field") document.querySelector('[name="email"]').type = "file";
          if (mode === "changed form get") FormData.prototype.get = function () { globalThis.argumentCalls++; throw Error("local replacement stopped before dispatch"); };
          if (mode === "dictionary iterator") Object.prototype[Symbol.iterator] = function* () { globalThis.argumentCalls++; throw Error("local dictionary iterator stopped before dispatch"); };
          const formElement = document.querySelector("form"), onFormData = () => { globalThis.argumentCalls++; };
          if (["formdata property", "formdata body"].includes(mode)) formElement.onformdata = onFormData;
          if (mode === "formdata ancestor") document.body.addEventListener("formdata", onFormData);
          if (mode === "formdata window") window.addEventListener("formdata", onFormData);
          if (mode === "custom control") formElement.append(document.createElement("unknown-control"));
          const { M } = await import("/component.mjs"), rows = mode === "sparse leading" ? [, "safe"]
            : mode === "sparse trailing" ? ["safe", ,] : mode === "sparse all holes" ? new Array(2) : ["safe"];
          const props = { record: { id: "item_2", rows }, locale: "fr-FR" }, tree = M(props), form = document.querySelector("form"), handler = tree.props.onSubmit;
          form.__reactProps$control = { onSubmit: handler }; form.__reactFiber$control = { type: M, memoizedProps: props };
          form.addEventListener("submit", (event) => { globalThis.controlOutcome = handler(event).then(() => "sent", (error) => error.message); });
        }, mode);
        const observed = await observer.capture("form", page.url());
        assert.equal(await page.evaluate(() => globalThis.argumentCalls), 0, "Discovery must never execute option work or getters");
        const discovered = observed.outcome === "observed" ? discoverReactEndpoint([observed.candidate], observed.linked) : null;
        if (mode.startsWith("sparse") || ["changed form get", "dictionary iterator"].includes(mode)) assert.equal(observed.outcome, "unknown", "Unproved native array/method must be rejected before effect proof");
        else assert.equal(observed.outcome, "observed", observed.reason);
        await page.evaluate(() => { document.querySelector("form").requestSubmit(); return globalThis.controlOutcome; });
        if (["dense", "file field", "custom control", "native form", "native body"].includes(mode) || mode.startsWith("sparse") || mode.startsWith("formdata ")) {
          assert.deepEqual(requests, ["/api/marketplace/item_2?locale=fr-FR"]);
          assert.equal(await page.evaluate(() => globalThis.argumentCalls), mode.startsWith("formdata ") ? 1 : 0);
        } else {
          assert.deepEqual(requests, []);
          assert.equal(await page.evaluate(() => globalThis.argumentCalls), 1, "The actual handler stopped in argument evaluation before native dispatch");
        }
        if (!["dense", "native form", "native body"].includes(mode)) assert.equal(discovered, null);
        else { assert.equal(discovered?.path, "/api/marketplace/item_2"); assert.equal(replayBindingProof(discovered, artifact), true); }
      } finally { await observer.close(); await context.close(); }
    });
  } finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

test("native own-property and callback-receiver effects cannot attest borrowed retention", { timeout: 30000 }, async (t) => {
  const cases = [
    ["own property", 'const value=r.id;', true, false],
    ["inherited getter", 'const value=r.valueOf;', false, false],
    ["map receiver retention", 'const rows=[r].map((value,index,array)=>{cache.set("retained",array);return value.id;});', false, true],
    ["filter receiver retention", 'const rows=[r].filter((value,index,array)=>{cache.set("retained",array);return true;});', false, true],
    ["default receiver retention", 'const rows=[r].filter((value,index,array=[])=>{cache.set("retained",array);return true;});', false, true],
    ["nested receiver retention", 'const rows=[r].map((value,index,array)=>{cache.set("retained",{array});return value.id;});', false, true],
    ["map receiver read", 'const rows=["safe"].map((value,index,array)=>array.length);', true, false],
    ["filter receiver read", 'const rows=["safe"].filter((value,index,array)=>array.length);', true, false],
  ];
  let scripts, browser;
  const server = createServer((req, res) => {
    const script = scripts.find((s) => s.path === req.url);
    if (script) { res.setHeader("content-type", "text/javascript"); res.end(script.source); }
    else { res.setHeader("content-type", "text/html"); res.end('<form action="/marketplace/fr-FR/item_2"></form>'); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await chromium.launch({ headless: true });
    for (const [name, prefix, supported, retained] of cases) await t.test(name, async () => {
      scripts = [
        { path: "/component.mjs", source: `import {jsx} from "/runtime.mjs";const cache=new Map();export function M({record:r,locale:l}){${prefix}return jsx("form",{onSubmit:async e=>{e.preventDefault();return fetch("/api/marketplace/"+r.id+"?locale="+l,{method:"POST"});}});}export function saved(){return cache.get("retained");}` },
        { path: "/runtime.mjs", source: 'export function jsx(tag,props){return {tag,props}}' },
      ];
      const artifact = createBindingArtifact({ ...identity, scripts }), context = await browser.newContext(), page = await context.newPage();
      const observer = new BindingLinkObserver(await context.newCDPSession(page), artifact); await observer.enable();
      try {
        await page.goto(base);
        const actual = await page.evaluate(async (mode) => {
          const { M, saved } = await import("/component.mjs"), props = { record: { id: "item_2" }, locale: "fr-FR" };
          globalThis.getterReads = 0;
          if (mode === "inherited getter") Object.defineProperty(Object.prototype, "valueOf", { configurable: true, get() { globalThis.getterReads++; return 0; } });
          const tree = M(props), value = saved(), form = document.querySelector("form");
          form.__reactProps$control = { onSubmit: tree.props.onSubmit }; form.__reactFiber$control = { type: M, memoizedProps: props };
          return { getterReads: globalThis.getterReads, retained: value?.[0] === props.record || value?.array?.[0] === props.record };
        }, name);
        assert.equal(actual.getterReads, name === "inherited getter" ? 1 : 0);
        assert.equal(actual.retained, retained, "Native callback receives the actual traversed array, not null");
        const observed = await observer.capture("form", page.url());
        assert.equal(observed.outcome, "observed", observed.reason);
        assert.equal(await page.evaluate(() => globalThis.getterReads), actual.getterReads, "Descriptor capture never executes the inherited getter");
        const effects = checkBindingEffects(observed.candidate, artifact, observed.receipt);
        assert.equal(effects.outcome, supported ? "proved" : "unknown", effects.reason);
        const found = discoverReactEndpoint([observed.candidate], observed.linked);
        if (supported) assert.equal(found?.path, "/api/marketplace/item_2"); else assert.equal(found, null);
      } finally { await observer.close(); await context.close(); }
    });
  } finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});
