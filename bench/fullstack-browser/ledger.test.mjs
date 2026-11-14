// Apparatus evidence only, not a contender or manufactured positive oracle capture.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { reconcileRequests } from "./ledger.mjs";
import { createUpstream, UpstreamAudit, reconcileUpstream, upstreamDelta } from "./upstream.mjs";
import { observeNetwork } from "./observe.mjs";
import { installResourceObserver, ResourceAudit } from "./resources.mjs";
import { mutationProbes } from "./probes.mjs";
import { runJourney } from "./journey.mjs";

const request = (id) => ({ id, method: "GET", path: "/actual", status: 200, completed: true, failure: null, input: null });
const evidence = () => ({ steps: [{ action: { id: "arrival" }, requests: [request("arrival")] }],
  nativeCleanup: { requests: [request("away")], probe: { requests: [] } }, requestLedger: [request("arrival"), request("away")], networkFailures: [], runtimeErrors: [] });
test("all final IDs and outcomes reconcile once, with no abort or capture-error waiver", () => {
  assert.equal(reconcileRequests(evidence()).outcome, "reconciled");
  for (const change of [
    (e) => e.requestLedger.push(request("late-success")),
    (e) => e.requestLedger.push({ ...request("late-post"), method: "POST", completed: false, failure: "net::ERR_ABORTED", captureError: "missing body" }),
    (e) => { e.requestLedger[0].status = 201; },
    (e) => { e.requestLedger[0].bodySha256 = "late-body"; },
    (e) => { e.requestLedger[0].captureError = "body unavailable"; },
    (e) => { e.requestLedger[0].failure = "blocked"; e.requestLedger[0].intentionallyDisabledPreload = true; },
    (e) => e.requestLedger.pop(),
    (e) => e.requestLedger.push(request("arrival")),
    (e) => e.steps[0].requests.push(request("away")),
    (e) => { delete e.requestLedger; },
    (e) => { delete e.nativeCleanup.requests; },
    (e) => e.networkFailures.push("late observer failure"),
    (e) => e.runtimeErrors.push("late browser error"),
  ]) {
    const e = evidence(); change(e);
    assert.equal(reconcileRequests(e).outcome, "unknown", JSON.stringify(e));
  }
});

async function listen(server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }

test("unavailable upstream counters retain errors, not invented zero outcomes", async () => {
  const audit = new UpstreamAudit(async () => { throw new Error("counter endpoint unavailable"); });
  await audit.start();
  for (const phase of ["initial-store", "mutation-probes", "cleanup"]) await assert.rejects(audit.end(await audit.begin(phase)), /counters/);
  await audit.finish();
  assert.equal(audit.ledger.terminal.snapshot, null); assert.equal(audit.ledger.terminal.error, "counter endpoint unavailable");
  assert.equal(reconcileUpstream(audit.ledger, { source: "fixture", actions: [] }).outcome, "unknown");
  assert.throws(() => upstreamDelta({ events: [] }, { events: [] }), /counters/);
});

test("browser cleanup and mutation probes retain real final request and upstream receipts", { timeout: 30000 }, async () => {
  const upstream = createUpstream({ item_1: { id: "item_1", numeric: 125 } });
  const source = await listen(upstream);
  const app = createServer(async (req, res) => {
    if (req.url === "/api/alerts") { res.setHeader("content-type", "application/json"); res.end("[]"); return; }
    if (req.url === "/late-failure") { req.socket.destroy(); return; }
    await (await fetch(source + "/marketplace/records/item_1")).arrayBuffer();
    if (req.method === "POST") { res.writeHead(req.url.endsWith("item_missing") ? 404 : 403); res.end("Rejected"); return; }
    if (req.url === "/cleanup") { await new Promise((resolve) => setTimeout(resolve, 250)); res.end("Away"); return; }
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><header><a href="/">Away</a></header><article class="marketplace"><div class="marketplace__alert"><form method="post" action="/marketplace/en-US/item_1"><input name="email"><input name="target_price"><button>Submit</button></form></div></article><script>
      const root = document.querySelector('article');
      document.querySelector('header a').addEventListener('click', async event => {
        event.preventDefault();
        await (await fetch('/cleanup')).text();
        root.remove();
      }, { once: true });
    </script>`);
  });
  let browser;
  try {
    const base = await listen(app), audit = new UpstreamAudit(async () => (await fetch(source + "/__browser/counters")).json());
    await audit.start();
    browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      await context.addInitScript(installResourceObserver);
      const page = await context.newPage(), cdp = await context.newCDPSession(page), network = observeNetwork(page);
      const resources = new ResourceAudit(page, cdp, true);
      const initial = await audit.begin("initial-store"); await context.request.get(base + "/api/alerts"); await audit.end(initial);
      const arrival = await audit.begin("arrival"); await page.goto(base); await network.drain(); await audit.end(arrival);
      const rows = structuredClone(network.rows);
      const probePhase = await audit.begin("mutation-probes");
      const probes = await mutationProbes({ browser, context, page, base, readback: { path: "/api/alerts" },
        profile: { key: "apparatus", steps: [{ kind: "accepted-write", input: { target_price: "1.25" } }, { itemId: "item_1" }] } });
      assert.deepEqual(probes.failures, []); assert.equal((await audit.end(probePhase)).completed, 3);
      const cleanupPhase = await audit.begin("cleanup");
      const cleanup = await resources.cleanup({ timeoutMs: 5000, observationMs: 25, network, runtimeErrors: [] });
      if (cleanup.outcome !== "observed") {
        const folder = new URL("./work/diagnostics/", import.meta.url);
        await mkdir(folder, { recursive: true });
        await writeFile(new URL(`ledger-cleanup-${Date.now()}-${process.pid}.json`, folder), JSON.stringify(cleanup, null, 2));
      }
      assert.equal(cleanup.outcome, "observed", JSON.stringify(cleanup.failures));
      assert.equal((await audit.end(cleanupPhase)).completed, 1);
      assert.ok(cleanup.requests.some((r) => r.path === "/cleanup" && r.completed));
      await new Promise((resolve) => setTimeout(resolve, 25)); await audit.finish();
      const options = { source: "api", actions: ["arrival"], observationMs: 25 };
      const proof = reconcileUpstream(audit.ledger, options);
      assert.equal(proof.outcome, "reconciled", JSON.stringify(proof.reasons)); assert.equal(proof.final.completed, 5);
      const raw = { steps: [{ action: { id: "arrival" }, requests: rows }], nativeCleanup: cleanup, requestLedger: structuredClone(network.rows), networkFailures: [], runtimeErrors: [] };
      assert.equal(reconcileRequests(raw).outcome, "reconciled", JSON.stringify(reconcileRequests(raw).reasons));

      // Mutate actual server snapshots, not synthetic zero/closure evidence.
      for (const mutate of [
        (l) => { l.terminal = null; },
        (l) => { l.phases.splice(2, 1); },
        (l) => { l.terminal.snapshot.events.pop(); },
        (l) => { l.terminal.snapshot.ledger = "restarted"; },
        (l) => { l.terminal.snapshot.events[0].completed++; },
        (l) => { l.terminal.snapshot.events[0].cancelled = l.terminal.snapshot.events[0].started; },
        (l) => { delete l.terminal.snapshot.events[0].completed; },
        (l) => { l.phases[2].before.snapshot = structuredClone(l.phases[2].after.snapshot); },
        (l) => { l.phases[3].before.snapshot = structuredClone(l.phases[3].after.snapshot); },
        (l) => { l.phases[2].after.snapshot.events.at(-1).completed = null; },
        (l) => { l.phases[3].after.snapshot.events.at(-1).completed = null; },
      ]) {
        const altered = structuredClone(audit.ledger); mutate(altered);
        assert.equal(reconcileUpstream(altered, options).outcome, "unknown");
      }
      assert.equal(reconcileUpstream(audit.ledger, { ...options, source: "fixture" }).outcome, "unknown");
      await context.request.get(base + "/cleanup"); await audit.finish();
      assert.match(reconcileUpstream(audit.ledger, options).reasons.join(" "), /Late unassigned upstream/);
      await page.evaluate(() => fetch("/late-failure", { method: "POST" }).catch(() => {})); await network.drain();
      raw.requestLedger = structuredClone(network.rows);
      assert.equal(reconcileRequests(raw).outcome, "unknown");
      assert.ok(raw.requestLedger.some((r) => r.method === "POST" && r.failure));

      // The deliberately incomplete page fails semantics; even that journey must
      // retain actual terminal ledgers and keep harness closure separate.
      const failed = await runJourney({ browser, app: "nuxt", base, records: {}, readback: { path: "/api/alerts" }, counters: audit.counters,
        profile: { key: "apparatus", device: "desktop", js: true, source: "api", locale: "en-US",
          steps: [{ id: "arrival", kind: "initial", path: "/", itemId: "item_1", query: {} }] } });
      assert.equal(failed.outcome, "failed"); assert.equal(failed.qualificationPassed, false);
      const e = failed.evidence;
      assert.ok(e.failures.length); assert.ok(e.upstreamLedger.terminal.snapshot.events.length);
      assert.deepEqual(e.upstreamLedger.phases.map((p) => p.phase), ["initial-store", "arrival", "mutation-probes", "cleanup"]);
      assert.equal(e.upstreamReconciliation.outcome, "reconciled", JSON.stringify(e.upstreamReconciliation.reasons));
      assert.equal(e.requestReconciliation.outcome, "reconciled", JSON.stringify(e.requestReconciliation.reasons));
      assert.ok(e.requestLedger.some((r) => r.path === "/cleanup" && r.completed));
      assert.equal(e.cleanup.contextClosed, true); assert.ok(Array.isArray(e.harnessClosedRequestLedger));
    } finally { await context.close(); }
  } finally { if (browser) await browser.close(); await close(app); await close(upstream); }
});
