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
export function hashExecutableDescriptor(fd, identity) {
  executableReference(identity);
  assert.deepEqual(executableIdentity(fd), identity, "sampled executable inode changed before hashing");
  const digest = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
  let offset = 0;
  for (;;) {
    const n = readSync(fd, buffer, 0, buffer.length, offset);
    if (n === 0) break;
    digest.update(buffer.subarray(0, n)); offset += n;
  }
  assert.equal(String(offset), identity.size);
  assert.deepEqual(executableIdentity(fd), identity, "sampled executable inode changed while hashing");
  return digest.digest("hex");
}

/** Pin the actual sampled inode, not a pathname that could be replaced after exit. */
export function participantExecutables() {
  const entries = new Map(); let closed = false;
  return Object.freeze({
    capture(pid) {
      assert.equal(closed, false); assert.equal(process.platform, "linux");
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      const path = `/proc/${pid}/exe`, fd = openSync(path, "r");
      let retained = false;
      try {
        const identity = executableIdentity(fd), info = statSync(path, { bigint: true });
        assert.deepEqual(Object.fromEntries(keys.map((key) => [key, String(info[key])])), identity);
        const ref = executableReference(identity);
        if (!entries.has(ref)) { entries.set(ref, { fd, identity }); retained = true; }
        return { executableRef: ref, executableIdentity: identity };
      } finally { if (!retained) closeSync(fd); }
    },
    recheck(pid, evidence) {
      assert.equal(closed, false);
      assert.equal(evidence.executableRef, executableReference(evidence.executableIdentity));
      const info = statSync(`/proc/${pid}/exe`, { bigint: true });
      assert.deepEqual(Object.fromEntries(keys.map((key) => [key, String(info[key])])), evidence.executableIdentity);
    },
    finish() {
      assert.equal(closed, false); closed = true;
      const values = [...entries].map(([ref, { identity }]) => ({ ref, identity }));
      try {
        // Hash only after the final resource sample. The fixed helper receives
        // already-open descriptors, never archive paths. It must exit cleanly
        // inside the existing bootstrap bound before the next command can start.
        const result = values.length ? JSON.parse(execFileSync(process.execPath, [helper, "--hash-open-executables"], {
          input: serial(values), encoding: "utf8", timeout: limits.readyMs, maxBuffer: 16 * 2 ** 20,
          stdio: ["pipe", "pipe", "ignore", ...[...entries.values()].map((v) => v.fd)], windowsHide: true,
          env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root", LANG: "C.UTF-8" },
        })) : [];
        assert.equal(result.length, values.length);
        result.forEach((entry, i) => {
          assert.deepEqual(Object.keys(entry).sort(), ["identity", "ref", "sha256"]);
          assert.deepEqual({ ref: entry.ref, identity: entry.identity }, values[i]);
          assert.match(entry.sha256, /^[a-f0-9]{64}$/);
          assert.deepEqual(executableIdentity([...entries.values()][i].fd), entry.identity);
        });
        return { schema: "benchmark-participant-executables/v1", executables: result };
      } finally { for (const { fd } of entries.values()) closeSync(fd); entries.clear(); }
    },
    close() {
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
  } catch { process.exitCode = 2; } // No producer-controlled paths or diagnostics.
}
