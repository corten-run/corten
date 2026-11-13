import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { command, here } from "./build.mjs";
import { checkoutIdentity, assertCheckoutUnchanged, verifyFixes } from "./verify-fixes.mjs";
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

test("receipt binds clean committed harness/oracle bytes and rejects changes after execution", () => {
  mkdirSync(join(here, "work"), { recursive: true });
  const base = mkdtempSync(join(here, "work/receipt-"));
  const git = (...args) => execFileSync("git", args, { cwd: base, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const verifier = "bench/deployments/express-bun/verify-fixes.mjs", oracle = "bench/workloads/json-check.mjs";
  try {
    git("init", "-q");
    git("config", "user.name", "Local regression fixture"); git("config", "user.email", "fixture@example.invalid");
    for (const path of [verifier, oracle]) {
      mkdirSync(join(base, path, ".."), { recursive: true }); writeFileSync(join(base, path), "export const fixture = 1;\n");
    }
    git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "Committed receipt fixture");
    const before = checkoutIdentity(base);
    assert.equal(before.dirty, false); assert.match(before.commit, /^[a-f0-9]{40}$/);
    assert.deepEqual(Object.keys(before.sources), [verifier, oracle]);
    assertCheckoutUnchanged(before, checkoutIdentity(base));
    for (const path of [verifier, oracle]) {
      const original = readFileSync(join(base, path));
      writeFileSync(join(base, path), "export const changed = true;\n");
      const changed = checkoutIdentity(base); assert.equal(changed.dirty, true);
      assert.throws(() => assertCheckoutUnchanged(before, changed), /became dirty/);
      // Structural hostile receipt check: even a forged clean flag cannot hide changed hashes.
      assert.throws(() => assertCheckoutUnchanged(before, { ...changed, dirty: false }), /bytes changed/);
      writeFileSync(join(base, path), original);
    }
    writeFileSync(join(base, "untracked.txt"), "untracked");
    assert.equal(checkoutIdentity(base).dirty, true); rmSync(join(base, "untracked.txt"));
    git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Different clean HEAD");
    const after = checkoutIdentity(base); assert.equal(after.dirty, false);
    assert.throws(() => assertCheckoutUnchanged(before, after), /commit changed/);
    git("rm", "--cached", verifier); git("-c", "commit.gpgsign=false", "commit", "-qm", "HEAD without verifier");
    assert.throws(() => checkoutIdentity(base), /verifier must be tracked/);
  } finally {
    assert.ok(base.startsWith(join(here, "work/receipt-")));
    rmSync(base, { recursive: true, force: true });
  }
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
