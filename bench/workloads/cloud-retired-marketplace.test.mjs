import assert from "node:assert/strict";
import test from "node:test";
import { reservation, validateFleet, validateLaunchFleet, validateState } from "./cloud-contract.mjs";
import { digest } from "./cloud-local.mjs";
import { failedNativeScript } from "./cloud-retirement.mjs";

// Reservation and script digests from the r41 controller (153be9116), generated
// with synthetic host inputs. Do not derive the expected roster from today's registry.
const group = "localized-marketplace", round = "r41", commit = "153be9116b725f6bd5ebd4a4184dfdef5756be39";
const at = "2026-11-21T00:00:00.000Z", token = "0".repeat(16), name = `corten-bench-groups-${round}-${token}`;
function retired() {
  const row = { group, contractSha256: "e7196bc53d5d9a48543dacdfa245c672d5dda68c514f43339779de58f022c9eb",
    apps: ["corten", "nextjs", "aspnet", "django", "topcoat", "leptos", "gin", "drogon"] };
  const selection = { schema: "benchmark-groups/v1", groups: [row] }, tag = `corten-bench-groups-run-${token}`;
  const host = { size: "c-8", region: "sfo3", image: "ubuntu-24-04-x64" };
  const fleet = { schema: "benchmark-group-fleet/v5", round, commit, token: "1".repeat(16), createdAt: at,
    provider: { accountId: "user:test", context: "test" }, sshKey: "42", host, selection, jobs: [{ group, token, name, tag }],
    single: { group, indexSha256: "a".repeat(64), checkout: "/test/measured" },
    fleetSha256: "05bb250ea22eb7ff28abb05c394cd1311871f547e1154bcce22024e68b739bdd" };
  return { schema: "benchmark-dedicated-group-host/v1", round, commit, token, name, tag, unit: name + ".service", host,
    selection: structuredClone(selection), group, fleet, createdAt: at, status: "retired", id: "123", ip: "192.0.2.10",
    benchPackage: true, archiveSha256: "b".repeat(64), deletionIntentAt: at, destroyedAt: at,
    retirement: { kind: "native-failed", evidenceSha256: "d".repeat(64) } };
}
const roots = ["/bench/campaign", "/bench/repo/bench/marketplace/results/r41"], grouped = { roots, host: { hostname: name } };
const snapshot = "c".repeat(64), fence = { snapshotSha256: snapshot,
  roots: [...roots, "/bench/run.log", "/bench/host.txt", "/bench/exit-code", "/bench/results.tgz"].map(path => ({ path, present: true })) };
const capture = (state) => failedNativeScript(state, null, null, grouped);

test("retired marketplace custody reproduces the pre-rotation capture, rehash and final scripts", () => {
  const state = retired();
  assert.deepEqual([capture(state), failedNativeScript(state, snapshot, null, grouped), failedNativeScript(state, snapshot, fence, grouped)]
    .map(script => digest(script)), ["35d64ae8897cf106a2f1b799232368ef790a17141a700c41cfa3087153b36e7d",
    "69c7d174a4bfbb5efe04e36cac59ff06593b9d472a6a4a5f800a607a700d4363", "e7e9ad61b4acdc312da73934530bd0e429aa34c696356bd813a283f98657959a"]);
});

test("the old roster cannot launch or render for a live, unconfirmed, or differently retired host", () => {
  const state = retired(), { retirement, deletionIntentAt, destroyedAt, ...prior } = state;
  assert.throws(() => validateState(state, round), /complete fixed registry/);
  assert.throws(() => validateLaunchFleet(state.fleet), /complete fixed registry/);
  assert.throws(() => reservation({ round, commit, token, group, fleet: state.fleet }, at), /complete fixed registry/);
  for (const saved of [{ ...prior, status: "running" }, { ...state, destroyedAt: undefined },
    { ...state, retirement: { ...retirement, kind: "setup-failed" } }]) assert.throws(() => capture(saved), /complete fixed registry/);
});

test("retired replay still binds the original contract, roster, fleet digest and child selection", () => {
  for (const change of [row => row.apps.reverse(), row => { row.contractSha256 = "f".repeat(64); }]) {
    const state = retired(), { fleetSha256, ...body } = state.fleet;
    change(body.selection.groups[0]);
    state.selection = structuredClone(body.selection);
    state.fleet = { ...body, fleetSha256: digest(JSON.stringify(body)) };
    validateFleet(state.fleet, { priorSelection: true }); // Internally consistent, but not the pinned historical roster.
    assert.throws(() => capture(state), /complete fixed registry/);
  }
  const state = retired();
  assert.throws(() => capture({ ...state, fleet: { ...state.fleet, fleetSha256: "0".repeat(64) } }), /complete fixed registry/);
  state.selection.groups[0].apps.pop();
  assert.throws(() => capture(state), /complete native group/);
});
