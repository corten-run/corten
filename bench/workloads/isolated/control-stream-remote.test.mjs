import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { binding, registration } from "../test-fixtures/control-stream-fixture.mjs";
import { streamHash, verifyStreamDrain } from "./control-stream.mjs";
import { superviseControlStream } from "./control-stream-remote.mjs";
import { digest } from "./evidence.mjs";

function fixture(t, { survivor = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "corten-control-lease-")), abort = new AbortController();
  let at = 2000000n, probes = 0, supervisor;
  const put = (name, value) => writeFileSync(join(root, name), typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  const get = (name) => JSON.parse(readFileSync(join(root, name)));
  const lease = () => put("stream-lease.json", { id: registration.id, host: registration.host, expiresMonoNs: String(at + 15000000000n), observedMonoNs: String(at), renewal: 1 });
  const drain = () => ({ schema: "benchmark-control-stream-drain/v1", id: registration.id, host: registration.host,
    registrationSha256: streamHash(registration), monoNs: String(at), identitiesAbsent: true, listener: registration.listener,
    scopes: [{ path: "/user.slice/session-1.scope", exists: true, events: "populated 0\nfrozen 0\n", members: [] }] });
  put("stream-registration.json", registration); lease();
  const runtime = { root, now: () => at, sample: () => ({ host: registration.host, members: structuredClone(registration.members), listener: structuredClone(registration.listener), monoNs: String(at) }),
    sleep: async () => {
      at += 100000000n; lease();
      if (get("stream-state.json").kind === "seal" && !existsSync(join(root, "stream-sealed.json"))) {
        const bytes = JSON.stringify({ sequence: 1, monoNs: String(at), registrationSha256: streamHash(registration) }) + "\n";
        put("stream-observations.jsonl", bytes); put("stream-sealed.json", { monoNs: String(at), lease: get("stream-lease.json"), observationsSha256: digest(bytes) });
      }
    }, probe: () => (++probes < 2 || survivor ? { status: 3 } : { status: 0, stdout: JSON.stringify(drain()) }) };
  supervisor = superviseControlStream(binding, { apparatus: registration }, abort, runtime);
  t.after(() => { supervisor.dispose(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"))); rmSync(root, { recursive: true }); });
  return { root, abort, supervisor, put, get, lease, drain, runtime, tick: (ns) => { at += ns; }, probes: () => probes };
}

test("independent consumer supervises native windows, paused audit, immutable seal and actual drain probe", async (t) => {
  const f = fixture(t), s = f.supervisor;
  s.progress({ state: "active" }); assert.equal(f.get("stream-state.json").kind, "progress");
  s.open({ app: "1", api: "2", load: "3-7" }); s.close();
  s.progress({ state: "blocked-review-needed", campaign: "r21-0123456789abcdef", auditGroup: "json-api", auditSubjectSha256: "e".repeat(64) });
  assert.equal(f.get("stream-state.json").kind, "audit-ready");
  const proof = await s.seal(); assert.equal(proof.schema, "benchmark-control-stream-seal/v1");
  assert.throws(() => s.open({ app: "1", api: "2", load: "3-7" }));
  const drained = await s.finish({ id: registration.id, nativeTerminal: true, sealSha256: digest(JSON.stringify(proof)) });
  assert.equal(f.probes(), 2); assert.equal(verifyStreamDrain(binding, registration, drained).remoteDrained, true); assert.equal(f.abort.signal.aborted, false);
});

test("expired or stale guardian lease irrevocably cancels native independently of local EOF", (t) => {
  const f = fixture(t); f.tick(16000000000n); assert.throws(() => f.supervisor.check());
  assert.equal(f.abort.signal.aborted, true); assert.ok(existsSync(join(f.root, "stream-invalid.json")));
  f.lease(); assert.throws(() => f.supervisor.check(), /revoked/);
  assert.equal(f.get("stream-invalid.json").remoteDrained, undefined);
});

test("local EOF and expired drain deadline cannot replace an actual terminal apparatus probe", async (t) => {
  const f = fixture(t, { survivor: true }); await f.supervisor.seal();
  const changed = f.drain(); changed.identitiesAbsent = false;
  assert.throws(() => verifyStreamDrain(binding, registration, changed));
  await assert.rejects(f.supervisor.finish({ id: registration.id, nativeTerminal: true }));
  assert.ok(f.probes() <= 100);
  assert.equal(f.abort.signal.aborted, true);
});
