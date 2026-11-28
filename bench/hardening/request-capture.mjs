import assert from "node:assert/strict";
import { records } from "../marketplace/fixtures.mjs";
import { assessBoundedRequests } from "./bounded-requests.mjs";
import { verifyNativeLimits, verifyParity } from "./evidence.mjs";
import { verifyLifecycle } from "./dependency-recovery-capture.mjs";
import { terminalRecovery } from "./lifecycle.mjs";

export function boundedProbeConfig({ phase, source, mode }, budget, runId, caPem) {
  assert.ok(["request-timeout", "request-limit"].includes(phase));
  assert.ok(["direct", "deployed-edge"].includes(mode));
  assert.ok(["fixture", "api"].includes(source));
  assert.match(runId, /^hardening-[a-f0-9]{12}$/);
  assert.equal(typeof caPem, mode === "direct" ? "undefined" : "string");
  const origin = mode === "direct" ? "http://localhost:8080" : "https://localhost:8080";
  return { budget, phase, source, target: { origin, ...(caPem === undefined ? {} : { caPem }) },
    upstream: `http://${runId}-cell-upstream:8080`, expected: records().item_1 };
}

export function assembleBounded({ settings, raw, parity, config, cleanup, provenance, lifecycle }) {
  const { phase, source, target, upstream, expected } = config;
  assert.equal(settings.phase, phase); assert.equal(settings.nativeSource, source);
  assert.equal(settings.deployment.mode, settings.case);
  assert.ok(!Object.hasOwn(settings, "emissionPlan"), "unexpected legacy probe settings");
  assert.deepEqual(JSON.parse(settings.effectiveBudgets), config.budget);
  verifyNativeLimits(settings, lifecycle); verifyParity(parity, source);
  const assessment = assessBoundedRequests({ phase, source, raw, expected, targetOrigin: target.origin, upstreamOrigin: upstream });
  const cleanupProof = verifyLifecycle(raw[0], settings.deployment, lifecycle, provenance, cleanup, assessment.completeAtMs);
  const { disposition, terminalServices } = terminalRecovery(true, settings.deployment.processes, [], lifecycle, source, settings.terminalHealthPaths);
  return { schema: "native-bounded-requests-capture/v1", case: settings.case, phase, assessment,
    terminal: { healthy: disposition === "recovered", disposition, services: terminalServices },
    deployment: settings.deployment, effectiveBudgets: settings.effectiveBudgets, provenance,
    parity: { status: "passed", evidence: "parity.json" }, cleanup: cleanupProof };
}
