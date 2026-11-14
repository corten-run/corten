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
test("native Docker original-ID ledger closes running and failed-start participants without weakening budgets", async (t) => {
  const image = JSON.parse(success(["image", "inspect", upstreamImage]))[0];
  for (const failedStart of [false, true]) {
    const task = `browser-${randomUUID().slice(0, 12)}`, root = mkdtempSync(join(tmpdir(), "corten-native-control-"));
    let cid;
    try {
      const store = new EvidenceStore(root), ledger = new ExecutionLedger(store, { task, commit, startedAt: Date.now() });
      ledger.append({ event: "created", kind: "image", id: image.Id, owned: false, at: Date.now() });
      cid = success(["create", "--pull=never", "--label", "agent.owner=codex", "--label", `agent.task=${task}`,
        "--cpus=1", "--memory=256m", "--mount", "type=volume,destination=/native-control", "--name", task, ...(failedStart ? ["--entrypoint", "/native-nonexistent-command"] : []),
        image.Id, ...(failedStart ? [] : ["node", "-e", "setInterval(()=>{},1000)"])]);
      const observe = (phase) => ledger.append({ event: "participant", phase, role: "upstream", app: null, case: null,
        snapshot: participantSnapshot(JSON.parse(success(["inspect", cid]))[0], image), at: Date.now() });
      observe("created"); const start = docker(["start", cid]);
      ledger.append({ event: "command", operation: "start", role: "upstream", app: null, case: null, id: cid, code: start.code, at: Date.now() });
      if (failedStart) assert.notEqual(start.code, 0); else { assert.equal(start.code, 0); observe("running"); }
      observe("terminal");
      const removal = docker(["rm", "-f", "-v", cid]);
      ledger.append({ event: "remove", kind: "container", id: cid, code: removal.code, at: Date.now() }); assert.equal(removal.code, 0);
      ledger.append({ event: "inventory", ...await collectDockerInventory(docker, "container", task, "all"), at: Date.now() });
      ledger.append({ event: "inventory", ...await collectDockerInventory(docker, "volume", task, "all"), at: Date.now() });
      for (const kind of ["container", "network", "image", "volume"]) ledger.append({ event: "inventory", ...await collectDockerInventory(docker, kind, task, "owned"), at: Date.now() });
      const ref = ledger.finish({ endedAt: Date.now() }); store.seal(); const reader = openEvidence(root), result = replayExecution(reader, ref); reader.finish();
      assert.equal(result.cleanupComplete, true); assert.deepEqual(result.blocked, []);
      assert.equal(result.participants[0].window === null, failedStart);
      assert.equal(result.commands[0].code === 0, !failedStart);
      t.diagnostic(`native ${failedStart ? "failed-start" : "running"} collector window: ${result.executionWindow.endedAt - result.executionWindow.startedAt} ms`);
    } finally { if (cid) docker(["rm", "-f", "-v", cid]); rmSync(root, { recursive: true }); }
  }
});
test("native Chromium continuous HTTP journal proves empty applicability; actual transient worker blocks", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/worker.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end("self.onmessage=()=>{};"); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/worker" ? '<script>globalThis.worker = new Worker("/worker.js")</script><p>native</p>' : "<p>native HTTP only</p>");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const browser = await chromium.launch({ headless: true });
  try {
    for (const worker of [false, true]) {
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
      await page.goto(`http://127.0.0.1:${server.address().port}/${worker ? "worker" : ""}`);
      if (worker) { await page.waitForFunction(() => globalThis.worker instanceof Worker); await page.waitForTimeout(100); await page.evaluate(() => globalThis.worker.terminate()); }
      await observer.finishObservation(); const journal = observer.snapshot(), proof = replayWorkerAbsence(journal);
      assert.equal(proof.status, worker ? "blocked" : "verified", JSON.stringify(proof));
      const peers = replayPeerApplicability(journal, proof);
      assert.equal(peers.status, worker ? "blocked" : "verified", JSON.stringify(peers));
      t.diagnostic(`native ${worker ? "worker-negative" : "HTTP-positive"} journal: ${journal.events.length} events, ${Buffer.byteLength(JSON.stringify(journal))} bytes`);
      await observer.close(); await context.close();
    }
  } finally { await browser.close(); await new Promise((done) => server.close(done)); }
});
