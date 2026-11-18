import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { registration as sample } from "./test-fixtures/control-stream-fixture.mjs";

const cwd = resolve("."), repo = resolve(process.env.CORTEN_CONTROL_FIXTURE_REPO ?? cwd);
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { cwd, encoding: "utf8", timeout: 5000, maxBuffer: 512 * 1024 }).trim();
const commit = git("rev-parse", "HEAD");
if (process.env.CORTEN_CONTROL_FIXTURE_REPO) {
  assert.equal(commit, process.env.CORTEN_CONTROL_FIXTURE_COMMIT, "pin external fixture checkout");
  assert.equal(git("diff", "HEAD", "--", "bench/workloads"), "", "external fixture source must be committed");
}
const load = (path) => import(pathToFileURL(join(repo, "bench/workloads", path)));
const { guardianSource } = await load("cloud-control-runtime.mjs");
const { openControlStream } = await load("cloud-control-stream.mjs");
const { deploymentSha256 } = await load("deployments.mjs");
const { digest, fileHash } = await load("cloud-local.mjs");

function packet(root) {
  const directory = join(root, "r21-0123456789abcdef"), source = join(directory, "mixed-audit-sources");
  for (const path of [directory, source, join(source, "blobs"), join(source, "contexts")]) mkdirSync(path, { mode: 0o700 });
  const entries = [{ path: "", type: "directory" }, { path: "blobs", type: "directory" }, { path: "contexts", type: "directory" }];
  const files = [], block = Buffer.from(Array.from({ length: 32768 }, (_, i) => i % 256));
  function save(path, value, repeats = 1) {
    const fd = openSync(join(source, path), "wx", 0o600), hash = createHash("sha256");
    try {
      for (let i = 0; i < repeats; i++) {
        let at = 0; while (at < value.length) { const n = writeSync(fd, value, at); assert.ok(n > 0); at += n; }
        hash.update(value);
      }
    } finally { closeSync(fd); }
    const row = { path, type: "file", bytes: value.length * repeats, sha256: hash.digest("hex") }; entries.push(row); return row;
  }
  const values = [Buffer.alloc(0), Buffer.from("source\r\nwith exact bytes\n"), block,
    ...Array.from({ length: 61 }, (_, i) => Buffer.from("small source member " + i + "\n"))];
  for (const value of values) {
    const storedAs = "blobs/" + digest(value), row = save(storedAs, value);
    files.push({ path: "src/file-" + files.length + ".mjs", storedAs, bytes: row.bytes, sha256: row.sha256 });
  }
  const contexts = [save("contexts/corten.tar", block, 1024), save("contexts/upstream.tar", block, 2)];
  const manifest = { files, snapshot: { entries, sha256: deploymentSha256(entries) } };
  const body = { schema: "benchmark-mixed-audit-subject/v1", commit,
    sourcesManifest: { ...manifest, sha256: deploymentSha256(manifest) },
    requests: contexts.map((row) => ({ identity: { app: row.path.split("/")[1].slice(0, -4) }, contextArchiveSha256: row.sha256 })) };
  const subject = { ...body, subjectSha256: deploymentSha256(body) }, bytes = Buffer.from(JSON.stringify(subject));
  writeFileSync(join(directory, "mixed-audit-subject.json"), bytes, { mode: 0o600 });
  return { directory, entries, subject, bytes, sourceBytes: entries.reduce((n, row) => n + (row.bytes ?? 0), 0) };
}

for (const mode of ["normal", "hash"])
  test("local-pipe shipped sender to actual receiver: " + mode, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "corten-audit-pipe-")), local = join(root, "receiver"), p = packet(root);
    mkdirSync(local, { mode: 0o700 });
    const binding = { ...sample.binding, commit, helperSha256: digest(guardianSource) }, registration = { ...sample, binding };
    let child, closed, stderr = 0;
    t.after(async () => {
      if (child && child.exitCode === null) child.stdin.end();
      if (closed) await closed;
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true });
    });
    const ready = openControlStream({ repo, argv: [], expected: { id: registration.id, binding }, local,
      launch(binary) {
        assert.equal(binary, "ssh");
        child = spawn(process.platform === "win32" ? "python" : "python3", ["-I", join(cwd, "bench/workloads/test-fixtures/control-stream-material.py")],
          { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: 18000 });
        closed = once(child, "close");
        child.stderr.on("data", (data) => { stderr += data.length; assert.ok(stderr <= 8192); });
        child.stdin.write(JSON.stringify({ source: guardianSource, directory: p.directory, group: "mixed-production", mode, wire: true, registration }) + "\n");
        return child;
      } });
    const result = await ready, done = await result.monitor.done;
    const readyPath = join(local, "monitor-audit-mixed-production-ready.json"), target = join(local, "monitor-audit-mixed-production");
    if (mode === "hash") {
      assert.equal(done.publicationRevoked, true); assert.equal(done.terminal, false);
      assert.equal(existsSync(readyPath), false); assert.equal(existsSync(target), false);
      assert.ok(existsSync(target + ".partial"));
    } else {
      assert.equal(done.terminal, true); assert.equal(done.remoteDrained, false);
      assert.equal(existsSync(join(local, "monitor-invalid.json")), false); assert.equal(existsSync(target + ".partial"), false);
      assert.deepEqual(JSON.parse(readFileSync(readyPath)), { campaign: "r21-0123456789abcdef", group: "mixed-production", subjectSha256: p.subject.subjectSha256 });
      assert.equal(digest(readFileSync(join(target, "mixed-audit-subject.json"))), digest(p.bytes));
      assert.deepEqual(readdirSync(target).sort(), ["mixed-audit-sources", "mixed-audit-subject.json"].sort());
      for (const name of ["", "blobs", "contexts"]) {
        const expected = name ? p.entries.filter((row) => row.type === "file" && row.path.startsWith(name + "/")).map((row) => row.path.slice(name.length + 1)) : ["blobs", "contexts"];
        assert.deepEqual(readdirSync(join(target, "mixed-audit-sources", name)).sort(), expected.sort());
      }
      for (const row of p.entries.filter((row) => row.type === "file")) assert.equal(fileHash(join(target, "mixed-audit-sources", row.path), row.bytes), row.sha256);
      const journal = readFileSync(join(local, "monitor-journal.jsonl"), "utf8").trimEnd().split("\n").map(JSON.parse);
      const exported = journal.find((frame) => frame.kind === "progress" && frame.payload.state === "fixture-audit-exported").payload;
      assert.ok(exported.renewals >= 8); assert.equal(exported.failed, false); assert.equal(exported.ended, true);
      assert.equal(exported.files, p.entries.filter((row) => row.type === "file").length + 1);
      assert.equal(exported.bytes, p.sourceBytes + p.bytes.length); assert.equal(exported.maximumChunk, 32768);
      assert.ok(exported.checkpoints >= 3, "joined sender must exercise each cooperative preflight phase");
      assert.ok(journal.findIndex((f) => f.kind === "audit-end") < journal.findIndex((f) => f.payload?.state === "fixture-audit-exported"));
      t.diagnostic(JSON.stringify({ commit, files: exported.files, bytes: exported.bytes, renewals: exported.renewals,
        payloadFrames: exported.frames, checkpoints: exported.checkpoints, maximumChunk: exported.maximumChunk, senderMs: exported.elapsedMs, subjectSha256: p.subject.subjectSha256 }));
    }
    assert.equal(stderr, 0); assert.equal(git("rev-parse", "HEAD"), commit);
    if (process.env.CORTEN_CONTROL_FIXTURE_REPO) assert.equal(git("diff", "HEAD", "--", "bench/workloads"), "");
  });
