import assert from "node:assert/strict";
import { test } from "node:test";
import { fork, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { providerTransport } from "../workloads/cloud-provider.mjs";
import { controller } from "./droplet.mjs";
import { nightly, officialRound, ownedDroplet, parseDropletArgs, remoteFiles, safeArchive, terminalUnit, validateState } from "./droplet-contract.mjs";

const commit = "a".repeat(40);
const state = () => ({ workload: "marketplace-v2", round: "r17", commit, options: nightly,
  name: "corten-marketplace-r17", unit: "corten-marketplace-r17.service", tag: "corten-marketplace-run-0123456789abcdef", id: "123", ip: "192.0.2.1", status: "running" });
const droplet = (s) => ({ id: Number(s.id), name: s.name, tags: ["corten-bench", "corten-marketplace", s.tag], networks: { v4: [{ type: "public", ip_address: s.ip }] }, size: { price_hourly: 0.25 } });
const loaded = "LoadState=loaded\nActiveState=inactive\nRestart=no\n";
test("official identity and explicit launch arguments", () => {
  for (const r of ["r17", "r19", "r20", "r99", "r100", "r1234"]) assert.equal(officialRound(r), r);
  for (const r of ["r16", "r1", "c1", "w1", "r017", "r17;true", "r17\n"]) assert.throws(() => officialRound(r));
  assert.equal(parseDropletArgs(["r17", "--detach", "--ssh-key", "42", "--state-dir", "../state"]).detach, true);
  assert.equal(parseDropletArgs(["r17", "--collect", "--state-dir", "../state", "--context", "bench"]).context, "bench");
  assert.throws(() => parseDropletArgs(["r17", "--collect", "--state-dir", "../state"]), /explicit saved doctl --context/);
  for (const args of [["r17"], ["r17", "--detach", "--ssh-key", "no", "--state-dir", "x"], ["r17", "--collect", "--detach", "--state-dir", "x"], ["r17", "--collect", "--state-dir", "x", "--keep"], ["r17", "--collect", "--collect", "--state-dir", "x"]]) assert.throws(() => parseDropletArgs(args));
});
test("identity never falls back to a similarly named or tagged host", () => {
  const s = state(), d = droplet(s);
  assert.equal(ownedDroplet([d], s), d);
  for (const change of [{ id: 124 }, { name: "corten-catalog-c1" }, { tags: [s.tag] }, { tags: ["corten-bench", "corten-marketplace"] }]) assert.throws(() => ownedDroplet([{ ...d, ...change }], s));
  assert.throws(() => ownedDroplet([d, d], s));
  assert.throws(() => validateState({ ...s, ip: "192.0.2.1;true" }, "r17"));
});
test("only terminal loaded non-restarting units permit collection", () => {
  assert.equal(terminalUnit(loaded), true);
  assert.equal(terminalUnit(loaded.replace("inactive", "active")), false);
  assert.equal(terminalUnit(loaded.replace("inactive", "activating")), false);
  assert.throws(() => terminalUnit(loaded.replace("loaded", "not-found")));
  assert.throws(() => terminalUnit(loaded.replace("Restart=no", "Restart=always")));
});
test("archive traversal, foreign results, symlinks and special files are refused", () => {
  const root = "repo/bench/marketplace/results/r17/summary.json";
  safeArchive(`run.log\nexit-code\n${root}\n`, "-rw-r--r-- file\ndrwxr-xr-x directory\n", "r17");
  for (const bad of ["../x", "/x", "C:/x", "a\\b", "repo/bench/fullstack/results/r17/x", "repo/bench/marketplace/results/r18/x", "repo/bench/marketplace/results/r17/../x"])
    assert.throws(() => safeArchive(bad, "-rw file", "r17"));
  for (const type of ["l", "h", "b", "c", "p"]) assert.throws(() => safeArchive(root, `${type}file`, "r17"));
});
test("remote job is pinned, detached and fail-closed without legacy measurements", () => {
  const files = remoteFiles(state());
  assert.match(files["job.sh"], new RegExp(`git checkout --detach ${commit}`));
  assert.match(files["job.sh"], /marketplace\/run.mjs r17 --build --passes 3 --duration 15 --warmup 10 --rate 150/);
  assert.match(files["job.sh"], /MARKETPLACE_APP_CPUS=1 MARKETPLACE_API_CPUS=2-3 MARKETPLACE_LOAD_CPUS=4-7/);
  assert.doesNotMatch(files["job.sh"], /run-all|catalog\/run|count.mjs|build.mjs/);
  assert.match(files[state().unit], /Restart=no/); assert.match(files[state().unit], /RuntimeMaxSec=36h/);
});
test("generated remote shell and systemd unit pass native syntax validation", { skip: process.platform !== "linux" }, (t) => {
  const temp = mkdtempSync(join(tmpdir(), "marketplace-unit-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(remoteFiles(state()))) {
    const file = join(temp, name); writeFileSync(file, content);
    const result = name.endsWith(".sh") ? spawnSync("bash", ["-n", file], { encoding: "utf8" }) : spawnSync("systemd-analyze", ["verify", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

function harness(t, { active = false, activates = false, corrupt = false, missing = false, dirty = false,
  failCreate = false, failDelete = false, lostDelete = false, failExtract = false, delayedDelete = false,
  interruptDelete = false, prefix = "marketplace-droplet-test-" } = {}) {
  const temp = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, "repo"), local = join(temp, "control"), remote = join(temp, "remote");
  mkdirSync(repo); mkdirSync(local); mkdirSync(remote);
  const statePath = join(local, "state.json");
  let s = state(), droplets = [droplet(s)], deleted = 0, creates = 0, extractions = 0, unitChecks = 0;
  let clock = 0, signal = null, team = "bench-team", getResponse, afterGet = () => {}, beforeUnit = () => {};
  const calls = [], waits = [], observedAfterDelete = [];
  const saved = () => JSON.parse(readFileSync(statePath, "utf8"));
  const run = (binary, args, bound = false) => {
    calls.push([binary, ...args]);
    const good = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (binary === "git") return good(args[0] === "rev-parse" ? commit : dirty ? " M README.md\n" : "");
    if (binary === "doctl") {
      if (args[0] === "account") return good(JSON.stringify([{ uuid: "operator", team: { uuid: team } }]));
      if (args[2] === "list") return good(JSON.stringify(droplets));
      if (args[2] === "get") {
        assert.ok(bound);
        const matches = droplets.filter((d) => String(d.id) === args[3]);
        const found = getResponse ?? (matches.length ? good(JSON.stringify(matches))
          : { status: 1, stdout: "", providerDiagnostic: { code: "get-http", httpStatus: 404 } });
        if (deleted) {
          observedAfterDelete.push(matches.map((d) => d.id));
          if (delayedDelete && !failDelete) droplets = [];
        }
        afterGet();
        return found;
      }
      if (args[2] === "create") {
        creates++;
        const saved = JSON.parse(readFileSync(join(local, "state.json"), "utf8")); s = { ...saved, id: "123", ip: "192.0.2.1" };
        droplets = [droplet(s)]; return failCreate ? { status: 1, stdout: "", stderr: "connection lost after create" } : good();
      }
      if (args[2] === "delete") {
        deleted++;
        assert.equal(args[3], "123");
        assert.ok(bound);
        assert.ok(existsSync(join(local, "collect.lock")));
        assert.equal(existsSync(join(local, "state.json.delete-intent.tmp")), false, "the staged file has been published before dispatch");
        assert.deepEqual(saved().deletionTarget, { id: "123", account: "team:bench-team", context: "bench" });
        assert.ok(saved().deletionIntentAt && saved().collectedAt && !saved().destroyedAt);
        if (failDelete) return { status: 1, stdout: "", stderr: "delete temporarily unavailable" };
        if (!delayedDelete) droplets = [];
        else droplets = droplets.map((d) => ({ ...d, tags: [] }));
        if (interruptDelete) signal = "SIGINT";
        if (lostDelete) throw new Error("delete acknowledgement lost");
        return good();
      }
    }
    if (binary === "ssh") {
      const script = args.at(-1);
      if (script.startsWith("systemctl show")) {
        unitChecks++;
        beforeUnit(unitChecks);
        return good(missing ? loaded.replace("loaded", "not-found") : active || (activates && unitChecks > 1) ? loaded.replace("inactive", "active") : loaded);
      }
      if (script === "sha256sum /bench/results.tgz") return good(`${createHash("sha256").update(readFileSync(join(remote, "results.tgz"))).digest("hex")}  /bench/results.tgz`);
      if (script.startsWith("tail")) return good("checking corten fixture\n");
      return good();
    }
    if (binary === "scp") {
      if (args.at(-2).startsWith("root@")) writeFileSync(args.at(-1), corrupt ? "corrupt archive" : readFileSync(join(remote, "results.tgz")));
      return good();
    }
    if (binary === "tar") {
      if (args[0] === "-xzf" && failExtract && ++extractions === 1) {
        writeFileSync(join(args.at(-1), "partial.txt"), "preserved partial extraction");
        throw new Error("transient extraction failure");
      }
      const r = spawnSync(binary, args, { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r;
    }
    throw new Error(`unexpected command ${binary} ${args.join(" ")}`);
  };
  const providerFactory = () => Object.assign(async (args) => {
    assert.deepEqual(args.slice(-2), ["--context", "bench"]);
    return run("doctl", args, true);
  }, { close: async () => {} });
  return { repo, local, remote, run, calls, waits, observedAfterDelete, saved, get deleted() { return deleted; }, get creates() { return creates; },
    reserve(change = {}) { writeFileSync(statePath, JSON.stringify({ ...s, ...change })); },
    changeHost(change) { droplets = droplets.map((d) => ({ ...d, ...change })); },
    selectTeam(value) { team = value; },
    getResponse(value) { getResponse = value; },
    onGet(callback) { afterGet = callback; },
    onUnit(callback) { beforeUnit = callback; },
    tick(ms) { clock += ms; },
    resume() { signal = null; },
    empty() { droplets = []; },
    archive({ beforeRun = false } = {}) {
      if (!beforeRun) {
        const result = join(remote, "repo/bench/marketplace/results/r17"); mkdirSync(result, { recursive: true });
        writeFileSync(join(result, "summary.json"), JSON.stringify({ workload: "marketplace-v2", round: "r17", commit, complete: false, failures: ["failed checks"] }));
      }
      writeFileSync(join(remote, "exit-code"), "1\n"); writeFileSync(join(remote, "run.log"), "checks failed\n");
      const r = spawnSync("tar", ["-czf", join(remote, "results.tgz"), "-C", remote, "run.log", "exit-code", ...(beforeRun ? [] : ["repo/bench/marketplace/results/r17"])], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr);
    },
    task(extra = {}, deps = {}) { return controller({ round: "r17", stateDir: local, sshKey: "42", context: "bench", ...extra },
      { run, repo, interrupted: () => signal, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; },
        providerFactory, ...deps }); },
  };
}
test("live unit: no pack, download, deletion or restart", async (t) => {
  const h = harness(t, { active: true }); h.reserve();
  assert.equal(await h.task().collect(), 3); assert.equal(h.deleted, 0);
  assert.ok(!h.calls.some((c) => c[0] === "scp" || c.at(-1) === "/bin/bash /bench/pack.sh"));
});
test("missing unit preserves droplet and evidence", async (t) => {
  const h = harness(t, { missing: true }); h.reserve();
  await assert.rejects(h.task().collect(), /unit missing/); assert.equal(h.deleted, 0);
});
test("wrong host identity refuses any SSH or delete", async (t) => {
  for (const change of [{ id: 124 }, { name: "unrelated" }, { tags: ["corten-bench"] },
    { networks: { v4: [{ type: "public", ip_address: "192.0.2.2" }] } }]) {
    const h = harness(t); h.reserve(); h.changeHost(change);
    await assert.rejects(h.task().collect(), /absence unconfirmed|Expected values|ownership tag|public IP differs/);
    assert.equal(h.deleted, 0); assert.ok(!h.calls.some((c) => c[0] === "ssh"));
  }
});
test("unit that becomes active after custody is not deleted", async (t) => {
  const h = harness(t, { activates: true }); h.reserve(); h.archive();
  await assert.rejects(h.task().collect(), /unit became active/);
  assert.ok(h.saved().collectedAt); assert.equal(h.saved().deletionIntentAt, undefined); assert.equal(h.deleted, 0);
});
test("exclusive collect lock prevents even provider reads", async (t) => {
  const h = harness(t); h.reserve();
  const lock = join(h.local, "collect.lock"); writeFileSync(lock, "other collector");
  await assert.rejects(h.task().collect(), { code: "EEXIST" });
  assert.deepEqual(h.calls, []); assert.equal(readFileSync(lock, "utf8"), "other collector");
});
test("hash mismatch preserves droplet and downloaded archive", async (t) => {
  const h = harness(t, { corrupt: true }); h.reserve(); h.archive();
  await assert.rejects(h.task().collect(), /hash mismatch/); assert.equal(h.deleted, 0);
  assert.ok(existsSync(join(h.local, "results.tgz.download")));
});
test("partial artifacts survive terminal deletion and repeated collect", async (t) => {
  const h = harness(t); h.reserve(); h.archive();
  assert.equal(await h.task().collect(), 1); assert.equal(h.deleted, 1);
  const saved = JSON.parse(readFileSync(join(h.local, "state.json"), "utf8"));
  assert.equal(saved.complete, false); assert.ok(saved.destroyedAt);
  assert.ok(existsSync(join(saved.resultFolder, "summary.json")));
  assert.ok(existsSync(saved.resultArchive));
  assert.equal(await h.task().collect(), 1); assert.equal(h.deleted, 1);
});

test("pre-measurement failure reports its actual preserved evidence directory", async (t) => {
  const h = harness(t); h.reserve(); h.archive({ beforeRun: true });
  assert.equal(await h.task().collect(), 1); assert.equal(h.deleted, 1);
  const saved = JSON.parse(readFileSync(join(h.local, "state.json"), "utf8"));
  assert.equal(saved.resultFolder, saved.evidenceFolder);
  assert.ok(existsSync(join(saved.resultFolder, "run.log")));
  assert.equal(existsSync(join(saved.resultFolder, "summary.json")), false);
});
test("failed DELETE and a still-listed ID time out; even a stale controller only reads", async (t) => {
  const h = harness(t, { failDelete: true }); h.reserve(); h.archive();
  const stale = h.task();
  await assert.rejects(h.task().collect(), /deletion not confirmed \(DELETE acknowledgement unavailable\).*deadline elapsed/);
  const pending = h.saved(), archive = readFileSync(pending.resultArchive);
  assert.ok(pending.collectedAt && pending.deletionIntentAt); assert.equal(pending.destroyedAt, undefined);
  assert.equal(h.waits.reduce((sum, n) => sum + n, 0), 120000);
  const calls = h.calls.length;
  await assert.rejects(stale.collect(), /saved intent, no DELETE attempted.*deadline elapsed/);
  assert.deepEqual(h.saved(), pending);
  h.empty();
  assert.equal(await h.task().collect(), 1);
  assert.ok(h.saved().destroyedAt);
  assert.deepEqual(readFileSync(pending.resultArchive), archive);
  assert.equal(h.deleted, 1);
  assert.ok(h.calls.slice(calls).every((c) => c[0] === "doctl" && (c[1] === "account" || c[3] === "get")));
});

test("interrupted extraction retries independently and preserves the failed attempt", async (t) => {
  const h = harness(t, { failExtract: true }); h.reserve(); h.archive();
  await assert.rejects(h.task().collect(), /transient extraction/); assert.equal(h.deleted, 0);
  const before = JSON.parse(readFileSync(join(h.local, "state.json"), "utf8"));
  assert.ok(existsSync(join(before.extractionAttempts[0], "partial.txt")));
  const downloads = h.calls.filter((c) => c[0] === "scp").length;
  assert.equal(await h.task().collect(), 1); assert.equal(h.deleted, 1);
  const after = JSON.parse(readFileSync(join(h.local, "state.json"), "utf8"));
  assert.equal(after.extractionAttempts.length, 2);
  assert.ok(existsSync(join(before.extractionAttempts[0], "partial.txt")));
  assert.ok(existsSync(join(after.resultFolder, "summary.json")));
  assert.equal(h.calls.filter((c) => c[0] === "scp").length, downloads);
  assert.equal(existsSync(join(h.repo, "bench/marketplace/results/r17")), false);
});

test("one still-present exact ID after DELETE does not fail terminal collection", async (t) => {
  const h = harness(t, { delayedDelete: true }); h.reserve(); h.archive();
  assert.equal(await h.task().collect(), 1);
  assert.equal(h.deleted, 1);
  assert.deepEqual(h.observedAfterDelete, [[123], []]);
  assert.deepEqual(h.waits, [3000]);
  assert.ok(h.saved().destroyedAt);
});

test("lost deletion acknowledgement is reconciled in the same call without a second delete", async (t) => {
  const h = harness(t, { lostDelete: true, delayedDelete: true }); h.reserve(); h.archive();
  assert.equal(await h.task().collect(), 1); assert.equal(h.deleted, 1);
  assert.deepEqual(h.observedAfterDelete, [[123], []]); assert.ok(h.saved().destroyedAt);
});
test("interrupted after DELETE: recheck saved evidence and account, then confirm on resume", async (t) => {
  const h = harness(t, { interruptDelete: true }); h.reserve(); h.archive();
  await assert.rejects(h.task().collect(), /deletion not confirmed.*SIGINT received/);
  const before = h.saved(), calls = h.calls.length, archive = readFileSync(before.resultArchive);
  assert.ok(before.collectedAt && before.deletionIntentAt); assert.equal(before.destroyedAt, undefined);
  assert.deepEqual(h.observedAfterDelete, []);
  assert.equal(existsSync(join(h.local, "collect.lock")), false);
  h.resume();
  h.selectTeam("another-team"); // Same doctl user, different team, empty inventory.
  await assert.rejects(h.task().collect(), /provider account changed/);
  assert.deepEqual(h.saved(), before);
  h.selectTeam("bench-team");
  await assert.rejects(h.task({ context: "wrong-context" }).collect(), /context differs/);
  h.onGet(() => h.selectTeam("another-team"));
  await assert.rejects(h.task().collect(), /provider account changed/);
  assert.deepEqual(h.saved(), before);
  h.selectTeam("bench-team"); h.onGet(() => {});
  h.getResponse({ status: 1, stdout: "", providerDiagnostic: { code: "get-http", httpStatus: 500 } });
  await assert.rejects(h.task().collect(), /provider read did not succeed/);
  assert.deepEqual(h.saved(), before);
  for (const bad of ["[", "null", "[]", '[{"id":99}]']) {
    h.getResponse({ status: 0, stdout: bad });
    await assert.rejects(h.task().collect(), /invalid JSON|did not return the exact ID/);
    assert.deepEqual(h.saved(), before);
  }
  h.getResponse(undefined);
  h.onGet(() => h.tick(120000));
  await assert.rejects(h.task().collect(), /confirmation deadline elapsed/);
  assert.deepEqual(h.saved(), before);
  h.onGet(() => {});
  writeFileSync(before.resultArchive, "tampered archive");
  await assert.rejects(h.task().collect(), /saved archive hash mismatch/);
  assert.deepEqual(h.saved(), before);
  writeFileSync(before.resultArchive, archive);
  assert.equal(await h.task().collect(), 1); assert.equal(h.deleted, 1);
  assert.ok(h.saved().destroyedAt);
  assert.ok(h.calls.slice(calls).every((c) => c[0] === "doctl" && (c[1] === "account" || c[3] === "get")));
});
test("unbound historical pending intent is not promoted, even on an empty inventory", async (t) => {
  const h = harness(t); h.reserve({ deletionIntentAt: "2026-01-01T00:00:00.000Z", collectedAt: "2026-01-01T00:00:00.000Z" });
  h.empty();
  await assert.rejects(h.task().collect(), /no bound ID\/account\/context.*never repeat DELETE/);
  assert.deepEqual(h.calls, []); assert.equal(h.saved().destroyedAt, undefined);
});
function credentialWorker(mode, onAction = () => {}) {
  const actions = [], children = [];
  const providerFactory = (options) => providerTransport({ ...options, launch(_binary, _args, opts) {
    const child = fork(fileURLToPath(new URL("./test-fixtures/credential-reload.mjs", import.meta.url)), [mode], opts);
    children.push(child);
    const send = child.send.bind(child);
    child.send = (message, done) => {
      if (message.args) { actions.push(message.args); onAction(message.args); }
      return send(message, done);
    };
    return child;
  } });
  return { actions, children, providerFactory };
}
test("a context remapped A to B to A cannot confirm absence of the live A host", async (t) => {
  const h = harness(t, { failDelete: true }); h.reserve(); h.archive();
  await assert.rejects(h.task().collect(), /deletion not confirmed/);
  const { actions, children, providerFactory } = credentialWorker("resume");
  const calls = h.calls.length;
  await assert.rejects(h.task({}, { providerFactory }).collect(), /deletion not confirmed.*deadline elapsed/);
  assert.deepEqual(children.map((child) => child.exitCode), [0]);
  assert.ok(actions.filter((a) => a[2] === "get").length > 1);
  assert.ok(actions.every((a) => a[0] === "account" || a[2] === "get"));
  assert.equal(h.calls.length, calls, "confirmation never reloads doctl via the legacy command runner");
  assert.equal(h.saved().destroyedAt, undefined);
  assert.equal(h.deleted, 1);
});
test("the worker that checks ownership sends the sole DELETE and confirms the exact ID", async (t) => {
  for (const mode of ["fresh", "lost"]) await t.test(mode, async (t) => {
    const h = harness(t); h.reserve(); h.archive();
    let durableAtDispatch = false;
    const { actions, children, providerFactory } = credentialWorker(mode, (args) => {
      if (args[2] === "delete") {
        durableAtDispatch = Boolean(h.saved().deletionIntentAt && h.saved().collectedAt && !h.saved().destroyedAt);
      }
    });
    const task = h.task({}, { providerFactory });
    if (mode === "fresh") {
      assert.equal(await task.collect(), 1);
      assert.ok(h.saved().destroyedAt);
      assert.ok(actions.some((a) => a[2] === "get" && a[3] === "123"));
      assert.deepEqual(children.map((child) => child.exitCode), [0]);
    } else {
      await assert.rejects(task.collect(), /deletion not confirmed.*acknowledgement unavailable/);
      assert.equal(h.saved().destroyedAt, undefined);
      assert.equal(children.length, 1, "an uncertain worker never triggers a new session in this invocation");
      const gone = credentialWorker("gone");
      assert.equal(await h.task({}, gone).collect(), 1);
      assert.ok(h.saved().destroyedAt);
      assert.ok(gone.actions.every((a) => a[0] === "account" || a[2] === "get"));
    }
    assert.ok(durableAtDispatch);
    assert.equal(actions.filter((a) => a[2] === "delete" && a[3] === "123").length, 1);
    assert.ok(!h.calls.some((c) => c[0] === "doctl"), "legacy command runner has no collection authority");
  });
});
test("native Windows publishes an intent on NTFS and resumes without a second DELETE", { skip: process.platform !== "win32" }, async (t) => {
  const h = harness(t, { prefix: "marketplace [Windows intent] 'test'-", interruptDelete: true }); h.reserve(); h.archive();
  await assert.rejects(h.task().collect(), /deletion not confirmed.*SIGINT received/);
  assert.equal(h.deleted, 1);
  assert.equal(h.saved().destroyedAt, undefined);
  assert.ok(h.saved().deletionIntentAt);
  h.resume();
  assert.equal(await h.task().collect(), 1);
  assert.equal(h.deleted, 1); assert.ok(h.saved().destroyedAt);
});
test("native Windows rename refusal never reaches DELETE", { skip: process.platform !== "win32" }, async (t) => {
  const h = harness(t); h.reserve(); h.archive();
  const target = join(h.local, "state.json"), backup = `${target}.test-backup`;
  h.onUnit((checks) => {
    if (checks !== 2) return;
    renameSync(target, backup);
    mkdirSync(target); // The Win32 file rename cannot replace a directory.
  });
  await assert.rejects(h.task().collect(), /no DELETE sent.*NTFS write-through intent rename failed/);
  assert.equal(h.deleted, 0);
  const prior = JSON.parse(readFileSync(backup, "utf8"));
  assert.ok(prior.collectedAt); assert.equal(prior.deletionIntentAt, undefined);
  assert.ok(existsSync(prior.resultArchive));
  assert.ok(existsSync(`${target}.delete-intent.tmp`), "preserve staged bytes for operator review");
});
test("last directory fsync must finish before DELETE, and a failed sync leaves read-only intent", { skip: process.platform === "win32" }, async (t) => {
  const h = harness(t, { failDelete: true }); h.reserve(); h.archive();
  let syncs = 0;
  const syncIntentDirectory = (directory) => {
    assert.equal(directory, h.local);
    assert.equal(h.deleted, 0);
    if (++syncs === 1) assert.equal(h.saved().deletionIntentAt, undefined);
    else {
      assert.ok(h.saved().deletionIntentAt, "final sync happens after rename");
      assert.equal(existsSync(join(h.local, "state.json.delete-intent.tmp")), false);
      throw new Error("injected directory fsync failure");
    }
  };
  await assert.rejects(h.task({}, { syncIntentDirectory }).collect(), /injected directory fsync failure/);
  assert.equal(syncs, 2); assert.equal(h.deleted, 0);
  await assert.rejects(h.task().collect(), /saved intent, no DELETE attempted.*deadline elapsed/);
  assert.equal(h.deleted, 0); assert.equal(h.saved().destroyedAt, undefined);
});
test("launch reserves once even when create response is ambiguous", async (t) => {
  const h = harness(t, { active: true, failCreate: true }); h.empty();
  assert.equal((await h.task().launch()).status, "running"); assert.equal(h.creates, 1);
  await assert.rejects(h.task().launch(), /already reserved/); assert.equal(h.creates, 1);
});
test("an unsupported durable publisher refuses an ordinary launch before any cloud command", async (t) => {
  const h = harness(t, { active: true }); h.empty();
  const publishIntent = () => { throw new Error("scripts are disabled on this system"); };
  await assert.rejects(h.task({}, { publishIntent }).launch(), /publisher preflight failed.*no droplet created.*scripts are disabled/);
  assert.ok(!h.calls.some((c) => c[0] === "doctl" || c[0] === "ssh"));
  assert.equal(h.creates, 0);
  assert.equal(existsSync(join(h.local, "state.json")), false);
});
test("Windows Restricted policy refuses before provisioning without a policy override", { skip: process.platform !== "win32" }, async (t) => {
  const h = harness(t, { active: true }); h.empty();
  const prior = process.env.PSExecutionPolicyPreference;
  process.env.PSExecutionPolicyPreference = "Restricted";
  try {
    await assert.rejects(h.task().launch(), /publisher preflight failed.*no droplet created.*running scripts is disabled/is);
  } finally {
    if (prior === undefined) delete process.env.PSExecutionPolicyPreference;
    else process.env.PSExecutionPolicyPreference = prior;
  }
  assert.ok(!h.calls.some((c) => c[0] === "doctl" || c[0] === "ssh"));
  assert.equal(existsSync(join(h.local, "state.json")), false);
});
test("dirty checkout and existing benchmark prevent create", async (t) => {
  const h = harness(t, { dirty: true }); h.empty();
  await assert.rejects(h.task().launch(), /clean measured commit/); assert.equal(h.creates, 0);
  const busy = harness(t); await assert.rejects(busy.task().launch(), /already exists/); assert.equal(busy.creates, 0);
});
