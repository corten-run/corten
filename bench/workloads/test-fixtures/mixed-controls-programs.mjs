// Synthetic control-boundary emitter. No transport, provider or campaign imports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
const future = process.argv.includes("--future-template");
if (future) registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url === new URL("../cloud-remote.mjs", import.meta.url).href) {
    const source = String(result.source), needle = "export function remoteFiles(state) {";
    assert.equal(source.split(needle).length, 2);
    return { ...result, source: source.replace(needle, `${needle} throw new Error("synthetic future launch template must not supply historical controls");`) };
  }
  return result;
} });
const { mixedWait, mixedCancelProgram, mixedCancelScript } = await import("../cloud-cancellation.mjs");
const { failedNativeScript } = await import("../cloud-retirement.mjs");
const { fleetPlan, reservation } = await import("../cloud-contract.mjs");
const { groupNames } = await import("../registry.mjs");
const { remoteFiles } = await import("../cloud-remote.mjs");
const provider = { accountId: mixedWait.accountId, context: mixedWait.context };
const tokens = Object.fromEntries(groupNames.map((g, i) => [g, g === mixedWait.group ? mixedWait.token : String(i + 1).padStart(16, "0")]));
const fleet = fleetPlan({ round: "r21", commit: mixedWait.commit, token: "f".repeat(16), tokens, provider, sshKey: "42" });
const state = { ...reservation({ round: "r21", commit: mixedWait.commit, token: mixedWait.token, group: mixedWait.group, fleet }),
  status: "running", id: mixedWait.id, ip: mixedWait.ip, provider, fullGroupQualified: false };
const cancelProgram = mixedCancelProgram(state), cancelScript = mixedCancelScript(state);
state.mixedCancellation = { controllerCommit: "c".repeat(40), intentSha256: "a".repeat(64), reservationSha256: "b".repeat(64) };
const custodyScript = failedNativeScript(state);
const original = JSON.parse(readFileSync(new URL("./mixed-original-controls.json", import.meta.url)));
let current = null;
if (future) assert.throws(() => remoteFiles(state), /synthetic future launch template/);
else current = remoteFiles(state);
console.log(JSON.stringify({ cancelProgram, cancelScript, custodyScript, original, current }));
