import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { qualificationProbes } from "../marketplace/qualification-fixture.mjs";
import { qualification, validateQualification } from "../marketplace/feature-contract.mjs";
import { cpuBoundary, replayCpuBoundary, participantEvidence } from "./producer-evidence.mjs";
import { pageProjection, probeProjection, qualificationEvidence, replayQualificationEvidence } from "./qualification-evidence.mjs";
import { runQualificationWorker } from "./qualify-worker.mjs";

function temporary(fn) {
  const root = tmpdir(), dir = mkdtempSync(join(root, "mixed-producer-"));
  return Promise.resolve().then(() => fn(dir)).finally(() => {
    const rel = relative(root, dir);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith(".."));
    rmSync(dir, { recursive: true });
  });
}
const participants = Object.fromEntries(["app", "upstream", "load"].map((role, i) => [role, { id: String(i + 1).repeat(64) }]));
const rawCounters = () => JSON.stringify(Object.fromEntries(Object.values(participants).map(({ id }, i) => [id, 100 + i])));
const save = (file) => (receipt) => writeFileSync(file, JSON.stringify(receipt));
const read = (file) => JSON.parse(readFileSync(file, "utf8"));

test("CPU sidecars retain original ID-bound bytes and replay both boundaries from real files", () => temporary(async (dir) => {
  for (const phase of ["before", "after"]) {
    const file = join(dir, `cpu-${phase}.json`), raw = rawCounters() + "\n", calls = [];
    const values = await cpuBoundary({ reader: "reader", participants, phase, onReceipt: save(file),
      docker: async (args) => { calls.push(args); return raw; } });
    assert.deepEqual(calls, [["exec", "reader", "node", "/src/bench/catalog/cgroup.mjs", ...Object.values(participants).map((p) => p.id)]]);
    assert.equal(read(file).raw, raw);
    assert.deepEqual(replayCpuBoundary(read(file), participants, phase), values);
    assert.deepEqual(values, { app: 100, upstream: 101, load: 102 });
    const mutation = read(file); mutation.participantIds.app = "f".repeat(64);
    assert.throws(() => replayCpuBoundary(mutation, participants, phase), /identity/);
    assert.throws(() => replayCpuBoundary(read(file), participants, phase === "before" ? "after" : "before"));
  }
}));

test("invalid/missing/duplicate CPU facts are retained, never replaced with guessed counters", () => temporary(async (dir) => {
  const id = participants.app.id, file = join(dir, "cpu.json");
  const cases = ["", "not-json", "{}", "[]", rawCounters().replace(/100/, "-1"), rawCounters().replace(/100/, "1.5"),
    rawCounters().replace(/100/, "9007199254740992"), rawCounters().replace(/}$/, `,"${id}":100}`),
    rawCounters().replace(/}$/, `,"${"f".repeat(64)}":99}`)];
  for (const raw of cases) {
    await assert.rejects(cpuBoundary({ reader: "reader", participants, phase: "before", onReceipt: save(file), docker: async () => raw }));
    assert.equal(read(file).raw, raw);
  }
  await assert.rejects(cpuBoundary({ reader: "reader", participants, phase: "after", onReceipt: save(file),
    docker: async () => { throw new Error("sensitive exception must not be stored"); } }));
  assert.equal(read(file).failure, "cgroup-command-failed"); assert.equal(read(file).raw, null);
  assert.doesNotMatch(readFileSync(file, "utf8"), /sensitive/);
  await assert.rejects(cpuBoundary({ reader: "reader", participants: { ...participants, load: participants.app }, phase: "before", onReceipt() {}, docker: async () => { assert.fail("duplicate IDs must not reach Docker"); } }));
}));

const inspectFixture = () => ({ Id: participants.app.id, Image: `sha256:${"a".repeat(64)}`, RestartCount: 0,
  State: { StartedAt: "2026-11-12T00:00:00Z", Running: true, OOMKilled: false, Paused: false },
  Config: { Env: ["PORT=8080", "MIXED_CONTROL_TOKEN=credential"] },
  HostConfig: { Memory: 1024, NanoCpus: 1e9, CpusetCpus: "1", NetworkMode: "test" } });
test("participant restart counts are stored before failed admission, without environment credentials", () => temporary(async (dir) => {
  const file = join(dir, "participant.json");
  for (const restartCount of [0, 1, undefined, -1]) {
    const info = inspectFixture(); info.RestartCount = restartCount;
    const promise = participantEvidence({ inspect: async () => info, name: "native", imageId: info.Image, role: "app", onReceipt: save(file) });
    if (restartCount === 0) {
      const p = await promise; assert.deepEqual(p.config.env, ["PORT=8080"]);
    } else await assert.rejects(promise, /stopped\/restarted\/OOM/);
    assert.equal(read(file).restartCount, restartCount);
    assert.doesNotMatch(readFileSync(file, "utf8"), /credential|Env/);
  }
  for (const change of ["Running", "OOMKilled", "Paused"]) {
    const info = inspectFixture(); info.State[change] = !info.State[change];
    await assert.rejects(participantEvidence({ inspect: async () => info, name: "native", imageId: info.Image, role: "app", onReceipt: save(file) }));
    assert.equal(read(file)[{ Running: "running", OOMKilled: "oomKilled", Paused: "paused" }[change]], info.State[change]);
  }
}));

function actualQualification(source = "api") {
  const probes = qualificationProbes(source);
  const secret = "credentialXYZ123";
  const html = `<meta name="csrf-token" content="${secret}"><script>const session='${secret}'</script><form action="/write?auth=${secret}" method="post"><input type="hidden" name="_csrf" value="${secret}"><input name="email"></form>`;
  probes.page.body = Buffer.from(html).toString("base64"); probes.page.bodyLength = Buffer.byteLength(html);
  probes.page.headers["set-cookie"] = [`session=${secret}; HttpOnly`];
  probes.page.headers["content-security-policy"] = `default-src 'self'; script-src 'nonce-${secret}' 'unsafe-inline'; frame-ancestors 'none'`;
  probes.page.headers.authorization = `Bearer ${secret}`;
  return validateQualification(qualification(probes, source));
}
test("actual qualification projection replays unchanged contract and removes credentials from saved bytes", () => temporary(async (dir) => {
  for (const source of ["fixture", "api"]) {
    const actual = actualQualification(source), before = JSON.stringify(actual), evidence = qualificationEvidence(actual), file = join(dir, "qualification.json");
    save(file)(evidence);
    const saved = read(file), q = validateQualification(saved.qualification);
    assert.deepEqual({ ...q, probes: null }, { ...actual, probes: null });
    assert.equal(JSON.stringify(actual), before, "projection must not mutate actual probes");
    const page = Buffer.from(q.probes.page.body, "base64");
    assert.equal(page.length, actual.probes.page.bodyLength);
    assert.doesNotMatch(page.toString(), /credential|_csrf|auth=|script|input|meta/);
    assert.doesNotMatch(readFileSync(file, "utf8"), /credentialXYZ123|Bearer|session=|set-cookie|authorization/);
    const original = Buffer.from(actual.probes.page.body, "base64");
    for (const span of saved.pageProjection.spans) assert.ok(page.subarray(span.offset, span.offset + span.length).equals(original.subarray(span.offset, span.offset + span.length)));
    q.probes.page.headers["cache-control"] = "public";
    assert.throws(() => validateQualification(q), /cells|missing|eligible|Expected/);
  }
}));

test("failed features remain failed; unknown credential-bearing header/error shapes block projection", () => {
  const actual = actualQualification(); actual.probes.crossSite.status = 200;
  const failed = qualification(actual.probes, "api"), saved = qualificationEvidence(failed);
  assert.equal(saved.qualification.eligible, false); assert.ok(saved.qualification.missing.includes("crossSite"));
  for (const [header, value] of [["cache-control", "private, credentialXYZ123"], ["content-security-policy", "script-src https://credentialXYZ123.invalid"], ["permissions-policy", 'camera=("https://credentialXYZ123.invalid")']]) {
    const q = actualQualification(); q.probes.page.headers[header] = value;
    assert.throws(() => qualificationEvidence(qualification(q.probes, "api")), /unfilterable/);
  }
  assert.throws(() => probeProjection({ ms: 1, error: "credentialXYZ123" }), /unfilterable/);
  const broken = actualQualification(); broken.probes.cap.held = 1;
  assert.equal(qualificationEvidence(qualification(broken.probes, "api")).qualification.eligible, false);
});

test("page projections preserve actual absent/script/native form branches, including hostile markup", () => {
  for (const html of ["<p>credentialXYZ123</p>", '<form method="post" wire:submit="credentialXYZ123"></form>',
    '<form method="get"></form><form METHOD=POST phx-submit="credentialXYZ123"></form>',
    '<form method="get"></form><form method="post" action="/credentialXYZ123"><input value="secret"></form>',
    '<!-- <form method="post">credentialXYZ123</form> -->',
    '<form method="post" method="get" wire:submit.foo="credentialXYZ123"></form>']) {
    const saved = pageProjection(Buffer.from(html).toString("base64"));
    assert.doesNotMatch(Buffer.from(saved.body, "base64").toString(), /credentialXYZ123|secret/);
  }
  assert.throws(() => pageProjection("not-base64"));
  assert.throws(() => pageProjection(Buffer.from([255]).toString("base64")), /non-UTF8/);
  assert.throws(() => pageProjection(Buffer.from('<form method="post"></form>'.repeat(129)).toString("base64")), /form limit/);
});

test("worker writes replayable fixture qualification, and retains negative/filter/transport outcomes", () => temporary(async (dir) => {
  const config = { app: "synthetic-transport-vector", source: "fixture", imageId: `sha256:${"a".repeat(64)}`,
    nativeProfile: "matched", base: "http://localhost:8080", output: join(dir, "qualification.json") };
  for (const outcome of ["complete", "feature-failed", "filter-blocked", "execution-failed"]) {
    const p = actualQualification("fixture").probes;
    if (outcome === "feature-failed") p.crossSite.status = 200;
    if (outcome === "filter-blocked") p.page.headers["cache-control"] = "private, credentialXYZ123";
    const result = await runQualificationWorker(config, (script, input) => {
      const pending = read(join(dir, "qualification-evidence.json")).events.at(-1);
      assert.equal(pending.response, null); assert.equal(pending.responseSha256, null);
      if (outcome === "execution-failed") throw new Error("credentialXYZ123");
      if (script === "conform-hold") return input.mode === "head" ? p.unfinishedHead : p.cap;
      const { path, headers, method } = input;
      if (path.startsWith("/health")) return p.live;
      if (path.endsWith("/missing")) return path.startsWith("/api") ? p.json404 : p.page404;
      if (headers.host === "unrecognized.invalid") return p.badHost;
      if (headers["x-qualification"]) return p.bigHead;
      if (method === "POST") return headers.origin !== "http://localhost:8080" ? p.crossSite : input.body.length > 2 ** 20 ? p.bigBody : p.ownPost;
      if (method === "DELETE") return p.json405;
      if (method === "HEAD") return p.head;
      if (headers["accept-encoding"] !== "identity") return path.startsWith("/api") ? p.jsonGzip : p.pageBr;
      return path.startsWith("/api") ? p.json : p.page;
    });
    const file = join(dir, "qualification-evidence.json"), saved = read(file);
    assert.equal(result.eligible, outcome === "complete");
    assert.doesNotMatch(readFileSync(file, "utf8") + readFileSync(config.output, "utf8"), /credentialXYZ123/);
    if (["complete", "feature-failed"].includes(outcome)) {
      assert.equal(saved.failure, null);
      assert.equal(validateQualification(saved.qualification).eligible, result.eligible);
      assert.equal(saved.rawProbeSha256, result.rawProbeSha256);
      assert.ok(saved.events.length > 15 && saved.events.every((event) => event.failure === null));
      const replayed = replayQualificationEvidence(saved, result, config); assert.equal(replayed.eligible, result.eligible);
      const changed = structuredClone(saved); changed.events[0].response.status = 201;
      assert.throws(() => replayQualificationEvidence(changed, result, config));
    } else {
      assert.ok(saved.failure); assert.equal(result.failure, "native-production-qualification-failed");
      assert.ok(saved.events.some((event) => event.failure));
      assert.equal(saved.qualification, undefined);
    }
  }
}));

test("actual native HTTP probe failure retains safe response facts without body/cookie credentials", () => temporary(async (dir) => {
  const server = new Worker(`const { parentPort } = require('node:worker_threads');
    const server = require('node:http').createServer((req,res) => {
      res.writeHead(503, {'content-type':'text/html', 'set-cookie':'session=credentialXYZ123'});
      res.end('<form method="post"><input value="credentialXYZ123"></form>');
    }); server.listen(0,'127.0.0.1',()=>parentPort.postMessage(server.address().port));`, { eval: true });
  try {
    const [port] = await once(server, "message");
    const config = { app: "synthetic-http-vector", source: "fixture", imageId: `sha256:${"a".repeat(64)}`,
      nativeProfile: "matched", base: `http://127.0.0.1:${port}`, output: join(dir, "qualification.json") };
    const settings = join(dir, "settings.json"); save(settings)(config);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("./qualify-worker.mjs", import.meta.url)), settings],
      { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 1); assert.equal(child.error, undefined);
    assert.doesNotMatch(child.stdout + child.stderr, /credentialXYZ123/);
    const result = read(config.output);
    assert.equal(result.eligible, false);
    const file = join(dir, "qualification-evidence.json"), saved = read(file);
    assert.equal(saved.failure, "native-production-qualification-failed");
    assert.equal(saved.events[0].response.status, 503);
    assert.equal(saved.events[0].kind, "http");
    const replayed = replayQualificationEvidence(saved, result, config);
    assert.deepEqual([replayed.eligible, replayed.targetFailure], [false, "native-qualification-unhealthy-page"]);
    const changed = structuredClone(saved); changed.events[0].response.status = 200; changed.events[1].response.status = 200;
    assert.throws(() => replayQualificationEvidence(changed, result, config));
    assert.doesNotMatch(readFileSync(file, "utf8"), /credentialXYZ123|set-cookie|<form/);
  } finally { await server.terminate(); }
}));
