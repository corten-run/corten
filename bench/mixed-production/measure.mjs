import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { cpuSettings } from "../catalog/contract.mjs";
import { sampleStats } from "../catalog/stats.mjs";
import { qualificationSettings } from "../marketplace/feature-contract.mjs";
import { spread } from "../fullstack/passes.mjs";
import { afterFunctionalGate, sha256, sleep } from "./capture.mjs";
import { calibrationPolicy, deriveWindow, observedCpuCeiling } from "./metrics.mjs";
import { resourceBoundary, resourceCoveragePolicy } from "./resources.mjs";
import { reconcileLedger, upstreamManifest, upstreamPhase } from "./upstream-ledger.mjs";

export async function measureNativeGroup(context) {
  const { summary, options, folder, repo, runId, network, nodeImage, browserImage, plan, records, token, readbacks,
    docker, io, own, remove, inspect, ready, save, captures } = context;
  // Recheck the entire unchanged native oracle at the measurement boundary.
  await afterFunctionalGate({ apps: options.apps, inventory: summary.inventory, plan, captures, records }, async () => {});
  assert.equal(summary.cleanupFailures.length, 0, "unclean native participants block measurement");
  assert.ok(!summary.provenance.nativeSource.dirty && !await io.command("git", ["status", "--porcelain"]), "measurement needs clean committed native/harness sources");
  const cpus = cpuSettings(Object.fromEntries(["APP", "LOAD", "API"].map((role) => [`CATALOG_${role}_CPUS`, process.env[`MIXED_PRODUCTION_${role}_CPUS`]])));
  const root = join(folder, "measurement"); mkdirSync(root);
  const result = summary.timing = { schema: "mixed-native-measurement/v1", complete: false, qualified: false, calibrated: false,
    timingBlocked: true, comparisonEligible: false, nativeProfile: options.profile, planSha256: plan.sha256,
    cpus, calibrationPolicy, resourceCoveragePolicy, interpretation: "Equal-plan closed-loop achieved load, not saturation/capacity; comparisons require explicit disjoint CPU placement and complete repeated native windows.",
    cells: Object.fromEntries(summary.inventory.map((app) => [app, Object.fromEntries(["fixture", "api"].map((source) => [source, {
      qualification: null, calibration: null, passes: Array.from({ length: options.passes }, (_, i) => ({ pass: i + 1, outcome: "not-run", metrics: null })),
    }]))])), failures: [] };
  summary.provenance.measurementHarnessFiles = Object.fromEntries(["measure.mjs", "metrics.mjs", "load-capture.mjs", "load-worker.mjs", "load-upstream.mjs", "upstream-ledger.mjs", "resources.mjs", "qualify-worker.mjs"].map((f) => [f, sha256(readFileSync(join(repo, "bench/mixed-production", f)))]));
  const mount = ["-v", `${repo}:/src:ro`, "-v", `${realpathSync(join(repo, "node_modules"))}:/src/node_modules:ro`, "-v", `${folder}:/out`, "-w", "/src"];
  const outputPath = (path) => `/out/${relative(folder, path).replaceAll("\\", "/")}`;
  const env = options.profile === "matched" ? ["-e", "PROFILE=matched", "-e", `MAX_CONNECTIONS=${qualificationSettings.maxConnections}`] : ["-e", "PROFILE="];
  const failure = (app, source, stage) => { result.failures.push({ app, source, stage }); save(); };
  const record = (path, value) => { writeFileSync(path, JSON.stringify(value, null, 2)); return { path: relative(folder, path).replaceAll("\\", "/"), sha256: sha256(readFileSync(path)) }; };
  const cleanup = async (names) => {
    let failed = false;
    for (const name of names) try { await remove(name); }
    catch { summary.cleanupFailures.push({ name }); failed = true; }
    if (failed) {
      result.complete = false; result.timingBlocked = true; result.comparisonEligible = false;
      throw new Error("owned native participant cleanup failed");
    }
  };
  const participant = async (name, imageId, role, paused = false) => {
    const info = await inspect(name);
    assert.equal(info.Image, imageId, "native participant image changed");
    assert.ok(info.State.Running && !info.State.OOMKilled && info.RestartCount === 0, "native participant stopped/restarted/OOM");
    assert.equal(info.State.Paused, paused, "native participant pause state changed");
    return { role, id: info.Id, imageId: info.Image, startedAt: info.State.StartedAt, state: info.State,
      config: { env: info.Config.Env.filter((value) => !value.startsWith("MIXED_CONTROL_TOKEN=")), memory: info.HostConfig.Memory,
        nanoCpus: info.HostConfig.NanoCpus, cpuset: info.HostConfig.CpusetCpus, networkMode: info.HostConfig.NetworkMode } };
  };
  const appArgs = (name, source, up, imageId) => ["run", "-d", "--network", network, ...cpus.app.args, "--memory", "1g", "--ulimit", "nofile=65536:65536", "-p", "127.0.0.1::8080",
    "-v", `${folder}:/fixtures:ro`, "-e", `MARKETPLACE_SOURCE=${source}`, "-e", "MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json", "-e", `API_BASE=http://${up}:8080`,
    "-e", "PORT=8080", "-e", `HOSTS=${name},localhost,127.0.0.1`, ...env, imageId];
  async function runQualification(app, source) {
    assert.equal(summary.cleanupFailures.length, 0, "unclean native participants block qualification");
    const dir = join(root, app, source, "qualification"); mkdirSync(dir, { recursive: true });
    const appName = `${runId}-q-${app}-${source}`, up = `${appName}-up`, worker = `${appName}-worker`;
    const probes = [], imageId = summary.apps[app].image.id;
    try {
      await own(["run", "-d", "--network", network, ...cpus.api.args, "--memory", "512m", "-p", "127.0.0.1::8080", ...mount,
        "-e", "MARKETPLACE_FIXTURE_PATH=/out/marketplace.json", nodeImage.Id, "node", "bench/marketplace/upstream.mjs"], up);
      await ready(up, "/health", probes, "upstream");
      await own(appArgs(appName, source, up, imageId), appName); await ready(appName, "/marketplace/en-US/item_1", probes, "app");
      const settings = { app, source, imageId, nativeProfile: options.profile, base: "http://127.0.0.1:8080", upstream: `http://${up}:8080`, output: outputPath(join(dir, "qualification.json")) };
      record(join(dir, "settings.json"), settings);
      await own(["create", "--network", `container:${appName}`, ...cpus.load.args, "--memory", "1g", "--ulimit", "nofile=65536:65536", ...mount,
        browserImage.Id, "node", "bench/mixed-production/qualify-worker.mjs", outputPath(join(dir, "settings.json"))], worker);
      let failed = false;
      try { await docker(["start", "-a", worker], { timeout: 8 * 60000 }); } catch { failed = true; }
      const raw = JSON.parse(readFileSync(join(dir, "qualification.json"), "utf8"));
      assert.deepEqual([raw.schema, raw.app, raw.source, raw.imageId, raw.nativeProfile], ["mixed-native-qualification/v1", app, source, imageId, options.profile]);
      raw.eligible = !failed && raw.eligible === true && raw.failure === null;
      const participants = { app: await participant(appName, imageId, "app"), upstream: await participant(up, nodeImage.Id, "upstream") };
      return { eligible: raw.eligible, missing: raw.missing ?? [], failure: raw.failure, artifact: record(join(dir, "qualification.json"), raw),
        participants, readiness: probes };
    } catch (error) {
      record(join(dir, "failure.json"), { schema: "mixed-native-stage-failure/v1", app, source, stage: "qualification", readiness: probes,
        failure: "native-qualification-execution-failed", errorSha256: sha256(String(error)) });
      throw error;
    } finally { await cleanup([worker, appName, up]); }
  }
  const cpuReader = `${runId}-measurement-cpu`;
  async function counters(names) {
    const ids = await Promise.all(Object.values(names).map(async (name) => (await inspect(name)).Id));
    const values = JSON.parse(await docker(["exec", cpuReader, "node", "/src/bench/catalog/cgroup.mjs", ...ids]));
    return Object.fromEntries(Object.keys(names).map((role, i) => [role, values[ids[i]]]));
  }
  async function runWindow(app, source, stage, pass) {
    assert.equal(summary.cleanupFailures.length, 0, "unclean native participants block native windows");
    const dir = join(root, app, source, `${stage}-${pass}`); mkdirSync(dir, { recursive: true });
    const name = `${runId}-${stage}-${pass}-${app}-${source}`, up = `${name}-up`, worker = `${name}-worker`, imageId = summary.apps[app].image.id;
    const probes = [], names = { app: name, upstream: up, load: worker };
    let sampler, stats;
    try {
      await own(["run", "-d", "--network", network, ...cpus.api.args, "--memory", "512m", "-p", "127.0.0.1::8080", ...mount,
        "-e", `MIXED_CONTROL_TOKEN=${token}`, "-e", "MARKETPLACE_FIXTURE_PATH=/out/marketplace.json", nodeImage.Id, "node", "bench/mixed-production/load-upstream.mjs"], up);
      await ready(up, "/health", probes, "upstream");
      // Readiness is preparation, but still gets a real path-scoped observation identity.
      const { control } = await import("./capture.mjs");
      const port = (await inspect(up)).NetworkSettings.Ports["8080/tcp"][0].HostPort;
      await control(`http://127.0.0.1:${port}`, token, "startup", { mode: "normal", delayMs: 0, path: "/marketplace/records/item_1" });
      await own(appArgs(name, source, up, imageId), name); await ready(name, "/marketplace/en-US/item_1", probes, "app");
      const startupObservation = await control(`http://127.0.0.1:${port}`, token, "startup");
      const seconds = stage === "calibration" ? options.calibration : options.duration;
      const settings = { plan, records, app, source, base: "http://127.0.0.1:8080", upstream: `http://${up}:8080`, readbackPath: readbacks[app] ?? "/api/alerts",
        seconds, warmup: options.warmup, tailSeconds: options.tailSeconds, maxCycles: options.maxCycles, folder: outputPath(dir), settings: options, startupObservation };
      record(join(dir, "settings.json"), settings);
      await own(["run", "-d", "--network", `container:${name}`, ...cpus.load.args, "--memory", "2g", "--shm-size", "512m", ...mount,
        "-e", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", "-e", `MIXED_CONTROL_TOKEN=${token}`, browserImage.Id, "node", "bench/mixed-production/load-worker.mjs", outputPath(join(dir, "settings.json"))], worker);
      const untilReady = Date.now() + options.startupTimeoutMs + (options.warmup + options.tailSeconds) * 1000;
      while (!existsSync(join(dir, "ready.json"))) {
        if (existsSync(join(dir, "window.json"))) assert.ok(!JSON.parse(readFileSync(join(dir, "window.json"), "utf8")).finishedAt, "native warmup failed");
        assert.ok(Date.now() < untilReady && !io.interrupted, "load worker readiness failed"); await sleep(50);
      }
      const participantsBefore = { app: await participant(name, imageId, "app"), upstream: await participant(up, nodeImage.Id, "upstream"), load: await participant(worker, browserImage.Id, "load") };
      sampler = sampleStats(Object.values(names), join(dir, "stats.log"), seconds + options.tailSeconds + 15);
      const beforeBoundary = await resourceBoundary(docker, Object.values(names));
      const before = await counters(names), hostStart = performance.now();
      record(join(dir, "go.json"), { go: true });
      const until = Date.now() + (seconds + options.tailSeconds + 10) * 1000;
      let window;
      while (Date.now() < until && !io.interrupted) {
        if (existsSync(join(dir, "window.json"))) { window = JSON.parse(readFileSync(join(dir, "window.json"), "utf8")); if (window.finishedAt) break; }
        await sleep(100);
      }
      assert.ok(window?.finishedAt, "native window exceeded its budget");
      // Freeze the owned producer before the final independent ledger read. Late
      // requests already in flight remain visible; no app can enqueue more work
      // between reconciliation and admission. Cleanup removes the paused app.
      await docker(["pause", name]);
      const admission = { nativePausedUnixMs: Date.now(), settleMs: options.cleanupMs };
      await sleep(options.cleanupMs);
      const finalUpstreamLedger = await control(`http://127.0.0.1:${port}`, token, "ledger");
      record(join(dir, "final-upstream-ledger.json"), { admission, ledger: finalUpstreamLedger });
      const after = await counters(names), afterBoundary = await resourceBoundary(docker, Object.values(names));
      record(join(dir, "resource-boundaries.json"), { before: beforeBoundary, after: afterBoundary });
      stats = await sampler.stop(); sampler = null;
      const hostElapsedMs = performance.now() - hostStart;
      const sampled = JSON.parse(readFileSync(join(dir, "stats.log.json"), "utf8")).samples;
      const participantsAfter = { app: await participant(name, imageId, "app", true), upstream: await participant(up, nodeImage.Id, "upstream"), load: await participant(worker, browserImage.Id, "load") };
      for (const role of Object.keys(names)) assert.deepEqual([participantsAfter[role].id, participantsAfter[role].startedAt], [participantsBefore[role].id, participantsBefore[role].startedAt]);
      const requestArtifacts = [];
      const captures = window.cycles.map((cycle) => {
        const rawDir = join(dir, `cycle_${cycle.cycle}`), capture = JSON.parse(readFileSync(join(rawDir, "capture.json"), "utf8"));
        capture.observations = plan.requests.filter((r) => r.source === source).map((r) => {
          const path = join(rawDir, `${r.id}.json`), body = readFileSync(path);
          requestArtifacts.push({ path: relative(folder, path), sha256: sha256(body) }); return JSON.parse(body);
        });
        return capture;
      });
      const warmups = Array.from({ length: window.warmup.cycles }, (_, i) => JSON.parse(readFileSync(join(dir, `warmup_${i}`, "capture.json"), "utf8")));
      const raw = { schema: "mixed-native-window-receipt/v1", app, source, stage, pass, planSha256: plan.sha256, imageId, nativeProfile: options.profile,
        hostElapsedMs, window, participantsBefore, participantsAfter, counters: Object.fromEntries(Object.keys(names).map((role) => [role, { before: before[role], after: after[role] }])),
        samples: Object.fromEntries(Object.entries(names).map(([role, n]) => [role,
          [...beforeBoundary.samples[n], ...(sampled[n] ?? []), ...afterBoundary.samples[n]].toSorted((a, b) => a.t - b.t)])), readiness: probes,
        startupObservation, finalUpstreamLedger, admission, resourceBoundaries: { before: beforeBoundary, after: afterBoundary },
        upstreamReconciliation: reconcileLedger(finalUpstreamLedger, upstreamManifest(plan, source, startupObservation,
          [...warmups.map((c, i) => upstreamPhase("warmup", i, c.capture, source)), ...captures.map((c, i) => upstreamPhase("cycle", i, c.capture, source))])),
        requestArtifacts, warmupCaptures: warmups.map((_, i) => { const path = join(dir, `warmup_${i}`, "capture.json"); return { path: relative(folder, path), sha256: sha256(readFileSync(path)) }; }),
        cycleCaptures: window.cycles.map((cycle) => { const path = join(dir, `cycle_${cycle.cycle}`, "capture.json"); return { path: relative(folder, path), sha256: sha256(readFileSync(path)) }; }) };
      const artifact = record(join(dir, "receipt.json"), raw);
      const metrics = deriveWindow({ ...raw, captures, warmups, plan, records, quotas: Object.fromEntries(Object.entries(cpus).map(([role, value]) => [role === "api" ? "upstream" : role, observedCpuCeiling(value)])), stage });
      return { outcome: metrics.eligible ? "measured" : "calibration-or-window-rejected", artifact, metrics, stats };
    } catch (error) {
      record(join(dir, "failure.json"), { schema: "mixed-native-stage-failure/v1", app, source, stage, pass, readiness: probes,
        failure: "native-window-execution-failed", errorSha256: sha256(String(error)) });
      throw error;
    } finally {
      if (sampler) try { await sampler.stop(); } catch { /* This phase already fails; preserve the raw sampler log. */ }
      await cleanup([worker, name, up]);
    }
  }
  try {
    for (const app of summary.inventory) for (const source of ["fixture", "api"]) {
      const cell = result.cells[app][source];
      try { cell.qualification = await runQualification(app, source); } catch { cell.qualification = { eligible: false, failure: "native-qualification-execution-failed" }; failure(app, source, "qualification"); }
      save();
    }
    result.qualified = Object.values(result.cells).every((sources) => Object.values(sources).every((c) => c.qualification?.eligible));
    if (!result.qualified) return result;
    await own(["run", "-d", "--network", "none", "--cpus", "1", "--memory", "128m", "--cgroupns=host", "-v", "/sys/fs/cgroup:/sys/fs/cgroup:ro", ...mount,
      nodeImage.Id, "node", "-e", "setInterval(() => {}, 1000)"], cpuReader);
    for (const app of summary.inventory) for (const source of ["fixture", "api"]) {
      try { result.cells[app][source].calibration = await runWindow(app, source, "calibration", 0); }
      catch { result.cells[app][source].calibration = { outcome: "failed", metrics: null }; failure(app, source, "calibration"); }
      save();
    }
    result.calibrated = Object.values(result.cells).every((sources) => Object.values(sources).every((c) => c.calibration?.metrics?.eligible));
    if (!result.calibrated) return result;
    for (let pass = 1; pass <= options.passes; pass++) {
      const offset = Math.floor((pass - 1) * summary.inventory.length / options.passes), order = summary.inventory.slice(offset).concat(summary.inventory.slice(0, offset));
      for (const source of ["fixture", "api"]) for (const app of order) {
        const slot = result.cells[app][source].passes[pass - 1];
        try { Object.assign(slot, await runWindow(app, source, "steady", pass)); }
        catch { slot.outcome = "failed"; failure(app, source, `steady-${pass}`); }
        save();
      }
    }
    result.complete = Object.values(result.cells).every((sources) => Object.values(sources).every((c) => c.passes.every((p) => p.outcome === "measured")));
    result.timingBlocked = !result.complete;
    result.comparisonEligible = result.complete && options.passes >= 3 && Object.values(cpus).every((role) => role.cpuset !== null);
    if (result.complete) for (const sources of Object.values(result.cells)) for (const c of Object.values(sources)) c.aggregate = {
      achievedOperationsPerSecond: spread(c.passes.map((p) => p.metrics.achievedPrimaryOperationsPerSecond)),
      primaryHttpP99Ms: spread(c.passes.map((p) => p.metrics.primaryHttpLatency.p99Ms)),
      cpuUsecPerOperation: spread(c.passes.map((p) => p.metrics.resources.app.cpuUsecPerPrimaryOperation)),
      peakMemoryMiB: spread(c.passes.map((p) => p.metrics.resources.app.memMaxMiB)),
    };
    return result;
  } finally { await cleanup([cpuReader]); save(); }
}
