// All cloud/SSH/SCP controls are fake. Only local tar and temporary-file operations run.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { controller } from "./droplet.mjs";
import { host, reservation, tags } from "./droplet-contract.mjs";
import { aggregate, phases, sources, targets } from "./contract.mjs";
import { groupResultSchema, qualificationIdentity, timingPlan } from "./group.mjs";
import { records } from "./fixtures.mjs";

const commit = "a".repeat(40);
// Synthetic, complete validator input. Not measurements or native/machine admission evidence.
function summary(s) {
  const imageId = `sha256:${"b".repeat(64)}`;
  const phase = { requests: 6000, rps: 100, p50: 1, p95: 2, p99: 3, failed: 0, dropped: 0, perCpuSecond: 110,
    cpuUsec: 55000000, cpuAvgPct: 99, memAvgMiB: 8, memMaxMiB: 8, upstream: { cpuAvgPct: 50, highCpu: false } };
  const check = { jsonRecords: 500, pages: 120, profiles: [false, true].flatMap((javaScriptEnabled) =>
    ["desktop-light", "desktop-dark", "phone-light", "phone-dark"].map((profile) => ({ profile, javaScriptEnabled, forms: true, related: true, styles: true }))),
    upstream: { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true } };
  const result = { schema: groupResultSchema, group: s.group, options: s.options, workload: "catalog-v1", round: s.round, commit: s.commit,
    dirty: false, commitAfter: s.commit, dirtyAfter: false, complete: true, checksPassed: true, failures: [], cleanupFailures: [],
    startedAt: "2026-11-12T10:00:00Z", finishedAt: "2026-11-12T16:00:00Z",
    fixtureSha256: createHash("sha256").update(`${JSON.stringify(records())}\n`).digest("hex"),
    measurement: { encoding: "identity", fixedRate: s.options.rate, cpus: s.cpus },
    apps: Object.fromEntries(s.group.apps.map((app) => [app, { imageId, checks: Object.fromEntries(sources.map((source) =>
      [source, { ...structuredClone(check), qualification: qualificationIdentity(s.group, app, source, imageId) }])), runs: {} }])) };
  for (const { app, pass, ...profile } of timingPlan(s.options, sources, targets)) {
    (result.apps[app].runs[`${profile.source}-${profile.target}`] ??= []).push({ pass, evidence: { app, ...profile, imageId }, complete: true,
      cold: { path: "/catalog/record_1", first200At: "2026-11-12T10:00:00.200Z", containerStartedAt: "2026-11-12T10:00:00.000Z",
        first200MsFromContainerStart: 200, measuredBeforeReadinessOrWarmup: true, attempts: 2, bytes: 1000, successfulRequestMs: 2 },
      warmup: structuredClone(phase), phases: Object.fromEntries(phases.map((p) => [p, structuredClone(phase)])) });
  }
  for (const entry of Object.values(result.apps)) entry.phases = Object.fromEntries(Object.entries(entry.runs).map(([key, runs]) =>
    [key, Object.fromEntries(phases.map((phase) => [phase, { ...aggregate(runs.map((r) => r.phases[phase])), asked: s.options.passes }]))]));
  return result;
}
function harness(t, flags = {}) {
  const temp = mkdtempSync(join(tmpdir(), "catalog-host-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, "repo"), base = join(temp, "control"), remote = join(temp, "remote"), local = join(base, "catalog-page-c2");
  mkdirSync(repo); mkdirSync(base); mkdirSync(remote);
  const statePath = join(local, "state.json"), calls = [];
  let s = { ...reservation("c2", commit, "0123456789abcdef"), id: "123", ip: "192.0.2.1", status: "running" };
  const d = () => ({ id: 123, name: s.name, tags: [...tags, s.tag], size_slug: host.size, region: { slug: host.region },
    networks: { v4: [{ type: "public", ip_address: "192.0.2.1" }] } });
  let droplets = [], creates = 0, deletes = 0, extracts = 0, units = 0;
  const good = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const run = (binary, args, timeout, allowFail) => {
    calls.push([binary, ...args]); assert.ok(Number.isSafeInteger(timeout ?? 60000) && (timeout ?? 60000) <= 15 * 60000, "bounded control call");
    if (binary === "git") {
      if (args[0] === "rev-parse") return good(args[1] === "HEAD" ? flags.wrongHead ? "b".repeat(40) : commit : flags.wrongRoot ? temp : repo);
      if (args[0] === "status") return good(flags.dirty ? " M README.md" : "");
      if (args[0] === "merge-base" && flags.unmerged) throw new Error("not merged");
      if (args[0] === "cat-file" && flags.untrackedLauncher) throw new Error("source not committed");
      return good();
    }
    if (binary === "doctl") {
      if (args[0] === "account") return good(JSON.stringify({ droplet_limit: flags.noCapacity ? 0 : 20 }));
      if (args[2] === "list") { if (flags.listError) throw new Error("list unavailable"); return good(JSON.stringify(droplets)); }
      if (args[2] === "create") {
        creates++; const round = /^corten-catalog-page-(c[1-9]\d*)-/.exec(args[3])?.[1]; assert.ok(round);
        const saved = JSON.parse(readFileSync(join(base, `catalog-page-${round}`, "state.json")));
        assert.ok(saved.createIntentAt, "reservation/intent must predate create"); s = saved;
        droplets = flags.createMissing ? [] : flags.createAmbiguous ? [d(), { ...d(), id: 124 }] : [d()];
        return flags.createResponseLost ? { status: null, error: new Error("create timed out"), stdout: "", stderr: "ambiguous create" } : good();
      }
      if (args[2] === "delete") {
        assert.equal(args[3], "123", "only exact owned ID may be deleted"); deletes++;
        const saved = JSON.parse(readFileSync(statePath)); assert.ok(saved.collectedAt && saved.deletionIntentAt && saved.archiveSha256);
        if (flags.deleteError && deletes === 1) throw new Error("delete unavailable");
        if (!flags.deleteUnconfirmed) droplets = [];
        if (flags.deleteAckLost && deletes === 1) throw new Error("delete acknowledgement lost");
        return good();
      }
    }
    if (binary === "ssh") {
      const script = args.at(-1);
      if (script === "true") return good();
      if (script.startsWith("systemctl show")) {
        units++;
        if (flags.unitError) throw new Error("unit control unavailable");
        return good(`Id=${flags.wrongUnit ? "foreign.service" : s.unit}\nLoadState=${flags.missingUnit ? "not-found" : "loaded"}\nFragmentPath=/etc/systemd/system/${s.unit}\nActiveState=${flags.active || flags.activeAfterDownload && units > 1 ? "active" : "inactive"}\nRestart=no\nMainPID=0\nExecMainCode=1\nExecMainStartTimestamp=Thu 2026-11-12 10:00:00 UTC\n`);
      }
      if (script === "sha256sum /bench/results.tgz") return good(`${createHash("sha256").update(readFileSync(join(remote, "results.tgz"))).digest("hex")}  /bench/results.tgz`);
      if (flags.packError && script.includes("/bin/bash /bench/pack.sh")) throw new Error("pack failed");
      if (flags.startError && script.startsWith("systemctl start")) throw new Error("start acknowledgement lost");
      return good();
    }
    if (binary === "scp") {
      if (args.at(-2).startsWith("root@")) {
        writeFileSync(args.at(-1), flags.corrupt ? "corrupt download" : readFileSync(join(remote, "results.tgz")));
        if (flags.downloadError) throw new Error("download interrupted");
      }
      return good();
    }
    if (binary === "tar") {
      if (args[0] === "-xzf" && ++extracts === 1 && flags.extractError) {
        writeFileSync(join(args.at(-1), "interrupted.txt"), "partial extraction"); throw new Error("extraction interrupted");
      }
      const r = spawnSync(binary, args, { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r;
    }
    throw new Error(`unexpected control ${binary} ${args.join(" ")}, allowFail=${allowFail}`);
  };
  return { temp, repo, base, local, remote, calls, flags,
    get creates() { return creates; }, get deletes() { return deletes; },
    saved() { return JSON.parse(readFileSync(statePath, "utf8")); },
    changeState(fn) { const saved = this.saved(); fn(saved); writeFileSync(statePath, JSON.stringify(saved)); },
    seed() { mkdirSync(local); writeFileSync(statePath, JSON.stringify(s)); droplets = [d()]; },
    hosts(value) { droplets = value ?? [d()]; },
    archive({ exitCode = 0, beforeRun = false, mutate = () => {}, extra } = {}) {
      const names = ["run.log", "exit-code"];
      writeFileSync(join(remote, "run.log"), "synthetic test log\n"); writeFileSync(join(remote, "exit-code"), `${exitCode}\n`);
      if (!beforeRun) {
        const root = `repo/bench/catalog/results/${s.round}`, folder = join(remote, root); mkdirSync(folder, { recursive: true });
        const result = summary(s); mutate(result); writeFileSync(join(folder, "summary.json"), JSON.stringify(result)); names.push(root);
      }
      if (extra) { writeFileSync(join(remote, extra), "foreign"); names.push(extra); }
      const r = spawnSync("tar", ["-czf", join(remote, "results.tgz"), "-C", remote, ...names], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr);
    },
    task(deps = {}, options = {}) { return controller({ round: "c2", group: "catalog-page", commit, sshKey: "42", stateDir: base, ...options }, { run, repo, sleep: async () => {}, ...deps }); },
  };
}

test("one exclusive durable reservation, lost create response reconciles one exact host but never creates twice", async (t) => {
  const h = harness(t, { createResponseLost: true, active: true });
  const s = await h.task().launch(); assert.equal(h.creates, 1); assert.equal(s.status, "running"); assert.equal(s.commit, commit);
  assert.ok(h.calls.some((c) => c[0] === "git" && c[1] === "cat-file"));
  assert.equal(h.calls.filter((c) => c[0] === "ssh" && c.at(-1).startsWith("systemctl start")).length, 1);
  await assert.rejects(h.task().launch(), /already reserved/); assert.equal(h.creates, 1);
});

test("missing or ambiguous create preserves reservation, never provisions or automatically relaunches", async (t) => {
  for (const flags of [{ createMissing: true }, { createAmbiguous: true }]) {
    const h = harness(t, flags); await assert.rejects(h.task().launch(), /missing or ambiguous/);
    assert.ok(h.saved().createIntentAt); assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
    assert.ok(!h.calls.some((c) => c[0] === "ssh")); await assert.rejects(h.task().launch(), /already reserved/);
  }
});

test("dirty/wrong-root/wrong-HEAD/unmerged/uncommitted source, old results, existing group host or capacity failure prevent create", async (t) => {
  for (const flags of [{ dirty: true }, { wrongRoot: true }, { wrongHead: true }, { unmerged: true }, { untrackedLauncher: true }, { noCapacity: true }]) {
    const h = harness(t, flags); await assert.rejects(h.task().launch()); assert.equal(h.creates, 0);
  }
  const busy = harness(t); busy.hosts(); await assert.rejects(busy.task().launch(), /already exists/); assert.equal(busy.creates, 0);
  const old = harness(t); mkdirSync(join(old.repo, "bench/catalog/results/c2"), { recursive: true });
  await assert.rejects(old.task().launch(), /round already exists/); assert.equal(old.creates, 0);
});

test("control state must be physically outside checkout, including junction/symlink aliases", (t) => {
  const h = harness(t);
  assert.throws(() => controller({ round: "c2", group: "catalog-page", stateDir: join(h.repo, "control") }, { repo: h.repo }), /outside checkout/);
  assert.ok(!existsSync(join(h.repo, "control")));
  const alias = join(h.temp, "repo-alias"); symlinkSync(h.repo, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => controller({ round: "c2", group: "catalog-page", stateDir: join(alias, "control") }, { repo: h.repo }), /outside checkout/);
  assert.ok(!existsSync(join(h.repo, "control")));
});

test("shared operation lock rejects overlap, including stale/unknown locks; no cloud calls", async (t) => {
  const h = harness(t); h.seed(); const lock = join(h.local, "operation.lock");
  for (const pid of [process.pid, 999999999]) {
    writeFileSync(lock, JSON.stringify({ pid })); await assert.rejects(h.task().collect(), /EEXIST/);
    assert.ok(existsSync(lock)); assert.equal(h.calls.length, 0);
  }
});

test("running unit never packs/downloads/deletes; missing/wrong/unreachable units preserve owned host", async (t) => {
  const live = harness(t, { active: true }); live.seed(); assert.equal(await live.task().collect(), 3);
  assert.ok(!live.calls.some((c) => c[0] === "scp" || c.at(-1).includes("/bin/bash /bench/pack.sh"))); assert.equal(live.deletes, 0);
  for (const flags of [{ missingUnit: true }, { wrongUnit: true }, { unitError: true }, { listError: true }]) {
    const h = harness(t, flags); h.seed(); await assert.rejects(h.task().collect()); assert.equal(h.deletes, 0);
  }
});

test("exact identity mismatch preserves all hosts and never uses fallback name/tag", async (t) => {
  const h = harness(t); h.seed(); h.hosts([{ id: 123, name: "corten-catalog-c1", tags: [] }]);
  await assert.rejects(h.task().collect()); assert.equal(h.deletes, 0); assert.ok(!h.calls.some((c) => c[0] === "ssh"));
});

test("start acknowledgement loss leaves durable starting state and collection cannot race a running unit", async (t) => {
  const h = harness(t, { startError: true, active: true }); await assert.rejects(h.task().launch(), /acknowledgement lost/);
  assert.equal(h.saved().status, "starting"); assert.equal(await h.task().collect(), 3); assert.equal(h.deletes, 0); assert.equal(h.creates, 1);
});

test("strict real catalog report accepts full synthetic matrix only; successful collection is idempotent", async (t) => {
  const h = harness(t); h.seed(); h.archive(); assert.equal(await h.task().collect(), 0);
  const saved = h.saved(); assert.equal(saved.complete, true); assert.ok(saved.destroyedAt && saved.evidenceSha256);
  assert.ok(existsSync(join(h.local, "validated-report.md"))); assert.equal(h.deletes, 1);
  const downloads = h.calls.filter((c) => c[0] === "scp").length;
  assert.equal(await h.task().collect(), 0); assert.equal(h.deletes, 1); assert.equal(h.calls.filter((c) => c[0] === "scp").length, downloads);
});

test("failed/pre-measurement jobs download partials and confirm deletion without claiming completeness", async (t) => {
  for (const beforeRun of [false, true]) {
    const h = harness(t); h.seed(); h.archive({ exitCode: 1, beforeRun }); assert.equal(await h.task().collect(), 1);
    const s = h.saved(); assert.equal(s.complete, false); assert.ok(s.validationError && s.destroyedAt);
    assert.ok(existsSync(join(h.local, "results.tgz"))); assert.ok(existsSync(join(h.local, s.evidence, "run.log")));
    assert.equal(await h.task().collect(), 1); assert.equal(h.deletes, 1);
  }
});

test("strict identity/defaults/CPU/matrix/provenance/aggregate validation rejects apparently successful summaries", async (t) => {
  for (const mutate of [
    (s) => { s.round = "c3"; }, (s) => { s.commit = "c".repeat(40); }, (s) => { s.group.contractSha256 = "c".repeat(64); },
    (s) => { s.options.duration = 15; }, (s) => { s.options.apps.pop(); }, (s) => { s.measurement.cpus.app.cpuset = "0"; },
    (s) => { delete s.apps.gin; }, (s) => { s.apps.corten.runs["api-page"].pop(); },
    (s) => { s.apps.corten.runs["api-page"][1].pass = 1; }, (s) => { s.apps.corten.checks.api.profiles.pop(); },
    (s) => { s.apps.corten.runs["fixture-json"] = []; }, (s) => { s.dirtyAfter = true; },
    (s) => { s.commitAfter = "c".repeat(40); }, (s) => { s.apps.corten.phases["api-page"].fixed.rps.median++; },
  ]) {
    const h = harness(t); h.seed(); h.archive({ mutate }); assert.equal(await h.task().collect(), 1);
    assert.equal(h.saved().complete, false); assert.ok(h.saved().validationError); assert.equal(h.deletes, 1);
  }
});

test("pack/download/hash/unsafe archive errors preserve host and downloaded evidence", async (t) => {
  for (const flags of [{ packError: true }, { downloadError: true }, { corrupt: true }]) {
    const h = harness(t, flags); h.seed(); h.archive(); await assert.rejects(h.task().collect()); assert.equal(h.deletes, 0);
    if (!flags.packError) assert.ok(existsSync(join(h.local, "results.tgz.download")));
  }
  const unsafe = harness(t); unsafe.seed(); unsafe.archive({ extra: "foreign.txt" });
  await assert.rejects(unsafe.task().collect(), /foreign archive/); assert.equal(unsafe.deletes, 0); assert.ok(existsSync(join(unsafe.local, "results.tgz")));
});

test("extraction interruption retries into a fresh directory without overwriting the failed attempt or downloading again", async (t) => {
  const h = harness(t, { extractError: true }); h.seed(); h.archive(); await assert.rejects(h.task().collect(), /extraction interrupted/);
  assert.equal(h.deletes, 0); const first = h.saved().extractionAttempts[0]; assert.ok(existsSync(join(h.local, first, "interrupted.txt")));
  assert.equal(await h.task().collect(), 0); assert.equal(h.saved().extractionAttempts.length, 2);
  assert.ok(existsSync(join(h.local, first, "interrupted.txt"))); assert.equal(h.calls.filter((c) => c[0] === "scp").length, 1);
});

test("unit becoming active after download prevents deletion; later collection reuses verified evidence", async (t) => {
  const h = harness(t, { activeAfterDownload: true }); h.seed(); h.archive();
  await assert.rejects(h.task().collect(), /unit became active/); assert.equal(h.deletes, 0); assert.ok(h.saved().collectedAt);
  h.flags.activeAfterDownload = false; assert.equal(await h.task().collect(), 0); assert.equal(h.calls.filter((c) => c[0] === "scp").length, 1);
});

test("validator infrastructure error is uncertain, preserves host and can retry the same evidence", async (t) => {
  const h = harness(t); h.seed(); h.archive();
  await assert.rejects(h.task({ inspect: () => { throw new Error("validator unavailable"); } }).collect(), /validator unavailable/);
  assert.equal(h.deletes, 0); assert.equal(await h.task().collect(), 0);
});

test("delete failure/unconfirmed deletion retries, lost acknowledgement reconciles confirmed absence without second delete", async (t) => {
  for (const flags of [{ deleteError: true }, { deleteUnconfirmed: true }, { deleteAckLost: true }]) {
    const h = harness(t, flags); h.seed(); h.archive(); await assert.rejects(h.task().collect());
    assert.ok(h.saved().deletionIntentAt && h.saved().collectedAt); assert.equal(h.saved().destroyedAt, undefined);
    h.flags.deleteUnconfirmed = false; assert.equal(await h.task().collect(), 0);
    assert.equal(h.deletes, flags.deleteAckLost ? 1 : 2); assert.equal(h.calls.filter((c) => c[0] === "scp").length, 1);
  }
});

test("archive/extracted evidence tampering prevents cleanup retries, including confirmed-absence reconciliation", async (t) => {
  for (const tamper of ["archive", "extracted"]) {
    const h = harness(t, { deleteAckLost: true }); h.seed(); h.archive(); await assert.rejects(h.task().collect(), /acknowledgement lost/);
    writeFileSync(tamper === "archive" ? join(h.local, "results.tgz") : join(h.local, h.saved().evidence, "run.log"), "tampered");
    await assert.rejects(h.task().collect(), tamper === "archive" ? /archive hash mismatch/ : /extracted evidence changed/);
    assert.equal(h.saved().destroyedAt, undefined); assert.equal(h.deletes, 1);
  }
});

test("collection rejects a round-directory junction before any lock write reaches the measured repository", async (t) => {
  const h = harness(t), events = [];
  symlinkSync(h.repo, h.local, process.platform === "win32" ? "junction" : "dir");
  const watcher = watch(h.repo, (_event, name) => events.push(String(name))); t.after(() => watcher.close());
  await assert.rejects(h.task().collect(), /symlink|boundary|physical/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!events.includes("operation.lock"), "lock creation/deletion must not touch the checkout before rejection");
  assert.equal(h.calls.length, 0);
});

test("an unresolved durable reservation blocks another round even when ambiguous create lists no host", async (t) => {
  const h = harness(t, { createMissing: true }); await assert.rejects(h.task().launch(), /missing or ambiguous/);
  assert.equal(h.creates, 1);
  await assert.rejects(h.task({}, { round: "c3" }).launch(), /unresolved.*c2|c2.*unresolved/);
  assert.equal(h.creates, 1); assert.ok(!existsSync(join(h.base, "catalog-page-c3", "state.json")));
});

test("stale shared launch locks and incomplete reservations are preserved rather than automatically cleared", async (t) => {
  const h = harness(t), lock = join(h.base, ".catalog-page-launch.lock");
  writeFileSync(lock, JSON.stringify({ pid: 999999999, round: "c2" }));
  await assert.rejects(h.task().launch(), /EEXIST/); assert.ok(existsSync(lock)); assert.equal(h.calls.length, 0);
  const partial = harness(t); mkdirSync(partial.local);
  await assert.rejects(partial.task({}, { round: "c3" }).launch(), /unresolved.*without state/);
  assert.equal(partial.calls.length, 0); assert.equal(partial.creates, 0);
});

test("a collected round with confirmed deletion permits a later explicit round under the same state root", async (t) => {
  const h = harness(t); h.seed(); h.archive(); assert.equal(await h.task().collect(), 0);
  h.flags.active = true;
  const next = await h.task({}, { round: "c3" }).launch();
  assert.equal(next.round, "c3"); assert.equal(next.status, "running"); assert.equal(h.creates, 1);
  assert.ok(h.saved().destroyedAt, "previous reservation remains intact");
});

test("synchronized independent launch processes cannot both preflight/create under one state root", { timeout: 30000 }, async (t) => {
  const h = harness(t), children = [];
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const script = `
    import assert from 'node:assert/strict';
    import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {controller} from ${JSON.stringify(new URL("./droplet.mjs", import.meta.url).href)};
    const [base,repo,round,commit]=process.argv.slice(1), hosts=join(base,'fake-hosts.jsonl');
    const local=join(base,'catalog-page-'+round); let first=true,s;
    const good=(stdout='')=>({status:0,stdout,stderr:''});
    const list=()=>existsSync(hosts)?readFileSync(hosts,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];
    const run=(binary,args)=>{
      if(binary==='git')return good(args[0]==='rev-parse'?(args[1]==='HEAD'?commit:repo):'');
      if(binary==='doctl'){
        if(args[0]==='account')return good(JSON.stringify({droplet_limit:20}));
        if(args[2]==='list'){
          const snapshot=list();
          if(first){first=false;writeFileSync(join(base,round+'-preflight'),'ready');
            const deadline=Date.now()+15000;
            while(!existsSync(join(base,'release-preflight'))){assert.ok(Date.now()<deadline,'barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
          }
          return good(JSON.stringify(snapshot));
        }
        if(args[2]==='create'){
          s=JSON.parse(readFileSync(join(local,'state.json'),'utf8'));
          assert.ok(s.createIntentAt);
          const d={id:round==='c2'?123:124,name:s.name,tags:['corten-bench','corten-catalog-page',s.tag],size_slug:'c-8',region:{slug:'sfo2'},networks:{v4:[{type:'public',ip_address:'192.0.2.1'}]}};
          appendFileSync(hosts,JSON.stringify(d)+'\\n'); return good();
        }
      }
      if(binary==='ssh')return good(args.at(-1).startsWith('systemctl show')?
        'Id='+s.unit+'\\nLoadState=loaded\\nFragmentPath=/etc/systemd/system/'+s.unit+'\\nActiveState=active\\nRestart=no\\nMainPID=22\\nExecMainCode=0\\nExecMainStartTimestamp=now\\n':'');
      if(binary==='scp')return good();
      throw Error('unexpected fake control '+binary);
    };
    try{await controller({round,group:'catalog-page',stateDir:base,commit,sshKey:'42'},{run,repo,sleep:async()=>{}}).launch();console.log('LAUNCHED');}
    catch(e){console.error(e.message);process.exitCode=1;}
  `;
  function start(round) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, h.base, h.repo, round, commit], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child); let output = ""; child.stdout.on("data", (s) => { output += s; }); child.stderr.on("data", (s) => { output += s; });
    return { child, done: new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (code) => resolve({ code, output })); }) };
  }
  const until = async (condition) => { const deadline = Date.now() + 10000; while (!condition()) { assert.ok(Date.now() < deadline, "child synchronization timeout"); await new Promise((r) => setTimeout(r, 10)); } };
  const a = start("c2"); await until(() => existsSync(join(h.base, "c2-preflight")));
  const b = start("c3"); await until(() => b.child.exitCode !== null || existsSync(join(h.base, "c3-preflight")));
  writeFileSync(join(h.base, "release-preflight"), "release");
  const [first, second] = await Promise.all([a.done, b.done]);
  assert.equal(first.code, 0, first.output); assert.equal(second.code, 1, second.output);
  assert.equal(readFileSync(join(h.base, "fake-hosts.jsonl"), "utf8").trim().split("\n").length, 1, "exactly one create");
  assert.ok(!existsSync(join(h.base, "c3-preflight")), "second process must not reach a stale cloud preflight");
});
