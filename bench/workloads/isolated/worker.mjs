// Local isolated-host API only: no provider, credentials, transport or CLI launcher.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureSources, validateBinding } from "./contract.mjs";
import { copyEvidence, digest, durable, inside, inspectEvidence, physical, readRegular, supportedGroups, syncDirectory, tree } from "./evidence.mjs";
import { supervise } from "./process.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[\\/]$/, "");
const freeze = (value) => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
function freshOutput(path) {
  assert.equal(lstatSync(path, { throwIfNoEntry: false }), undefined, "native round already exists; never overwrite or relaunch");
  let parent = dirname(path);
  while (!lstatSync(parent, { throwIfNoEntry: false })) parent = dirname(parent);
  physical(parent);
}

/** Verify files actually executed, not only the Git tree named in a receipt. */
export function matchesWorkingSource(bytes, expectedSha256) {
  if (digest(bytes) === expectedSha256) return true;
  if (bytes.includes(0)) return false;
  const canonical = Buffer.from(bytes.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
  return digest(canonical) === expectedSha256;
}
export function verifyWorkingSources(binding) {
  validateBinding(binding);
  for (const entry of binding.sources.files) {
    const bytes = readRegular(join(repo, ...entry.path.split("/")));
    // Git's documented text checkout conversion changes only CRLF, never binary data.
    assert.ok(matchesWorkingSource(bytes, entry.sha256), `executed working source differs: ${entry.path}`);
  }
  assert.equal(captureSources(binding.request.commit).sha256, binding.sources.sha256);
}

/** The callback is caller authority, not an unsigned binding/declaration field. No default. */
export function createWorker({ authorize }) {
  assert.equal(typeof authorize, "function", "explicit independent caller authorization policy required");
  const owned = new WeakMap();
  function own(handle) {
    const attempt = owned.get(handle);
    assert.ok(attempt, "attempt is not owned by this live worker; receipt files confer no authority");
    physical(attempt.base); physical(attempt.directory);
    assert.equal(digest(readRegular(join(attempt.base, ".host-attempt.json"))), attempt.reservationHash, "host reservation ownership changed");
    const stat = lstatSync(attempt.directory);
    assert.equal(stat.dev, attempt.device); assert.equal(stat.ino, attempt.inode, "attempt directory replaced");
    for (const entry of attempt.records) assert.equal(digest(readRegular(join(attempt.directory, entry.path))), entry.sha256, "durable attempt record changed");
    return attempt;
  }
  function record(attempt, name, value) {
    own(attempt.handle);
    const path = `${String(attempt.records.length).padStart(4, "0")}-${name}.json`, bytes = json(value);
    durable(join(attempt.directory, path), bytes);
    attempt.records.push({ path, sha256: digest(bytes) });
  }
  function reserve(binding, base) {
    base = physical(base);
    assert.ok(!inside(repo, base) && !inside(base, repo), "state root and checkout must be disjoint");
    if (process.platform === "linux") {
      const stat = lstatSync(base);
      assert.equal(stat.uid, process.getuid(), "state root is not owned by this user");
      assert.equal(stat.mode & 0o022, 0, "state root must not be writable by other users");
    }
    const token = randomBytes(16).toString("hex"), id = `${binding.request.group}-${binding.request.round}-${token}`;
    const reservation = json({ schema: "benchmark-isolated-attempt/v1", id, token,
      bindingSha256: binding.bindingSha256, commit: binding.request.commit, pid: process.pid, createdAt: new Date().toISOString() });
    // Durable, exclusive, never automatically unlocked, including interrupted reservations.
    durable(join(base, ".host-attempt.json"), reservation);
    const directory = join(base, id);
    mkdirSync(directory, { mode: 0o700 }); syncDirectory(base);
    const stat = lstatSync(directory), handle = Object.freeze({ id, directory });
    const attempt = { handle, base, directory, device: stat.dev, inode: stat.ino,
      reservationHash: digest(reservation), binding, records: [], commands: [], settled: false, failed: false, receipt: null };
    owned.set(handle, attempt);
    record(attempt, "binding", binding);
    return attempt;
  }
  async function command(attempt, invocation, signal) {
    own(attempt.handle);
    verifyWorkingSources(attempt.binding);
    if (invocation.argv[0] === attempt.binding.execution.invocation.argv[0])
      freshOutput(join(repo, ...attempt.binding.validation.artifactRoot.split("/")));
    const logPath = join(attempt.directory, `command-${attempt.commands.length}.log`);
    const fd = openSync(logPath, "wx", 0o600);
    let result;
    try {
      record(attempt, "intent", { invocation, at: new Date().toISOString() });
      result = await supervise({ ...invocation, shell: false }, { cwd: repo,
        // Do not forward NODE_OPTIONS, credentials, legacy selectors or environment tuning.
        env: { PATH: "/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: os.homedir(), LANG: "C.UTF-8", TZ: "UTC",
          GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0",
          ...attempt.binding.resources.requestedCpuEnv }, signal,
        log(bytes) {
          let offset = 0;
          while (offset < bytes.length) {
            const written = writeSync(fd, bytes, offset, bytes.length - offset);
            assert.ok(written > 0, "command log write made no progress"); offset += written;
          }
        },
        onStart(pid) { record(attempt, "started", { pid, at: new Date().toISOString() }); },
      });
    } finally { try { fsyncSync(fd); } finally { closeSync(fd); } }
    attempt.commands.push(result);
    attempt.failed ||= !result.success;
    record(attempt, "exited", result);
    return result;
  }
  function verifyCollection(attempt) {
    own(attempt.handle);
    assert.ok(attempt.receipt, "no completed collection");
    assert.deepEqual(tree(join(attempt.directory, "native")), attempt.manifest, "collected evidence mutated");
    if (attempt.sourcePresent) assert.deepEqual(tree(attempt.source), attempt.manifest, "original native evidence mutated");
    else assert.equal(lstatSync(attempt.source, { throwIfNoEntry: false }), undefined, "native evidence appeared after missing-output failure");
    for (const entry of attempt.logs) assert.equal(digest(readRegular(join(attempt.directory, entry.path))), entry.sha256, "command evidence mutated");
    return attempt.receipt;
  }
  function collect(handle) {
    const attempt = own(handle);
    assert.ok(attempt.settled && attempt.commands.every((c) => c.terminal), "owned native process is not observed terminal; preserve attempt");
    if (attempt.receipt) return verifyCollection(attempt);
    const source = join(repo, ...attempt.binding.validation.artifactRoot.split("/"));
    attempt.source = source;
    // A failed preparation/spawn may produce no native root. Preserve that failure too.
    const destination = join(attempt.directory, "native");
    record(attempt, "collection-intent", { artifactRoot: attempt.binding.validation.artifactRoot, at: new Date().toISOString() });
    attempt.sourcePresent = !!lstatSync(source, { throwIfNoEntry: false });
    if (attempt.sourcePresent) attempt.manifest = copyEvidence(source, destination);
    else {
      assert.ok(attempt.failed, "successful native command produced no evidence");
      mkdirSync(destination, { mode: 0o700 }); attempt.manifest = tree(destination);
    }
    durable(join(attempt.directory, "native-manifest.json"), json(attempt.manifest));
    attempt.records.push({ path: "native-manifest.json", sha256: digest(readRegular(join(attempt.directory, "native-manifest.json"))) });
    let report = null, validationError = null;
    try { report = inspectEvidence(attempt.binding, destination); }
    catch (error) { validationError = error.message; attempt.failed = true; }
    // Failed process/cleanup cannot be promoted even if its saved summary looks successful.
    if (!attempt.failed) assert.ok(attempt.commands.every((c) => c.success));
    assert.deepEqual(tree(destination), attempt.manifest, "evidence changed during native validation");
    if (attempt.sourcePresent) assert.deepEqual(tree(source), attempt.manifest, "source changed during native validation");
    attempt.logs = attempt.commands.map((_, i) => ({ path: `command-${i}.log`, sha256: digest(readRegular(join(attempt.directory, `command-${i}.log`))) }));
    const receipt = { schema: "benchmark-isolated-collection/v1", attempt: handle.id, bindingSha256: attempt.binding.bindingSha256,
      outcome: attempt.failed ? "failed" : report?.qualification === "blocked" ? "blocked" : "native-validated", report, validationError,
      nativeEvidenceSha256: attempt.manifest.sha256, commands: structuredClone(attempt.commands), logs: attempt.logs,
      controllerReady: false, hostIsolation: "unverified", reservation: "retained-no-automatic-release",
      coverage: attempt.binding.coverage, blockers: attempt.binding.status.blockers };
    record(attempt, "collection", receipt);
    attempt.receipt = freeze(receipt);
    return attempt.receipt;
  }
  return Object.freeze({
    async run(binding, { stateRoot, signal } = {}) {
      validateBinding(binding);
      binding = freeze(structuredClone(binding));
      if (!supportedGroups.includes(binding.request.group)) return freeze({ outcome: "not-run", group: binding.request.group,
        coverage: binding.coverage, blockers: [...binding.status.blockers, "isolated native worker/collector is not integrated for this group"], controllerReady: false });
      assert.equal(os.platform(), "linux", "native isolated-host execution requires Linux; tests use fake processes only");
      assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "native host requires Node 24+");
      assert.ok(os.availableParallelism() >= 8, "native host requires at least eight available CPUs");
      assert.ok(!signal?.aborted, "already cancelled");
      verifyWorkingSources(binding);
      const authorityRoot = physical(stateRoot);
      assert.ok(!inside(repo, authorityRoot) && !inside(authorityRoot, repo), "state root and checkout must be disjoint");
      const subject = freeze({ action: "execute-isolated-native", bindingSha256: binding.bindingSha256,
        commit: binding.request.commit, group: binding.request.group, round: binding.request.round,
        stateRoot: authorityRoot,
        host: { hostname: os.hostname(), platform: os.platform(), cpus: os.availableParallelism() } });
      assert.equal(await authorize(subject), true, "caller did not authorize this exact local execution");
      assert.ok(!signal?.aborted, "cancelled during authorization");
      verifyWorkingSources(binding); // Approval may have yielded while source changed.
      const source = join(repo, ...binding.validation.artifactRoot.split("/"));
      freshOutput(source);
      const attempt = reserve(binding, authorityRoot);
      const abort = new AbortController(), cancel = () => abort.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
      try {
        // Never run a report against the untrusted producer tree. Fixed in-process
        // validators run only after exclusive copy, type/link checks and hashing.
        const commands = [...binding.preparation.fixtures, binding.execution.invocation];
        for (const invocation of commands) {
          if (abort.signal.aborted) { attempt.failed = true; break; }
          const result = await command(attempt, invocation, abort.signal);
          if (!result.success) break;
        }
        verifyWorkingSources(binding);
      } catch (error) {
        attempt.failed = true;
        record(attempt, "worker-failure", { error: error.message });
      } finally {
        signal?.removeEventListener("abort", cancel);
        process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
      }
      attempt.settled = true;
      record(attempt, "terminal", { commands: attempt.commands, failed: attempt.failed });
      try { return { attempt: attempt.handle, collection: collect(attempt.handle) }; }
      catch (error) {
        attempt.failed = true;
        record(attempt, "collection-failure", { error: error.message, at: new Date().toISOString() });
        return { attempt: attempt.handle, outcome: "preserved-uncertain", error: error.message, controllerReady: false };
      }
    },
    collect,
    verify(handle) { return verifyCollection(own(handle)); },
  });
}
