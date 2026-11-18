import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as contract from "./cloud-contract.mjs";
import { host as catalogHost } from "../catalog/droplet-contract.mjs";
import { groupNames, selectedApps } from "./registry.mjs";
import { accountId, archive, commit, context, harness, metadata, syntheticInspection } from "./cloud-fixtures.mjs";
import { campaignOutcome, controllerState, parseDropletArgs } from "./cloud-options.mjs";
import { remoteFiles } from "./cloud-remote.mjs";
import { digest } from "./cloud-local.mjs";
import { guardianSource, guardianSha256 } from "./cloud-control-runtime.mjs";

const at = "2026-11-14T00:00:00.000Z";
const input = () => ({ round: "r21", commit: "a".repeat(40), token: "f".repeat(16),
  tokens: Object.fromEntries(groupNames.map((group, i) => [group, (i + 1).toString(16).padStart(16, "0")])),
  provider: { accountId: "team:synthetic-fleet", context: "synthetic" }, sshKey: "42" });
const plan = () => contract.fleetPlan(input(), at);
const state = (fleet, group = groupNames[0]) => contract.reservation({ round: fleet.round, commit: fleet.commit,
  token: fleet.jobs.find((row) => row.group === group).token, group, fleet }, at);
const droplet = (row, id = 123) => ({ id, name: row.name, tags: [...contract.tags, row.tag],
  size_slug: contract.host.size, region: { slug: contract.host.region },
  networks: { v4: [{ type: "public", ip_address: "192.0.2.10" }] } });

test("fleet fixes the complete current registry to one unique host per group", () => {
  const fleet = plan();
  assert.equal(contract.validateFleet(fleet), fleet);
  assert.equal(fleet.schema, "benchmark-group-fleet/v1");
  assert.deepEqual(fleet.selection, contract.selection());
  assert.deepEqual(fleet.jobs.map((row) => row.group), groupNames);
  assert.equal(new Set(fleet.jobs.map((row) => row.token)).size, groupNames.length);
  assert.equal(new Set(fleet.jobs.map((row) => row.name)).size, groupNames.length);
  for (const group of groupNames) {
    const s = state(fleet, group);
    assert.equal(s.schema, "benchmark-dedicated-group-host/v1");
    assert.equal(contract.validateState(s, "r21"), s);
    assert.deepEqual(s.selection.groups.map((row) => row.group), [group]);
    assert.deepEqual(s.selection.groups[0].apps, selectedApps(group));
    assert.deepEqual(s.fleet, fleet);
    const job = contract.remoteFiles(s)["job.sh"];
    assert.ok(job.includes(`campaign-entry.mjs r21 --commit ${fleet.commit} --state-dir /bench/campaign --group ${group}`));
    assert.ok(!job.includes("--apps") && !job.includes("--duration") && !job.includes("--passes"));
  }
});

test("new grouped fleets bind sfo3 without retargeting an sfo2 reservation", () => {
  const fleet = plan(), s = state(fleet), actual = droplet(fleet.jobs[0]);
  assert.equal(catalogHost.region, "sfo2");
  assert.deepEqual(fleet.host, { ...catalogHost, region: "sfo3" });
  assert.deepEqual(s.host, fleet.host);
  assert.equal(contract.assertFleetCensus([actual], fleet), true);
  assert.throws(() => contract.assertFleetCensus([{ ...actual, region: { slug: "sfo2" } }], fleet));
  assert.throws(() => contract.validateState({ ...s, host: catalogHost }, s.round));
  assert.throws(() => contract.validateFleet({ ...fleet, host: catalogHost }));
});

test("partial, duplicate, reordered or altered fleet plans cannot authorize a host", () => {
  for (const alter of [
    (f) => f.jobs.pop(), (f) => f.jobs.reverse(), (f) => f.jobs[1].token = f.jobs[0].token,
    (f) => f.jobs[0].group = "arbitrary", (f) => f.jobs[0].name = "foreign",
    (f) => f.selection.groups[0].apps.pop(), (f) => f.selection.groups.pop(),
    (f) => f.host.size = "s-1vcpu-1gb", (f) => f.provider.context = "other",
    (f) => f.sshKey = "99", (f) => f.createdAt = "2026-02-30T00:00:00.000Z",
    (f) => f.commit += "\n", (f) => f.extra = true,
  ]) {
    const f = structuredClone(plan()); alter(f);
    assert.throws(() => contract.validateFleet(f));
    assert.throws(() => state(f));
  }
  for (const alter of [(i) => delete i.tokens[groupNames[0]], (i) => i.tokens.extra = "e".repeat(16),
    (i) => i.tokens[groupNames[1]] = i.tokens[groupNames[0]], (i) => i.provider.accountId = "not-scoped",
    (i) => i.apps = ["corten"]]) {
    const i = input(); alter(i); assert.throws(() => contract.fleetPlan(i, at));
  }
});

test("single-group evidence cannot be disguised as a legacy whole campaign", () => {
  const f = plan();
  for (const alter of [(s) => s.schema = "benchmark-group-host/v1", (s) => delete s.group,
    (s) => delete s.fleet, (s) => s.group = groupNames[1], (s) => s.token = "e".repeat(16),
    (s) => s.selection = contract.selection(), (s) => s.selection.groups[0].apps.pop()]) {
    const s = structuredClone(state(f)); alter(s); assert.throws(() => contract.validateState(s, "r21"));
  }
  const legacy = contract.reservation({ round: "r21", commit: f.commit, token: "e".repeat(16) }, at);
  assert.equal(legacy.schema, "benchmark-group-host/v1");
  assert.deepEqual(legacy.selection, contract.selection());
  assert.throws(() => contract.validateState({ ...legacy, group: groupNames[0] }, "r21"));
});

test("fleet census permits only exact reserved siblings, not a tag-prefix exemption", () => {
  const f = plan(), sibling = droplet(f.jobs[1]);
  assert.equal(contract.assertFleetCensus([], f), true);
  assert.equal(contract.assertFleetCensus([sibling, { id: 456, name: "unrelated", tags: [] }], f), true);
  for (const rows of [[sibling, sibling], [{ ...sibling, id: "invalid" }],
    [{ ...sibling, name: "corten-bench-groups-foreign" }], [{ ...sibling, tags: contract.tags }],
    [{ ...sibling, size_slug: "s-1vcpu-1gb" }], [{ ...sibling, region: { slug: "nyc1" } }],
    [{ id: 789, name: "corten-marketplace-r20", tags: ["corten-bench"] }],
    [sibling, { ...droplet(f.jobs[2]), id: sibling.id }]]) {
    assert.throws(() => contract.assertFleetCensus(rows, f));
  }
});

function configured(t) {
  const h = harness(t, { active: true }), values = input(); values.provider = { accountId, context };
  const fleet = contract.fleetPlan(values, at), path = join(h.temp, "fleet.json");
  writeFileSync(path, JSON.stringify(fleet));
  const options = { collect: undefined, detach: true, commit, sshKey: "42", accountId, context, group: groupNames[0], fleet: path };
  return { h, fleet, path, options };
}

test("group launch permits exact siblings but reserves only this group's complete work", async (t) => {
  const { h, fleet, options } = configured(t);
  h.hosts([droplet(fleet.jobs[1], 456)]);
  await h.task({}, options).launch();
  const saved = h.saved(); assert.equal(h.creates, 1); assert.equal(saved.status, "running");
  assert.equal(controllerState(saved, "r21"), saved);
  assert.equal(saved.group, groupNames[0]); assert.deepEqual(saved.fleet, fleet);
  assert.equal(saved.fullGroupQualified, false);
  const job = readFileSync(join(h.local, "job.sh"), "utf8");
  assert.ok(job.includes(`--group '${groupNames[0]}'`));
  assert.equal(job, remoteFiles(saved)["job.sh"]);
  await assert.rejects(h.task({}, options).launch()); assert.equal(h.creates, 1);
});

test("a terminal later group cannot be saved as running admission and remains collectable", async (t) => {
  const { h, options, fleet } = configured(t);
  options.group = groupNames[1]; h.flags.active = false;
  // Replay the real guardian against the in-memory kernel, including the
  // actual controller requests and the original exit archive's custody bytes.
  const kernel = spawn(process.platform === "win32" ? "python" : "python3",
    ["-I", fileURLToPath(new URL("./test-fixtures/control-session-kernel.py", import.meta.url)), "setup-fleet"],
    { timeout: 25000, killSignal: "SIGKILL", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: kernel.stdout })[Symbol.asyncIterator]();
  let stderr = ""; kernel.stderr.on("data", (part) => { stderr = (stderr + part).slice(-4096); });
  const closed = new Promise((resolve) => { kernel.on("error", (e) => resolve(String(e))); kernel.on("close", resolve); });
  t.after(async () => { kernel.stdin.end(); assert.equal(await closed, 0, stderr); });
  const token = fleet.jobs[1].token;
  kernel.stdin.write(JSON.stringify({ mode: "setup-fleet", token, source: guardianSource }) + "\n");
  const run = async (binary, args, timeout, allowFail, expiry, control) => {
    if (!control) return h.run(binary, args, timeout, allowFail);
    const s = h.saved(), script = args.at(-1), request = control.request;
    const exitArchive = request.epoch === "bootstrap" && script.startsWith("systemctl show");
    // Re-running pack.sh extends remote custody even though the exit archive
    // is immutable. A second pack here must fail the custody comparison.
    const pack = exitArchive || script === "timeout 600 /bin/bash /bench/pack.sh";
    const query = script.includes("<<'CORTEN_FAILED_SETUP_HOST'");
    const expected = query && { sequence: request.sequence, requests: s.control.ledger.slice(0, -1).map((r) => r.request),
      binding: { round: s.round, commit, token, helperSha256: guardianSha256 },
      queryArgv: ["/usr/bin/python3", "-", s.id, s.unit, JSON.stringify(Object.fromEntries(Object.entries(remoteFiles(s)).map(([k, v]) => [k, digest(v)]))), "1"] };
    kernel.stdin.write(JSON.stringify({ request, payload: binary === "ssh" ? `set -euo pipefail\n${script}\n` : "synthetic SFTP",
      pack, ...(query ? { expected } : {}) }) + "\n");
    const line = await lines.next(); assert.equal(line.done, false, stderr);
    const reply = JSON.parse(line.value);
    if (exitArchive) h.setArchive(archive([...metadata(), { name: "control/" },
      ...Object.entries(reply.custody).map(([k, v]) => ({ name: "control/" + k, body: Buffer.from(v, "hex") }))]));
    if (query) return { status: 0, stdout: JSON.stringify({ schema: "benchmark-failed-setup-host/v2", hostId: s.id, unit: s.unit,
      setupFailed: true, exitCode: 1, observedAtMs: Date.now(), control: reply.proof }) };
    return h.run(binary, args, timeout, allowFail);
  };
  await assert.rejects(h.task({ run }, options).launch(), /group ended before running admission/);
  assert.equal(h.saved().status, "starting"); assert.equal(h.saved().group, groupNames[1]);
  assert.equal(h.creates, 1); assert.equal(h.deletes, 0); assert.equal(h.inspections, 0);
  assert.equal(await h.task({ run }).collect(), 1);
  const s = h.saved();
  assert.equal(s.status, "retired"); assert.equal(s.retirement.kind, "setup-failed"); assert.ok(s.destroyedAt);
  assert.ok(s.archiveSha256 && s.evidenceSha256); assert.equal(s.validation, undefined); assert.equal(s.collectedAt, undefined);
  assert.equal(await h.task({ run }).collect(), 1); assert.equal(h.inspections, 0);
  assert.equal(h.saved().fullGroupQualified, false);
  assert.equal(h.creates, 1); assert.equal(h.deletes, 1);

  for (const mode of ["native", "absent-proof", "active", "unacknowledged", "monitor-artifact", "changed-record", "foreign-unit"]) {
    const f = configured(t), g = f.h;
    // The first group passes its first running check, then exits inside commonBootstrap.
    g.flags.hook = (bin, a) => { if (bin === "ssh" && a.at(-1).startsWith("systemctl show") && g.units === 1) g.flags.active = false; };
    g.flags.startLost = mode === "unacknowledged";
    await assert.rejects(g.task({}, f.options).launch(), mode === "unacknowledged" ? /start acknowledgement/ : /ended before common bootstrap/);
    assert.equal(!!g.saved().preBootstrapTerminal, mode !== "unacknowledged"); g.flags.hook = undefined;
    if (mode === "active") g.flags.active = true;
    if (mode === "foreign-unit") g.flags.wrongUnit = true;
    if (mode === "absent-proof") g.setArchive(archive(metadata()));
    if (mode === "monitor-artifact") writeFileSync(join(g.local, "monitor-journal.jsonl"), "");
    if (mode === "changed-record") g.change((v) => { v.preBootstrapTerminal.invocation = "f".repeat(32); });
    let inspections = 0;
    await assert.rejects(g.task({ inspect() { inspections++; return syntheticInspection("verified"); } }).collect());
    assert.equal(g.calls.filter(([bin, ...a]) => bin === "scp" && a.at(-2).endsWith(":/bench/results.tgz")).length,
      ["native", "absent-proof"].includes(mode) ? 1 : 0); assert.equal(inspections, 0);
    if (mode === "native") {
      assert.ok(g.saved().archiveSha256 && g.saved().evidenceSha256);
      assert.equal(readFileSync(join(g.local, g.saved().evidence, "campaign/fake.json"), "utf8"), "{}");
    }
    assert.equal(g.deletes, 0); assert.equal(g.saved().validation, undefined); assert.equal(g.saved().retirement, undefined);
  }
});

test("a nonterminal later group retains ordinary running admission", async (t) => {
  const { h, options } = configured(t); options.group = groupNames[1];
  await h.task({}, options).launch();
  assert.equal(h.saved().status, "running"); assert.equal(h.saved().group, groupNames[1]);
  assert.equal(h.saved().bootstrapReady, undefined); assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
});

test("foreign benchmark, own preexisting host, or fleet/account tampering cannot create", async (t) => {
  for (const mode of ["foreign", "own", "changed-account", "changed-fleet"]) {
    const { h, fleet, options, path } = configured(t);
    if (mode === "foreign") h.hosts([{ id: 999, name: "corten-marketplace-r20", tags: ["corten-bench"] }]);
    if (mode === "own") h.hosts([droplet(fleet.jobs[0])]);
    if (mode === "changed-account") options.accountId = "user:other";
    if (mode === "changed-fleet") { fleet.jobs[0].group = "unknown"; writeFileSync(path, JSON.stringify(fleet)); }
    await assert.rejects(async () => h.task({}, options).launch());
    assert.equal(h.creates, 0); assert.equal(h.deletes, 0);
  }
});

test("first host requires account room for the whole reserved fleet, not just itself", async (t) => {
  const { h, options } = configured(t);
  h.hosts(Array.from({ length: 20 - groupNames.length + 1 }, (_, i) => ({ id: 1000 + i, name: `unrelated-${i}`, tags: [] })));
  await assert.rejects(h.task({}, options).launch(), /capacity cannot cover/);
  assert.equal(h.creates, 0); assert.equal(h.deletes, 0);
});

function finishSupervisedFixture(h, status) {
  h.flags.active = false; h.flags.reportStatus = status;
  const path = join(h.local, "monitor-local-closed.json"), closed = JSON.parse(readFileSync(path));
  closed.closedAtMs = Date.now() - 31000; closed.recoverAfterMs = closed.closedAtMs + 30000;
  writeFileSync(path, JSON.stringify(closed));
  return h.report();
}

test("group inspection is distinct from whole-campaign evidence and retains terminal deletion gates", async (t) => {
  const { h, options } = configured(t); await h.task({}, options).launch();
  const report = finishSupervisedFixture(h, "verified");
  report.schema = "benchmark-isolated-group-campaign-inspection/v1";
  report.selection.groups = report.selection.groups.filter((row) => row.group === options.group);
  report.groups = report.groups.filter((row) => row.group === options.group);
  assert.equal(campaignOutcome(report, h.saved(), 0).evidenceOutcome, "validated");
  for (const alter of [(r) => r.schema = "benchmark-isolated-campaign-inspection/v1",
    (r) => r.selection.groups[0].apps.pop(), (r) => r.groups = [], (r) => r.uncollectedNativeRoots = ["partial"],
    (r) => r.collectionIntegrity = "unverified", (r) => r.commandLifecycle = "uncertain"]) {
    const r = structuredClone(report); alter(r); assert.throws(() => campaignOutcome(r, h.saved(), 0));
  }
  h.setArchive(archive([...metadata().map((row) => row.name === "exit-code" ? { ...row, body: "0\n" } : row),
    { name: "campaign/" }, { name: "campaign/fake.json", body: "{}" }]));
  assert.equal(await h.task({ inspect: async () => report }).collect(), 0);
  assert.equal(h.deletes, 1); assert.ok(h.saved().destroyedAt);
  assert.equal(h.saved().fullGroupQualified, false);
});

test("CLI group selection cannot omit the full fleet or change collection scope", () => {
  const common = ["r21", "--state-dir", join(process.cwd(), "outside")];
  const detach = [...common, "--detach", "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context];
  const path = join(process.cwd(), "fleet.json");
  assert.equal(parseDropletArgs([...detach, "--group", groupNames[0], "--fleet", path]).group, groupNames[0]);
  for (const args of [[...detach, "--group", groupNames[0]], [...detach, "--fleet", path],
    [...detach, "--group", "unknown", "--fleet", path], [...common, "--collect", "--group", groupNames[0], "--fleet", path],
    [...detach, "--group", groupNames[0], "--fleet", path, "--apps", "corten"]]) assert.throws(() => parseDropletArgs(args));
});

test("failed and blocked collection preserves a host when evidence belongs to another selection", async (t) => {
  for (const status of ["failed", "blocked"]) for (const change of ["group", "apps", "contract"]) {
    const { h, options } = configured(t); await h.task({}, options).launch();
    const report = finishSupervisedFixture(h, status);
    report.schema = "benchmark-isolated-group-campaign-inspection/v1";
    report.selection.groups = report.selection.groups.filter((row) => row.group === options.group);
    report.groups = [];
    if (change === "group") report.selection.groups[0].group = groupNames[1];
    if (change === "apps") report.selection.groups[0].apps.pop();
    if (change === "contract") report.selection.groups[0].contractSha256 = "0".repeat(64);
    assert.throws(() => campaignOutcome(report, h.saved(), 1), /complete current native selection required/);
    await assert.rejects(h.task({ inspect: async () => report }).collect(), /native campaign validation unavailable or invalid/);
    assert.equal(h.deletes, 0); assert.equal(h.saved().destroyedAt, undefined);
    assert.equal(h.saved().deletionIntentAt, undefined);
  }
});

test("first official group waits for the bound common bootstrap marker, not native qualification", async (t) => {
  const { h, options } = configured(t); h.flags.bootstrapPending = 1;
  const saved = await h.task({}, options).launch();
  assert.equal(saved.status, "running"); assert.ok(saved.bootstrapReady.sha256); assert.ok(saved.bootstrapReady.observedAt);
  assert.equal(saved.fullGroupQualified, false); assert.equal(h.creates, 1);
  assert.equal(h.calls.filter((c) => c[0] === "ssh" && c.at(-1).startsWith("if test ! -e /bench/bootstrap-ready.json")).length, 2);
});

test("failed or wrong common bootstrap leaves the first host observable without another allocation", async (t) => {
  for (const mode of ["read-failed", "wrong-identity", "ended", "expired", "reverse-time", "cancelled"]) {
    const { h, options } = configured(t); let clock = 0;
    if (mode === "read-failed") h.flags.bootstrapError = true;
    if (mode === "wrong-identity") h.flags.bootstrapMarker = { schema: "benchmark-common-bootstrap/v1", commit: "foreign" };
    if (mode === "ended") h.flags.active = false;
    if (["expired", "reverse-time", "cancelled"].includes(mode)) h.flags.hook = (binary, args) => {
      if (binary === "ssh" && args.at(-1).startsWith("if test ! -e /bench/bootstrap-ready.json")) {
        clock = mode === "expired" ? 45 * 60000 : -1;
        if (mode === "cancelled") h.flags.cancelled = true;
      }
    };
    await assert.rejects(h.task({ now: () => clock }, options).launch());
    const saved = h.saved(), witness = saved.preBootstrapTerminal;
    if (mode === "ended") {
      assert.equal(saved.status, "starting");
      const row = saved.control.ledger.at(-1), query = h.calls.filter(([binary]) => binary === "ssh").at(-1).at(-1);
      assert.ok(query.startsWith(`systemctl show ${saved.unit} `));
      assert.equal(row.request.epoch, "bootstrap"); assert.equal(row.request.invocation.channel, "ssh");
      assert.equal(row.request.invocation.requestSha256, digest(`set -euo pipefail\n${query}\n`));
      assert.equal(row.localTerminal, true); assert.equal(row.code, 0);
      assert.equal(witness.invocation, row.request.invocation.id); assert.equal(witness.monitorId, saved.control.monitor.id);
      assert.equal(witness.hostId, saved.id); assert.equal(witness.ip, saved.ip);
      assert.equal(contract.terminalUnit(witness.stdout, saved), true);
    } else {
      assert.equal(saved.status, "running", mode); assert.equal(witness, undefined, mode);
    }
    assert.equal(saved.control.monitor.phase, "pending"); assert.equal(saved.bootstrapReady, undefined);
    assert.equal(saved.fullGroupQualified, false); assert.equal(saved.validation, undefined);
    assert.equal(saved.deletionIntentAt, undefined); assert.equal(saved.destroyedAt, undefined);
    assert.equal(h.creates, 1); assert.equal(h.deletes, 0); assert.equal(h.inspections, 0);
  }
});
