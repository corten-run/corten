// Local, opt-in native execution only. No collector, cloud, nightly or publishing code.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { candidates, emptyCells, parseOptions, publishPort, retainedFamilies, schema, settings, sha256, validateTargets } from "./contract.mjs";
import { records as fixtureRecords } from "../marketplace/fixtures.mjs";
import { createBrowserPlan } from "../workloads/browser.mjs";
import { runJourney } from "./journey.mjs";
import { nativeBuildArgs } from "./build.mjs";
import { exportBrowserCaptures } from "./capture.mjs";
import { bindingArtifactFromImage } from "./binding-image.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
export async function command(binary, args, timeout = 30000, log = null) {
  const child = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", (s) => { if (log) appendFileSync(log, s); stdout = (stdout + s).slice(-8 * 1024 * 1024); });
  child.stderr.on("data", (s) => { if (log) appendFileSync(log, s); stderr = (stderr + s).slice(-8192); });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
  try {
    const code = await new Promise((accept, reject) => { child.on("error", reject); child.on("close", accept); });
    if (timedOut || code !== 0) throw new Error(`${binary} ${args[0]}: ${timedOut ? "timed out" : `exit ${code}`} ${stderr}`);
    return stdout.trim();
  } finally { clearTimeout(timer); }
}
const docker = (args) => command("docker", args);
const inspect = async (id) => JSON.parse(await docker(["inspect", id]))[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function imageEvidence(info, commit) {
  const labels = info.Config?.Labels ?? {};
  const builtCommit = labels["run.corten.browser.commit"] ?? labels["run.corten.marketplace.commit"] ?? null;
  const builtDirty = labels["run.corten.browser.dirty"] ?? labels["run.corten.marketplace.dirty"] ?? null;
  return { id: info.Id, repoDigests: info.RepoDigests ?? [], created: info.Created, architecture: info.Architecture, os: info.Os,
    builtCommit, builtDirty, imageSourceVerified: builtCommit === commit && builtDirty === "false" };
}
export class OwnedDocker {
  constructor(task) { this.task = task; this.containers = new Set(); this.images = new Set(); this.network = null; }
  get labels() { return ["--label", "agent.owner=codex", "--label", `agent.task=${this.task}`]; }
  async createNetwork() {
    const name = `${this.task}-net`;
    this.network = await docker(["network", "create", ...this.labels, name]);
    return name;
  }
  async start(name, args, image, commandArgs = []) {
    // Register the ID before start. A failed start is still cleaned up; a name
    // collision never registers someone else's container for removal.
    const id = await docker(["create", "--pull=never", "--name", name, ...this.labels, ...args, image, ...commandArgs]);
    this.containers.add(id); await docker(["start", id]); return id;
  }
  async remove(id) {
    assert.ok(this.containers.has(id), "refusing cleanup of an unowned container");
    const info = await inspect(id);
    assert.equal(info.Config.Labels["agent.task"], this.task); assert.equal(info.Config.Labels["agent.owner"], "codex");
    await docker(["rm", "-f", "-v", id]); this.containers.delete(id);
  }
  async cleanup() {
    const errors = [];
    for (const id of [...this.containers]) try { await this.remove(id); } catch (e) { errors.push(e.message); }
    if (this.network) try {
      const info = JSON.parse(await docker(["network", "inspect", this.network]))[0];
      assert.equal(info.Labels["agent.task"], this.task);
      await docker(["network", "rm", this.network]); this.network = null;
    } catch (e) { errors.push(e.message); }
    for (const tag of this.images) try {
      const found = await docker(["image", "ls", "--quiet", "--filter", `reference=${tag}`]);
      if (found) {
        const image = JSON.parse(await docker(["image", "inspect", tag]))[0];
        assert.equal(image.Config.Labels["agent.task"], this.task);
        await docker(["image", "rm", tag]);
      }
    } catch (e) { errors.push(e.message); }
    return errors;
  }
}
async function address(id) {
  const info = await inspect(id);
  const port = info.NetworkSettings.Ports["8080/tcp"]?.[0]?.HostPort;
  assert.ok(port, "container's private host port missing"); return `http://127.0.0.1:${port}`;
}
async function ready(base, path, interrupted) {
  const end = Date.now() + settings.startupTimeoutMs;
  let reason = "no response";
  while (Date.now() < end) {
    if (interrupted()) throw new Error("interrupted");
    try {
      const r = await fetch(base + path, { signal: AbortSignal.timeout(1000), redirect: "manual" }); await r.arrayBuffer();
      if (r.status === 200) return;
      reason = `HTTP ${r.status}`;
    } catch { reason = "connection failed"; }
    await sleep(100);
  }
  throw new Error(`startup deadline: ${reason}`);
}

// Aggregate only after native/harness cleanup and unchanged-oracle export. A
// selected subset completing is not a complete-group qualification.
export function groupQualificationPassed(summary, reports) {
  const empty = (value) => Array.isArray(value) && value.length === 0;
  const fullRegistry = (value) => value && Object.keys(value).length === candidates.length && candidates.every((app) => Object.hasOwn(value, app));
  const profiles = summary.effectivePlan?.cases;
  if (summary.complete !== true || summary.code?.dirty !== false || !empty(summary.failures) || !empty(summary.cleanupFailures)
    || !Array.isArray(profiles) || !profiles.length || new Set(profiles.map((p) => p.key)).size !== profiles.length
    || !fullRegistry(summary.cells) || !fullRegistry(reports)
    || summary.browser?.engine !== "chromium" || !summary.browser.version || !summary.browser.playwright
    || !/^[a-f0-9]{64}$/.test(summary.browser.executableSha256 ?? "")) return false;
  return candidates.every((app) => {
    const image = summary.images?.[app], cells = summary.cells[app], report = reports[app], validation = report?.validation;
    if (image?.imageSourceVerified !== true || image.builtCommit !== summary.code.commit || image.builtDirty !== "false"
      || !Array.isArray(cells) || cells.length !== profiles.length || !empty(report?.diagnostics)
      || validation?.functionalPassed !== true || validation.app !== app || validation.planSha256 !== summary.effectivePlan.sha256
      || !Array.isArray(validation.cases) || validation.cases.length !== profiles.length) return false;
    return profiles.every((profile) => {
      const matches = cells.filter((cell) => cell.case === profile.key), checked = validation.cases.filter((cell) => cell.case === profile.key);
      if (matches.length !== 1 || checked.length !== 1) return false;
      const cell = matches[0], e = cell.evidence;
      return cell.outcome === "captured" && cell.qualificationPassed === true
        && e?.functionalChecksPassed === true && e.domChecksPassed === true && empty(e.failures) && empty(e.gaps)
        && e.nativeCleanup?.outcome === "observed" && e.cleanup?.contextClosed === true && e.provenance?.stillSameProcess === true
        && checked[0].outcome === "captured" && checked[0].functionalPassed === true;
    });
  });
}

export async function run(args) {
  const options = Array.isArray(args) ? parseOptions(args) : args;
  assert.match(options.round ?? "", /^w[1-9]\d*$/);
  const targets = options.targets ? validateTargets(JSON.parse(readFileSync(resolve(options.targets), "utf8")))
    : Object.fromEntries(candidates.map((app) => [app, { image: `cb-marketplace-${app}` }]));
  for (const target of Object.values(targets)) target.readback ??= { path: "/api/alerts" };
  const records = fixtureRecords(), plan = createBrowserPlan({ records });
  assert.ok(options.cases === null || options.cases.every((key) => plan.cases.some((p) => p.key === key)), "unknown case key");
  const folder = resolve(options.out);
  // Atomic reservation. Never overwrite an earlier failed/partial result.
  mkdirSync(dirname(folder), { recursive: true });
  mkdirSync(folder, { recursive: false });
  const task = `browser-${randomUUID().slice(0, 12)}`;
  const owned = new OwnedDocker(task);
  const commit = await command("git", ["rev-parse", "HEAD"]);
  const dirty = await command("git", ["status", "--porcelain", "--untracked-files=normal"]);
  const summary = { schema, group: "fullstack-browser", startedAt: new Date().toISOString(), task, effectivePlan: plan, settings,
    code: { commit, dirty: Boolean(dirty), status: dirty,
      runnerFiles: Object.fromEntries(readdirSync(here).filter((p) => p.endsWith(".mjs")).sort().map((p) => [p, sha256(readFileSync(join(here, p)))])),
      runnerDiffSha256: sha256(await command("git", ["diff", "HEAD", "--", "bench/fullstack-browser"])) },
    host: { hostname: hostname(), platform: platform(), release: release(), node: process.version },
    fixtureSha256: sha256(JSON.stringify(records)), targetsSha256: sha256(JSON.stringify(targets)),
    options, images: {}, builds: {}, bindingArtifacts: {}, browser: null, cells: emptyCells(plan), complete: false, qualificationPassed: false, readyForLoad: false,
    retainedFamilies: retainedFamilies.map((f) => ({ ...f, outcome: "not-run", reason: "Retained; not replaced by native browser diagnostics" })),
    limits: ["No comparative result until all selected native capabilities and exact-image source provenance pass",
      "Browser-primitive resource observations do not invent framework ownership or probes into destroyed realms",
      "No load, production HTTP, repeated timing, build, CPU, memory or instruction qualification"], cleanupFailures: [], failures: [] };
  const save = () => { writeFileSync(join(folder, "summary.json.tmp"), JSON.stringify(summary, null, 2) + "\n"); renameSync(join(folder, "summary.json.tmp"), join(folder, "summary.json")); };
  save();
  let browser, interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try {
    writeFileSync(join(folder, "marketplace.json"), JSON.stringify(records));
    if (options.build) for (const app of options.apps) {
      if (interrupted) throw new Error("interrupted");
      const before = await sourceSnapshot();
      assert.equal(await command("git", ["rev-parse", "HEAD"]), commit, "HEAD changed before native image build");
      assert.equal(await command("git", ["status", "--porcelain", "--untracked-files=normal"]), dirty, "checkout changed before native image build");
      const build = nativeBuildArgs({ app, repo, task, commit, dirty: Boolean(dirty), snapshot: before });
      owned.images.add(build.tag);
      const entry = summary.builds[app] = { image: build.tag, dockerfile: build.dockerfile, context: build.context, commit, dirty: Boolean(dirty), sourceSnapshot: before, passed: false };
      try {
        console.log(`building native ${app}`);
        await command("docker", build.args, 60 * 60 * 1000, join(folder, `build-${app}.log`));
        assert.equal(await command("git", ["rev-parse", "HEAD"]), commit, "HEAD changed during native image build");
        assert.equal(await sourceSnapshot(), before, "source changed during native image build");
        targets[app] = { ...targets[app], image: build.tag };
        entry.passed = true;
      } catch (e) {
        entry.error = e.message;
        for (const cell of summary.cells[app]) if (!options.cases || options.cases.includes(cell.case)) Object.assign(cell, { outcome: "failed", reason: `native build failed: ${e.message}` });
      }
      save();
    }
    const network = await owned.createNetwork();
    const upstreamImage = JSON.parse(await docker(["image", "inspect", "node:24-bookworm-slim"]))[0];
    summary.upstreamImage = imageEvidence(upstreamImage, commit);
    const upstreamName = `${task}-upstream`;
    const upstream = await owned.start(upstreamName, ["--network", network, "--cpus", "1", "--memory", "256m", "-p", "127.0.0.1::8080",
      "-v", `${here}:/runner:ro`, "-v", `${folder}:/fixtures:ro`], upstreamImage.Id, ["node", "/runner/upstream.mjs", "/fixtures/marketplace.json"]);
    const upstreamBase = await address(upstream);
    await ready(upstreamBase, "/__browser/counters", () => interrupted);
    const counters = async () => {
      const r = await fetch(upstreamBase + "/__browser/counters", { signal: AbortSignal.timeout(5000) }); assert.equal(r.status, 200); return r.json();
    };
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch({ headless: true });
    const executable = chromium.executablePath();
    summary.browser = { engine: "chromium", version: browser.version(), playwright: JSON.parse(readFileSync(createRequire(import.meta.url).resolve("@playwright/test/package.json"))).version,
      executable, executableSha256: sha256(readFileSync(executable)), launch: { headless: true }, scope: "Local Playwright Chromium, no external browser service" };
    for (const app of candidates) {
      if (!options.apps.includes(app) || !targets[app]) continue;
      if (options.build && !summary.builds[app]?.passed) continue;
      let image;
      try {
        image = JSON.parse(await docker(["image", "inspect", targets[app].image]))[0];
        summary.images[app] = { ...imageEvidence(image, commit), sourceTreeSha256: sha256(await command("git", ["ls-tree", "-r", "HEAD", "--", app === "corten" ? "bench/marketplace/corten" : `bench/fullstack/apps/${app}`])) };
        if (app === "nextjs") {
          try { summary.bindingArtifacts[app] = await bindingArtifactFromImage(command, { imageId: image.Id, sourceCommit: commit, task }); }
          catch (error) { summary.images[app].bindingArtifactError = error.message; }
        }
      } catch (e) {
        for (const cell of summary.cells[app]) if (!options.cases || options.cases.includes(cell.case)) Object.assign(cell, { outcome: "failed", reason: e.message });
        save(); continue;
      }
      for (const profile of plan.cases) {
        if (options.cases && !options.cases.includes(profile.key)) continue;
        if (interrupted) throw new Error("interrupted");
        let id;
        const index = summary.cells[app].findIndex((c) => c.case === profile.key);
        try {
          const name = `${task}-${app}-${plan.cases.indexOf(profile)}`;
          id = await owned.start(name, ["--network", network, "--cpus", "1", "--memory", "1g", "-p", publishPort(app),
            "-v", `${folder}:/fixtures:ro`, "-e", `MARKETPLACE_SOURCE=${profile.source}`, "-e", "MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json",
            "-e", `API_BASE=http://${upstreamName}:8080`, "-e", "PORT=8080", "-e", `HOSTS=${name},localhost,127.0.0.1`], image.Id);
          const base = await address(id);
          const before = await inspect(id);
          await ready(base, profile.steps[0].path, () => interrupted);
          const cell = await runJourney({ browser, app, base, profile, records, readback: targets[app].readback, counters, bindingArtifact: summary.bindingArtifacts[app] ?? null });
          const after = await inspect(id);
          cell.evidence.provenance = { containerId: id, imageId: before.Image, startedAt: before.State.StartedAt, source: profile.source,
            stillSameProcess: after.State.Running && before.State.StartedAt === after.State.StartedAt && before.RestartCount === after.RestartCount,
            configuration: { cpus: 1, memoryBytes: 2 ** 30, marketplaceSource: profile.source, fixtureSha256: summary.fixtureSha256 } };
          if (!cell.evidence.provenance.stillSameProcess) { cell.evidence.failures.push("App stopped/restarted during journey"); cell.outcome = "failed"; }
          if (!summary.images[app].imageSourceVerified) {
            cell.evidence.gaps.push("Image lacks matching clean source-commit labels; immutable image identity is captured, source correspondence is unverified");
            cell.qualificationPassed = false;
            if (cell.outcome === "captured") cell.outcome = "unsupported";
          }
          summary.cells[app][index] = cell;
          console.log(`${app} ${profile.key}: ${cell.outcome}; ${cell.evidence.steps.length} real actions; qualification=${cell.qualificationPassed}`);
        } catch (e) { summary.cells[app][index] = { case: profile.key, outcome: "failed", reason: e.message, qualificationPassed: false, evidence: null }; }
        finally {
          if (id) try { await owned.remove(id); } catch (e) { summary.cleanupFailures.push(e.message); }
          save();
        }
      }
    }
    summary.complete = true;
  } catch (e) { summary.failures.push(e.message); }
  finally {
    if (browser) try { await browser.close(); } catch (e) { summary.cleanupFailures.push(e.message); }
    summary.cleanupFailures.push(...await owned.cleanup());
    let qualificationReports;
    try {
      const exported = exportBrowserCaptures(summary, records), captureDir = join(folder, "captures"); mkdirSync(captureDir);
      for (const [app, capture] of Object.entries(exported.captures)) writeFileSync(join(captureDir, `${app}.json`), JSON.stringify(capture, null, 2) + "\n");
      writeFileSync(join(captureDir, "manifest.json"), JSON.stringify(exported.manifest, null, 2) + "\n");
      summary.strictCaptureExport = { manifest: "captures/manifest.json", functionalPassed: Object.values(exported.manifest.reports).every((report) => report.validation.functionalPassed), readyForLoad: false };
      qualificationReports = exported.manifest.reports;
    } catch (error) { summary.failures.push(`Strict capture export: ${error.message}`); }
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    summary.qualificationPassed = groupQualificationPassed(summary, qualificationReports);
    summary.finishedAt = new Date().toISOString(); save();
  }
  return summary;
}
async function sourceSnapshot() {
  const untracked = (await command("git", ["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean);
  return sha256(JSON.stringify({ diff: await command("git", ["diff", "HEAD"]),
    untracked: untracked.map((p) => [p, sha256(readFileSync(join(repo, p)))]) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const summary = await run(process.argv.slice(2));
    // Failed/unsupported/partial matrices are not successful qualifications.
    if (!summary.qualificationPassed || summary.cleanupFailures.length) process.exitCode = 1;
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
