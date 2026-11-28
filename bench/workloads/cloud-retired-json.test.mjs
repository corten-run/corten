import assert from "node:assert/strict";
import test from "node:test";
import { reservation, validateFleet, validateLaunchFleet, validateState } from "./cloud-contract.mjs";
import { digest } from "./cloud-local.mjs";
import { remoteFiles } from "./cloud-remote.mjs";
import { failedNativeScript } from "./cloud-retirement.mjs";

// Generated at the r105 measured commit with synthetic host inputs. The
// roster and expected bytes must not come from the current checkout's plan.
const group = "json-api", round = "r105", commit = "15aa9c615c45ccdf00ea9c7a8beaa75e25bcaa64";
const at = "2026-11-25T00:00:00.000Z", token = "0".repeat(16), name = `corten-bench-groups-${round}-${token}`;
function retired() {
  const selection = { schema: "benchmark-groups/v1", groups: [{ group,
    contractSha256: "b0015ffc90e28f85823f1e7a392e8ed5a97f2f2a6e56cf6c9287934589325fb9",
    apps: ["corten", "aspnet", "fastapi", "express", "spring", "axum-maud", "drogon", "gin", "aspnet-aot"] }] };
  const tag = `corten-bench-groups-run-${token}`, loadLayout = "json-c32-generator-v1";
  const host = { size: "c-32", region: "sfo2", image: "ubuntu-24-04-x64" };
  const fleet = { schema: "benchmark-group-fleet/v5", round, commit, token: "1".repeat(16), createdAt: at,
    provider: { accountId: "user:test", context: "test" }, sshKey: "42", host: { ...host, size: "c-8" }, selection,
    jobs: [{ group, token, name, tag, host, loadLayout }],
    single: { group, indexSha256: "a".repeat(64), checkout: "/test/measured", loadLayout },
    fleetSha256: "414710f91e39737e5f522c1e0305ea111f1fff4a026c545a25082ef35cd90faa" };
  return { schema: "benchmark-dedicated-group-host/v1", round, commit, token, name, tag, unit: name + ".service", host,
    selection: structuredClone(selection), group, fleet, createdAt: at, status: "retired", id: "123", ip: "192.0.2.10",
    benchPackage: true, archiveSha256: "b".repeat(64), deletionIntentAt: at, destroyedAt: at,
    retirement: { kind: "native-failed", evidenceSha256: "d".repeat(64) } };
}

const roots = ["/bench/campaign", "/bench/repo/bench/json-api/results/j210", "/bench/repo/bench/json-api/results/j211"];
const grouped = { roots, host: { bootId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name, knownHostsSha256: "e".repeat(64) } };
const snapshot = "c".repeat(64), fence = { snapshotSha256: snapshot,
  roots: [...roots, "/bench/run.log", "/bench/host.txt", "/bench/exit-code", "/bench/results.tgz"].map(path => ({ path, present: true })) };
const capture = (state) => failedNativeScript(state, null, null, grouped);

test("retired JSON API custody with the original nine-app roster reproduces all three saved scripts", () => {
  const state = retired();
  assert.deepEqual([capture(state), failedNativeScript(state, snapshot, null, grouped), failedNativeScript(state, snapshot, fence, grouped)]
    .map(script => digest(script)), ["c30fd5426f445e2755a8ef32d805a3489fe38da9c5eeae9a846937eb38e49607",
    "c3500e9044097248a3712019f712e93454888f26d6bf2593da2e7364716d1744", "ec8cba4c360425fd770331e7236a5dff1a10991b1b8a30639d6ddee3ed545894"]);
  const files = remoteFiles(state);
  assert.deepEqual(Object.fromEntries(Object.entries(files).map(([key, bytes]) => [key, digest(bytes)])), {
    "job.sh": "e9b1d9b7f5208d00b7144d9b46105066c9648edb3731dfc31267a713d53c354c",
    "pack.sh": "345498b521483f13180ddcc5610814fba2127efa14c138580f99b2a1aac2e39b",
    [state.unit]: "d19643196020dd8b8238547d4ac8b468fad4122da548317404f8d978a55d9ef3",
  });
});

test("the old JSON API roster cannot launch or reconstruct files without confirmed native-failure retirement", () => {
  const state = retired(), { retirement, deletionIntentAt, destroyedAt, ...prior } = state;
  assert.throws(() => validateState(state, round), /complete fixed registry/);
  assert.throws(() => validateLaunchFleet(state.fleet), /complete fixed registry/);
  assert.throws(() => reservation({ round, commit, token, group, fleet: state.fleet }, at), /complete fixed registry/);
  for (const saved of [{ ...prior, status: "running" }, { ...state, destroyedAt: undefined },
    { ...state, retirement: { ...retirement, kind: "setup-failed" } }]) {
    assert.throws(() => capture(saved), /complete fixed registry/);
  }
});

test("retired JSON API replay still binds the original contract, roster, fleet digest and child selection", () => {
  for (const change of [row => row.apps.reverse(), row => { row.contractSha256 = "f".repeat(64); }]) {
    const state = retired(), { fleetSha256, ...body } = state.fleet;
    change(body.selection.groups[0]);
    state.selection = structuredClone(body.selection);
    state.fleet = { ...body, fleetSha256: digest(JSON.stringify(body)) };
    validateFleet(state.fleet, { priorSelection: true });
    assert.throws(() => capture(state), /complete fixed registry/);
  }
  const state = retired();
  assert.throws(() => capture({ ...state, fleet: { ...state.fleet, fleetSha256: "0".repeat(64) } }), /complete fixed registry/);
  state.selection.groups[0].apps.pop();
  assert.throws(() => capture(state), /complete native group/);
});
