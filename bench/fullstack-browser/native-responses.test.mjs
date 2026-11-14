import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { records } from "../marketplace/fixtures.mjs";
import { referenceHtml } from "../marketplace/reference.mjs";
import { snapshotMixedPage } from "../mixed-production/snapshot.mjs";
import { collectDOMReads, replayDOMReads } from "../mixed-production/response-evidence.mjs";
import { snapshotPage, comparePage } from "../marketplace/check.mjs";
import { definition } from "../workloads/registry.mjs";
import { installResourceObserver } from "./resources.mjs";
import { collectBrowserDOM, replayBrowserDOM } from "./native-browser-dom.mjs";
import { EvidenceStore, openEvidence, sha256, encoded } from "./native-evidence.mjs";
import { retainPublicJSON, retainPublicAsset, retainDOMProjection, retainBrowserDOMProjection, replayResponse } from "./native-responses.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "corten-native-response-")); t.after(() => rmSync(root, { recursive: true }));
  return { root, store: new EvidenceStore(root) };
}
const bind = (body, path = "/api/alerts") => ({ requestId: "observed-request", responseSha256: sha256(body), path, status: 200 });

const caseKey = definition("fullstack-browser").cases[0].key;
const expectation = (o) => Object.fromEntries(["observer", "context", "case", "action", "scope", "originatingResponse", "readInterval", "url"].map((key) => [key, o[key]]));
async function browserDOMFixture(t) {
  let body = referenceHtml(records().item_2, "en-US");
  const server = createServer((req, res) => {
    res.writeHead(req.url.endsWith("/item_missing") ? 404 : 200, { "content-type": "text/html" });
    res.end(req.url === "/native-frame-public" ? "<p>Public subdocument</p>" : body.replaceAll("http://localhost", `http://127.0.0.1:${server.address().port}`));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await new Promise((done) => server.close(done)); } });
  browser = await chromium.launch({ headless: true });
  const contextId = randomUUID(), context = await browser.newContext(); await context.addInitScript(installResourceObserver); const page = await context.newPage();
  await page.route("**/*", (route) => route.request().resourceType() === "document" ? route.continue() : route.abort());
  return { page, setBody(value) { body = value; }, async read(path = "/marketplace/en-US/item_2") {
    const response = await page.goto(`http://127.0.0.1:${server.address().port}${path}`), bytes = await response.body();
    const identity = { context: contextId, case: caseKey, action: `${caseKey}-0`,
      scope: await page.evaluate(() => globalThis.__fullstackBrowserAudit.checkpoint().scope),
      originatingResponse: { requestId: randomUUID(), sha256: sha256(bytes) } };
    return { identity, observation: await collectBrowserDOM(page, identity), response };
  } };
}
test("actual strict page/Alice observations replay installed snapshot and preserve mixed API behavior", async (t) => {
  const f = await browserDOMFixture(t);
  const ordinary = await f.read(), page = await f.page.evaluate(snapshotPage);
  assert.equal(ordinary.response.status(), 200);
  assert.equal(ordinary.observation.failure, null);
  assert.deepEqual(replayBrowserDOM(ordinary.observation, expectation(ordinary.observation)).page, page);
  const mixed = await f.page.evaluate(collectDOMReads, { source: snapshotMixedPage.toString(), readPath: "/marketplace/en-US/item_2" });
  assert.equal(mixed.failure, null); assert.deepEqual(replayDOMReads(mixed), page);
  f.setBody(referenceHtml(records().item_2, "en-US").replace("seller=&amp;sort=asc", "seller=Alice&amp;sort=desc"));
  const alice = await f.read("/marketplace/en-US/item_2?seller=Alice&sort=desc");
  assert.equal(alice.observation.failure, null); assert.deepEqual(alice.observation.url.query, { seller: "Alice", sort: "desc" });
  assert.deepEqual(replayBrowserDOM(alice.observation, expectation(alice.observation)).page, await f.page.evaluate(snapshotPage));
  await f.page.locator('[name="seller"]').fill("Alice");
  const publicInput = await collectBrowserDOM(f.page, alice.identity);
  assert.equal(publicInput.failure, null); assert.deepEqual(replayBrowserDOM(publicInput, expectation(publicInput)).page, page);
  const old = await f.page.evaluate(collectDOMReads, { source: snapshotMixedPage.toString(), readPath: "/marketplace/en-US/item_2" });
  assert.equal(old.failure, "credential-filter-blocked");
  const root = mkdtempSync(join(tmpdir(), "corten-browser-dom-"));
  try {
    const store = new EvidenceStore(root), expected = expectation(alice.observation), receipt = retainBrowserDOMProjection(store, alice.observation, expected);
    const ref = store.record("live-dom", receipt); store.seal(); const reader = openEvidence(root), result = replayResponse(reader, reader.json(ref), expected);
    assert.equal(result.type, "public-browser-dom-observation"); assert.deepEqual(result.page, page); reader.finish();
    const wrongResult = structuredClone(receipt); wrongResult.result.page.title = "forged";
    assert.throws(() => replayResponse(reader, wrongResult, expected));
    const wrongIdentity = structuredClone(expected); wrongIdentity.originatingResponse.requestId = "other-request";
    assert.throws(() => replayResponse(reader, receipt, wrongIdentity));
    const changed = structuredClone(alice.observation);
    // This observed guard value is not returned in snapshotPage's result. Its
    // exact bytes still belong to the sealed transcript, not just the summary.
    const guard = changed.events.find((e) => e.key === "getAttribute" && e.args[0]?.scalar === "aria-hidden");
    assert.deepEqual(guard.result, { scalar: null }); guard.result = { scalar: "false" };
    writeFileSync(join(root, receipt.body.path), encoded(changed));
    assert.throws(() => openEvidence(root));
  } finally { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true }); }
  t.diagnostic(`ordinary ${ordinary.observation.events.length} reads; Alice ${alice.observation.events.length} reads/${Buffer.byteLength(JSON.stringify(alice.observation))} bytes`);
});
test("actual missing-item captures article absence and exact visible error, never arbitrary body text", async (t) => {
  const f = await browserDOMFixture(t);
  f.setBody('<!doctype html><html><body><input type="hidden" value="csrf-private-canary"><meta name="csrf-token" content="csrf-private-canary"><h1>Not found</h1><p>arbitrary diagnostic text that must not be retained</p><x-private-tag-canary role="alert">unknown text</x-private-tag-canary><p aria-hidden="attribute-private-canary">unknown text</p></body></html>');
  const { observation, response } = await f.read("/marketplace/en-US/item_missing"), result = replayBrowserDOM(observation, expectation(observation));
  assert.equal(response.status(), 404);
  assert.equal(observation.failure, null);
  assert.deepEqual(result, { kind: "missing-item", page: null, error: { code: "not-found", text: "Not found", tag: "h1" }, articleCount: 0, extractionComplete: true });
  assert.doesNotMatch(JSON.stringify(observation), /csrf-private-canary|arbitrary diagnostic|private-tag-canary|attribute-private-canary/);
  for (const html of [
    '<body><h1>unknown private error text</h1></body>',
    '<body><section hidden><h1>Not found</h1></section></body>',
    '<body><x-private-canary role="alert">Not found</x-private-canary></body>',
    '<body><input type="hidden" value="Not found"><h1>Not found</h1></body>',
    '<body><article class="marketplace"></article><h1>Not found</h1></body>',
  ]) {
    f.setBody(html); const read = await f.read("/marketplace/en-US/item_missing");
    assert.notEqual(read.observation.failure, null); assert.equal(replayBrowserDOM(read.observation, expectation(read.observation)).extractionComplete, false);
    assert.equal(read.observation.events.length, 0); assert.doesNotMatch(JSON.stringify(read.observation), /unknown private error text/);
  }
});
test("unknown/secret queries, hidden/meta values, wrong scope and caller-selected code fail closed", async (t) => {
  const f = await browserDOMFixture(t), { identity } = await f.read();
  for (const query of ["token=secret-query-canary", "seller=secret-query-canary", "seller=A", "seller=Alice&seller=Alice", "unknown=", "sort=unknown", "offers=unknown", "seller=%41lice", "seller=Alice&"]) {
    await f.page.goto(new URL(`?${query}`, f.page.url()).href);
    await assert.rejects(() => collectBrowserDOM(f.page, identity));
  }
  for (const attr of ['href="/marketplace/en-US/item_2?token=private-canary"', 'action="/marketplace/en-US/item_2?csrf=private-canary"', 'href="http://user:password@localhost/x"']) {
    f.setBody(referenceHtml(records().item_2, "en-US").replace("</article>", `<a ${attr}>link</a></article>`));
    const read = await f.read(); assert.equal(read.observation.failure, "credential-filter-blocked"); assert.doesNotMatch(JSON.stringify(read.observation), /private-canary|user:password/);
  }
  f.setBody(referenceHtml(records().item_2, "en-US").replace("</body>", '<input type="hidden" value="private-canary"><meta name="csrf-token" content="meta-canary"></body>')
    .replace(/<h1>[^<]*<\/h1>/, "<h1>private-canary</h1>"));
  const secret = await f.read(); assert.equal(secret.observation.failure, "credential-filter-blocked"); assert.doesNotMatch(JSON.stringify(secret.observation), /private-canary|meta-canary/);
  await assert.rejects(() => collectBrowserDOM(f.page, { ...secret.identity, source: "()=>document.body.innerHTML" }));
  const badScope = await collectBrowserDOM(f.page, { ...secret.identity, scope: "wrong" }); assert.equal(badScope.failure, "native-scope-mismatch");
  f.setBody(referenceHtml(records().item_2, "en-US").replace(/<h1>[^<]*<\/h1>/, '<h1>Public title<script type="application/json">script-private-canary</script></h1>'));
  const nested = await f.read(); assert.equal(nested.observation.failure, "credential-filter-blocked"); assert.doesNotMatch(JSON.stringify(nested.observation), /script-private-canary/);
  f.setBody(referenceHtml(records().item_2, "en-US").replace('action="/marketplace/en-US/item_2" method="post"', 'action="/marketplace/en-US/item_3" method="post"'));
  const wrongForm = await f.read(); assert.equal(wrongForm.observation.failure, "native-dom-snapshot-failed");
  assert.equal(replayBrowserDOM(wrongForm.observation, expectation(wrongForm.observation)).extractionComplete, false);
});
test("private source variants cannot leak through semantically unchanged strict snapshot guards", async (t) => {
  const f = await browserDOMFixture(t);
  for (const [name, source, live] of [
    ["itemprop-meta", '<meta itemprop="csrf-token" content="TOKEN">'],
    ["content-only-meta", '<meta content="TOKEN">'],
    ["hidden-attribute-input", '<input hidden value="TOKEN">'],
    ["css-hidden-input", '<input style="display:none" value="TOKEN">'],
    ["css-invisible-input", '<input style="visibility:hidden" value="TOKEN">'],
    ["css-transparent-input", '<input style="opacity:0" value="TOKEN">'],
    ["hidden-ancestor-input", '<div hidden><input value="TOKEN"></div>'],
    ["aria-hidden-ancestor-input", '<div aria-hidden="true"><input value="TOKEN"></div>'],
    ["hidden-textarea", '<textarea hidden>TOKEN</textarea>'],
    ["hidden-select", '<select hidden><option value="TOKEN">Private option</option></select>'],
    ["unselected-private-option", '<select hidden><option value="">Choose</option><option value="TOKEN">Private option</option></select>'],
    ["password-default-value", '<input type="password" value="TOKEN">'],
    ["live-password", '<input id="private-source" type="password">', true],
  ]) for (const guard of ["aria-hidden", "label-for"]) await t.test(`${name}/${guard}`, async () => {
    const token = `private-inventory-${name}-canary`;
    f.setBody(referenceHtml(records().item_2, "en-US").replace("</body>", `${source.replaceAll("TOKEN", token)}</body>`));
    const { identity } = await f.read();
    await f.page.evaluate(({ token, guard, live }) => {
      if (live) { const input = document.querySelector("#private-source"); input.value = token; if (input.hasAttribute("value")) throw Error("live-only control"); }
      if (guard === "aria-hidden") { const span = document.createElement("span"); span.setAttribute("aria-hidden", token); document.querySelector("article").append(span); }
      else document.querySelector("article label").htmlFor = token;
    }, { token, guard, live: Boolean(live) });
    // These guard reads are NOT returned in the semantic page object. A strict
    // result comparison alone therefore cannot protect the retained transcript.
    comparePage(await f.page.evaluate(snapshotPage), records().item_2, "en-US");
    const observation = await collectBrowserDOM(f.page, identity), expected = expectation(observation);
    assert.equal(observation.failure, "credential-filter-blocked");
    assert.deepEqual(observation.events, []); assert.ok(!JSON.stringify(observation).includes(token));
    const { root, store } = fixture(t), receipt = retainBrowserDOMProjection(store, observation, expected);
    const ref = store.record("private-source-blocked", receipt); store.seal(); const reader = openEvidence(root);
    const result = replayResponse(reader, reader.json(ref), expected);
    assert.equal(result.extractionComplete, false); assert.equal(result.kind, null); reader.finish();
  });
});

test("unsupported private sources and noncanonical guard metadata fail before retention", async (t) => {
  const f = await browserDOMFixture(t);
  for (const variant of ["meta-child", "file", "oversized-meta", "unknown-guard"]) await t.test(variant, async () => {
    f.setBody(referenceHtml(records().item_2, "en-US")); const { identity } = await f.read();
    await f.page.evaluate((variant) => {
      if (variant === "meta-child" || variant === "oversized-meta") {
        const meta = document.createElement("meta");
        if (variant === "meta-child") meta.append(document.createTextNode("private-child-canary")); else meta.content = "x".repeat(131073);
        document.head.append(meta);
      } else if (variant === "file") { const input = document.createElement("input"); input.type = "file"; document.body.append(input); }
      else { const span = document.createElement("span"); span.setAttribute("aria-hidden", "unknown-private-canary"); document.querySelector("article").append(span); }
    }, variant);
    if (variant === "file") await f.page.locator('input[type="file"]').setInputFiles({ name: "private-file-canary.txt", mimeType: "text/plain", buffer: Buffer.from("private-file-content-canary") });
    comparePage(await f.page.evaluate(snapshotPage), records().item_2, "en-US");
    const observation = await collectBrowserDOM(f.page, identity);
    assert.equal(observation.failure, "credential-filter-blocked"); assert.deepEqual(observation.events, []);
    assert.doesNotMatch(JSON.stringify(observation), /private-(?:child|file|content)-canary|unknown-private-canary/);
    assert.equal(replayBrowserDOM(observation, expectation(observation)).extractionComplete, false);
  });
});

test("native template private fields cannot enter sealed unchanged htmlFor guards", async (t) => {
  const f = await browserDOMFixture(t);
  for (const [name, source] of [
    ["input", '<template><input type="hidden" value="TOKEN"></template>'],
    ["nested-input", '<template><template><input type="hidden" value="TOKEN"></template></template>'],
    ["meta", '<template><meta content="TOKEN"></template>'],
    ["textarea", '<template><textarea hidden>TOKEN</textarea></template>'],
    ["nested-select", '<template><template><select><option value="">Choose</option><option value="TOKEN">Private</option></select></template></template>'],
  ]) await t.test(name, async () => {
    const token = `template-private-${name}-canary`;
    f.setBody(referenceHtml(records().item_2, "en-US").replace("</body>", `${source.replaceAll("TOKEN", token)}</body>`));
    const { identity } = await f.read();
    await f.page.evaluate((token) => { document.querySelector("article label").htmlFor = token; }, token);
    comparePage(await f.page.evaluate(snapshotPage), records().item_2, "en-US");
    const observation = await collectBrowserDOM(f.page, identity), expected = expectation(observation);
    const { root, store } = fixture(t), receipt = retainBrowserDOMProjection(store, observation, expected);
    const ref = store.record("template-private", receipt); store.seal(); const reader = openEvidence(root);
    const result = replayResponse(reader, reader.json(ref), expected); reader.finish();
    assert.equal(result.extractionComplete, false); assert.equal(observation.failure, "credential-filter-blocked");
    assert.deepEqual(observation.events, []); assert.ok(!JSON.stringify(observation).includes(token));
  });
});

test("native template inventory shares bounds and allows unreflected private fields", async (t) => {
  const f = await browserDOMFixture(t), token = "unreflected-template-private-canary";
  f.setBody(referenceHtml(records().item_2, "en-US").replace("</body>",
    `<template><template><input value="${token}"><meta content="${token}"><textarea>${token}</textarea></template></template></body>`));
  const { observation } = await f.read();
  assert.equal(observation.failure, null);
  comparePage(replayBrowserDOM(observation, expectation(observation)).page, records().item_2, "en-US");
  assert.ok(!JSON.stringify(observation).includes(token));
  for (const kind of ["fields", "options"]) await t.test(kind, async () => {
    f.setBody(referenceHtml(records().item_2, "en-US")); const { identity } = await f.read();
    await f.page.evaluate((kind) => {
      const template = document.createElement("template"); document.body.append(template);
      const parent = kind === "options" ? template.content.appendChild(document.createElement("select")) : template.content;
      for (let i = 0; i < 10000; i++) parent.append(document.createElement(kind === "options" ? "option" : "input"));
    }, kind);
    const read = await collectBrowserDOM(f.page, identity);
    assert.equal(read.failure, "credential-filter-blocked"); assert.deepEqual(read.events, []);
    assert.equal(replayBrowserDOM(read, expectation(read)).extractionComplete, false);
  });
});

test("missing error content-visibility policy rejects own descendant and ancestor skipping", async (t) => {
  const f = await browserDOMFixture(t);
  for (const [name, html] of [
    ["own-hidden", '<h1 style="content-visibility:hidden">Not found</h1>'],
    ["inline-block-hidden", '<h1>Not <span style="display:inline-block;content-visibility:hidden">found</span></h1>'],
    ["block-hidden", '<h1>Not <span style="display:block;content-visibility:hidden">found</span></h1>'],
    ["ancestor-hidden", '<section style="content-visibility:hidden"><h1>Not found</h1></section>'],
    ["non-atomic-inline-hidden", '<h1>Not <span style="content-visibility:hidden">found</span></h1>'],
    ["own-auto", '<h1 style="content-visibility:auto">Not found</h1>'],
    ["descendant-auto", '<h1>Not <span style="content-visibility:auto">found</span></h1>'],
    ["ancestor-auto", '<section style="content-visibility:auto"><h1>Not found</h1></section>'],
  ]) await t.test(name, async () => {
    f.setBody(`<body>${html}</body>`); const { observation, response } = await f.read("/marketplace/en-US/item_missing");
    assert.equal(response.status(), 404);
    // Native diagnostics only: these are never a production read or fallback.
    if (["own-hidden", "inline-block-hidden", "block-hidden"].includes(name)) {
      const native = await f.page.locator("h1").evaluate((el) => ({
        visible: el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true }),
        rendered: el.innerText.trim(),
      }));
      assert.equal(native.visible, true); assert.notEqual(native.rendered, "Not found");
    }
    const { root, store } = fixture(t), expected = expectation(observation), receipt = retainBrowserDOMProjection(store, observation, expected);
    const ref = store.record("content-visibility", receipt); store.seal(); const reader = openEvidence(root);
    const result = replayResponse(reader, reader.json(ref), expected); reader.finish();
    assert.equal(result.extractionComplete, false); assert.equal(observation.failure, "public-error-unavailable");
    assert.deepEqual(observation.events, []);
  });
  f.setBody('<body><h1>Not <span style="content-visibility:visible">found</span></h1></body>');
  const { observation } = await f.read("/marketplace/en-US/item_missing");
  assert.equal(observation.failure, null); assert.equal(replayBrowserDOM(observation, expectation(observation)).error.text, "Not found");
});

test("missing error cannot use text from CSS-hidden descendants", async (t) => {
  const f = await browserDOMFixture(t);
  for (const style of ["display:none", "visibility:hidden", "opacity:0"]) await t.test(style, async () => {
    f.setBody(`<body><h1>Not <span style="${style}">found</span></h1></body>`);
    const { observation, response } = await f.read("/marketplace/en-US/item_missing");
    assert.equal(response.status(), 404);
    assert.equal(await f.page.locator("h1 span").evaluate((el) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })), false);
    assert.equal(observation.failure, "public-error-unavailable");
    assert.equal(replayBrowserDOM(observation, expectation(observation)).extractionComplete, false); assert.deepEqual(observation.events, []);
  });
  f.setBody("<body><h1>Not <span>found</span></h1></body>");
  const { observation } = await f.read("/marketplace/en-US/item_missing");
  assert.equal(observation.failure, null); assert.equal(replayBrowserDOM(observation, expectation(observation)).error.text, "Not found");
});

test("ordered reads, fixed source, original response and unique observation identity cannot be substituted", async (t) => {
  const f = await browserDOMFixture(t), { observation } = await f.read(), expected = expectation(observation);
  for (const mutate of [
    (o) => { o.events.push(o.events[0]); }, (o) => { o.events.splice(3, 1); },
    (o) => { o.events[0].key = "innerHTML"; }, (o) => { o.result.page.title = "substituted"; },
    (o) => { o.snapshotSha256 = sha256(snapshotMixedPage.toString()); },
    // ce2's old digest did not bind the collector privacy policy.
    (o) => { o.snapshotSha256 = "c9ea53976efe041ed2d9f9133a62460e7ec4c266775238eb6eaf52172ecdf79e"; },
    // 5b's collector omitted template contents and own content-visibility.
    (o) => { o.snapshotSha256 = "a0a1287f59874809d24f3d1df432989684178397e69287c0f326474e62550197"; },
    (o) => { o.events.find((e) => e.key === "getAttribute" && e.args[0]?.scalar === "aria-hidden").result = { scalar: "private-guard-canary" }; },
    (o) => { o.source = "()=>document.cookie"; }, (o) => { o.context = "other-context"; },
    (o) => { o.originatingResponse.sha256 = "0".repeat(64); }, (o) => { o.scopeObservation.after = "new-scope"; },
    (o) => { o.urlObservation.after.query = { token: "untrusted" }; },
    (o) => { o.readInterval.finishedAt = o.readInterval.startedAt + 15001; },
  ]) { const o = structuredClone(observation); mutate(o); assert.throws(() => replayBrowserDOM(o, expected)); }
  const later = await collectBrowserDOM(f.page, { ...expectation(observation), observer: undefined }).catch(() => null);
  assert.equal(later, null); // Extra identity/source fields are not collector configuration.
  await f.page.locator("h1").evaluate((el) => { el.textContent = "Public later title"; });
  const live = await collectBrowserDOM(f.page, { context: observation.context, case: observation.case, action: observation.action, scope: observation.scope, originatingResponse: observation.originatingResponse });
  assert.notEqual(live.observer, observation.observer); assert.equal(live.originatingResponse.sha256, observation.originatingResponse.sha256);
  assert.equal(replayBrowserDOM(live, expectation(live)).page.title, "Public later title");
});
function sealedBrowserDOM(t, observation) {
  const { root, store } = fixture(t), expected = expectation(observation);
  const ref = store.record("dom", retainBrowserDOMProjection(store, observation, expected)); store.seal();
  const reader = openEvidence(root), result = replayResponse(reader, reader.json(ref), expected); reader.finish(); return result;
}

function interceptDOMSession(page, hook) {
  const context = page.context(), original = context.newCDPSession;
  context.newCDPSession = async function (target) {
    const session = await original.call(this, target), send = session.send.bind(session);
    session.send = async (method, params) => { await hook(method, params, session); return send(method, params); };
    return session;
  };
  return () => { context.newCDPSession = original; };
}

test("fixed public offers field is not a private substring exception outside its exact native contract", async (t) => {
  const f = await browserDOMFixture(t);
  for (const variant of ["public", "wrong-name", "outside-form", "extra-attribute", "live-private", "duplicate", "other-private-all", "missing-query", "wrong-action"]) await t.test(variant, async () => {
    const { identity } = await f.read(`/marketplace/en-US/item_2${variant === "missing-query" ? "" : "?offers=all"}`);
    await f.page.evaluate((variant) => {
      const form = document.querySelector(".marketplace__listings form"), field = document.createElement("input");
      field.type = "hidden"; field.name = "offers"; field.value = "all"; form.append(field);
      if (variant === "wrong-name") field.name = "csrf";
      if (variant === "outside-form") document.body.append(field);
      if (variant === "extra-attribute") field.setAttribute("data-private", "offers-private-canary");
      if (variant === "live-private") { field.value = "offers-private-canary"; document.querySelector("article label").htmlFor = field.value; }
      if (variant === "duplicate") form.append(field.cloneNode());
      if (variant === "other-private-all") { const other = field.cloneNode(); other.name = "csrf"; document.body.append(other); }
      if (variant === "wrong-action") form.action = "/marketplace/en-US/item_3";
    }, variant);
    const observation = await collectBrowserDOM(f.page, identity), result = sealedBrowserDOM(t, observation);
    if (variant === "public") { assert.equal(observation.failure, null); assert.equal(result.extractionComplete, true); comparePage(result.page, records().item_2, "en-US"); }
    else { assert.equal(result.extractionComplete, false); assert.deepEqual(observation.events, []); assert.doesNotMatch(JSON.stringify(observation), /offers-private-canary/); }
  });
});

test("native boundary refuses declarative and imperative author roots without private guard retention", async (t) => {
  const f = await browserDOMFixture(t);
  for (const mode of ["open", "closed"]) for (const [kind, source] of [
    ["input", '<input type="hidden" value="TOKEN">'], ["meta", '<meta content="TOKEN">'],
    ["textarea", '<textarea hidden>TOKEN</textarea>'], ["nested-template", '<template><input type="hidden" value="TOKEN"></template>'],
  ]) await t.test(`declarative-${mode}/${kind}`, async () => {
    const token = `native-shadow-${mode}-${kind}-canary`;
    f.setBody(referenceHtml(records().item_2, "en-US").replace("</body>",
      `<div><template shadowrootmode="${mode}">${source.replaceAll("TOKEN", token)}</template></div></body>`));
    const { identity } = await f.read();
    await f.page.evaluate((token) => { document.querySelector("article label").htmlFor = token; }, token);
    comparePage(await f.page.evaluate(snapshotPage), records().item_2, "en-US");
    const observation = await collectBrowserDOM(f.page, identity), result = sealedBrowserDOM(t, observation);
    assert.equal(result.extractionComplete, false); assert.deepEqual(observation.events, []);
    assert.ok(!JSON.stringify(observation).includes(token));
  });
  for (const mode of ["open", "closed"]) for (const inert of [false, true]) await t.test(`imperative-${mode}/inert-${inert}`, async () => {
    const token = `native-imperative-${mode}-canary`;
    f.setBody(referenceHtml(records().item_2, "en-US").replace("</body>",
      inert ? '<template id="private-template"><template><div></div></template></template></body>' : '<div id="private-host"></div></body>'));
    const { identity } = await f.read();
    await f.page.evaluate(({ mode, inert, token }) => {
      const host = inert ? document.querySelector("#private-template").content.querySelector("template").content.querySelector("div") : document.querySelector("#private-host");
      const root = host.attachShadow({ mode }), field = document.createElement("input"); field.type = "hidden"; field.value = token; root.append(field);
      document.querySelector("article label").htmlFor = token;
      if (mode === "closed" && host.shadowRoot !== null) throw Error("closed root control");
    }, { mode, inert, token });
    comparePage(await f.page.evaluate(snapshotPage), records().item_2, "en-US");
    const observation = await collectBrowserDOM(f.page, identity);
    assert.equal(sealedBrowserDOM(t, observation).extractionComplete, false); assert.deepEqual(observation.events, []);
    assert.ok(!JSON.stringify(observation).includes(token));
  });
});

test("native boundary retains complete typed population and UA roots but rejects substituted native receipts", async (t) => {
  const f = await browserDOMFixture(t);
  f.setBody(referenceHtml(records().item_2, "en-US").replace("</body>", '<input type="date"><input type="range"><template><template><input type="password" value="ua-private-canary"></template></template></body>'));
  const { observation } = await f.read(), expected = expectation(observation), b = observation.boundaryObservation;
  assert.equal(observation.failure, null); comparePage(sealedBrowserDOM(t, observation).page, records().item_2, "en-US");
  const members = b.commands.flatMap((c) => c.nodes ?? []);
  assert.ok(members.some((n) => n.shadowRoots.some((r) => r.type === "user-agent")));
  assert.equal(members.filter((n) => n.kind === "template").length, 2);
  assert.doesNotMatch(JSON.stringify(observation), /ua-private-canary|"nodeValue"|"attributes"|"documentURL"/);
  for (const mutate of [
    (o) => { delete o.boundaryObservation; }, (o) => { o.boundaryObservation = null; },
    (o) => { o.boundaryObservation.observer = randomUUID(); },
    (o) => { o.boundaryObservation.document.backendNodeId++; },
    (o) => { o.boundaryObservation.document.frameId = "other-frame"; },
    (o) => { o.boundaryObservation.commands.splice(5, 1); },
    (o) => { o.boundaryObservation.commands.push({ method: "DOM.disable" }); },
    (o) => { o.boundaryObservation.commands.find((c) => c.role === "mutation-start").result.roots++; },
    (o) => { o.boundaryObservation.commands.find((c) => c.role === "mutation-check" && c.result).result.mutations.push("changed"); },
    (o) => { o.boundaryObservation.commands.find((c) => c.role === "semantic-read" && c.observer).observer = randomUUID(); },
    (o) => { o.boundaryObservation.commands.find((c) => c.role === "mutation-check").executionContextId++; },
    (o) => { o.boundaryObservation.commands.find((c) => c.method === "DOM.requestChildNodes").nodeId++; },
    (o) => { o.boundaryObservation.commands.find((c) => c.nodes?.length).nodes[0].attributes = []; },
    (o) => { o.boundaryObservation.commands.find((c) => c.nodes?.length).nodes[0].childNodeCount++; },
    (o) => { const c = o.boundaryObservation.commands.find((c) => c.nodes?.some((n) => n.shadowRoots.length)); c.nodes.find((n) => n.shadowRoots.length).shadowRoots[0].type = "closed"; },
    (o) => { const c = o.boundaryObservation.commands.find((c) => c.nodes?.some((n) => n.templateContent)); c.nodes.find((n) => n.templateContent).templateContent = 999999; },
    (o) => { o.snapshotSha256 = "220e441a44d3fdd628383d1cd891b347e2f2d56d3c393652fcb2e1a86d735696"; },
  ]) { const changed = structuredClone(observation); mutate(changed); assert.throws(() => replayBrowserDOM(changed, expected)); }
  const changed = structuredClone(observation), native = changed.boundaryObservation.commands.flatMap((c) => c.nodes ?? []).find((n) => n.nodeType === 3);
  native.backendNodeId += 1000000;
  assert.deepEqual(replayBrowserDOM(changed, expected), replayBrowserDOM(observation, expected));
  const { root, store } = fixture(t), receipt = retainBrowserDOMProjection(store, observation, expected); store.record("dom", receipt); store.seal();
  writeFileSync(join(root, receipt.body.path), encoded(changed)); assert.throws(() => openEvidence(root));
});

test("native boundary refuses incomplete population observer loss and over-bound native nodes", async (t) => {
  const f = await browserDOMFixture(t);
  for (const variant of ["missing-child-reply", "detached-session", "node-bound"]) await t.test(variant, async () => {
    f.setBody(referenceHtml(records().item_2, "en-US")); const { identity } = await f.read(); let acted = false;
    const restore = interceptDOMSession(f.page, async (method, _params, session) => {
      if (acted) return;
      if (variant === "detached-session" && method === "DOM.resolveNode") { acted = true; await session.detach(); }
      if (variant === "node-bound" && method === "DOM.getDocument") {
        acted = true; await f.page.evaluate(() => { for (let i = 0; i < 10000; i++) document.body.append(document.createElement("span")); });
      }
      if (variant === "missing-child-reply" && method === "DOM.getDocument") { acted = true; session.removeAllListeners("DOM.setChildNodes"); }
    });
    let observation; try { observation = await collectBrowserDOM(f.page, identity); } finally { restore(); }
    assert.equal(acted, true); assert.equal(sealedBrowserDOM(t, observation).extractionComplete, false); assert.deepEqual(observation.events, []);
  });
});

test("native boundary refuses shadow-mediated missing text even when correctly slotted", async (t) => {
  const f = await browserDOMFixture(t);
  for (const mode of ["open", "closed"]) for (const shadow of ["", "<span>Other page</span>", "<slot></slot>"]) await t.test(`${mode}/${shadow || "empty"}`, async () => {
    f.setBody(`<body><div role="alert">Not found<template shadowrootmode="${mode}">${shadow}</template></div></body>`);
    const { observation, response } = await f.read("/marketplace/en-US/item_missing"); assert.equal(response.status(), 404);
    assert.equal(sealedBrowserDOM(t, observation).extractionComplete, false); assert.deepEqual(observation.events, []);
  });
});

test("native boundary refuses frame owners including inert same and cross origin subdocuments", async (t) => {
  const f = await browserDOMFixture(t);
  for (const source of ['<iframe srcdoc="<h1>Other page</h1>"></iframe>', '<iframe src="http://localhost/native-frame-public"></iframe>',
    '<iframe src="http://localhost:9/cross-origin"></iframe>', '<template><template><iframe></iframe></template></template>',
    '<object data="about:blank"></object>', '<embed src="about:blank">']) await t.test(source.split(" ")[0], async () => {
    f.setBody(referenceHtml(records().item_2, "en-US").replace("</body>", `${source}</body>`));
    const { observation } = await f.read(); comparePage(await f.page.evaluate(snapshotPage), records().item_2, "en-US");
    assert.equal(sealedBrowserDOM(t, observation).extractionComplete, false); assert.deepEqual(observation.events, []);
  });
});

test("native boundary covers transient changes before incremental child population", async (t) => {
  const f = await browserDOMFixture(t);
  for (const depth of [0, 1, 2]) await t.test(`unpopulated-depth-${depth}`, async () => {
    f.setBody(referenceHtml(records().item_2, "en-US").replace("</body>", '<template id="native-template"><div></div><template><div></div></template></template></body>'));
    const { identity } = await f.read(); let injected = false;
    const restore = interceptDOMSession(f.page, async (method) => {
      if (method !== "DOM.requestChildNodes" || injected) return; injected = true;
      await f.page.evaluate((depth) => {
        let parent = depth ? document.querySelector("#native-template").content : document.body;
        if (depth === 2) parent = parent.querySelector("template").content;
        const host = parent.appendChild(document.createElement("div")), root = host.attachShadow({ mode: "closed" });
        const field = document.createElement("input"); field.type = "hidden"; field.value = "unpopulated-private-canary"; root.append(field);
        document.querySelector("article label").htmlFor = field.value; host.remove();
      }, depth);
    });
    let observation; try { observation = await collectBrowserDOM(f.page, identity); } finally { restore(); }
    comparePage(await f.page.evaluate(snapshotPage), records().item_2, "en-US");
    assert.equal(injected, true); assert.equal(sealedBrowserDOM(t, observation).extractionComplete, false); assert.deepEqual(observation.events, []);
    assert.doesNotMatch(JSON.stringify(observation), /unpopulated-private-canary/);
  });
});

test("native boundary rejects transient roots and replacement across the actual subscribed read window", async (t) => {
  const f = await browserDOMFixture(t);
  for (const phase of ["DOM.resolveNode", "Runtime.callFunctionOn", "DOM.describeNode"]) for (const change of ["append-remove", "existing-closed", "inert-append-remove", "inert-existing-closed", "replace-document"]) await t.test(`${phase}/${change}`, async () => {
    f.setBody(referenceHtml(records().item_2, "en-US").replace("</body>", '<div id="native-host"></div><template id="native-template"><div></div></template></body>'));
    const { identity } = await f.read(); let injected = false;
    const restore = interceptDOMSession(f.page, async (method, params) => {
      if (method !== phase || injected || method === "Runtime.callFunctionOn" && !params.objectId) return; injected = true;
      await f.page.evaluate((change) => {
        if (change === "replace-document") { document.open(); document.write("<body><h1>Not found</h1></body>"); document.close(); return; }
        const inert = change.startsWith("inert-"), parent = inert ? document.querySelector("#native-template").content : document.body;
        const host = change.endsWith("append-remove") ? parent.appendChild(document.createElement("div")) : inert ? parent.querySelector("div") : document.querySelector("#native-host");
        host.attachShadow({ mode: "closed" }); if (change.endsWith("append-remove")) host.remove();
      }, change);
    });
    let observation;
    try { observation = await collectBrowserDOM(f.page, identity); } finally { restore(); }
    assert.equal(injected, true); assert.equal(sealedBrowserDOM(t, observation).extractionComplete, false);
    assert.deepEqual(observation.events, []);
  });
});

test("public JSON and asset bytes replay exact original bytes with independent binding", (t) => {
  const { root, store } = fixture(t), body = Buffer.from('[ {"email":"native@example.test","item_id":"item_1","target_minor":125} ]');
  const json = retainPublicJSON(store, body, "state", bind(body)), js = Buffer.from('export const value = 1;\n'), assetBinding = bind(js, "/assets/native.js");
  const asset = retainPublicAsset(store, js, assetBinding, "text/javascript"); store.seal(); const reader = openEvidence(root);
  assert.deepEqual(replayResponse(reader, json, bind(body)).value, JSON.parse(body));
  assert.equal(replayResponse(reader, asset, assetBinding).sha256, sha256(js)); reader.finish();
  assert.throws(() => replayResponse(reader, json, { ...bind(body), requestId: "other" }));
  assert.throws(() => replayResponse(reader, asset, { ...assetBinding, responseSha256: "0".repeat(64) }));
});
test("raw HTML, unknown JSON, credential keys and query-bearing transport bodies are refused before storage", (t) => {
  const { store } = fixture(t);
  for (const body of ['{"session":"private-canary"}', '[{"email":"native@example.test","item_id":"item_1","target_minor":1,"csrf":"private-canary"}]', '{"email":1,"email":2}'])
    assert.throws(() => retainPublicJSON(store, Buffer.from(body), "state", bind(body)));
  const html = Buffer.from('<input type="hidden" value="private-canary">');
  assert.throws(() => retainPublicAsset(store, html, bind(html, "/native.html"), "text/html"));
  assert.throws(() => retainPublicAsset(store, html, bind(html, "/a.js?token=private-canary"), "text/javascript"));
  assert.equal(store.files.size, 0);
});
test("native Chromium public semantic read transcript is typed projection, never raw HTML or CSRF", async (t) => {
  const { root, store } = fixture(t), browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false }), page = await context.newPage();
    const html = referenceHtml(records().item_1, "en-US").replace("</body>", '<input type="hidden" value="native-secret-canary"></body>');
    const path = "/marketplace/en-US/item_1";
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`http://localhost${path}`);
    const transcript = await page.evaluate(collectDOMReads, { source: snapshotMixedPage.toString(), readPath: path });
    assert.equal(transcript.failure, null); assert.doesNotMatch(JSON.stringify(transcript), /native-secret-canary/);
    const binding = bind(html, path), receipt = retainDOMProjection(store, transcript, binding);
    const ref = store.record("response", receipt); store.seal(); const reader = openEvidence(root);
    assert.equal(replayResponse(reader, reader.json(ref), binding).extractionComplete, true); reader.finish();
    assert.equal(receipt.type, "public-dom-read-projection"); assert.notEqual(receipt.body.sha256, binding.responseSha256);
    const v = structuredClone(receipt); v.page.title = "forged"; assert.throws(() => replayResponse(reader, v, binding));
    await context.close();
  } finally { await browser.close(); }
});
