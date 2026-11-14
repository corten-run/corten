// Bounded apparatus controls only, not contender captures or parity evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { chromium } from "@playwright/test";
import { installResourceObserver, ResourceAudit } from "./resources.mjs";
import { discoverReactEndpoint, reactHandlerSources } from "./bindings.mjs";
import { createUpstream, UpstreamAudit, reconcileUpstream } from "./upstream.mjs";
import { PlatformLifecycle, validatePlatformRetirement } from "./lifecycle.mjs";
import { nativeDOM } from "./observe.mjs";
import { runJourney } from "./journey.mjs";
import { projectCase } from "./capture.mjs";
import { settings } from "./contract.mjs";
import { createBrowserPlan } from "../workloads/browser.mjs";
import { records } from "../marketplace/fixtures.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }

test("row7: suppressed abort delivery cannot leave a stale once wrapper", { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const audited of [false, true]) {
      const context = await browser.newContext();
      try {
        if (audited) await context.addInitScript(installResourceObserver);
        const page = await context.newPage(); await page.goto('data:text/html,<article class="marketplace"><button>Probe</button></article>');
        for (const capture of [false, true]) for (const once of [true, false]) {
          const observed = await page.evaluate(({ capture, once }) => {
            const button = document.querySelector("button"), controller = new AbortController(); let calls = 0;
            const callback = () => { calls++; };
            controller.signal.onabort = (event) => event.stopImmediatePropagation();
            button.addEventListener("probe", callback, { signal: controller.signal, once, capture });
            controller.abort();
            const aborted = globalThis.__fullstackBrowserAudit?.checkpoint();
            button.addEventListener("probe", callback, { capture });
            button.dispatchEvent(new Event("probe")); button.dispatchEvent(new Event("probe"));
            const live = globalThis.__fullstackBrowserAudit?.checkpoint();
            button.removeEventListener("probe", callback, capture);
            const removed = globalThis.__fullstackBrowserAudit?.checkpoint();
            const count = (s) => s?.scopes.find((r) => r.scope === s.scope).owned.listeners;
            return { calls, aborted: count(aborted), live: count(live), removed: count(removed), unattributed: live?.unattributed.listeners };
          }, { capture, once });
          assert.equal(observed.calls, 2, JSON.stringify({ audited, capture, once, observed }));
          if (audited) assert.deepEqual(observed, { calls: 2, aborted: 0, live: 1, removed: 0, unattributed: 0 });
        }
        const synthetic = await page.evaluate(() => {
          const target = document.querySelector("button"), controller = new AbortController(); let calls = 0;
          const callback = () => calls++;
          target.addEventListener("probe", callback, { signal: controller.signal });
          controller.signal.dispatchEvent(new Event("abort"));
          const snapshot = globalThis.__fullstackBrowserAudit?.checkpoint();
          target.dispatchEvent(new Event("probe")); controller.abort(); target.dispatchEvent(new Event("probe"));
          return { calls, live: snapshot?.scopes.find((s) => s.scope === snapshot.scope).owned.listeners };
        });
        assert.equal(synthetic.calls, 1);
        if (audited) assert.equal(synthetic.live, 1, "A synthetic abort event is not native signal cancellation");
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});

test("row7: all eleven API actions require successful requested-record reads", { timeout: 30000 }, async () => {
  const upstream = createUpstream(records()), source = await listen(upstream);
  const profile = createBrowserPlan({ records: records() }).cases.find((p) => p.source === "api" && !p.js);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    try {
      const page = await context.newPage(); await page.goto(source + "/__browser/counters");
      for (const mode of ["requested", "missing-only", "wrong-record"]) {
        const audit = new UpstreamAudit(async () => (await context.request.get(source + "/__browser/counters")).json());
        await audit.start(); const steps = [];
        for (const phase of ["initial-store", ...profile.steps.map((s) => s.id), "mutation-probes", "cleanup"]) {
          const receipt = await audit.begin(phase), action = profile.steps.find((s) => s.id === phase);
          if (action) {
            const id = mode === "missing-only" ? "item_missing" : mode === "wrong-record" ? (action.itemId === "item_1" ? "item_2" : "item_1") : action.itemId;
            const status = await page.evaluate(async (url) => { const response = await fetch(url); await response.arrayBuffer(); return response.status; }, source + "/marketplace/records/" + id);
            assert.equal(status, id === "item_missing" ? 404 : 200);
            steps.push({ action, requests: [{ id: action.id, path: action.path, method: "GET", transport: "document", completed: true, failure: null, status: action.kind === "missing" ? 404 : 200 }] });
          }
          await audit.end(receipt);
        }
        await audit.finish();
        const original = JSON.stringify(audit.ledger), options = { source: "api", actions: profile.steps.map((s) => s.id), steps };
        const proof = reconcileUpstream(audit.ledger, options);
        assert.equal(proof.outcome, mode === "requested" ? "reconciled" : "unknown", `${mode}: ${JSON.stringify(proof.reasons)}`);
        assert.equal(proof.final.completed, 11, "Failure classification must preserve all native finish receipts");
        if (mode !== "requested") assert.equal(proof.reasons.length, 10, "Only the missing-record action is exempt from successful-record reads");
        if (mode !== "requested") {
          // Hostile projection scaffold, deliberately not a native capture.
          const evidence = { upstreamLedger: audit.ledger, upstreamReconciliation: { outcome: "reconciled" }, steps,
            requestLedger: steps.flatMap((s) => s.requests), nativeCleanup: { requests: [], probe: { requests: [] } }, networkFailures: [], runtimeErrors: [],
            functionalChecksPassed: true, failures: [], gaps: [] };
          assert.throws(() => projectCase({ evidence }, profile, "nuxt", { ...settings, cleanupObservationMs: 0 }), /Successful request-time upstream read/);
        }
        assert.equal(JSON.stringify(audit.ledger), original);
        if (mode === "missing-only") assert.ok(audit.ledger.terminal.snapshot.events.slice(-11).every((e) => e.status === 404 && e.completed !== null));
      }
    } finally { await context.close(); }
  } finally { if (browser) await browser.close(); await close(upstream); }
});

test("row7: real journey retains failed upstream reads instead of accepting their completion", { timeout: 30000 }, async () => {
  const upstream = createUpstream(records()), source = await listen(upstream); let mode = "requested", browser;
  const app = createServer(async (req, res) => {
    if (req.url === "/api/alerts") { res.setHeader("content-type", "application/json"); res.end("[]"); return; }
    if (req.url.startsWith("/marketplace/")) await (await fetch(source + "/marketplace/records/" + (mode === "requested" ? "item_1" : "item_missing"))).arrayBuffer();
    res.setHeader("content-type", "text/html");
    res.end('<header><a href="/">Away</a></header><article class="marketplace"><h1>Deliberately incomplete apparatus</h1><div class="marketplace__alert"><form method="post" action="/marketplace/en-US/item_1"><input name="email"><input name="target_price"><button>Submit</button></form></div></article>');
  });
  try {
    const base = await listen(app); browser = await chromium.launch({ headless: true });
    for (mode of ["requested", "missing-only"]) {
      const result = await runJourney({ browser, app: "nuxt", base, records: records(), readback: { path: "/api/alerts" },
        counters: async () => (await fetch(source + "/__browser/counters")).json(),
        profile: { key: "row7-apparatus", device: "desktop", js: false, source: "api", locale: "en-US",
          steps: [{ id: "arrival", kind: "initial", path: "/marketplace/en-US/item_1", itemId: "item_1", query: {} }] } });
      assert.equal(result.outcome, "failed", "Incomplete apparatus must never qualify native semantics");
      const row = result.evidence.steps[0];
      assert.equal(row.upstream.completed, 1); assert.equal(row.upstream.events[0].status, mode === "requested" ? 200 : 404);
      assert.equal(row.failures.some((f) => f.includes("Successful request-time upstream read")), mode !== "requested");
      assert.equal(result.evidence.upstreamReconciliation.outcome, mode === "requested" ? "reconciled" : "unknown");
      assert.equal(result.evidence.cleanup.contextClosed, true);
    }
  } finally { if (browser) await browser.close(); await close(app); await close(upstream); }
});

test("row7: React endpoint discovery rejects unsupported lexical and control flow", { timeout: 30000 }, async (t) => {
  const base = "http://local", endpoint = '"/api/marketplace/"+r.id+"?locale="+l';
  const candidate = (handlerSource, prefix = "") => ({ handlerSource,
    componentSource: `function M({record:r,locale:l}){${prefix}const submit=${handlerSource};return null}`,
    recordId: "item_2", locale: "fr-FR", action: base + "/marketplace/fr-FR/item_2", base, basis: "mounted-react-onSubmit-and-owning-fiber-props" });
  assert.equal(discoverReactEndpoint([candidate(`async e=>fetch(${endpoint},{method:"POST"})`)]).path, "/api/marketplace/item_2");
  assert.equal(discoverReactEndpoint([candidate(`async e=>fetch(${endpoint},{method:"POST"})`, ";;const unused=[];")])?.path,
    "/api/marketplace/item_2", "Empty statements and unrelated declarations are supported");
  assert.equal(discoverReactEndpoint([candidate(`async e=>fetch(${endpoint},{method:"POST"})`, 'const rows=[{id:"other"}];const view=rows.map(r=>r.id);')])?.path,
    "/api/marketplace/item_2", "An unrelated nested callback cannot shadow the mounted handler's props");
  assert.equal(discoverReactEndpoint([candidate(`async e=>fetch(${endpoint},{method:"POST"})`, 'const rows=[{id:"other"}];const view=rows.map(r=>{const alias=r;return alias.id;});')])?.path,
    "/api/marketplace/item_2", "An alias of an unrelated callback parameter is not an escape of the component prop");
  assert.equal(discoverReactEndpoint([candidate(`async e=>fetch(${endpoint},{method:"POST"})`, 'const id=r.id;const other=r.id;')])?.path,
    "/api/marketplace/item_2", "Pure property reads are not receiver invocations");
  assert.equal(discoverReactEndpoint([candidate(`async e=>fetch(${endpoint},{method:"POST"})`, 'const title=r.title;')]),
    null, "A missing-own field is not a proved pure property read");
  assert.equal(discoverReactEndpoint([candidate(`async e=>{const unused="safe";return fetch(${endpoint},{method:"POST"})}`, 'const rows=[{id:"other"}];const view=rows.map(submit=>submit.id);')])?.path,
    "/api/marketplace/item_2", "Pure prefix declarations and unrelated handler-name shadows are supported");
  assert.equal(discoverReactEndpoint([candidate(`async e=>{let unused="safe";e.preventDefault();return fetch(${endpoint},{method:"POST"})}`)])?.path,
    "/api/marketplace/item_2", "Ordinary let declarations preserve the native event binding");
  for (const [name, returned, prefix = "", supported = false] of [
    ["JSX form constructor", '_jsx("form",{onSubmit:submit})', 'const _jsx=(tag,props)=>({tag,props});', true],
    ["nested JSX host constructors", '_jsxs("article",{children:[_jsx("form",{onSubmit:submit})]})', 'const _jsx=(tag,props)=>({tag,props});const _jsxs=_jsx;', true],
    ["terminal props factory", 'retain(r,{onSubmit:submit})'],
    ["nested props factory", '_jsx("article",{children:retain(r,{onSubmit:submit})})'],
    ["factory around JSX form", 'retain(r,_jsx("form",{onSubmit:submit}))'],
    ["bare props object", '{onSubmit:submit}'],
    ["unknown render constructor", 'render("form",{onSubmit:submit})'],
    ["JSX constructor extra factory argument", '_jsx("form",{onSubmit:submit},retain(r))'],
    ["JSX props spread", '_jsx("form",{...props,onSubmit:submit})'],
    ["JSX computed prop", '_jsx("form",{[key]:value,onSubmit:submit})'],
    ["JSX duplicate prop", '_jsx("form",{onSubmit:submit,onSubmit:submit})'],
    ["component-supplied JSX constructor", '_jsx("form",{onSubmit:submit})', 'const _jsx=retain;'],
    ["component using declaration", 'null', 'using unused="safe";'],
    ["component var declaration", 'null', 'var unused="safe";'],
  ]) await t.test(name, () => {
    const observed = candidate(`async e=>{e.preventDefault();return fetch(${endpoint},{method:"POST"})}`, prefix);
    observed.componentSource = observed.componentSource.replace("return null}", `return ${returned}}`);
    const result = discoverReactEndpoint([observed]);
    if (supported) assert.equal(result?.path, "/api/marketplace/item_2");
    else assert.equal(result, null);
  });
  await t.test("unsupported concise component execution", () => {
    const observed = candidate(`async e=>fetch(${endpoint},{method:"POST"})`);
    observed.componentSource = `({record:r,locale:l})=>(retain(r),${observed.handlerSource})`;
    assert.equal(discoverReactEndpoint([observed]), null);
  });
  for (const [name, returned] of [
    ["terminal return sequence", `box.push(r),HANDLER`],
    ["terminal return factory", `retain(r,HANDLER)`],
    ["handler initializer factory", `retain(r,HANDLER)`],
  ]) await t.test(name, () => {
    const observed = candidate(`async e=>fetch(${endpoint},{method:"POST"})`);
    const expression = returned.replace("HANDLER", observed.handlerSource);
    observed.componentSource = `function M({record:r,locale:l}){const box=[];const retain=(v,h)=>{box.push(v);return h;};${name.startsWith("handler") ? `const submit=${expression};return null` : `return (${expression})`}}`;
    assert.equal(discoverReactEndpoint([observed]), null);
  });
  for (const [name, ending] of [
    ["handler reference passed to factory", "return retain(r,submit)"],
    ["handler reference captured by factory", "const factory=()=>submit;return factory(r)"],
    ["handler reference alias", "const alias=submit;return alias"],
    ["nested return sequence", 'return render("form",{onSubmit:submit},(retain(r),null))'],
  ]) await t.test(name, () => {
    const observed = candidate(`async e=>fetch(${endpoint},{method:"POST"})`);
    observed.componentSource = `function M({record:r,locale:l}){const submit=${observed.handlerSource};${ending}}`;
    assert.equal(discoverReactEndpoint([observed]), null);
  });
  for (const [name, handler, prefix] of [
    ["handler parameter", `async r=>fetch(${endpoint},{method:"POST"})`],
    ["destructured parameter", `async ({r})=>fetch(${endpoint},{method:"POST"})`],
    ["handler reassignment", `async e=>{r={id:"item_1"};return fetch(${endpoint},{method:"POST"})}`],
    ["component reassignment", `async e=>fetch(${endpoint},{method:"POST"})`, 'r={id:"item_1"};'],
    ["property reassignment", `async e=>{r.id="item_1";return fetch(${endpoint},{method:"POST"})}`],
    ["destructured reassignment", `async e=>{({record:r}=e);return fetch(${endpoint},{method:"POST"})}`],
    ["array reassignment", `async e=>{[r]=e;return fetch(${endpoint},{method:"POST"})}`],
    ["mutable object alias", `async e=>{const alias=r;alias.id="item_1";return fetch(${endpoint},{method:"POST"})}`],
    ["component object alias", `async e=>{alias.id="item_1";return fetch(${endpoint},{method:"POST"})}`, "const alias=r;"],
    ["parenthesized component alias", `async e=>{alias.id="item_1";return fetch(${endpoint},{method:"POST"})}`, "const alias=(r);"],
    ["component container escape", `async e=>{box.record.id="item_1";return fetch(${endpoint},{method:"POST"})}`, "const box={record:r};"],
    ["component array escape", `async e=>{box[0].id="item_1";return fetch(${endpoint},{method:"POST"})}`, "const box=[r];"],
    ["component assigned alias", `async e=>{alias.id="item_1";return fetch(${endpoint},{method:"POST"})}`, "let alias;alias=r;"],
    ["component call escape", `async e=>{alias.id="item_1";return fetch(${endpoint},{method:"POST"})}`, "const alias=identity(r);"],
    ["receiver call escape", `async e=>{alias.id="item_1";return fetch(${endpoint},{method:"POST"})}`, "const alias=r.valueOf();"],
    ["parenthesized receiver call escape", `async e=>fetch(${endpoint},{method:"POST"})`, "const alias=(r.valueOf)();"],
    ["computed receiver call escape", `async e=>fetch(${endpoint},{method:"POST"})`, 'const alias=r["valueOf"]();'],
    ["optional receiver call escape", `async e=>fetch(${endpoint},{method:"POST"})`, "const alias=r.clone?.();"],
    ["unknown receiver call escape", `async e=>fetch(${endpoint},{method:"POST"})`, "const alias=r.arbitrary();"],
    ["receiver constructor escape", `async e=>fetch(${endpoint},{method:"POST"})`, "const alias=new r.Factory();"],
    ["receiver tag escape", `async e=>fetch(${endpoint},{method:"POST"})`, "const alias=r.tag`text`;"],
    ["standalone array retention", `async e=>{box[0].id="item_1";return fetch(${endpoint},{method:"POST"})}`, "const box=[];box.push(r);"],
    ["standalone function retention", `async e=>{box[0].id="item_1";return fetch(${endpoint},{method:"POST"})}`, "const box=[];const retain=value=>box.push(value);retain(r);"],
    ["void statement retention", `async e=>fetch(${endpoint},{method:"POST"})`, "void retain(r);"],
    ["conditional component statement", `async e=>fetch(${endpoint},{method:"POST"})`, "if(ready)retain(r);"],
    ["loop component statement", `async e=>fetch(${endpoint},{method:"POST"})`, "for(const value of values)retain(value);"],
    ["nested component block", `async e=>fetch(${endpoint},{method:"POST"})`, "{retain(r);}"],
    ["labeled component statement", `async e=>fetch(${endpoint},{method:"POST"})`, "label:retain(r);"],
    ["try component statement", `async e=>fetch(${endpoint},{method:"POST"})`, "try{retain(r)}finally{}"],
    ["unknown standalone statement without visible prop argument", `async e=>fetch(${endpoint},{method:"POST"})`, "retain();"],
    ["component closure escape", `async e=>{alias().id="item_1";return fetch(${endpoint},{method:"POST"})}`, "function alias(){return r;}"],
    ["component field escape", `async e=>{new Alias().record.id="item_1";return fetch(${endpoint},{method:"POST"})}`, "class Alias{record=r}"],
    ["prop passed to unknown call", `async e=>{e(r);return fetch(${endpoint},{method:"POST"})}`],
    ["unknown pre-fetch call", `async e=>{mutate();return fetch(${endpoint},{method:"POST"})}`],
    ["unknown pre-fetch initializer", `async e=>{const alias=mutate();return fetch(${endpoint},{method:"POST"})}`],
    ["pre-fetch alias write without visible prop escape", `async e=>{box[0].id="item_1";return fetch(${endpoint},{method:"POST"})}`],
    ["pre-fetch property getter", `async e=>{const value=box[0].trigger;return fetch(${endpoint},{method:"POST"})}`],
    ["pre-fetch await", `async e=>{const value=await mutate();return fetch(${endpoint},{method:"POST"})}`],
    ["var prefix declaration", `async e=>{var value="safe";return fetch(${endpoint},{method:"POST"})}`],
    ["using prefix declaration", `async e=>{using value="safe";return fetch(${endpoint},{method:"POST"})}`],
    ["await using prefix declaration", `async e=>{await using value="safe";return fetch(${endpoint},{method:"POST"})}`],
    ["var fetch declaration", `async e=>{var response=await fetch(${endpoint},{method:"POST"});}`],
    ["using fetch declaration", `async e=>{using response=await fetch(${endpoint},{method:"POST"});}`],
    ["await using fetch declaration", `async e=>{await using response=await fetch(${endpoint},{method:"POST"});}`],
    ["event assignment", `async e=>{e=l;e.preventDefault();return fetch(${endpoint},{method:"POST"})}`],
    ["lexically shadowed FormData event", `async e=>{{const e=l;const form=new FormData(e.currentTarget);return fetch(${endpoint},{method:"POST"})}}`],
    ["earlier initializer in fetch declaration", `async e=>{const value=mutate(),response=await fetch(${endpoint},{method:"POST"});}`],
    ["pre-fetch parameter default", `async (e=mutate())=>fetch(${endpoint},{method:"POST"})`],
    ["pre-fetch comma expression", `async e=>(mutate(),fetch(${endpoint},{method:"POST"}))`],
    ["fetch wrapper call", `async e=>wrapper(fetch(${endpoint},{method:"POST"}))`],
    ["shadowed FormData constructor", `async e=>{const form=new FormData(e.currentTarget);return fetch(${endpoint},{method:"POST"})}`, "const FormData=mutate;"],
    ["named function shadow", `async function r(e){return fetch(${endpoint},{method:"POST"})}`],
    ["uncalled nested function", `async e=>{const unused=()=>fetch(${endpoint},{method:"POST"});}`],
    ["uninstantiated class field", `async e=>{class Unused{request=fetch(${endpoint},{method:"POST"})}}`],
    ["uniterated generator", `function* submit(e){yield fetch(${endpoint},{method:"POST"})}`],
    ["optional call", `async e=>e?.(fetch(${endpoint},{method:"POST"}))`],
    ["unreachable fetch", `async e=>{return;fetch(${endpoint},{method:"POST"});}`],
    ["conditional fetch", `async e=>{if(false) return fetch(${endpoint},{method:"POST"});}`],
    ["overridden method", `async e=>fetch(${endpoint},{method:"POST",method:"GET"})`],
    ["spread override", `async e=>fetch(${endpoint},{method:"POST",...e})`],
  ]) await t.test(name, () => assert.equal(discoverReactEndpoint([candidate(handler, prefix)]), null));

  const requests = [], server = createServer((req, res) => {
    if (req.url.startsWith("/api/")) requests.push({ path: req.url, method: req.method });
    res.setHeader("content-type", "text/html"); res.end('<form action="/marketplace/fr-FR/item_2"></form>');
  }), url = await listen(server); let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); await page.goto(url);
    await page.evaluate(() => {
      function M({ record: r, locale: l }) { return async r => fetch('/api/marketplace/' + r.id + '?locale=' + l, { method: 'POST' }); }
      const form = document.querySelector("form");
      form.__reactProps$control = { onSubmit: M({ record: { id: "item_2" }, locale: "fr-FR" }) };
      form.__reactFiber$control = { type: M, memoizedProps: { record: { id: "item_2" }, locale: "fr-FR" } };
    });
    const candidates = await page.locator("form").evaluate(reactHandlerSources);
    assert.equal(discoverReactEndpoint(candidates), null);
    await page.evaluate(() => document.querySelector("form").__reactProps$control.onSubmit({ id: "item_1" }));
    assert.deepEqual(requests, [{ path: "/api/marketplace/item_1?locale=fr-FR", method: "POST" }]);
  } finally { if (browser) await browser.close(); await close(server); }
});

test("row7: mounted component aliases fail closed while the actual handler POST remains observable", { timeout: 30000 }, async (t) => {
  const requests = [], server = createServer((req, res) => {
    if (req.url.startsWith("/api/")) requests.push({ path: req.url, method: req.method });
    res.setHeader("content-type", "text/html"); res.end('<form action="/marketplace/fr-FR/item_2"></form>');
  }), url = await listen(server); let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    for (const mode of ["alias", "container", "push", "retain", "return-sequence", "return-factory", "factory-reference", "receiver", "computed-receiver", "custom-receiver", "native"]) await t.test(mode, async () => {
      await page.goto(url); requests.length = 0;
      await page.evaluate((mode) => {
        function Alias({ record: r, locale: l }) {
          const alias = r;
          return async e => { alias.id = "item_1"; return fetch('/api/marketplace/' + r.id + '?locale=' + l, { method: 'POST' }); };
        }
        function Container({ record: r, locale: l }) {
          const box = { record: r };
          return async e => { box.record.id = "item_1"; return fetch('/api/marketplace/' + r.id + '?locale=' + l, { method: 'POST' }); };
        }
        function Native({ record: r, locale: l }) {
          return async e => fetch('/api/marketplace/' + r.id + '?locale=' + l, { method: 'POST' });
        }
        function Push({ record: r, locale: l }) {
          const box = [];
          box.push(r);
          return async e => { box[0].id = "item_1"; return fetch('/api/marketplace/' + r.id + '?locale=' + l, { method: 'POST' }); };
        }
        function Retain({ record: r, locale: l }) {
          const box = [];
          const retain = value => box.push(value);
          retain(r);
          return async e => { box[0].id = "item_1"; return fetch('/api/marketplace/' + r.id + '?locale=' + l, { method: 'POST' }); };
        }
        function ReturnSequence({ record: r, locale: l }) {
          const box = [];
          return (box.push(r), async e => { box[0].id = "item_1"; return fetch('/api/marketplace/' + r.id + '?locale=' + l, { method: 'POST' }); });
        }
        function ReturnFactory({ record: r, locale: l }) {
          const box = [], retain = (value, handler) => { box.push(value); return handler; };
          return retain(r, async e => { box[0].id = "item_1"; return fetch('/api/marketplace/' + r.id + '?locale=' + l, { method: 'POST' }); });
        }
        function Receiver({ record: r, locale: l }) {
          const alias = r.valueOf();
          return async e => { alias.id = "item_1"; return fetch('/api/marketplace/' + r.id + '?locale=' + l, { method: 'POST' }); };
        }
        function FactoryReference({ record: r, locale: l }) {
          const box = [], retain = (value, handler) => { box.push(value); return handler; };
          const submit = async e => { box[0].id = "item_1"; return fetch('/api/marketplace/' + r.id + '?locale=' + l, { method: 'POST' }); };
          return retain(r, submit);
        }
        function ComputedReceiver({ record: r, locale: l }) {
          const alias = r["valueOf"]();
          return async e => { alias.id = "item_1"; return fetch('/api/marketplace/' + r.id + '?locale=' + l, { method: 'POST' }); };
        }
        function CustomReceiver({ record: r, locale: l }) {
          const alias = r.retainSelf();
          return async e => { alias.id = "item_1"; return fetch('/api/marketplace/' + r.id + '?locale=' + l, { method: 'POST' }); };
        }
        const component = { alias: Alias, container: Container, push: Push, retain: Retain, "return-sequence": ReturnSequence,
          "return-factory": ReturnFactory, "factory-reference": FactoryReference, receiver: Receiver,
          "computed-receiver": ComputedReceiver, "custom-receiver": CustomReceiver, native: Native }[mode];
        const props = { record: { id: "item_2", retainSelf() { return this; } }, locale: "fr-FR" }, form = document.querySelector("form");
        form.__reactProps$control = { onSubmit: component(props) };
        form.__reactFiber$control = { type: component, memoizedProps: props };
      }, mode);
      const candidates = await page.locator("form").evaluate(reactHandlerSources);
      const discovered = discoverReactEndpoint(candidates);
      // Invoke the mounted native function even when static discovery rejects it.
      // Keep the server receipt independent of discovery and check both outcomes.
      await page.evaluate(() => document.querySelector("form").__reactProps$control.onSubmit({}));
      assert.deepEqual(requests, [{ path: `/api/marketplace/${mode === "native" ? "item_2" : "item_1"}?locale=fr-FR`, method: "POST" }]);
      assert.equal(candidates[0].recordId, "item_2", "Discovery captured props before the native handler mutated the record");
      if (mode === "native") assert.equal(discovered?.path, "/api/marketplace/item_2");
      else assert.equal(discovered, null, "An escaped prop reference is unsupported, not an invented endpoint");
    });
  } finally { if (browser) await browser.close(); await close(server); }
});

test("row7: closed binding grammar agrees with Node and native Chromium dispatch", { timeout: 30000 }, async (t) => {
  const requests = [], server = createServer((req, res) => {
    if (req.url.startsWith("/api/")) requests.push({ path: req.url, method: req.method });
    res.setHeader("content-type", "text/html"); res.end('<form action="/marketplace/fr-FR/item_2"></form>');
  }), base = await listen(server); let browser;
  const source = (mode, origin = "") => {
    const prefix = { native: "e.preventDefault();", "event-var": "var e=l;e.preventDefault();",
      "event-block": "const e=l;e.preventDefault();", using: 'using value="safe";', "await-using": 'await using value="safe";' }[mode] ?? "e.preventDefault();";
    const handlerSource = `async e=>{${mode === "event-block" ? "{" : ""}${prefix}return fetch(${JSON.stringify(origin + "/api/marketplace/")}+r.id+"?locale="+l,{method:"POST"});${mode === "event-block" ? "}" : ""}}`;
    const componentSource = mode === "terminal-wrapper"
      ? `function M({record:r,locale:l}){const retain=(value,props)=>{document.addEventListener("submit",()=>{value.id="item_1"},{capture:true,once:true});return props.onSubmit;};return retain(r,{onSubmit:${handlerSource}});}`
      : `function M({record:r,locale:l}){return ${handlerSource};}`;
    return { handlerSource, componentSource, recordId: "item_2", locale: "fr-FR", base,
      action: base + "/marketplace/fr-FR/item_2", basis: "native-grammar-control" };
  };
  try {
    for (const mode of ["native", "event-var", "event-block", "using", "await-using"]) await t.test(`Node ${mode}`, async () => {
      requests.length = 0;
      const candidate = source(mode, base), component = new Function(`return (${candidate.componentSource})`)();
      const handler = component({ record: { id: "item_2" }, locale: "fr-FR" });
      const outcome = await handler({ preventDefault() {} }).then(() => "completed", (error) => error.name);
      assert.equal(outcome, mode === "native" ? "completed" : "TypeError");
      assert.deepEqual(requests, mode === "native" ? [{ path: "/api/marketplace/item_2?locale=fr-FR", method: "POST" }] : []);
      const discovered = discoverReactEndpoint([candidate]);
      if (mode === "native") assert.equal(discovered?.path, "/api/marketplace/item_2");
      else assert.equal(discovered, null, "A pre-dispatch TypeError cannot certify a native POST binding");
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    for (const mode of ["terminal-wrapper", "event-var", "event-block", "using", "await-using", "native"]) await t.test(`Chromium ${mode}`, async () => {
      await page.goto(base); requests.length = 0;
      await page.evaluate(({ componentSource }) => {
        const component = new Function(`return (${componentSource})`)(), props = { record: { id: "item_2" }, locale: "fr-FR" };
        const form = document.querySelector("form"), handler = component(props);
        form.__reactProps$control = { onSubmit: handler };
        form.__reactFiber$control = { type: component, memoizedProps: props };
        form.addEventListener("submit", (event) => {
          const pending = handler(event);
          // Cancel HTML fallback after native invocation, including error cases.
          event.preventDefault();
          globalThis.controlOutcome = pending.then(() => "completed", (error) => error.name);
        });
      }, source(mode));
      const candidates = await page.locator("form").evaluate(reactHandlerSources);
      const discovered = discoverReactEndpoint(candidates);
      const outcome = await page.evaluate(() => { document.querySelector("form").requestSubmit(); return globalThis.controlOutcome; });
      const dispatched = ["native", "terminal-wrapper"].includes(mode);
      assert.equal(outcome, dispatched ? "completed" : "TypeError");
      assert.deepEqual(requests, dispatched ? [{ path: `/api/marketplace/${mode === "terminal-wrapper" ? "item_1" : "item_2"}?locale=fr-FR`, method: "POST" }] : []);
      assert.equal(candidates[0].recordId, "item_2", "Capture precedes the native capture listener's mutation");
      if (mode === "native") assert.equal(discovered?.path, "/api/marketplace/item_2");
      else assert.equal(discovered, null, "Unsupported syntax must not invent a successful endpoint");
    });
  } finally { if (browser) await browser.close(); await close(server); }
});

test("row7: sibling render effects cannot certify a native binding", { timeout: 30000 }, async (t) => {
  const requests = [], server = createServer((req, res) => {
    if (req.url.startsWith("/api/")) requests.push({ path: req.url, method: req.method });
    res.setHeader("content-type", "text/html"); res.end('<form action="/marketplace/fr-FR/item_2"></form>');
  }), base = await listen(server); let browser;
  const placements = [
    ["earlier array sibling", '_jsxs("article",{children:[retain(r),FORM]})'],
    ["later array sibling", '_jsxs("article",{children:[FORM,retain(r)]})'],
    ["ancestor prop sibling", '_jsx("article",{effect:retain(r),children:FORM})'],
    ["form prop sibling", '_jsx("form",{effect:retain(r),onSubmit:submit})'],
  ];
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    for (const [name, expression] of placements) await t.test(name, async () => {
      await page.goto(base); requests.length = 0;
      const handlerSource = 'async e=>{e.preventDefault();return fetch("/api/marketplace/"+r.id+"?locale="+l,{method:"POST"});}';
      const componentSource = `function M({record:r,locale:l}){const submit=${handlerSource};return ${expression.replace("FORM", '_jsx("form",{onSubmit:submit})')};}`;
      await page.evaluate(({ componentSource }) => {
        const jsx = (tag, props) => ({ tag, props }), retain = (value) => {
          document.addEventListener("submit", () => { value.id = "item_1"; }, { capture: true, once: true });
          return null;
        };
        const component = new Function("_jsx", "_jsxs", "retain", `return (${componentSource})`)(jsx, jsx, retain);
        const props = { record: { id: "item_2" }, locale: "fr-FR" }, tree = component(props), form = document.querySelector("form");
        const find = (node) => !node ? null : node.tag === "form" ? node.props.onSubmit
          : Array.isArray(node) ? node.map(find).find(Boolean) : find(node?.props?.children);
        const handler = find(tree);
        form.__reactProps$control = { onSubmit: handler };
        form.__reactFiber$control = { type: component, memoizedProps: props };
        form.addEventListener("submit", (event) => { globalThis.controlOutcome = handler(event); });
      }, { componentSource });
      const candidates = await page.locator("form").evaluate(reactHandlerSources);
      const discovered = discoverReactEndpoint(candidates);
      await page.evaluate(() => { document.querySelector("form").requestSubmit(); return globalThis.controlOutcome; });
      assert.deepEqual(requests, [{ path: "/api/marketplace/item_1?locale=fr-FR", method: "POST" }]);
      assert.equal(candidates[0].recordId, "item_2");
      assert.equal(discovered, null, "All render siblings and prop values must be admissible, not just the handler's ancestors");
    });
  } finally { if (browser) await browser.close(); await close(server); }
});

test("row7: the repository's native Next marketplace handler remains supported", { timeout: 30000 }, async () => {
  const source = readFileSync(new URL("../fullstack/apps/nextjs/lib/marketplace-page.tsx", import.meta.url), "utf8");
  const emitted = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const file = ts.createSourceFile("native-next.js", emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const component = file.statements.find((s) => ts.isFunctionDeclaration(s) && s.name.text === "Marketplace"); let handler;
  const visit = (node) => { if (ts.isPropertyAssignment(node) && node.name.text === "onSubmit") handler = node.initializer; ts.forEachChild(node, visit); };
  visit(component);
  const observed = { handlerSource: handler.getText(), componentSource: component.getText().replace(/^export /, ""), recordId: "item_2", locale: "fr-FR",
    action: "http://local/marketplace/fr-FR/item_2", base: "http://local", basis: "source-control-only-not-a-mounted-capture" };
  assert.equal(discoverReactEndpoint([observed]), null, "Source-only Next discovery lacks imported callable evidence; emitted linked positives are tested separately");
  const requests = [], server = createServer(async (req, res) => {
    if (req.url.startsWith("/api/")) {
      let body = ""; for await (const chunk of req) body += chunk;
      requests.push({ path: req.url, method: req.method, body: Object.fromEntries(new URLSearchParams(body)) });
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ message: "native accepted" }));
    } else {
      res.setHeader("content-type", "text/html");
      res.end('<form action="/marketplace/fr-FR/item_2"><input name="email" value="native@example.test"><input name="target_price" value="1,25"></form><p></p>');
    }
  }), url = await listen(server); let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); await page.goto(url);
    await page.evaluate(({ componentSource, handlerSource }) => {
      // Test-only closure construction from the repository source. Discovery
      // itself still parses, never invokes or evaluates, these functions.
      const record = { id: "item_2" }, locale = "fr-FR", form = document.querySelector("form");
      const component = new Function(`return (${componentSource})`)();
      const handler = new Function("record", "locale", "setSubmitted", `return (${handlerSource})`)(record, locale,
        (message) => { document.querySelector("p").textContent = message; });
      form.__reactProps$control = { onSubmit: handler };
      form.__reactFiber$control = { type: component, memoizedProps: { record, locale } };
    }, observed);
    const candidates = await page.locator("form").evaluate(reactHandlerSources);
    assert.equal(discoverReactEndpoint(candidates), null, "Evaluated test closures are not immutable emitted module provenance");
    await page.evaluate(() => {
      const form = document.querySelector("form");
      return form.__reactProps$control.onSubmit({ currentTarget: form, preventDefault() {} });
    });
    assert.deepEqual(requests, [{ path: "/api/marketplace/item_2?locale=fr-FR", method: "POST", body: { email: "native@example.test", target_price: "1,25" } }]);
    assert.equal(await page.locator("p").textContent(), "native accepted");
  } finally { if (browser) await browser.close(); await close(server); }
});

test("row7: native Next helper effects are not resolved by identical component source", { timeout: 30000 }, async (t) => {
  const compilerOptions = { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
  const compile = (name) => ts.createSourceFile(name,
    ts.transpileModule(readFileSync(new URL(`../fullstack/apps/nextjs/lib/${name}`, import.meta.url), "utf8"), { compilerOptions }).outputText,
    ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const componentSource = compile("marketplace-page.tsx").statements.find((s) => ts.isFunctionDeclaration(s) && s.name.text === "Marketplace").getText().replace(/^export /, "");
  const helperSource = compile("marketplace.ts").statements.filter((s) => !ts.isImportDeclaration(s))
    .map((s) => s.getText().replace(/^export /, "")).join("\n");
  const labels = JSON.parse(readFileSync(new URL("../fullstack/apps/nextjs/lib/marketplace-labels.json", import.meta.url), "utf8"));
  const requests = [], captures = [], server = createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      requests.push({ path: req.url, method: req.method });
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ message: "native accepted" }));
    } else {
      res.setHeader("content-type", "text/html");
      res.end('<form action="/marketplace/fr-FR/item_2"><input name="email" value="native@example.test"><input name="target_price" value="1,25"></form><p></p>');
    }
  }), base = await listen(server); let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    for (const mode of ["native", "retaining-helper"]) await t.test(mode, async () => {
      await page.goto(base); requests.length = 0;
      await page.evaluate(({ componentSource, helperSource, labels, record, mode }) => {
        const helpers = new Function("labels", `${helperSource}\nreturn {formatters,marketplacePath,sortedListings};`)(labels);
        const sortedListings = mode === "native" ? helpers.sortedListings : (value, query) => {
          document.addEventListener("submit", () => { value.id = "item_1"; }, { capture: true, once: true });
          return helpers.sortedListings(value, query);
        };
        // Execute the real component with its real repository value helpers.
        // Only the test JSX/runtime adapter and the adversarial helper differ.
        const jsx = (tag, props) => ({ tag, props }), form = document.querySelector("form");
        const component = new Function("_jsx", "_jsxs", "_Fragment", "Fragment", "useState", "formatters", "marketplacePath", "sortedListings", `return (${componentSource})`)(
          jsx, jsx, Symbol("Fragment"), Symbol("Fragment"), () => [null, (message) => { document.querySelector("p").textContent = message; }],
          helpers.formatters, helpers.marketplacePath, sortedListings);
        const props = { record, locale: "fr-FR", query: { seller: "", sort: "asc", allOffers: false } }, tree = component(props);
        const find = (node) => !node || typeof node !== "object" ? null
          : node.tag === "form" && node.props.onSubmit ? node.props.onSubmit
            : Array.isArray(node) ? node.map(find).find(Boolean) : find(node.props?.children);
        const handler = find(tree);
        form.__reactProps$control = { onSubmit: handler };
        form.__reactFiber$control = { type: component, memoizedProps: props };
        form.addEventListener("submit", (event) => { globalThis.controlOutcome = handler(event); });
      }, { componentSource, helperSource, labels, record: records().item_2, mode });
      const candidates = await page.locator("form").evaluate(reactHandlerSources);
      captures.push(candidates);
      const discovered = discoverReactEndpoint(candidates);
      await page.evaluate(() => { document.querySelector("form").requestSubmit(); return globalThis.controlOutcome; });
      assert.deepEqual(requests, [{ path: `/api/marketplace/${mode === "native" ? "item_2" : "item_1"}?locale=fr-FR`, method: "POST" }]);
      assert.equal(await page.locator("p").textContent(), "native accepted");
      if (mode === "native") assert.equal(discovered, null, "Source-only native helper identities are unresolved; the emitted linked positive is required separately");
      else {
        assert.deepEqual(candidates, captures[0], "The current capture cannot distinguish the real helper from one retaining the record");
        assert.equal(discovered, null, "Unobserved helper identity cannot certify request intent from component source alone");
      }
    });
  } finally { if (browser) await browser.close(); await close(server); }
});

test("row7: actual socket receipts require unique ordered bounded native clocks", { timeout: 30000 }, async (t) => {
  const server = createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end('<article class="marketplace">Native document</article>'); });
  const peers = new Set();
  server.on("upgrade", (req, socket) => {
    peers.add(socket); socket.on("close", () => peers.delete(socket)); socket.on("error", () => {});
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.once("data", () => socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8])));
  });
  const base = await listen(server); let browser, journal;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(); await context.addInitScript(installResourceObserver);
    try {
      const page = await context.newPage(), cdp = await context.newCDPSession(page);
      journal = new PlatformLifecycle(cdp, await browser.newBrowserCDPSession(), { javaScriptEnabled: true });
      await journal.enable(); await journal.enableDomains(); await journal.startObservation(); journal.markApplicationStart();
      const audit = new ResourceAudit(page, cdp, true, journal);
      const observe = async () => {
        const resources = await audit.checkpoint();
        await journal.recordDocument({ observer: randomUUID(), scope: resources.scope, url: { path: new URL(page.url()).pathname }, native: await page.evaluate(nativeDOM) }, resources);
        return resources;
      };
      await page.goto(base + "/before"); const before = await observe();
      await page.evaluate(() => new Promise((resolve, reject) => {
        const socket = new WebSocket(location.origin.replace("http:", "ws:") + "/socket");
        socket.onopen = () => socket.close(); socket.onclose = resolve; socket.onerror = reject;
      }));
      const retiredAt = performance.now(); await page.goto(base + "/after"); await observe();
      await journal.finishObservation({ observationMs: 25, realms: [before.realm] });
      const snapshot = journal.snapshot(), original = JSON.stringify(snapshot), options = { realm: before.realm, retiredAt, observationMs: 25 };
      assert.equal(validatePlatformRetirement(snapshot, options).outcome, "proved");
      const event = (j, suffix) => j.events.find((e) => e.event === "Network.webSocket" + suffix);
      for (const [name, mutate] of [
        ["missing close", (j) => { j.events = j.events.filter((e) => e.event !== "Network.webSocketClosed"); }],
        ["missing close clock", (j) => { delete event(j, "Closed").at; }],
        ["future close clock", (j) => { event(j, "Closed").at += 3600; }],
        ["backwards close clock", (j) => { event(j, "Closed").at = event(j, "HandshakeResponseReceived").at - 1; }],
        ["missing handshake clock", (j) => { delete event(j, "HandshakeResponseReceived").at; }],
        ["future handshake clock", (j) => { event(j, "HandshakeResponseReceived").at += 3600; }],
        ["invalid handshake status", (j) => { event(j, "HandshakeResponseReceived").status = null; }],
        ["missing handshake", (j) => { j.events = j.events.filter((e) => e.event !== "Network.webSocketHandshakeResponseReceived"); }],
        ["out-of-bounds creation", (j) => { event(j, "Created").receivedAt = j.boundaries.startedAt - 1; j.events.sort((a, b) => a.receivedAt - b.receivedAt); }],
        ["missing socket identity", (j) => { for (const e of j.events.filter((e) => e.event.startsWith("Network.webSocket"))) e.request = null; }],
        ...["Created", "HandshakeResponseReceived", "Closed"].map((suffix) => [`duplicate ${suffix}`, (j) => { const e = event(j, suffix); j.events.splice(j.events.indexOf(e), 0, structuredClone(e)); }]),
        ["orphan handshake", (j) => { event(j, "HandshakeResponseReceived").request = "unobserved"; }],
        ["orphan close", (j) => { event(j, "Closed").request = "unobserved"; }],
        ["late handshake", (j) => { const e = event(j, "HandshakeResponseReceived"); j.events.splice(j.events.indexOf(e), 1); const closed = event(j, "Closed"); e.receivedAt = closed.receivedAt; j.events.splice(j.events.indexOf(closed) + 1, 0, e); }],
      ]) await t.test(name, () => {
        const altered = structuredClone(snapshot); mutate(altered);
        assert.equal(validatePlatformRetirement(altered, options).outcome, "unknown", name);
      });
      assert.equal(JSON.stringify(snapshot), original);
    } finally { await context.close(); }
  } finally { if (journal) await journal.close(); if (browser) await browser.close(); for (const peer of peers) peer.destroy(); await close(server); }
});
