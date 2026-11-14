// Bounded real collector controls, not fullstack application qualification.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { EvidenceStore, openEvidence } from "./native-evidence.mjs";
import { participantSnapshot, ExecutionLedger, replayExecution, collectDockerInventory } from "./native-execution.mjs";
import { PlatformLifecycle } from "./lifecycle.mjs";
import { replayWorkerAbsence, replayPeerApplicability } from "./native-lifetimes.mjs";

const commit = "0972dc632fbfe3b66012d188ecdb30250f2469bc";
const upstreamImage = "node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1";
function docker(args) {
  const result = spawnSync("docker", args, { windowsHide: true, encoding: "utf8", timeout: 30000, maxBuffer: 1024 ** 2 });
  assert.ok(!result.error); return { code: result.status, stdout: result.stdout.trim() };
}
function success(args) { const result = docker(args); assert.equal(result.code, 0, "bounded native Docker command failed"); return result.stdout; }
test("native Docker ledger closes running/failed-start/stopped artifacts and retains short-lived artifact execution", async (t) => {
  const image = JSON.parse(success(["image", "inspect", upstreamImage]))[0];
  for (const mode of ["running", "failed-start", "stopped-artifact", "exited-artifact"]) {
    const failedStart = mode === "failed-start", artifact = mode.endsWith("artifact"), role = artifact ? "artifact" : "upstream", app = artifact ? "corten" : null;
    const task = `browser-${randomUUID().slice(0, 12)}`, root = mkdtempSync(join(tmpdir(), "corten-native-control-"));
    let cid;
    try {
      const store = new EvidenceStore(root), ledger = new ExecutionLedger(store, { task, commit, startedAt: Date.now() });
      ledger.append({ event: "created", kind: "image", id: image.Id, owned: false, at: Date.now() });
      cid = success(["create", "--pull=never", "--label", "agent.owner=codex", "--label", `agent.task=${task}`,
        "--cpus=1", "--memory=256m", "--mount", "type=volume,destination=/native-control", "--name", task, ...(failedStart ? ["--entrypoint", "/native-nonexistent-command"] : []),
        image.Id, ...(failedStart ? [] : ["node", "-e", mode === "exited-artifact" ? "process.exit(0)" : "setInterval(()=>{},1000)"])]);
      ledger.append({ event: "command", operation: "create", role, app, case: null, id: cid, code: 0, at: Date.now() });
      const observe = (phase) => ledger.append({ event: "participant", phase, role, app, case: null,
        snapshot: participantSnapshot(JSON.parse(success(["inspect", cid]))[0], image), at: Date.now() });
      observe("created");
      if (mode !== "stopped-artifact") {
        const start = docker(["start", cid]);
        ledger.append({ event: "command", operation: "start", role, app, case: null, id: cid, code: start.code, at: Date.now() });
        if (failedStart) assert.notEqual(start.code, 0);
        else { assert.equal(start.code, 0); if (artifact) assert.equal(success(["wait", cid]), "0"); else observe("running"); }
      }
      observe("terminal");
      const removal = docker(["rm", "-f", "-v", cid]);
      ledger.append({ event: "remove", kind: "container", id: cid, code: removal.code, at: Date.now() }); assert.equal(removal.code, 0);
      ledger.append({ event: "inventory", ...await collectDockerInventory(docker, "container", task, "all"), at: Date.now() });
      ledger.append({ event: "inventory", ...await collectDockerInventory(docker, "volume", task, "all"), at: Date.now() });
      for (const kind of ["container", "network", "image", "volume"]) ledger.append({ event: "inventory", ...await collectDockerInventory(docker, kind, task, "owned"), at: Date.now() });
      const ref = ledger.finish({ endedAt: Date.now() });
      const lost = mode === "running" ? store.record("lost-create-readback", { ...ledger.value,
        events: ledger.value.events.filter((e) => e.event === "command" && e.operation === "create" || e.event === "inventory" && e.scope === "owned").map((e, seq) => ({ ...e, seq })) }) : null;
      store.seal(); const reader = openEvidence(root), result = replayExecution(reader, ref);
      assert.equal(result.cleanupComplete, true);
      if (mode === "exited-artifact") { assert.ok(result.blocked.includes("artifact-executed")); assert.equal(result.participants[0].terminal.state.Status, "exited"); }
      else assert.deepEqual(result.blocked, []);
      assert.equal(result.participants[0].window === null, failedStart || mode === "stopped-artifact");
      if (mode !== "stopped-artifact") assert.equal(result.commands.find((c) => c.operation === "start").code === 0, !failedStart);
      if (lost) { const incomplete = replayExecution(reader, lost); assert.equal(incomplete.cleanupComplete, false); assert.equal(incomplete.participants[0].id, cid); assert.ok(incomplete.blocked.length); }
      reader.finish();
      t.diagnostic(`native ${mode} collector window: ${result.executionWindow.endedAt - result.executionWindow.startedAt} ms`);
    } finally { if (cid) docker(["rm", "-f", "-v", cid]); rmSync(root, { recursive: true }); }
  }
});
test("native Chromium continuous HTTP journal proves empty applicability; actual transient worker blocks", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "/final" }); res.end(); return; }
    if (req.url === "/worker.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end("self.onmessage=()=>{};"); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/worker" ? '<script>globalThis.worker = new Worker("/worker.js")</script><p>native</p>' : "<p>native HTTP only</p>");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const browser = await chromium.launch({ headless: true });
  try {
    for (const mode of ["HTTP-positive", "redirect-positive", "worker-negative"]) {
      const worker = mode === "worker-negative";
      const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage();
      const cdp = await context.newCDPSession(page), targets = await browser.newBrowserCDPSession();
      let observer;
      const instrumented = {
        on: (...args) => targets.on(...args), detach: () => targets.detach(),
        async send(method, params) {
          const startedAt = performance.now(), answer = await targets.send(method, params);
          if (method === "Target.setDiscoverTargets") observer.events.push({ event: method, startedAt, receivedAt: performance.now(), params, result: answer });
          return answer;
        },
      };
      observer = new PlatformLifecycle(cdp, instrumented, { javaScriptEnabled: true });
      await observer.enable(); await observer.enableDomains(); await observer.startObservation();
      observer.boundaries.applicationStartedAt = performance.now();
      await page.goto(`http://127.0.0.1:${server.address().port}/${worker ? "worker" : mode === "redirect-positive" ? "redirect" : ""}`);
      if (worker) { await page.waitForFunction(() => globalThis.worker instanceof Worker); await page.waitForTimeout(100); await page.evaluate(() => globalThis.worker.terminate()); }
      await observer.finishObservation(); const journal = observer.snapshot(), proof = replayWorkerAbsence(journal);
      assert.equal(proof.status, worker ? "blocked" : "verified", JSON.stringify(proof));
      const peers = replayPeerApplicability(journal, proof);
      assert.equal(peers.status, worker ? "blocked" : "verified", JSON.stringify(peers));
      if (mode === "redirect-positive") {
        assert.ok(journal.events.some((e) => e.event === "Network.requestWillBeSentExtraInfo"));
        assert.ok(journal.events.some((e) => e.event === "Page.frameNavigated" && e.scheme === "http:"));
        for (const mutation of ["predecessor", "main-stream", "whole-stream"]) {
          const changed = structuredClone(journal);
          if (mutation === "predecessor") changed.events.splice(changed.events.findIndex((e) => e.event === "Network.requestWillBeSent" && e.type === "Document"), 1);
          else changed.events = changed.events.filter((e) => mutation === "whole-stream" ? !e.event.startsWith("Network.")
            : !["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"].includes(e.event));
          assert.equal(replayPeerApplicability(changed, replayWorkerAbsence(changed)).status, "blocked", mutation);
        }
      }
      t.diagnostic(`native ${mode} journal: ${journal.events.length} events, ${Buffer.byteLength(JSON.stringify(journal))} bytes`);
      await observer.close(); await context.close();
    }
  } finally { await browser.close(); await new Promise((done) => server.close(done)); }
});
