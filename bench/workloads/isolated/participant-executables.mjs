import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { limits } from "./process.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const serial = (value) => JSON.stringify(value);
const helper = fileURLToPath(import.meta.url);
const keys = ["dev", "ino", "size", "mtimeNs", "ctimeNs"];
const hashOperations = ["executable-hash-before", "executable-hash-read", "executable-hash-after"];
const proofOperations = [...hashOperations, "executable-hash-helper", "executable-hash-result", "executable-hash-recheck", "executable-proof-publish"];
const proofCodes = ["identity-ctime", "ENOENT", "EACCES", "EPERM", "EIO", "ENOSPC", "EDQUOT", "EMFILE", "ENFILE", "EBADF",
  "ETIMEDOUT", "ENOBUFS", "ERR_ASSERTION", "unknown"];

export function executableProofFailure(operation, error, ref) {
  assert.ok(proofOperations.includes(operation));
  const code = proofCodes.includes(error?.code) ? error.code : "unknown";
  return Object.assign(new Error(`${operation}: ${code}`), { operation, code, ...(ref ? { executableRef: ref } : {}) });
}

export function executableProofFailureMessage(failure) {
  if (!proofOperations.includes(failure?.operation) || !proofCodes.includes(failure.code)) return "host-executable-proof-incomplete";
  const ref = /^[a-f0-9]{64}$/.test(failure.executableRef) ? ` (${failure.executableRef})` : "";
  return `host-executable-proof-incomplete: ${failure.operation}: ${failure.code}${ref}`;
}

export function executableIdentity(fd) {
  const info = fstatSync(fd, { bigint: true });
  assert.ok(info.isFile());
  return Object.fromEntries(keys.map((key) => [key, String(info[key])]));
}
export function executableReference(identity) {
  assert.deepEqual(Object.keys(identity), keys);
  for (const value of Object.values(identity)) assert.match(value, /^\d+$/);
  return hash(serial(identity));
}
function checkIdentity(fd, identity) {
  const actual = executableIdentity(fd);
  if (actual.ctimeNs !== identity.ctimeNs && keys.every((key) => key === "ctimeNs" || actual[key] === identity[key]))
    throw Object.assign(new Error("executable change time differs"), { code: "identity-ctime" });
  assert.deepEqual(actual, identity, "sampled executable inode changed");
}

export function hashExecutableDescriptor(fd, identity, checkDeadline) {
  checkDeadline?.();
  const ref = executableReference(identity);
  const stage = (operation, work) => {
    try { return work(); } catch (error) { throw executableProofFailure(operation, error, ref); }
  };
  stage("executable-hash-before", () => checkIdentity(fd, identity));
  const digest = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
  stage("executable-hash-read", () => {
    for (let offset = 0;;) {
      checkDeadline?.();
      const n = readSync(fd, buffer, 0, buffer.length, offset);
      checkDeadline?.();
      if (n === 0) { assert.equal(String(offset), identity.size); break; }
      digest.update(buffer.subarray(0, n)); offset += n;
    }
  });
  stage("executable-hash-after", () => checkIdentity(fd, identity));
  return digest.digest("hex");
}

function sealExecutables(values, descriptors) {
  let bytes;
  try {
    bytes = execFileSync(process.execPath, [helper, "--hash-open-executables"], {
      input: serial(values), encoding: "utf8", timeout: limits.readyMs, maxBuffer: 16 * 2 ** 20,
      stdio: ["pipe", "pipe", "ignore", ...descriptors], windowsHide: true,
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root", LANG: "C.UTF-8" },
    });
  } catch (error) {
    let reported;
    if (error.status === 2 && !error.signal && typeof error.stdout === "string" && error.stdout.length <= 256) {
      try { reported = JSON.parse(error.stdout); } catch { /* Not a fixed helper failure. */ }
    }
    if (hashOperations.includes(reported?.operation) && proofCodes.includes(reported.code) && values.some(({ ref }) => ref === reported.executableRef))
      throw executableProofFailure(reported.operation, reported, reported.executableRef);
    throw executableProofFailure("executable-hash-helper", error);
  }
  let result;
  try {
    result = JSON.parse(bytes); assert.ok(Array.isArray(result)); assert.equal(result.length, values.length);
    result.forEach((entry, i) => {
      assert.deepEqual(Object.keys(entry).sort(), ["identity", "ref", "sha256"]);
      assert.deepEqual({ ref: entry.ref, identity: entry.identity }, values[i]);
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    });
  } catch (error) { throw executableProofFailure("executable-hash-result", error); }
  result.forEach(({ ref, identity }, i) => {
    try { checkIdentity(descriptors[i], identity); }
    catch (error) { throw executableProofFailure("executable-hash-recheck", error, ref); }
  });
  return result;
}

/** Pin the actual sampled inode, not a pathname that could be replaced after exit. */
export function participantExecutables() {
  const entries = new Map(), transactions = []; let closed = false;
  return Object.freeze({
    transaction(action) {
      assert.equal(closed, false);
      const added = []; transactions.push(added); let committed = false;
      try {
        const value = action();
        assert.ok(!value || typeof value.then !== "function", "executable capture transactions must be synchronous");
        committed = true; return value;
      } finally {
        assert.equal(transactions.pop(), added);
        if (committed) {
          // A successful inner census still belongs to its enclosing observation.
          if (transactions.length) for (const ref of added) transactions.at(-1).push(ref);
        } else {
          for (const ref of added) { closeSync(entries.get(ref).fd); entries.delete(ref); }
        }
      }
    },
    capture(pid) {
      assert.equal(closed, false); assert.equal(process.platform, "linux");
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      const path = `/proc/${pid}/exe`, fd = openSync(path, "r");
      let retained = false;
      try {
        const identity = executableIdentity(fd), info = statSync(path, { bigint: true });
        assert.deepEqual(Object.fromEntries(keys.map((key) => [key, String(info[key])])), identity);
        const ref = executableReference(identity);
        if (!entries.has(ref)) {
          entries.set(ref, { fd, identity }); retained = true;
          transactions.at(-1)?.push(ref);
        }
        return { executableRef: ref, executableIdentity: identity };
      } finally { if (!retained) closeSync(fd); }
    },
    recheck(pid, evidence, observing) {
      assert.equal(closed, false);
      const expected = evidence.executableIdentity;
      observing("executable-recheck-reference", () => assert.equal(evidence.executableRef, executableReference(expected)));
      const info = statSync(`/proc/${pid}/exe`, { bigint: true });
      const actual = Object.fromEntries(keys.map((key) => [key, String(info[key])]));
      const operation = actual.dev !== expected.dev || actual.ino !== expected.ino ? "executable-recheck-inode"
        : actual.size !== expected.size || actual.mtimeNs !== expected.mtimeNs ? "executable-recheck-size-or-mtime"
        : "executable-recheck-ctime";
      observing(operation, () => assert.deepEqual(actual, expected));
    },
    checkPinned(evidence) {
      const entry = entries.get(evidence.executableRef);
      assert.ok(entry);
      assert.deepEqual(executableIdentity(entry.fd), evidence.executableIdentity);
    },
    finish() {
      assert.equal(closed, false); assert.equal(transactions.length, 0); closed = true;
      const values = [...entries].map(([ref, { identity }]) => ({ ref, identity }));
      try {
        // Hash only after the final resource sample. The fixed helper receives
        // already-open descriptors, never archive paths. It must exit cleanly
        // inside the existing bootstrap bound before the next command can start.
        const result = values.length ? sealExecutables(values, [...entries.values()].map(({ fd }) => fd)) : [];
        return { schema: "benchmark-participant-executables/v1", executables: result };
      } finally { for (const { fd } of entries.values()) closeSync(fd); entries.clear(); }
    },
    close() {
      assert.equal(transactions.length, 0);
      if (!closed) { closed = true; for (const { fd } of entries.values()) closeSync(fd); entries.clear(); }
    },
  });
}

if (process.argv[1] === helper) {
  try {
    assert.deepEqual(process.argv.slice(2), ["--hash-open-executables"]);
    const values = JSON.parse(readFileSync(0, "utf8")); assert.ok(Array.isArray(values));
    const result = values.map(({ ref, identity }, i) => {
      assert.equal(ref, executableReference(identity));
      return { ref, identity, sha256: hashExecutableDescriptor(i + 3, identity) };
    });
    process.stdout.write(serial(result));
  } catch (error) {
    if (hashOperations.includes(error?.operation)) {
      const { operation, code, executableRef } = error;
      process.stdout.write(serial({ operation, code, executableRef }));
    }
    process.exitCode = 2; // No paths, descriptor contents or raw diagnostics.
  }
}
