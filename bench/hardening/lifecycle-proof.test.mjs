import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedContainerRecorder, verifyContainerCommands, ownedResourceCleanup, verifyResourceCleanup, ownedCleanupObservation, verifyOwnedCleanup, requireCommandAcknowledgement } from "./lifecycle.mjs";

const root = mkdtempSync(join(tmpdir(), "hardening-recorder-"));
after(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
const id = "a".repeat(64), other = "b".repeat(64), runId = "hardening-test", name = `${runId}-ready`;

test("build acknowledgement completeness covers every required input/status field without defaulting", () => {
  const fields = ["args", "exitCode", "startedAt", "finishedAt", "timedOut", "interrupted", "inputSha256", "inputBytes"];
  const row = { args: ["build"], exitCode: 0, startedAt: "2026-11-13T12:00:00Z", finishedAt: "2026-11-13T12:00:01Z",
    timedOut: false, interrupted: false, inputSha256: "a".repeat(64), inputBytes: 1 };
  const check = (value) => requireCommandAcknowledgement(value, ["timedOut", "interrupted", "inputSha256", "inputBytes"]);
  assert.doesNotThrow(() => check(row));
  for (const field of fields) for (const value of [undefined, null]) {
    assert.throws(() => check({ ...row, [field]: value }), (e) => e.code === "ENOENT", field);
  }
  for (const patch of [{ args: "build" }, { exitCode: "0" }, { timedOut: "false" }, { startedAt: "not-a-date" }])
    assert.throws(() => check({ ...row, ...patch }), (e) => e.code === "ERR_ASSERTION");
  for (const malformed of [false, 0, "acknowledged", []]) assert.throws(() => check(malformed), (e) => e.code === "ERR_ASSERTION");
});
function apparatus({ loseCreationAck = false, foreignCollision = false, disappeared = false, startFailure } = {}) {
  const folder = join(root, String(sequence++)); mkdirSync(folder); const calls = [];
  const info = { Id: id, Name: "/" + name, HostConfig: { NetworkMode: "none" }, Config: { Labels: {
    "run.corten.hardening": runId, "agent.owner": "codex", "agent.task": runId } } };
  let exists = false;
  const command = async (args) => {
    calls.push(args);
    if (args[0] === "create") {
      const intent = JSON.parse(readFileSync(join(folder, "owned-containers/00000000.json")));
      assert.equal(intent.created, null); assert.equal(intent.creation.exitCode, undefined);
      exists = true;
      if (loseCreationAck || foreignCollision) throw Error("creation not acknowledged");
      return id;
    }
    if (args[0] === "inspect") {
      if (foreignCollision) return JSON.stringify([{ ...info, Id: other, Config: { Labels: { "agent.task": "other-owner" } } }]);
      assert.equal(args[1], id); return JSON.stringify([info]);
    }
    if (args[0] === "start") { assert.equal(args[2], id); if (startFailure) throw startFailure; return ""; }
    if (args[0] === "ps") return exists && !disappeared ? foreignCollision ? other : id : "";
    assert.deepEqual(args, ["rm", "-f", "-v", id]); exists = false; return id;
  };
  const recorder = ownedContainerRecorder({ folder, runId, command, cell: () => ({ key: "cell", mode: "direct" }), tools: () => ({}) });
  return { recorder, calls, folder };
}

test("creation intent is durable first; start, removal and absence use the observed ID", async () => {
  const { recorder, calls, folder } = apparatus(); await recorder.owned(name, ["create", "node"]);
  await recorder.docker(["start", "-a", name]); await recorder.remove(name); recorder.seal();
  const record = JSON.parse(readFileSync(join(folder, "owned-containers/00000000.json")));
  assert.doesNotThrow(() => verifyContainerCommands(record, runId)); assert.equal(recorder.active.size, 0);
  assert.deepEqual(calls.filter((c) => c[0] === "rm"), [["rm", "-f", "-v", id]]);
  assert.ok(!calls.some((c) => c[0] === "ps" && c.at(-1).startsWith("name=")));
});

test("failed starts retain observed subprocess output but never invent missing stdout", async () => {
  for (const stdout of [undefined, "", Buffer.alloc(0), Buffer.from("observed output\n")]) {
    const failure = Object.assign(new Error("known exit"), { code: 23, stderr: Buffer.from("observed error\n"),
      ...(stdout === undefined ? {} : { stdout }) });
    const { recorder, folder } = apparatus({ startFailure: failure }); await recorder.owned(name, ["create", "node"]);
    await assert.rejects(recorder.docker(["start", "-a", name]), (error) => error === failure);
    await recorder.remove(name);
    const record = JSON.parse(readFileSync(join(folder, "owned-containers/00000000.json")));
    assert.equal(record.start.exitCode, 23); assert.equal(record.start.failed, true);
    assert.equal(record.start.stderr, "observed error");
    if (stdout === undefined) {
      assert.equal(Object.hasOwn(record.start, "stdout"), false);
      assert.throws(() => verifyContainerCommands(record, runId), (error) => error.code === "ENOENT");
    } else {
      assert.equal(record.start.stdout, stdout.toString().trim());
      assert.doesNotThrow(() => verifyContainerCommands(record, runId));
    }
  }
});

test("creation acknowledgement binds the intent, injected name and every ownership label", async () => {
  const { recorder } = apparatus(); await recorder.owned(name, ["create", "node"]); await recorder.remove(name);
  const record = recorder.records[0]; assert.doesNotThrow(() => verifyContainerCommands(record, runId));
  for (const mutate of [
    (r) => r.creation.args = ["unrelated-command"],
    (r) => r.creation.args[2] = "foreign-name",
    ...[4, 6, 8].map((index) => (r) => r.creation.args[index] = "foreign-label=value"),
    (r) => r.intent.args.push("unacknowledged-input"),
    (r) => r.intent.args[0] = "run",
  ]) {
    const changed = structuredClone(record); mutate(changed);
    assert.throws(() => verifyContainerCommands(changed, runId));
  }
  const missing = structuredClone(record); delete missing.intent.args;
  assert.throws(() => verifyContainerCommands(missing, runId), (e) => e.code === "ENOENT");
});

for (const key of ["creation", "removal", "absence"]) test(`missing ${key} acknowledgement is incomplete proof, not a contradiction`, async () => {
  const { recorder } = apparatus(); await recorder.owned(name, ["create", "node"]); await recorder.remove(name);
  const record = structuredClone(recorder.records[0]); delete record[key];
  assert.throws(() => verifyContainerCommands(record, runId), (e) => e.code === "ENOENT");
});

test("ambiguous daemon creation is reconciled for cleanup, never backfilled as successful creation", async () => {
  const { recorder, calls } = apparatus({ loseCreationAck: true });
  await assert.rejects(recorder.owned(name, ["create", "node"])); await recorder.remove(name);
  const r = recorder.records[0]; assert.equal(r.created, null); assert.equal(r.creation.failed, true);
  assert.equal(r.removed, true); assert.ok(calls.some((c) => c[0] === "rm" && c[3] === id));
  assert.throws(() => verifyContainerCommands(r, runId));
});

test("a foreign name collision is never removed during ambiguous-creation reconciliation", async () => {
  const { recorder, calls } = apparatus({ foreignCollision: true });
  await assert.rejects(recorder.owned(name, ["create", "node"])); await assert.rejects(recorder.remove(name), /unowned/);
  assert.ok(!calls.some((c) => c[0] === "rm"));
});

test("external disappearance is not an acknowledged owned removal", async () => {
  const { recorder, calls } = apparatus({ disappeared: true }); await recorder.owned(name, ["create", "node"]); await recorder.remove(name);
  assert.equal(recorder.records[0].removed, false); assert.ok(!calls.some((c) => c[0] === "rm"));
  assert.throws(() => verifyContainerCommands(recorder.records[0], runId));
});

test("network/image cleanup journals exact observed IDs and rejects missing acknowledgements", async () => {
  const startedAt = new Date().toISOString(), tag = `${runId}-corten`, imageId = `sha256:${id}`;
  const labels = { "run.corten.hardening": runId, "agent.owner": "codex", "agent.task": runId };
  const image = { Id: imageId, Config: { Labels: labels }, RepoTags: [`${tag}:latest`] };
  const receipt = await ownedResourceCleanup("image", tag, runId, async (args) => {
    if (args[1] === "ls") return imageId;
    if (args[1] === "inspect") return JSON.stringify([image]);
    assert.deepEqual(args, ["image", "rm", imageId]); return `Deleted: ${imageId}`;
  });
  const summary = { runId, ownedImages: [tag], builds: { corten: { imageId } }, startedAt, finishedAt: new Date().toISOString() };
  assert.doesNotThrow(() => verifyResourceCleanup([receipt], summary));
  assert.doesNotThrow(() => verifyResourceCleanup([receipt], { ...summary, builds: {} }));
  for (let index = 0; index < receipt.commands.length; index++) {
    for (const field of ["args", "stdout", "exitCode", "startedAt", "finishedAt"]) {
      const changed = structuredClone(receipt); delete changed.commands[index][field];
      assert.throws(() => verifyResourceCleanup([changed], summary), (e) => e.code === "ENOENT", `${index}/${field}`);
    }
    const failed = structuredClone(receipt); failed.commands[index].exitCode = 1;
    assert.throws(() => verifyResourceCleanup([failed], summary), (e) => e.code === "ERR_ASSERTION");
  }
  assert.throws(() => verifyResourceCleanup([], summary), (e) => e.code === "ENOENT");
  const disappeared = structuredClone(receipt); disappeared.commands = [{ ...disappeared.commands[0], stdout: "" }];
  assert.throws(() => verifyResourceCleanup([disappeared], summary), (e) => e.code === "ENOENT");
  assert.throws(() => verifyResourceCleanup([], { ...summary, ownedImages: [] }), (e) => e.code === "ENOENT");
  receipt.commands[2].args[2] = tag; assert.throws(() => verifyResourceCleanup([receipt], summary));
  image.RepoTags.push("unrelated:latest");
  await assert.rejects(ownedResourceCleanup("image", tag, runId, async (args) => args[1] === "ls" ? imageId : JSON.stringify([image])), /shared image/);
});

test("final inventory acknowledgements distinguish missing fields from explicit unsuccessful responses", async () => {
  const summary = { runId, startedAt: "2000-01-01T00:00:00Z", finishedAt: "2100-01-01T00:00:00Z", cleanupFailures: [] };
  const receipt = await ownedCleanupObservation(async () => "", runId, 0, 0);
  assert.equal(verifyOwnedCleanup(receipt, summary), true);
  for (let index = 0; index < receipt.inventories.length; index++) {
    for (const field of ["args", "stdout", "exitCode", "startedAt", "finishedAt"]) {
      const changed = structuredClone(receipt); delete changed.inventories[index][field];
      assert.throws(() => verifyOwnedCleanup(changed, summary), (e) => e.code === "ENOENT", `${index}/${field}`);
    }
    const failed = structuredClone(receipt); failed.inventories[index].exitCode = 1;
    assert.throws(() => verifyOwnedCleanup(failed, summary), (e) => e.code === "ERR_ASSERTION");
  }
});

test("network removal must acknowledge the deployment's original immutable network ID", async () => {
  const startedAt = new Date().toISOString(), network = { Id: id, Name: `${runId}-net`, Containers: {}, Labels: {
    "run.corten.hardening": runId, "agent.owner": "codex", "agent.task": runId } };
  const receipt = await ownedResourceCleanup("network", network.Name, runId, async (args) =>
    args[1] === "ls" ? id : args[1] === "inspect" ? JSON.stringify([network]) : id);
  const summary = { runId, ownedNetworks: [network.Name], startedAt, finishedAt: new Date().toISOString(), cells: [{ status: "observed" }] };
  assert.doesNotThrow(() => verifyResourceCleanup([receipt], summary, [id]));
  assert.throws(() => verifyResourceCleanup([receipt], summary, [other]));
  const missing = structuredClone(receipt); missing.commands = [{ ...missing.commands[0], stdout: "" }];
  assert.throws(() => verifyResourceCleanup([missing], summary, [id]), (e) => e.code === "ENOENT");
  assert.throws(() => verifyResourceCleanup([], { ...summary, ownedNetworks: [] }, [id]), (e) => e.code === "ENOENT");
});
