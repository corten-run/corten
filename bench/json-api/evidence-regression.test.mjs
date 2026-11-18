// Reviewer regressions. Synthetic evidence and local test adapters are not native admission.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { catalogServer } from "../catalog/upstream.mjs";
import { marketplaceServer } from "../marketplace/upstream.mjs";
import { aggregate, deriveLoad, descriptor, loadConfig, participantReceipt, payloads, runtimeContext, runtimeReceipt } from "./contract.mjs";
import { functionalVerifier, verifyCold, verifyFunctional } from "./evidence.mjs";
import { captureJson } from "./check.mjs";
import { inspectJson } from "./report.mjs";
import { functional, k6Summary, observations, result, runtimeInfo } from "./test-fixtures.mjs";
import { ByteStore } from "./production-fixtures.mjs";

test("historical v1 replays only the exact fixed offer in every JSON case", () => {
  const e = result([], { artifacts: new ByteStore() }), s = e.summary;
  for (const profile of descriptor().cases) {
    const run = s.apps.corten.runs[profile.key][0], raw = e.load(run.phases.fixed.raw);
    const count = s.options.rate * s.options.duration;
    raw.k6 = k6Summary(count, raw.clock.k6DurationMs / 1000);
    if (profile.source === "api") raw.upstreamReads.after = { [payloads[profile.payload].first]: count };
    const metrics = deriveLoad(raw, run.identity, "fixed", s.options, s.tools, runtimeContext(s, profile));
    assert.equal(metrics.requests, count, profile.key);
    run.phases.fixed = { raw: e.put(raw), metrics };
    s.apps.corten.aggregates[profile.key].fixed = { ...aggregate([metrics]), asked: 1 };
  }
  const report = inspectJson(s, { load: e.load });
  assert.equal(report.baseline, true, report.warnings.slice(0, 3).join("\n"));
  const profile = descriptor().cases.find((p) => p.source === "api"), run = s.apps.corten.runs[profile.key][0];
  const good = run.phases.fixed;
  for (const count of [1, s.options.rate * s.options.duration - 1, s.options.rate * s.options.duration + 1, s.options.rate * s.options.duration + 2]) {
    const raw = e.load(good.raw), seconds = raw.clock.k6DurationMs / 1000;
    raw.k6 = k6Summary(count, seconds);
    raw.upstreamReads.after = { [payloads[profile.payload].first]: count };
    const metrics = { ...good.metrics, requests: count, rps: count / seconds, perCpuSecond: count / (good.metrics.cpuUsec / 1e6) };
    run.phases.fixed = { raw: e.put(raw), metrics };
    s.apps.corten.aggregates[profile.key].fixed = { ...aggregate([metrics]), asked: 1 };
    assert.equal(inspectJson(s, { load: e.load }).baseline, false, `rewritten count ${count}`);
  }
});

test("fixed count, rate, check, iteration and drop corruption fails at the exact historical v1 offer", () => {
  const e = result([], { artifacts: new ByteStore() }), s = e.summary;
  for (const profile of descriptor().cases) {
    const run = s.apps.corten.runs[profile.key][0], raw = e.load(run.phases.fixed.raw);
    const count = s.options.rate * s.options.duration, seconds = raw.clock.k6DurationMs / 1000;
    const setCount = (r, n) => {
      r.k6 = k6Summary(n, seconds);
      if (profile.source === "api") r.upstreamReads.after = { [payloads[profile.payload].first]: n };
    };
    setCount(raw, count);
    const derive = (r) => deriveLoad(r, run.identity, "fixed", s.options, s.tools, runtimeContext(s, profile));
    assert.equal(derive(raw).requests, count);
    for (const [name, mutate] of [
      ["one coherent request", (r) => setCount(r, 1)],
      ["below offered", (r) => setCount(r, count - 2)],
      ["extra unexplained work", (r) => setCount(r, count + 1)],
      ["fractional request", (r) => setCount(r, count - 0.5)],
      ["request rate", (r) => { r.k6.metrics.http_reqs.values.rate = count / s.options.duration; }],
      ["named check coverage", (r) => { r.k6.root_group.checks["JSON status 200"].passes--; }],
      ["named check failure", (r) => { r.k6.root_group.checks["JSON content type"].fails++; }],
      ["total check coverage", (r) => { r.k6.metrics.checks.values.passes--; }],
      ["total check failure", (r) => { r.k6.metrics.checks.values.fails++; }],
      ["HTTP failure", (r) => { r.k6.metrics.http_req_failed.values.rate = 1 / count; }],
      ["fewer completed iterations", (r) => { r.k6.metrics.iterations.values.count--; }],
      ["extra completed iterations", (r) => { r.k6.metrics.iterations.values.count++; }],
      ["iteration rate", (r) => { r.k6.metrics.iterations.values.rate *= 2; }],
      ["malformed iterations", (r) => { r.k6.metrics.iterations = null; }],
      ["dropped arrival", (r) => { r.k6.metrics.dropped_iterations.values.count = 1; }],
      ["underload plus drop equals offer", (r) => { setCount(r, count - 2); r.k6.metrics.dropped_iterations.values.count = 1; }],
      ["negative drops", (r) => { r.k6.metrics.dropped_iterations.values.count = -1; }],
      ["drop rate", (r) => { r.k6.metrics.dropped_iterations.values.rate = 1; }],
      ["malformed drops", (r) => { r.k6.metrics.dropped_iterations = {}; }],
      ["upstream reads", (r) => { r.upstreamReads.after[payloads[profile.payload].first] = count - 1; }],
    ]) {
      const bad = structuredClone(raw); mutate(bad);
      assert.throws(() => derive(bad), `${profile.key}: ${name}`);
    }
    const legacy = structuredClone(raw); delete legacy.k6.metrics.iterations; delete legacy.k6.metrics.dropped_iterations;
    assert.equal(derive(legacy).requests, count, "v1 does not require new raw counters");
    const flat = structuredClone(raw);
    for (const [key, value] of Object.entries(flat.k6.metrics)) flat.k6.metrics[key] = value.values;
    assert.equal(derive(flat).requests, count, "legacy k6 summary-export metric shape");
    flat.k6.metrics.iterations.count--;
    assert.throws(() => derive(flat), /requests\/completed iterations differ/);
  }
});

test("historical v1 rejects even one extra fixed request without scheduling observations", () => {
  for (const [rate, duration, offered] of [[1, 1, 1], [100, 60, 6000], [150, 60, 9000], [9990, 300, 2997000]]) {
    const e = result(["--rate", String(rate), "--duration", String(duration)], { artifacts: new ByteStore() }), s = e.summary, profile = descriptor().cases[0];
    const run = s.apps.corten.runs[profile.key][0], raw = e.load(run.phases.fixed.raw);
    const derive = (count) => deriveLoad({ ...raw, k6: k6Summary(count, raw.clock.k6DurationMs / 1000) },
      run.identity, "fixed", s.options, s.tools, runtimeContext(s, profile));
    assert.equal(derive(offered).requests, offered, `${rate}/s ${duration}s`);
    for (const count of [offered - 1, offered + 1, offered + 2, offered + rate * 10]) assert.throws(() => derive(count));
  }
});

test("prepared functional replay preserves exact, reformatted and typed complete-record checks", () => {
  for (const profile of descriptor().cases) {
    const records = payloads[profile.payload].records(), events = observations(profile, records), summary = functional(profile, records);
    const verify = functionalVerifier(profile, records), index = events.findIndex((e) => e.kind === "application");
    assert.equal(verify(summary, events), true);
    const body = JSON.parse(events[index].body);
    const formatted = structuredClone(events);
    formatted[index].body = JSON.stringify(Object.fromEntries(Object.entries(body).reverse()), null, 2);
    assert.equal(verify(summary, formatted), true, `${profile.key}: formatting and object-key order are not contract requirements`);
    for (const mutate of [
      (e) => { e[index].body = JSON.stringify({ ...body, extra: true }); },
      (e) => { const value = { ...body }; delete value.title; e[index].body = JSON.stringify(value); },
      (e) => { e[index].body = JSON.stringify({ ...body, id: "wrong" }); },
      (e) => { e[index].body = JSON.stringify({ ...body, title: 42 }); },
      (e) => { e[index].body = "not JSON"; },
      (e) => { e[index].type = "text/html"; },
      (e) => { e[index].status = 500; },
      (e) => { e.at(-1).body = "not JSON"; },
    ]) { const changed = structuredClone(events); mutate(changed); assert.throws(() => verify(summary, changed)); }
    const id = Object.keys(records)[0]; records[id].title = "caller changed expected record";
    assert.equal(verify(summary, events), true, "prepared expected bytes cannot drift when caller mutates its records");
    assert.throws(() => verify({ ...summary, recordsSha256: "0".repeat(64) }, events));
  }
});

for (const [name, mutate] of [
  ["fixed one-request run", (r) => {
    r.k6.metrics.http_reqs.values = { count: 1, rate: 1 }; r.k6.metrics.checks.values = { passes: 2, fails: 0 };
    for (const c of Object.values(r.k6.root_group.checks)) Object.assign(c, { passes: 1, fails: 0 });
  }],
  ["contradictory count/rate", (r) => { r.k6.metrics.http_reqs.values.rate = 1e9; }],
  ["nonsensical sample window", (r) => { r.samples.app = [{ cpu: 0, mem: 0.000001, t: -12345 }]; }],
]) test(`${name} cannot become a baseline by recomputing raw hashes and aggregates`, () => {
  const e = result(), s = e.summary, key = descriptor().cases[0].key, phase = name.startsWith("fixed") ? "fixed" : "sat64";
  const run = s.apps.corten.runs[key][0], raw = e.load(run.phases[phase].raw); mutate(raw);
  let accepted = false;
  try {
    const metrics = deriveLoad(raw, run.identity, phase, s.options, s.tools, runtimeContext(s, run.identity));
    run.phases[phase] = { raw: e.put(raw), metrics }; s.apps.corten.aggregates[key][phase] = { ...aggregate([metrics]), asked: 1 };
    accepted = inspectJson(s, { load: e.load }).baseline;
  } catch { /* raw inconsistency must fail closed, before aggregates can legitimize it */ }
  assert.equal(accepted, false);
});

test("missing fixture mount/unrelated API/matched profile cannot produce an accepted runtime receipt", () => {
  const e = result(), expected = e.summary.apps.corten.checks[descriptor().cases[0].key].identity;
  const info = { Id: "e".repeat(64), Image: expected.imageId,
    Config: { Env: ["CATALOG_SOURCE=fixture", "CATALOG_FIXTURE_PATH=/fixtures/catalog.json", "API_BASE=http://unrelated:8080", "PROFILE=matched"] },
    HostConfig: { Memory: 2 ** 30, NanoCpus: 1e9, CpusetCpus: "" }, Mounts: [] };
  assert.throws(() => runtimeReceipt(info, expected));
});

test("observed app receipts independently reject mount, profile, source, routing and ownership drift in all four cases", () => {
  const e = result();
  for (const profile of descriptor().cases) {
    const expected = e.summary.apps.corten.checks[profile.key].identity, context = runtimeContext(e.summary, profile);
    const info = runtimeInfo(expected, context); assert.ok(runtimeReceipt(info, expected, context));
    for (const mutate of [
      (i) => { i.Mounts = []; }, (i) => { i.Mounts[0].RW = true; }, (i) => { i.Mounts[0].Source = "/unrelated"; },
      (i) => { i.Mounts.push({ ...i.Mounts[0], Destination: "/fixtures/catalog.json" }); },
      (i) => { i.Config.Env[3] = "PROFILE=matched"; }, (i) => { i.Config.Env[2] = "API_BASE=http://unrelated:8080"; },
      (i) => { i.Config.Env.push(i.Config.Env[0]); }, (i) => { i.Name = "/unrelated"; },
      (i) => { i.Config.Labels["run.corten.json-api"] = "other-run"; }, (i) => { i.NetworkSettings.Networks = { other: {} }; },
    ]) { const bad = structuredClone(info); mutate(bad); assert.throws(() => runtimeReceipt(bad, expected, context)); }
  }
});

test("upstream/load/probe runtime receipts independently check actual identity, source mounts, CPU, memory and commands", () => {
  const e = result(), profile = descriptor().cases[0], expected = e.summary.apps.corten.checks[profile.key].identity;
  const context = { ...runtimeContext(e.summary, profile), load: loadConfig(e.summary.options, "fixed") };
  for (const role of ["upstream", "load", "probe"]) {
    const info = runtimeInfo(expected, context, role); assert.ok(participantReceipt(info, expected, context, role));
    for (const mutate of [
      (i) => { i.Id = ""; }, (i) => { i.Image = "sha256:" + "9".repeat(64); }, (i) => { i.Name = "/unrelated"; },
      (i) => { i.HostConfig.Memory *= 2; }, (i) => { i.HostConfig.NanoCpus /= 2; }, (i) => { i.HostConfig.CpusetCpus = "99"; },
      (i) => { i.Mounts = []; }, (i) => { i.Mounts[0].RW = true; }, (i) => { i.Config.Cmd = ["unrelated"]; },
      (i) => { i.NetworkSettings.Networks = { other: {} }; },
    ]) { const bad = structuredClone(info); mutate(bad); assert.throws(() => participantReceipt(bad, expected, context, role)); }
    if (role === "load") {
      for (let i = 0; i < info.Config.Env.length; i++) {
        const bad = structuredClone(info); bad.Config.Env[i] = bad.Config.Env[i].split("=")[0] + "=wrong";
        assert.throws(() => participantReceipt(bad, expected, context, role));
      }
    }
  }
});

test("no runtime role can hide unexpected executable, root, source or volume overlays", () => {
  const e = result(), profile = descriptor().cases[0], expected = e.summary.apps.corten.checks[profile.key].identity;
  const context = { ...runtimeContext(e.summary, profile), load: loadConfig(e.summary.options, "fixed") };
  for (const role of ["app", "upstream", "load", "probe"]) for (const destination of ["/", "/app", "/usr/bin", "/repo", "/tmp"])
    for (const type of ["bind", "volume", "tmpfs"]) {
      const info = runtimeInfo(expected, context, role);
      info.Mounts.push({ Type: type, Source: "/unrelated/override", Destination: destination, RW: true });
      assert.throws(() => role === "app" ? runtimeReceipt(info, expected, context) : participantReceipt(info, expected, context, role),
        `${role}: ${type} ${destination}`);
    }
});

test("all payload/source/phase cells require clocks, sustained samples, correct participating budgets and source read deltas", () => {
  const e = result([], { artifacts: new ByteStore() }), s = e.summary;
  for (const profile of descriptor().cases) {
    const checked = s.apps.corten.checks[profile.key], run = s.apps.corten.runs[profile.key][0], context = runtimeContext(s, profile);
    const checkedRaw = e.load(checked.raw); assert.equal(verifyFunctional(checked.functional, checkedRaw.events, profile, payloads[profile.payload].records()), true);
    if (profile.source === "fixture") {
      const bad = structuredClone(checkedRaw.events); bad.at(-1).body = JSON.stringify({ requests: { record_1: 501 } });
      assert.throws(() => verifyFunctional(checked.functional, bad, profile, payloads[profile.payload].records()));
    }
    const cold = e.load(run.cold.raw); assert.ok(verifyCold(cold, run.identity, s.options, context));
    for (const mutate of [
      (r) => { delete r.participants.upstream; }, (r) => { delete r.participants.probe; },
      (r) => { r.participants.probe.memoryBytes = 2 ** 30; }, (r) => { delete r.upstreamReads; },
      (r) => { r.upstreamReads.after = { record_1: profile.source === "api" ? 10000 : 1 }; },
    ]) { const bad = structuredClone(cold); mutate(bad); assert.throws(() => verifyCold(bad, run.identity, s.options, context)); }
    for (const phase of ["warmup", "fixed", "sat64", "sat256"]) {
      const raw = e.load((phase === "warmup" ? run.warmup : run.phases[phase]).raw);
      const derive = (r) => deriveLoad(r, run.identity, phase, s.options, s.tools, context);
      assert.ok(derive(raw));
      for (const mutate of [
        (r) => { delete r.clock; }, (r) => { r.clock.k6DurationMs = 1000; }, (r) => { r.clock.finishedAt = r.clock.startedAt; },
        (r) => { r.k6.metrics.http_reqs.values.rate *= 2; }, (r) => { r.samples.app = r.samples.app.slice(0, 1); },
        (r) => { r.samples.app.reverse(); }, (r) => { r.samples.app[0].t = -1; },
        (r) => { r.samples.app.splice(1, 10); }, (r) => { delete r.participants.upstream; },
        (r) => { delete r.participants.load; }, (r) => { r.participants.load.memoryBytes /= 2; },
        (r) => { r.participants.upstream.quota = 1; }, (r) => { r.participants.load.containerId = r.runtime.containerId; },
        (r) => { r.upstreamReads = null; }, (r) => { r.upstreamReads.after = { record_1: profile.source === "api" ? 0 : 1 }; },
      ]) { const bad = structuredClone(raw); mutate(bad); assert.throws(() => derive(bad), `${profile.key} ${phase}`); }
      if (phase === "fixed") {
        const short = structuredClone(raw); short.k6.metrics.http_reqs.values = { count: 1, rate: 1000 / short.clock.k6DurationMs };
        assert.throws(() => derive(short), /historical v1 fixed phase must complete exactly the configured offer/);
      }
    }
  }
});

test("fixture functional capture rejects an adapter that secretly fetches 501 upstream records", { timeout: 120000 }, async () => {
  const folder = mkdtempSync(join(tmpdir(), "json-fixture-hidden-api-"));
  const listen = async (s) => { await new Promise((r) => s.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${s.address().port}`; };
  const close = async (s) => { await new Promise((r) => { s.close(r); s.closeAllConnections(); }); };
  try {
    for (const profile of descriptor().cases.filter((p) => p.source === "fixture")) {
      const p = payloads[profile.payload], records = p.records(), up = profile.payload === "catalog-v1" ? catalogServer(records) : marketplaceServer(records);
      const upstream = await listen(up);
      const app = createServer(async (req, res) => {
        const id = req.url.slice(`/api/${p.path}/`.length);
        try {
          const r = await fetch(`${upstream}/${p.path}/records/${id}`);
          res.writeHead(r.status, { "Content-Type": "application/json" }); res.end(JSON.stringify(await r.json()));
        } catch { res.writeHead(502, { "Content-Type": "application/json" }); res.end("{}"); }
      });
      try {
        const base = await listen(app), recordsPath = join(folder, "records.json"), rawPath = join(folder, "raw.jsonl");
        writeFileSync(recordsPath, JSON.stringify(records));
        await assert.rejects(captureJson({ identity: profile, recordsPath, rawPath, base, upstream }), /fixture.*upstream|upstream.*fixture/i);
        const counts = await (await fetch(`${upstream}/__${p.path}/control`)).json();
        assert.equal(Object.values(counts.requests).reduce((a, b) => a + b, 0), 501);
        const events = readFileSync(rawPath, "utf8").trim().split("\n").map(JSON.parse);
        assert.ok(events.some((e) => e.kind === "control" && e.method === "GET"), "retain failing upstream observation");
      } finally { await close(app); await close(up); }
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
