// Opt-in bounded control against an independently built, unchanged native image.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { command, OwnedDocker } from "./run.mjs";
import { bindingArtifactFromImage } from "./binding-image.mjs";
import { BindingLinkObserver } from "./binding-links.mjs";
import { discoverReactEndpoint } from "./bindings.mjs";
import { checkBindingEffects } from "./binding-effects.mjs";
import { records } from "../marketplace/fixtures.mjs";
import ts from "typescript";
import { createBindingArtifact, indexBindingArtifact, bindingHash } from "./binding-artifact.mjs";
import { replayBindingProof } from "./bindings.mjs";
import { emittedModules } from "./binding-modules.mjs";
import { nativeForm } from "./observe.mjs";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PlatformLifecycle } from "./lifecycle.mjs";
import { installResourceObserver, ResourceAudit } from "./resources.mjs";
import { beginBindingWindow, finishBindingWindow, replayActionBinding, validateBindingClockPhase } from "./binding-window.mjs";

// Only the ordinary case uses unchanged image bytes. Intercepted emitted-bundle
// controls have separate, explicitly synthetic identities and never qualify an
// image. They still execute the real React mount and native submit function.
function controlArtifact(artifact, linked, mode) {
  if (mode === "ordinary") return artifact;
  const index = indexBindingArtifact(artifact), root = index.functions.get(linked.component), script = root.script;
  const edits = [], insert = (at, value) => edits.push([at, at, value]);
  const returned = root.node.body.statements.at(-1).expression;
  const rootProps = returned.arguments[1], children = rootProps.properties.find((p) => p.name?.text === "children").initializer;
  let form;
  const scan = (node) => {
    if (ts.isCallExpression(node) && node.arguments[0]?.text === "form" && ts.isObjectLiteralExpression(node.arguments[1])
      && node.arguments[1].properties.some((p) => p.name?.text === "onSubmit")) form = node;
    ts.forEachChild(node, scan);
  };
  scan(root.node); assert.ok(form);
  const retain = "bindingRetain(e)", declaration = 'const bindingRetain=value=>{document.addEventListener("submit",()=>{value.id="item_1"},{capture:true,once:true});return null;};';
  if (["earlier sibling", "later sibling", "ancestor prop", "form prop", "initializer", "callback"].includes(mode)) {
    insert(root.node.body.getStart() + 1, declaration);
    if (mode === "earlier sibling") insert(children.getStart() + 1, retain + ",");
    if (mode === "later sibling") insert(children.end - 1, "," + retain);
    if (mode === "ancestor prop") insert(rootProps.getStart() + 1, `bindingEffect:${retain},`);
    if (mode === "form prop") insert(form.arguments[1].getStart() + 1, `bindingEffect:${retain},`);
    if (mode === "initializer") insert(root.node.body.getStart() + 1, `const bindingEffect=${retain};`);
    if (mode === "callback") insert(root.node.body.getStart() + 1, 'const bindingEffect=[e].map(value=>bindingRetain(value));');
  } else if (mode === "renamed safe helper") {
    const helper = script.functions.find((f) => ts.isFunctionDeclaration(f.node) && f.node.name?.text === "l" && f.start < root.start);
    assert.ok(helper);
    // Rename every lexical identifier with the same spelling to one fresh name;
    // property keys are not bindings and remain unchanged.
    const rename = (node) => {
      if (ts.isIdentifier(node) && node.text === "l" && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
        && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) edits.push([node.getStart(), node.end, "nativeSafeHelperRenamed"]);
      ts.forEachChild(node, rename);
    };
    rename(emittedModules(index).owner(root).node);
  } else if (["effectful helper substitution", "dependency initializer", "dispatcher dependency"].includes(mode)) {
    const helper = script.functions.find((f) => ts.isFunctionDeclaration(f.node) && f.node.name?.text === "l" && f.start < root.start);
    assert.ok(helper);
    const effect = 'document.addEventListener("submit",event=>{const form=event.target;let fiber=form[Object.keys(form).find(key=>key.startsWith("__reactFiber$"))];for(;fiber;fiber=fiber.return)if(fiber.memoizedProps?.record){fiber.memoizedProps.record.id="item_1";break}},{capture:true,once:true});';
    if (mode === "effectful helper substitution") insert(helper.node.body.getStart() + 1, effect);
    else {
      const target = emittedModules(index).modules.get(mode === "dispatcher dependency" ? "11829" : "20955"); assert.ok(target?.length);
      const scripts = artifact.scripts.map((s) => {
        let source = s.source;
        for (const factory of target.filter((f) => f.script.path === s.path).sort((a, b) => b.start - a.start)) {
          const at = factory.node.body.getStart() + 1; source = source.slice(0, at) + effect + source.slice(at);
        }
        return { path: s.path, source };
      });
      return createBindingArtifact({ imageId: `sha256:${bindingHash("synthetic-native-bundle-control:" + mode)}`, sourceCommit: "0".repeat(40), scripts });
    }
  } else assert.fail("Unknown production control");
  let source = script.source;
  for (const [start, end, value] of edits.map((edit, i) => [...edit, i]).sort((a, b) => b[0] - a[0] || b[3] - a[3])) source = source.slice(0, start) + value + source.slice(end);
  return createBindingArtifact({ imageId: `sha256:${bindingHash("synthetic-native-bundle-control:" + mode)}`, sourceCommit: "0".repeat(40),
    scripts: artifact.scripts.map((s) => ({ path: s.path, source: s.path === script.path ? source : s.source })) });
}

test("production Next: immutable native page links and independently POSTs requested record", {
  skip: !process.env.BINDING_NEXT_IMAGE, timeout: 180000,
}, async (t) => {
  const info = JSON.parse(await command("docker", ["image", "inspect", process.env.BINDING_NEXT_IMAGE]))[0];
  const commit = info.Config.Labels["run.corten.browser.commit"];
  const owned = new OwnedDocker("browser-b17d1e00"), scratch = mkdtempSync(join(tmpdir(), "binding-native-")), fixture = join(scratch, "marketplace.json");
  writeFileSync(fixture, JSON.stringify(records()));
  let browser;
  try {
    const artifact = await bindingArtifactFromImage(command, { imageId: info.Id, sourceCommit: commit, task: owned.task });
    const id = await owned.start(owned.task, ["-p", "127.0.0.1::8080", "-e", "MARKETPLACE_SOURCE=fixture", "-e", "MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json", "--mount", `type=bind,source=${fixture},target=/fixtures/marketplace.json,readonly`], info.Id);
    const address = JSON.parse(await command("docker", ["inspect", id]))[0].NetworkSettings.Ports["8080/tcp"][0];
    const base = `http://127.0.0.1:${address.HostPort}`;
    for (let n = 0; ; n++) {
      try { if ((await fetch(base + "/api/marketplace/item_2", { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
      if (n >= 60) assert.fail("Owned native image did not become ready: " + await command("docker", ["logs", id]));
      await new Promise((r) => setTimeout(r, 250));
    }
    browser = await chromium.launch({ headless: true });
    let originalLinks;
    assert.ok(!process.env.BINDING_NEXT_ORDINARY_ONLY || process.env.BINDING_NEXT_ORDINARY_ONLY === "1", "Unknown production control selector");
    const modes = process.env.BINDING_NEXT_ORDINARY_ONLY ? ["ordinary"] : ["ordinary", "earlier sibling", "later sibling", "ancestor prop", "form prop", "initializer", "callback", "renamed safe helper", "effectful helper substitution", "dependency initializer", "dispatcher dependency"];
    for (const mode of modes) await t.test(mode, { timeout: mode === "ordinary" ? 60000 : 30000 }, async () => {
    const activeArtifact = controlArtifact(artifact, originalLinks, mode);
    const context = await browser.newContext(), page = await context.newPage(), posts = [], errors = [];
    await context.addInitScript(installResourceObserver);
    if (mode !== "ordinary") await page.route("**/_next/static/chunks/*.js", async (route) => {
      const script = activeArtifact.scripts.find((s) => s.path === new URL(route.request().url()).pathname);
      if (script) await route.fulfill({ status: 200, contentType: "text/javascript", body: script.source }); else await route.continue();
    });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => { if (r.method() === "POST") posts.push({ method: r.method(), path: new URL(r.url()).pathname, query: new URL(r.url()).search, input: r.postData() }); });
    const cdp = await context.newCDPSession(page), observer = new BindingLinkObserver(cdp, activeArtifact); await observer.enable();
    const lifecycle = new PlatformLifecycle(cdp, await browser.newBrowserCDPSession(), { javaScriptEnabled: true });
    const resources = new ResourceAudit(page, cdp, true, lifecycle);
    const evidence = { bindingInstance: randomUUID(), clock: { startedAt: performance.now() }, steps: [] };
    await lifecycle.enable(); await lifecycle.enableDomains(); await lifecycle.startObservation(); lifecycle.markApplicationStart();
    try {
      await page.goto(base + "/marketplace/fr-FR/item_2");
      await page.waitForFunction(() => window.next?.router?.isReady === true);
      const row = { action: { id: "ordinary-submit" }, at: performance.now() - evidence.clock.startedAt };
      evidence.steps.push(row);
      if (mode === "ordinary") row.bindingWindow = await beginBindingWindow(cdp, lifecycle, resources,
        { instance: evidence.bindingInstance, case: "production-native-control", action: row.action.id });
      const observed = await observer.capture(".marketplace__alert form", page.url(), row.bindingWindow);
      row.formBefore = { enhancement: observed.outcome === "observed" ? discoverReactEndpoint([observed.candidate], observed.linked) : null };
      if (row.bindingWindow) await finishBindingWindow(lifecycle, row.bindingWindow, row.formBefore.enhancement);
      const effects = observed.outcome === "observed" ? checkBindingEffects(observed.candidate, activeArtifact, observed.receipt) : observed;
      if (mode === "ordinary") originalLinks = observed.receipt;
      if (mode === "ordinary") {
        const native = await nativeForm(page, { form: { method: "POST", action: "/marketplace/fr-FR/item_2", fields: ["email", "target_price"] } }, "nextjs", true, cdp);
        assert.equal(native.bindingObservation.outcome, "proved", native.bindingObservation.reason);
        assert.equal(replayBindingProof(native.enhancement, activeArtifact), true);
      }
      if (process.env.BINDING_DEBUG) {
        const path = fileURLToPath(new URL("./work/production-binding/", import.meta.url)); mkdirSync(path, { recursive: true });
        writeFileSync(path + "artifact.json", JSON.stringify(artifact)); writeFileSync(path + "observed.json", JSON.stringify(observed));
      }
      const form = page.locator(".marketplace__alert form");
      row.dispatchStartedAt = performance.now();
      await form.locator('[name="email"]').fill("binding-native@example.test");
      await form.locator('[name="target_price"]').fill("1,25");
      const response = page.waitForResponse((r) => r.request().method() === "POST");
      await form.locator('button[type="submit"]').click(); assert.equal((await response).status(), 200);
      row.resourcesAtDOM = await resources.checkpoint();
      const positive = ["ordinary", "renamed safe helper"].includes(mode);
      assert.deepEqual(posts.map(({ method, path, query }) => ({ method, path, query })), [{ method: "POST", path: `/api/marketplace/${positive ? "item_2" : "item_1"}`, query: "?locale=fr-FR" }]);
      assert.deepEqual(errors, []);
      assert.equal(observed.outcome, "observed", observed.reason);
      const discovered = discoverReactEndpoint([observed.candidate], observed.linked);
      if (!positive) { assert.equal(effects.outcome, "unknown"); assert.equal(discovered, null); }
      else {
        assert.equal(effects.outcome, "proved", effects.reason);
        assert.equal(discovered?.path, "/api/marketplace/item_2");
        assert.equal(replayBindingProof(discovered, activeArtifact), true);
        if (mode === "ordinary") {
          await lifecycle.finishObservation({ observationMs: 0 }); evidence.platformLifecycle = lifecycle.snapshot();
          assert.equal(replayActionBinding(discovered, activeArtifact, evidence, row, "production-native-control"), true, "Actual production dispatch has its own native capture window");
          for (const sample of evidence.platformLifecycle.events.filter((r) => r.phase?.startsWith("binding-")))
            assert.equal(validateBindingClockPhase(sample, evidence, "production-native-control"), true, "Ordinary native proof clocks enter the same saved chronology check");
          const reject = (change) => {
            const copy = structuredClone(evidence); change(copy, copy.steps[0]);
            assert.equal(replayActionBinding(copy.steps[0].formBefore.enhancement, activeArtifact, copy, copy.steps[0], "production-native-control"), false);
          };
          reject((e) => { e.bindingInstance = randomUUID(); });
          reject((e, r) => { r.action.id = "later-submit"; });
          reject((e, r) => { r.at = r.dispatchStartedAt - e.clock.startedAt; });
          reject((e, r) => { r.bindingWindow.form.backendNodeId++; });
          reject((e, r) => { r.bindingWindow.resources.scope += "-other"; });
          reject((e, r) => { r.bindingWindow.native.uniqueId += "-other"; });
          reject((e) => { e.platformLifecycle.events = e.platformLifecycle.events.filter((r) => r.event !== "binding-observation"); });
          reject((e) => { e.platformLifecycle.events.push(structuredClone(e.platformLifecycle.events.find((r) => r.event === "binding-observation"))); });
          reject((e) => { e.steps.push(structuredClone(e.steps[0])); });
          reject((e, r) => { r.dispatchStartedAt = r.bindingWindow.startedAt; });
          const mutate = (change) => { const saved = structuredClone(discovered); change(saved.bindingProof.links); assert.equal(replayBindingProof(saved, activeArtifact), false); };
          mutate((links) => { links.hooks[1].current = true; });
          mutate((links) => { links.hooks[0].reducer = links.hooks[0].target; });
          mutate((links) => { delete links.frames.find((f) => f.function === links.handler).bindings.m; });
          mutate((links) => { links.frames.find((f) => f.function === links.handler).bindings.h.identity = 0; });
          mutate((links) => { delete links.hooks[0].fiberIdentity; });
          mutate((links) => { delete links.hooks[0].queueIdentity; });
          mutate((links) => { links.hooks[0].target.location.columnNumber++; });
          mutate((links) => { delete links.formDataFields; });
          mutate((links) => { links.formDataFields.email = "unknown"; });
          await form.locator('button[type="submit"]').waitFor({ state: "visible" });
          await page.waitForFunction(() => !document.querySelector('.marketplace__alert button').disabled);
          const settled = await observer.capture(".marketplace__alert form", page.url());
          assert.equal(settled.outcome, "observed", settled.reason);
          assert.equal(settled.receipt.hooks[0].value.type, "string", "Actual post-response state must remain linked, not assumed initial null");
          const next = discoverReactEndpoint([settled.candidate], settled.linked);
          assert.equal(next?.path, "/api/marketplace/item_2"); assert.equal(replayBindingProof(next, activeArtifact), true);
          await page.evaluate(() => {
            const form = document.querySelector('.marketplace__alert form');
            let fiber = form[Object.keys(form).find((key) => key.startsWith('__reactFiber$'))];
            while (!fiber.memoizedProps?.record) fiber = fiber.return;
            fiber.memoizedState.next.memoizedState.current = true;
          });
          const guardRow = { action: { id: "guarded-submit" }, at: performance.now() - evidence.clock.startedAt };
          evidence.steps.push(guardRow);
          guardRow.bindingWindow = await beginBindingWindow(cdp, lifecycle, resources,
            { instance: evidence.bindingInstance, case: "production-native-control", action: guardRow.action.id });
          const guarded = await observer.capture(".marketplace__alert form", page.url(), guardRow.bindingWindow);
          assert.equal(guarded.outcome, "observed", guarded.reason);
          assert.equal(guarded.receipt.hooks[1].current, true);
          assert.equal(discoverReactEndpoint([guarded.candidate], guarded.linked), null, "A live set pending ref must not attest unconditional dispatch");
          await finishBindingWindow(lifecycle, guardRow.bindingWindow, null);
          guardRow.dispatchStartedAt = performance.now();
          await form.locator('button[type="submit"]').click(); await page.waitForTimeout(250);
          guardRow.resourcesAtDOM = await resources.checkpoint();
          assert.equal(posts.length, 1, "The actual native guard returns without a POST");
          await lifecycle.finishObservation({ observationMs: 0 }); evidence.platformLifecycle = lifecycle.snapshot();
          guardRow.formBefore = { enhancement: structuredClone(discovered) };
          assert.equal(replayBindingProof(guardRow.formBefore.enhancement, activeArtifact), true, "An intact earlier proof still structurally replays: the former gap");
          assert.equal(replayActionBinding(guardRow.formBefore.enhancement, activeArtifact, evidence, guardRow, "production-native-control"), false, "The earlier intact proof cannot attest the guarded action");
        }
      }
    } finally { await observer.close(); await context.close(); await lifecycle.close(); }
    });
  } finally {
    if (browser) await browser.close(); await owned.cleanup();
    assert.equal(dirname(realpathSync(scratch)), realpathSync(tmpdir())); rmSync(scratch, { recursive: true, force: true });
  }
});
