// Invoked explicitly with --experimental-test-module-mocks. The sole local
// substitution is a declared synthetic known_hosts hash. Installed native
// verifier imports still require the real, source-bound Git commit.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as local from "../cloud-local.mjs";
import { mixedWait, mixedCancelScript, verifyMixedCancellation } from "../cloud-cancellation.mjs";
import { fleetPlan, host, reservation, tags } from "../cloud-contract.mjs";
import { groupNames } from "../registry.mjs";
import { mixedIntentRoot } from "../cloud-retirement.mjs";
const keyBytes = "SYNTHETIC known_hosts DATA, no real key\n";
const originalControls = JSON.parse(readFileSync(new URL("./mixed-original-controls.json", import.meta.url))).files;
const originalHashes = Object.fromEntries(Object.entries(originalControls).map(([name, bytes]) => [name, local.digest(bytes)]));
mock.module(new URL("../cloud-local.mjs", import.meta.url).href, { namedExports: { ...local, fileHash(path, ...rest) {
  if (path.endsWith("known_hosts")) {
    const bytes = local.regular(path); return bytes.toString() === keyBytes ? mixedWait.knownHostsSha256 : local.digest(bytes);
  }
  return local.fileHash(path, ...rest);
} } });
const { controller } = await import("../droplet.mjs");
function fixture(t, flags = {}) {
  t.mock.method(Date, "now", () => Date.parse("2026-11-16T01:00:00.000Z"));
  const root = mkdtempSync(join(tmpdir(), "mixed-controller-")), repo = join(root, "repo"), base = join(root, "state"), folder = join(base, "groups-r21");
  mkdirSync(repo); mkdirSync(base); mkdirSync(folder);
  t.after(() => { assert.ok(root.startsWith(join(tmpdir(), "mixed-controller-"))); rmSync(root, { recursive: true, force: true }); });
  const provider = { accountId: mixedWait.accountId, context: mixedWait.context };
  const tokens = Object.fromEntries(groupNames.map((g, i) => [g, g === mixedWait.group ? mixedWait.token : String(i + 1).padStart(16, "0")]));
  const fleet = fleetPlan({ round: "r21", commit: mixedWait.commit, token: "f".repeat(16), tokens, provider, sshKey: "42" });
  const state = { ...reservation({ round: "r21", commit: mixedWait.commit, token: mixedWait.token, group: mixedWait.group, fleet }),
    status: "running", id: mixedWait.id, ip: mixedWait.ip, provider, fullGroupQualified: false, createIntentAt: new Date().toISOString() };
  const statePath = join(folder, "state.json"); writeFileSync(statePath, JSON.stringify(state)); writeFileSync(join(folder, "known_hosts"), keyBytes);
  const saved = () => JSON.parse(readFileSync(statePath));
  const calls = [], counts = { signals: 0, units: 0, deletes: 0, downloads: 0, accounts: 0 };
  const good = (stdout) => ({ status: 0, stdout });
  const run = (binary, argv) => {
    calls.push([binary, argv]);
    if (binary === "doctl") {
      assert.equal(argv.at(-1), "default");
      if (argv[0] === "account") {
        counts.accounts++; return good(JSON.stringify({ team: { uuid: flags.foreignAccount ? "foreign" : mixedWait.accountId.slice(5) } }));
      }
      if (argv[2] === "get") {
        assert.equal(argv[3], mixedWait.id);
        if (flags.changeState) writeFileSync(statePath, `${readFileSync(statePath)}\n`);
        return good(JSON.stringify([{ id: Number(state.id), name: state.name, tags: [...tags, state.tag], size_slug: host.size,
          region: { slug: host.region }, networks: { v4: [{ type: "public", ip_address: state.ip }] } }]));
      }
      if (argv[2] === "delete") { counts.deletes++; assert.fail("synthetic wait proof cannot delete"); }
    }
    if (binary === "ssh") {
      assert.ok(argv.includes("StrictHostKeyChecking=yes")); const script = argv.at(-1);
      if (script.includes("CORTEN_MIXED_CANCEL")) {
        assert.equal(script, mixedCancelScript(state));
        const configLine = script.split("\n")[2];
        assert.deepEqual(JSON.parse(JSON.parse(configLine.slice("c = json.loads(".length, -1))).files, originalHashes);
        verifyMixedCancellation(folder, saved());
        assert.ok(existsSync(join(folder, "operation.lock"))); counts.signals++;
        if (flags.lost) throw Object.assign(new Error("synthetic lost signal response"), { controlTreeUncertain: true });
        if (flags.refused) throw new Error("synthetic remote refusal");
        if (flags.changeAfterSignal) writeFileSync(statePath, `${readFileSync(statePath)}\n`);
        return good(JSON.stringify({ schema: "benchmark-mixed-cancel-signal/v1", hostId: state.id, unit: state.unit,
          campaign: mixedWait.campaign, subjectSha256: mixedWait.subjectSha256, remoteIntentSha256: "a".repeat(64),
          pid: 1234, startTicks: 567, signaled: !flags.badAck, observedAtMs: Date.now() }));
      }
      if (script.startsWith("systemctl show")) {
        counts.units++; return good(`Id=${state.unit}\nLoadState=loaded\nFragmentPath=/etc/systemd/system/${state.unit}\nActiveState=active\nRestart=no\nMainPID=2251\nExecMainCode=0\nExecMainStartTimestamp=${mixedWait.unitStart}\n`);
      }
    }
    if (binary === "scp") counts.downloads++;
    assert.fail("unexpected synthetic transport");
  };
  const task = (action = "cancelMixedWait") => controller({ round: "r21", stateDir: base, [action]: true }, {
    repo, run, recoveryApproval: { controllerCommit: "c".repeat(40), reservationSha256: local.digest(readFileSync(statePath)) },
  });
  return { folder, saved, calls, counts, task, flags };
}
test("actual caller/callee join durably reserves one intent before the exact signal script", async (t) => {
  const f = fixture(t); assert.equal(await f.task().cancelMixedWait(), 3);
  assert.equal(f.counts.signals, 1); assert.equal(f.counts.deletes, 0); verifyMixedCancellation(f.folder, f.saved());
  assert.ok(existsSync(join(f.folder, "mixed-cancel-signal.json"))); assert.ok(!existsSync(join(f.folder, "operation.lock")));
  await assert.rejects(f.task().cancelMixedWait()); assert.equal(f.counts.signals, 1);
  const before = f.calls.length; assert.equal(await f.task("retireFailedNative").retireFailedNative(), 3);
  assert.equal(f.counts.units, 1); assert.equal(f.counts.downloads, 0); assert.equal(f.counts.deletes, 0);
  assert.ok(!f.calls.slice(before).some(([b, argv]) => b === "ssh" && /(?:pack.sh|CORTEN_MIXED_CANCEL)/.test(argv.at(-1))));
  assert.equal(f.saved().fullGroupQualified, false); assert.equal(f.saved().validation, undefined); assert.equal(f.saved().auditIntents, undefined);
});
for (const mode of ["lost", "refused", "badAck", "changeAfterSignal"]) test(`${mode} retains single-attempt intent and lock without retry or DELETE`, async (t) => {
  const f = fixture(t, { [mode]: true }); await assert.rejects(f.task().cancelMixedWait());
  assert.equal(f.counts.signals, 1); assert.equal(f.counts.deletes, 0);
  assert.ok(existsSync(join(f.folder, "mixed-cancel-intent.json"))); assert.ok(existsSync(join(f.folder, "operation.lock")));
  await assert.rejects(f.task().cancelMixedWait()); assert.equal(f.counts.signals, 1);
});
for (const mode of ["foreignAccount", "changeState"]) test(`${mode} refuses before intent and signal`, async (t) => {
  const f = fixture(t, { [mode]: true }); await assert.rejects(f.task().cancelMixedWait());
  assert.equal(f.counts.signals, 0); assert.equal(f.counts.deletes, 0); assert.ok(!existsSync(join(f.folder, "mixed-cancel-intent.json")));
});
test("actual regular intent root framing and link refusals on Linux", (t) => {
  const f = fixture(t), path = join(f.folder, "root-2"), bytes = Buffer.from('{"signal":"SIGTERM"}\n');
  writeFileSync(path, bytes, { mode: 0o600 });
  const root = { path: "/bench/mixed-cancel-intent.json", present: true, nodes: 1, bytes: bytes.length,
    treeSha256: local.digest(Buffer.concat([Buffer.from(`f\0\0${bytes.length}\0`), bytes])) };
  assert.deepEqual(mixedIntentRoot(path, root), { signal: "SIGTERM" });
  assert.throws(() => mixedIntentRoot(path, { ...root, treeSha256: local.digest(bytes) }));
  writeFileSync(path, '{"signal":"SIGINT"}\n'); assert.throws(() => mixedIntentRoot(path, root)); writeFileSync(path, bytes);
  linkSync(path, join(f.folder, "hardlink")); assert.throws(() => mixedIntentRoot(path, root)); unlinkSync(join(f.folder, "hardlink"));
  symlinkSync(path, join(f.folder, "symlink")); assert.throws(() => mixedIntentRoot(join(f.folder, "symlink"), root));
});
