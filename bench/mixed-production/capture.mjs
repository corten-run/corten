import { createHash } from "node:crypto";
import { bindNativeForm, resultSchema, validateResults, workload } from "../workloads/mixed.mjs";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const expectedOutcome = (request) => request.category === "rejected-write" ? "rejected"
  : request.category === "slow" ? { complete: "completed", deadline: "deadline", cancel: "cancelled" }[request.variant] : "completed";
export function unsent(request, outcome = "not-run") {
  return { request, outcome, status: 0, contentType: null, contentEncoding: null, error: null, upstream: null, page: null, record: null, form: null, state: null };
}
export const emptyCapture = (plan, app) => ({ schema: resultSchema, workload, app, effectivePlan: plan, results: plan.requests.map((r) => unsent(r)) });

// Never serialize arbitrary exception text: native URLs, bodies and tokens can be in it.
export function oracle(plan, capture, records) {
  try { return { valid: true, result: validateResults(plan, capture, records), error: null }; }
  catch (e) { return { valid: false, result: null, error: e.message.startsWith("mixed contract:") ? e.message : "mixed contract: invalid evidence" }; }
}
export function checkCell(plan, capture, records, request) {
  // Validate this cell with its real preceding state transitions, not fabricated success rows.
  const isolated = { ...capture, results: capture.results.map((row) => row.request.id === request.id || row.request.index < request.index
    && row.request.source === request.source && row.request.client === request.client && row.state !== null ? row : unsent(row.request, "unsupported")) };
  const checked = oracle(plan, isolated, records);
  return { passed: checked.valid && capture.results[request.index].outcome === expectedOutcome(request), error: checked.error };
}

export function upstreamEvidence(observation, request) {
  const paths = [...new Set(observation.events.map((event) => event.path))];
  return { requests: observation.requests, completed: observation.completed, cancelled: observation.cancelled, pending: observation.pending,
    path: paths.length === 1 ? paths[0] : paths.length ? "multiple-paths" : null, mode: observation.mode };
}

export async function control(base, token, id, value) {
  const response = await fetch(`${base}/__mixed/control${value ? "" : `?id=${encodeURIComponent(id)}`}`, {
    method: value ? "POST" : "GET", headers: { authorization: `Bearer ${token}` },
    ...(value ? { body: JSON.stringify({ id, ...value }) } : {}), signal: AbortSignal.timeout(5000), redirect: "error",
  });
  if (response.status !== 200) throw new Error("injector unavailable");
  return response.json();
}

export function responseOutcome(request, response) {
  if (response.error) return response.error;
  if (response.status === 429) return "limited";
  if ([401, 403, 419].includes(response.status)) return "refused";
  if (request.category === "slow" && request.variant === "deadline" && [408, 503, 504].includes(response.status)) return "deadline";
  if (request.category === "rejected-write" && [200, 302, 303, 400, 422].includes(response.status)) return "rejected";
  return [200, 201, 202, 204, 302, 303].includes(response.status) ? "completed" : "failed";
}

/** Execute in plan order. This is stricter than per-source/client ordering and makes injector
 * attribution unambiguous. Transport owns cookies/CSRF, never this module or the oracle. */
export async function captureSource({ plan, records, app, source, transport, injector, settings, save }) {
  const capture = emptyCapture(plan, app), cells = [];
  for (const request of plan.requests.filter((r) => r.source === source)) {
    const evidence = { requestId: request.id, source, stages: [], gaps: [], clock: "driver monotonic wall time, not CPU or load latency" };
    let row = unsent(request), started = false;
    try {
      await injector.begin(`prep_${request.id}`, "normal", 0);
      let binding, before = null;
      if (request.method === "POST") {
        const form = await transport.discover(request, evidence);
        if (!form) {
          row = unsent(request, "unsupported"); evidence.gaps.push("native-form-unavailable");
        } else {
          binding = bindNativeForm(request, form);
          before = await transport.readState(request, evidence, "before");
          if (before === null) evidence.gaps.push("independent-alert-readback-unavailable");
        }
      }
      if (request.method !== "POST" || binding) {
        const mode = request.category === "slow" ? request.variant : "normal";
        const delayMs = request.category !== "slow" ? 0 : request.variant === "complete" ? settings.completeDelayMs : settings.slowDelayMs;
        await injector.begin(request.id, mode, delayMs); started = true;
        evidence.primaryStartedAt = new Date().toISOString();
        await save(request, { row: { ...unsent(request), outcome: "network-error", error: "network-error" }, evidence,
          check: { passed: false, error: "native primary capture incomplete" } }, "started");
        const response = await transport.send(request, binding, evidence, injector);
        const outcome = responseOutcome(request, response);
        row = { request, outcome, status: response.status, error: response.error, contentType: response.contentType, contentEncoding: response.contentEncoding,
          upstream: null, page: null, record: null, form: binding?.evidence ?? null, state: null };
        if (["completed", "rejected"].includes(outcome)) {
          try {
            if (request.category === "json") row.record = JSON.parse(response.body.toString("utf8"));
            else row.page = await transport.snapshot(response, request, evidence);
          } catch { evidence.gaps.push("native-body-extraction-failed"); }
        }
        // Take the primary counters before any readback so setup/state HTTP cannot inflate them.
        const settleUntil = Date.now() + settings.cleanupMs;
        let observation;
        do {
          observation = await injector.read(request.id);
          if (!observation.pending || Date.now() >= settleUntil) break;
          await sleep(20);
        } while (true);
        row.upstream = upstreamEvidence(observation, request); evidence.upstream = observation;
        if (request.method === "POST") {
          await injector.begin(`state_${request.id}`, "normal", 0);
          const after = await transport.readState(request, evidence, "after");
          const readback = await transport.readState(request, evidence, "readback");
          if (before !== null && after !== null && readback !== null) row.state = { before, after, readback: { via: "independent-read", alerts: readback } };
        }
      }
    } catch {
      evidence.gaps.push(started ? "capture-failed-after-primary-start" : "preparation-or-injector-failed");
      // An attempted request is never relabeled unsupported/not-run. Incomplete evidence fails.
      if (started && row.outcome === "not-run") row = { ...row, outcome: "network-error", error: "network-error" };
    }
    capture.results[request.index] = row;
    const check = checkCell(plan, capture, records, request);
    cells.push({ requestId: request.id, category: request.category, locale: request.locale, variant: request.variant,
      outcome: row.outcome, status: row.status, passed: check.passed, error: check.error, gaps: evidence.gaps });
    await save(request, { row, evidence, check }, "finished");
  }
  return { capture, cells };
}

export function combine(plan, app, sources) {
  const capture = emptyCapture(plan, app);
  for (const source of sources) for (const row of source.capture.results) if (row.request.source === source.source) capture.results[row.request.index] = row;
  return capture;
}

// A caller cannot measure a subset or convert oracle rejection into permission to time it.
export async function afterFunctionalGate({ apps, inventory, plan, captures, records }, measure) {
  if (apps.length !== inventory.length || inventory.some((app) => !apps.includes(app))) throw new Error("timing blocked: incomplete inventory");
  for (const app of inventory) {
    const checked = oracle(plan, captures[app], records);
    if (!checked.valid || !checked.result.functionalPassed) throw new Error("timing blocked: native functional evidence failed");
  }
  return measure();
}
