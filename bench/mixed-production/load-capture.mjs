import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { bindNativeForm } from "../workloads/mixed.mjs";
import { emptyCapture, expectedOutcome, oracle, responseOutcome, sleep, unsent, upstreamEvidence } from "./capture.mjs";

export function loadPaths(plan, source) {
  const rows = plan.requests.filter((r) => r.source === source), paths = new Set();
  for (const row of rows) {
    assert.ok(!paths.has(row.itemId), "load attribution ambiguous: two planned operations use one native record path");
    paths.add(row.itemId);
  }
  assert.ok(rows.length && new Set(rows.map((r) => r.client)).size >= 2, "load requires at least two active native clients");
  return rows;
}

// This keeps each client's native order while allowing different clients to overlap.
// The full shared plan is never rewritten, and no expected-state helper is imported.
export async function loadCycle({ plan, records, app, source, transport, injector, settings, save, now = () => performance.now() }) {
  const requests = loadPaths(plan, source), capture = emptyCapture(plan, app), operations = [];
  await Promise.all([...new Set(requests.map((r) => r.client))].map(async (client) => {
    for (const request of requests.filter((r) => r.client === client)) {
      const start = now(), evidence = { requestId: request.id, source, stages: [], gaps: [] };
      let row = unsent(request), started = false, primaryStarted = null;
      try {
        const path = `/marketplace/records/${request.itemId}`;
        await injector.begin(`prep_${request.id}`, "normal", 0, path);
        let binding, before = null;
        if (request.method === "POST") {
          const form = await transport.discover(request, evidence);
          if (form) { binding = bindNativeForm(request, form); before = await transport.readState(request, evidence, "before"); }
          else { row = unsent(request, "unsupported"); evidence.gaps.push("native-form-unavailable"); }
          if (before === null) evidence.gaps.push("independent-alert-readback-unavailable");
        }
        if (request.method !== "POST" || binding) {
          const mode = request.category === "slow" ? request.variant : "normal";
          await injector.begin(request.id, mode, request.category !== "slow" ? 0 : request.variant === "complete" ? settings.completeDelayMs : settings.slowDelayMs, path);
          started = true; primaryStarted = now();
          await save(request, { row: { ...unsent(request), outcome: "network-error", error: "network-error" }, evidence, incomplete: true });
          const response = await transport.send(request, binding, evidence, injector), outcome = responseOutcome(request, response);
          row = { request, outcome, status: response.status, error: response.error, contentType: response.contentType, contentEncoding: response.contentEncoding,
            upstream: null, page: null, record: null, form: binding?.evidence ?? null, state: null };
          if (["completed", "rejected"].includes(outcome)) try {
            if (request.category === "json") row.record = JSON.parse(response.body.toString("utf8"));
            else row.page = await transport.snapshot(response, request, evidence);
          } catch { evidence.gaps.push("native-body-extraction-failed"); }
          const until = Date.now() + settings.cleanupMs;
          let observed;
          do { observed = await injector.read(request.id); if (!observed.pending || Date.now() >= until) break; await sleep(20); } while (true);
          row.upstream = upstreamEvidence(observed, request); evidence.upstream = observed;
          if (request.method === "POST") {
            await injector.begin(`state_${request.id}`, "normal", 0, path);
            const after = await transport.readState(request, evidence, "after"), readback = await transport.readState(request, evidence, "readback");
            if (before !== null && after !== null && readback !== null) row.state = { before, after, readback: { via: "independent-read", alerts: readback } };
          }
        }
      } catch {
        evidence.gaps.push(started ? "capture-failed-after-primary-start" : "native-preparation-failed");
        if (started && row.outcome === "not-run") row = { ...row, outcome: "network-error", error: "network-error" };
      }
      capture.results[request.index] = row;
      const end = now();
      const primary = evidence.stages.find((s) => s.stage === "primary");
      const operation = { requestId: request.id, category: request.category, locale: request.locale, variant: request.variant,
        client, startedMs: start, primaryStartedMs: primaryStarted, finishedMs: end, primaryMs: primary?.elapsedMs ?? null,
        journeyMs: end - start, outcome: row.outcome, status: row.status, passed: null,
        nativeHttpResponses: evidence.stages.filter((s) => s.status > 0).length };
      operations.push(operation);
      await save(request, { row, evidence, check: { passed: null, error: "awaiting complete-cycle oracle" }, operation, incomplete: false });
    }
  }));
  const checked = oracle(plan, capture, records);
  for (const operation of operations) operation.passed = checked.valid && operation.outcome === expectedOutcome(requests.find((r) => r.id === operation.requestId));
  return { capture, oracle: checked, operations, passed: checked.valid && operations.length === requests.length && operations.every((o) => o.passed) };
}
