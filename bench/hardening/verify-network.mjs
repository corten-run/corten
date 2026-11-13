// Opt-in, bounded Docker-daemon control, not a native benchmark or qualification.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { trackedNetworkCreate, removeOwnedNetwork } from "./lifecycle.mjs";

const runId = `hardening-network-${randomBytes(6).toString("hex")}`, name = `${runId}-net`, other = `${name}-other`;
const summary = {}, reserved = [], started = new Date().toISOString();
const docker = async (args) => execFileSync("docker", args, { encoding: "utf8", timeout: 15000, windowsHide: true }).trim();
const labels = (owner) => ["--label", "agent.owner=codex", "--label", `agent.task=${owner}`, "--label", `run.corten.hardening=${owner}`];
let interrupted = false;
const interrupt = () => { interrupted = true; };
process.on("SIGINT", interrupt);
try {
  reserved.push([other, `${runId}-other`]);
  await docker(["network", "create", ...labels(`${runId}-other`), other]);
  reserved.push([name, runId]);
  await assert.rejects(trackedNetworkCreate(summary, name, () => {
    assert.deepEqual(summary.ownedNetworks, [name]);
  }, async () => {
    await docker(["network", "create", ...labels(runId), name]);
    // The daemon has committed the network, but this caller has not received its acknowledgement.
    process.emit("SIGINT"); assert.equal(interrupted, true);
    throw new Error("interrupted before acknowledgement returned to owner");
  }), /interrupted/);
  await removeOwnedNetwork(name, runId, docker);
  const remaining = JSON.parse(await docker(["network", "inspect", other]))[0];
  assert.equal(remaining.Name, other); assert.equal(remaining.Labels["run.corten.hardening"], `${runId}-other`);
  assert.equal(await docker(["network", "ls", "-q", "--filter", `label=run.corten.hardening=${runId}`]), "");
  console.log(JSON.stringify({ runId, started, control: "real-daemon-create-then-SIGINT-before-owner-ack", removedOwnedNetwork: true, preservedDifferentOwner: true }));
} finally {
  process.off("SIGINT", interrupt);
  for (const [network, owner] of reserved) await removeOwnedNetwork(network, owner, docker);
  for (const owner of [runId, `${runId}-other`]) assert.equal(await docker(["network", "ls", "-q", "--filter", `label=run.corten.hardening=${owner}`]), "");
  console.log(JSON.stringify({ runId, finished: new Date().toISOString(), ownedNetworksRemaining: 0, containersStarted: 0, volumesCreated: 0 }));
}
