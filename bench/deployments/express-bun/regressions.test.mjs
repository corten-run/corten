import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { command, here } from "./build.mjs";
import { assertCheckoutUnchanged, verifyFixes } from "./verify-fixes.mjs";
import { upstream, checkHttp, fixtureIndependent, read } from "./checks.mjs";
import { records as catalogRecords } from "../../catalog/fixtures.mjs";
import { records as marketplaceRecords } from "../../marketplace/fixtures.mjs";

test("fixture JSON checks reject API relays, including fallback after upstream failure", async (t) => {
  const records = { catalog: catalogRecords(), marketplace: marketplaceRecords() };
  const api = await upstream(records, () => {});
  let fallback = false;
  const relay = createServer(async (req, res) => {
    const response = await fetch(api.url + req.url.replace(/^\/api\//, "/").replace(/\/(catalog|marketplace)\//, "/$1/records/"));
    const [, kind, id] = /^\/api\/(catalog|marketplace)\/([^/?]+)/.exec(req.url);
    const body = await response.text();
    res.writeHead(fallback ? records[kind][id] ? 200 : 404 : response.status, { "Content-Type": "application/json" });
    res.end(fallback ? JSON.stringify(records[kind][id] ?? {}) : body);
  });
  await new Promise((done) => relay.listen(0, "127.0.0.1", done));
  try {
    for (fallback of [false, true]) await t.test(`fallback=${fallback}`, async () => {
      const outcomes = [];
      await checkHttp({ base: `http://127.0.0.1:${relay.address().port}`, source: "fixture", profile: "default", records, upstream: api, observe: () => {},
        test: async (name, action) => {
          if (!name.endsWith("/all-500-json-and-source")) return;
          try { await action(); outcomes.push({ name, passed: true }); }
          catch (error) { outcomes.push({ name, passed: false, reason: error.message }); }
        } });
      assert.equal(outcomes.length, 2);
      assert.ok(outcomes.every((outcome) => !outcome.passed), JSON.stringify({ outcomes, upstreamReads: api.reads() }));
      assert.ok(outcomes.every((outcome) => /fixture.*upstream/i.test(outcome.reason)), JSON.stringify(outcomes));
    });
  } finally { relay.closeAllConnections(); await new Promise((done) => relay.close(done)); await api.close(); }
});

test("fixture isolation counts non-record attempts and restores previous unavailability", async () => {
  const observed = [], api = await upstream({ catalog: catalogRecords(), marketplace: marketplaceRecords() }, (entry) => observed.push(entry));
  try {
    api.unavailable(true);
    await assert.rejects(fixtureIndependent(api, (entry) => observed.push(entry), "page", async () => {
      assert.equal((await read(api.url, "/health", () => {})).status, 503);
    }), /fixture check contacted upstream/);
    assert.equal(api.unavailable(false), true);
    assert.equal(api.requests(), 1); assert.equal(api.reads(), 0);
    assert.equal(observed.find((entry) => entry.kind === "fixture-source-independence").attempts, 1);
    await fixtureIndependent(api, () => {}, "page", async () => {});
    assert.equal(api.unavailable(false), false);
  } finally { await api.close(); }
});

test("command stream artifacts retain full stdout and stderr separately", async () => {
  mkdirSync(join(here, "work"), { recursive: true });
  const out = mkdtempSync(join(here, "work/streams-"));
  try {
    const stdout = join(out, "stdout.log"), stderr = join(out, "stderr.log"), combined = join(out, "combined.log");
    await command(process.execPath, ["-e", 'process.stdout.write("out\\n\\n"); process.stderr.write("err\\n\\n")'], { stdoutFile: stdout, stderrFile: stderr, log: combined });
    assert.equal(readFileSync(stdout, "utf8"), "out\n\n");
    assert.equal(readFileSync(stderr, "utf8"), "err\n\n");
    assert.ok(readFileSync(combined, "utf8").includes("err\n\n"));
    await assert.rejects(command(process.execPath, ["-e", 'process.stderr.write("before failure\\n"); process.exitCode=7'], { stdoutFile: stdout, stderrFile: stderr }), /exit 7/);
    assert.equal(readFileSync(stdout, "utf8"), "");
    assert.equal(readFileSync(stderr, "utf8"), "before failure\n");
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("receipt binds clean committed harness/oracle bytes and rejects changes after execution", (t) => {
  mkdirSync(join(here, "work"), { recursive: true });
  const base = mkdtempSync(join(here, "work/receipt-"));
  // Registered before any setup, so a failed setup (no Git, a refused commit) still removes it.
  t.after(() => {
    assert.ok(base.startsWith(join(here, "work/receipt-")));
    rmSync(base, { recursive: true, force: true });
  });
  const verifier = "bench/deployments/express-bun/verify-fixes.mjs", oracle = "bench/workloads/json-check.mjs";
  // Setup and the raw control run on the ambient environment without any GIT_* variable, built here rather than by
  // the helper, so neither can reach a repository an outer caller selects.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  // A disposable caller repository whose GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE the process calling checkoutIdentity
  // inherits. It has its own commit tracking the verifier, so a checkoutIdentity that dropped its `env` would read it and
  // return its commit, and a tracked file whose times differ from its index entry, so a status run against it would
  // rewrite its index.
  const caller = join(base, "caller");
  const callerGit = (...args) => execFileSync("git", args, { cwd: caller, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: clean }).trim();
  for (const path of [verifier, "tracked.txt"]) { mkdirSync(join(caller, path, ".."), { recursive: true }); writeFileSync(join(caller, path), "caller\n"); }
  callerGit("init", "-q"); callerGit("add", ".");
  callerGit("-c", "user.name=Caller", "-c", "user.email=caller@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Caller");
  const callerCommit = callerGit("rev-parse", "HEAD");
  utimesSync(join(caller, "tracked.txt"), new Date(2001, 0, 1), new Date(2001, 0, 1));
  // Besides the selectors, variables a caller may carry: two that together outrun a Windows command line, and one whose
  // value must reach neither a child's arguments nor the test's output.
  const canary = `receipt-canary-${randomUUID()}`;
  const callerEnv = { ...clean, GIT_DIR: join(caller, ".git"), GIT_WORK_TREE: caller, GIT_INDEX_FILE: join(caller, ".git", "index"),
    CORTEN_RECEIPT_CANARY: canary, CORTEN_RECEIPT_PAD_A: "a".repeat(18000), CORTEN_RECEIPT_PAD_B: "b".repeat(18000) };
  const callerIndex = () => readFileSync(join(caller, ".git", "index")), indexBefore = callerIndex();
  const module = pathToFileURL(join(here, "verify-fixes.mjs")).href;
  const helper = new URL("../../../scripts/fixture-git.mjs", import.meta.url).href;
  // The real checkoutIdentity, called by a process whose own environment selects the caller: only the `env` it is
  // given, which that process builds from its own environment with fixtureGitEnv, can point its Git at the fixture.
  // Its arguments are paths alone, never environment values. Status only reads the fixture: no optional index
  // refresh of its own.
  const checkoutIdentity = (/** @type {string} */ path) => {
    const args = ["--input-type=module", "-e", `
      const { checkoutIdentity } = await import(process.argv[1]);
      const { fixtureGitEnv } = await import(process.argv[2]);
      let result;
      try { result = { identity: checkoutIdentity(process.argv[3], fixtureGitEnv({ GIT_OPTIONAL_LOCKS: "0" })) }; } catch (error) { result = { error: error.message }; }
      process.stdout.write(JSON.stringify(result));`, module, helper, path];
    assert.ok(!args.join("\0").includes(canary), "no environment value goes on the child's command line");
    const run = spawnSync(process.execPath, args, { cwd: base, env: callerEnv, encoding: "utf8", timeout: 60000, windowsHide: true });
    // The code alone: a spawn error carries the arguments.
    assert.equal(run.error && /** @type {NodeJS.ErrnoException} */ (run.error).code, undefined, "the child must start");
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    if (result.error) throw new Error(result.error);
    return result.identity;
  };
  const repo = join(base, "repo"); mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: clean }).trim();
  git("init", "-q");
  git("config", "user.name", "Local regression fixture"); git("config", "user.email", "fixture@example.invalid");
  for (const path of [verifier, oracle]) {
    mkdirSync(join(repo, path, ".."), { recursive: true }); writeFileSync(join(repo, path), "export const fixture = 1;\n");
  }
  git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "Committed receipt fixture");
  const before = checkoutIdentity(repo);
  assert.equal(before.dirty, false); assert.match(before.commit, /^[a-f0-9]{40}$/);
  assert.equal(before.commit, git("rev-parse", "HEAD")); assert.notEqual(before.commit, callerCommit);
  assert.deepEqual(Object.keys(before.sources), [verifier, oracle]);
  assertCheckoutUnchanged(before, checkoutIdentity(repo));
  for (const path of [verifier, oracle]) {
    const original = readFileSync(join(repo, path));
    writeFileSync(join(repo, path), "export const changed = true;\n");
    const changed = checkoutIdentity(repo); assert.equal(changed.dirty, true);
    assert.throws(() => assertCheckoutUnchanged(before, changed), /became dirty/);
    // Structural hostile receipt check: even a forged clean flag cannot hide changed hashes.
    assert.throws(() => assertCheckoutUnchanged(before, { ...changed, dirty: false }), /bytes changed/);
    writeFileSync(join(repo, path), original);
  }
  writeFileSync(join(repo, "untracked.txt"), "untracked");
  assert.equal(checkoutIdentity(repo).dirty, true); rmSync(join(repo, "untracked.txt"));
  git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Different clean HEAD");
  const after = checkoutIdentity(repo); assert.equal(after.dirty, false);
  assert.throws(() => assertCheckoutUnchanged(before, after), /commit changed/);
  git("rm", "--cached", verifier); git("-c", "commit.gpgsign=false", "commit", "-qm", "HEAD without verifier");
  assert.throws(() => checkoutIdentity(repo), /verifier must be tracked/);
  assert.deepEqual(callerIndex(), indexBefore, "the fixture's status must not refresh the caller's index");
  // Control: the same status with the caller's environment, optional locks on, does rewrite that index.
  execFileSync("git", ["status", "--porcelain"], { cwd: repo, stdio: "ignore", env: { ...callerEnv, GIT_OPTIONAL_LOCKS: "1" } });
  assert.notDeepEqual(callerIndex(), indexBefore, "the control must show the write the sanitized environment prevents");
});

test("dirty checkout is refused before output creation or Docker execution", async () => {
  const scratch = mkdtempSync(join(here, "receipt-untracked-")), out = join(scratch, "must-not-exist");
  try {
    writeFileSync(join(scratch, "dirty.txt"), "Untracked preflight regression fixture\n");
    await assert.rejects(verifyFixes(["reject-dirty", "--out", out]), /requires a clean committed checkout/);
    assert.equal(existsSync(out), false);
  } finally {
    assert.ok(scratch.startsWith(join(here, "receipt-untracked-")));
    rmSync(scratch, { recursive: true, force: true });
  }
});
