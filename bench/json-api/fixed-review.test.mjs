// Permanent small regressions for independent review findings, not qualification.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixedFixture } from "./fixed-test-fixtures.mjs";
import { readFixedStream } from "./fixed-stream.mjs";
import { joinFixedPrototype, prototypeLimits, verifyFixedPrototype } from "./fixed-prototype.mjs";

const here = dirname(fileURLToPath(import.meta.url)), hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function directory(t) {
  const folder = mkdtempSync(join(tmpdir(), "json-fixed-review-"));
  t.after(() => { assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep)); rmSync(folder, { recursive: true, force: true }); });
  return folder;
}
async function portable(t) {
  const folder = directory(t), f = fixedFixture(), bytes = f.bytes();
  writeFileSync(join(folder, "events.jsonl"), bytes);
  writeFileSync(join(folder, "summary.json"), JSON.stringify(f.summary)); writeFileSync(join(folder, "clock.json"), JSON.stringify(f.clock)); writeFileSync(join(folder, "stderr.jsonl"), "");
  const capture = { schema: "json-api-fixed-prototype/v1", errors: [], limits: prototypeLimits,
    instrumentation: { output: "stock-json-stdout", script: "fixed-prototype-load.js", changedGeneratorIO: true, gzip: false, nativeQualified: false },
    config: { ...f.config, payload: "catalog-v1", base: "http://127.0.0.1:8080" }, command: { ...f.command, stdoutBytes: bytes.length, stderrBytes: 0 },
    executable: { path: "/synthetic/k6", sha256: "a".repeat(64), version: "k6 v2.4.0 (synthetic; not native qualification)" },
    sources: Object.fromEntries(["fixed-prototype-load.js", "load.js", "load-outcome.js"].map((name) => [name, hash(readFileSync(join(here, name)))])),
    argv: ["run", "--quiet", "--log-format", "json", "--summary-export", join(folder, "summary.json"), "--out", "json=-",
      "-e", "BASE=http://127.0.0.1:8080", "-e", "PAYLOAD=catalog-v1", "-e", "MODE=fixed", "-e", "RATE=3", "-e", "VUS=64", "-e", "DURATION=1s",
      "-e", `JSON_PROTOTYPE_OUTPUT=${folder.replaceAll("\\", "/")}`, join(here, "fixed-prototype-load.js")],
    raw: (await readFixedStream(join(folder, "events.jsonl"))).receipt,
    files: Object.fromEntries(["summary.json", "clock.json", "stderr.jsonl"].map((name) => { const bytes = readFileSync(join(folder, name)); return [name, { bytes: bytes.length, sha256: hash(bytes) }]; })) };
  const save = (value) => writeFileSync(join(folder, "capture.json"), JSON.stringify(value)); save(capture);
  return { folder, f, capture, save };
}

test("review: every custom clock counter count and rate joins raw evidence independently", async (t) => {
  const folder = directory(t);
  for (const responses of [["ok", "ok", "ok"], ["ok", "timeout", "http429"], ["ok", "ok", "ok", "ok"]]) {
    const f = fixedFixture({ responses }); writeFileSync(join(folder, "events"), f.bytes());
    const stream = await readFixedStream(join(folder, "events"));
    assert.equal(joinFixedPrototype(f, stream).requests, responses.length);
    for (const name of ["json_started", "json_ok", "json_timeout", "json_http_error", "json_invalid", "json_start_capped"]) {
      for (const field of ["count", "rate"]) {
        const clock = structuredClone(f.clock); clock.metrics[name].values[field]++;
        assert.throws(() => joinFixedPrototype({ ...f, clock }, stream), undefined, `${name}.${field}`);
      }
    }
  }
});

test("review: latency average joins the sum and point count, not just max and order", async (t) => {
  const folder = directory(t), f = fixedFixture(); writeFileSync(join(folder, "events"), f.bytes());
  const stream = await readFixedStream(join(folder, "events"));
  f.summary.metrics.http_req_duration.avg = 0;
  assert.throws(() => joinFixedPrototype(f, stream), /latency.*(average|mean)/);
});

test("review: portable evidence requires coherent pinned executable, source and exact fixed argv identity", async (t) => {
  const { folder, capture, save } = await portable(t);
  assert.equal((await verifyFixedPrototype(folder)).status, "unqualified");
  for (const [name, mutate] of [
    ["missing executable", (r) => delete r.executable], ["missing sources", (r) => delete r.sources], ["missing argv", (r) => delete r.argv],
    ["wrong version", (r) => r.executable.version = "k6 v0.0.0"], ["malformed digest", (r) => r.executable.sha256 = "not-a-digest"],
    ["relative executable", (r) => r.executable.path = "unreviewed/k6"], ["missing source", (r) => delete r.sources["load.js"]],
    ["wrong source bytes", (r) => r.sources["load.js"] = "f".repeat(64)], ["other source", (r) => r.sources["different.js"] = "a".repeat(64)],
    ["warmup override", (r) => r.argv[r.argv.indexOf("MODE=fixed")] = "MODE=warmup"],
    ["other script", (r) => r.argv[r.argv.length - 1] = "/another.js"], ["argv prepend", (r) => r.argv.unshift("unreviewed")],
    ["rate override", (r) => r.argv[r.argv.indexOf("RATE=3")] = "RATE=4"], ["output override", (r) => r.argv[7] = "json=/tmp/filtered"],
    ["payload mismatch", (r) => r.config.payload = "marketplace-v2"], ["nonloopback base", (r) => r.config.base = "http://example.test"],
  ]) { const changed = structuredClone(capture); mutate(changed); save(changed); await assert.rejects(verifyFixedPrototype(folder), undefined, name); }
  save(capture);
  await verifyFixedPrototype(folder, { sourceManifest: capture.sources, executableManifest: { sha256: capture.executable.sha256 } });
  await assert.rejects(verifyFixedPrototype(folder, { executableManifest: { sha256: "b".repeat(64) } }), /executable differs/);
  await assert.rejects(verifyFixedPrototype(folder, { sourceManifest: { ...capture.sources, "load.js": "b".repeat(64) } }), /source.*differs/);
});
