import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { workerRound, indexRound, legacyRound } from "./workers-fixture.mjs";
import { collectTimedPhase } from "./timed.mjs";
import { replayCatalog } from "./raw.mjs";
import { validateSaved } from "./verify.mjs";

const here = dirname(fileURLToPath(import.meta.url)), repo = join(here, "../..");
const failure = { app: "fastapi", source: "api", pass: 1, phase: "sat256", timeouts: 1 };
function scratch() { return mkdtempSync(join(here, ".worker-test-")); }
function remove(path) { assert.equal(dirname(path), here); rmSync(path, { recursive: true, force: true }); }
const info = (p) => ({ Id: p.id, Name: p.name, Image: p.image, RestartCount: p.restarts, Path: p.path, Args: p.args,
  State: p.state, HostConfig: p.budget, Config: { Entrypoint: p.entrypoint, Cmd: p.command, Env: p.env, Labels: { "run.corten.catalog": p.owner } },
  NetworkSettings: { Networks: Object.fromEntries(p.networks.map((n) => [n, {}])) }, Mounts: p.mounts });

test("worker-aware producer retains native exit99, exact worker raw observations and secondary cleanup errors", async () => {
  const f = workerRound(failure), prefix = "api/fastapi/p1-page", phase = "sat256";
  const proof = f.reader.readJson(`${prefix}/${phase}-cpu-counters.json`), boundary = f.reader.readJson(`${prefix}/${phase}-boundary.json`);
  const worker = f.reader.readJson(`${prefix}/${phase}-workers.json`), now = Date.now;
  for (const broken of [false, true]) {
    const raw = scratch(); let started = false, reads = 0, removed = false, clock = proof.startedAt;
    Date.now = () => clock;
    const context = { summary: f.summary, raw, cpus: f.summary.measurement.cpus, k6Image: "synthetic", mount: [], owned: async () => {},
      upstreamControl: async (value) => {
        if (value?.observation === "begin") return { processes: worker.processes.map(({ identity }) => ({ identity })) };
        if (value?.observation === "end") { if (broken) throw new Error("worker observation lost"); return { processes: worker.processes }; }
        return value === undefined ? worker.after : worker.before;
      },
      inspect: async (name) => info(boundary[started ? "after" : "before"][name.endsWith("-k6") ? "load" : name.endsWith("-upstream") ? "upstream" : "runtime"]),
      cpu: async () => ({ ids: proof.ids, values: ++reads === 1 ? proof.before : proof.after }),
      sampleStats: () => ({ stop: async () => {
        for (const suffix of ["-stats.log", "-stats.log.json"]) writeFileSync(join(raw, phase + suffix), f.reader.readText(`${prefix}/${phase}${suffix}`));
        if (broken) throw new Error("sampler incomplete");
      } }),
      docker: async (args) => {
        if (args[0] === "start") {
          started = true; clock = proof.finishedAt; writeFileSync(join(raw, `${phase}.log`), "synthetic native exit99\n");
          throw Object.assign(new Error("exit99"), { exit: boundary.exit });
        }
        assert.equal(args[0], "cp"); writeFileSync(join(raw, `${phase}.json`), f.reader.readText(`${prefix}/${phase}.json`));
      },
      remove: async () => { removed = true; if (broken) throw new Error("cleanup failed"); },
    };
    const subject = { app: "fastapi", source: "api", target: "page", phase, seconds: f.summary.options.duration,
      instance: f.reader.readJson(`${prefix}/container.json`) };
    try {
      if (broken) {
        await assert.rejects(collectTimedPhase(context, subject), /apparatus failed/);
        const saved = JSON.parse(readFileSync(join(raw, `${phase}-boundary.json`)));
        assert.equal(saved.exit.code, 99);
        for (const stage of ["sampler stop", "worker sampler stop", "load cleanup"]) assert.ok(saved.errors.some((e) => e.stage === stage));
      } else {
        const measured = await collectTimedPhase(context, subject); assert.equal(measured.outcome, "failed"); assert.equal(measured.timeouts, 1);
        const observed = JSON.parse(readFileSync(join(raw, `${phase}-workers.json`))); assert.equal(observed.processes.length, 3);
        for (const key of [".json", ".log", "-boundary.json", "-cpu-counters.json", "-cpu.json", "-stats.log", "-stats.log.json", "-workers.json"])
          f.put(`${prefix}/${phase}${key}`, readFileSync(join(raw, `${phase}${key}`), "utf8"));
        indexRound(f); assert.equal(replayCatalog(f.summary, f.reader, f.commit).attemptComplete, true);
      }
      assert.equal(removed, true);
    } finally { Date.now = now; remove(raw); }
  }
});

test("old v3 stays strictly replayable without worker proof, never acquires v4 admission", () => {
  const f = legacyRound(failure), report = replayCatalog(f.summary, f.reader, f.commit);
  assert.equal(report.attemptComplete, true); assert.equal(report.rawVerified, undefined); assert.equal(report.apparatusPreflight, undefined);
  f.summary.savedEvidence.schema = "catalog-saved-evidence/v4";
  assert.throws(() => replayCatalog(f.summary, f.reader, f.commit), /apparatus differs/);
});

test("saved v4 API and strict report join raw replay; missing preflight and retained cleanup cannot pass", { timeout: 15000 }, () => {
  const f = workerRound(), folder = scratch();
  try {
    for (const [key, bytes] of f.files) { mkdirSync(dirname(join(folder, key)), { recursive: true }); writeFileSync(join(folder, key), bytes); }
    const saved = validateSaved({ folder, round: f.summary.round, commit: f.commit });
    assert.equal(saved.status, "verified"); assert.equal(saved.report.rawVerified, true);
    const run = () => spawnSync(process.execPath, ["--max-old-space-size=256", join(here, "report.mjs"), join(folder, "summary.json"), "--commit", f.commit, "--require-complete"], {
      cwd: repo, windowsHide: true, encoding: "utf8", timeout: 10000, maxBuffer: 256 * 1024,
    });
    const passed = run(); assert.equal(passed.status, 0, passed.stderr); assert.match(passed.stdout, /Raw replay: verified; first-host admission: passed/);
    writeFileSync(join(folder, "preflight.json"), "{}");
    assert.equal(validateSaved({ folder, round: f.summary.round, commit: f.commit }).status, "invalid");
    const failed = run(); assert.equal(failed.status, 1); assert.match(failed.stdout, /worker-aware raw replay required/);
  } finally { remove(folder); }
});
