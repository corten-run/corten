import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controller } from "./droplet.mjs";
import { nightly, officialRound, ownedDroplet, parseDropletArgs, remoteFiles, safeArchive, terminalUnit, validateState } from "./droplet-contract.mjs";

const commit = "a".repeat(40);
const state = () => ({ workload: "marketplace-v2", round: "r17", commit, options: nightly,
  name: "corten-marketplace-r17", unit: "corten-marketplace-r17.service", tag: "corten-marketplace-run-0123456789abcdef", id: "123", ip: "192.0.2.1", status: "running" });
const droplet = (s) => ({ id: Number(s.id), name: s.name, tags: ["corten-bench", "corten-marketplace", s.tag], networks: { v4: [{ type: "public", ip_address: s.ip }] }, size: { price_hourly: 0.25 } });
const loaded = "LoadState=loaded\nActiveState=inactive\nRestart=no\n";
test("official identity and explicit launch arguments", () => {
  for (const r of ["r17", "r19", "r20", "r99", "r100", "r1234"]) assert.equal(officialRound(r), r);
  for (const r of ["r16", "r1", "c1", "w1", "r017", "r17;true", "r17\n"]) assert.throws(() => officialRound(r));
  assert.equal(parseDropletArgs(["r17", "--detach", "--ssh-key", "42", "--state-dir", "../state"]).detach, true);
  assert.equal(parseDropletArgs(["r17", "--collect", "--state-dir", "../state"]).collect, true);
  for (const args of [["r17"], ["r17", "--detach", "--ssh-key", "no", "--state-dir", "x"], ["r17", "--collect", "--detach", "--state-dir", "x"], ["r17", "--collect", "--state-dir", "x", "--keep"], ["r17", "--collect", "--collect", "--state-dir", "x"]]) assert.throws(() => parseDropletArgs(args));
});
test("identity never falls back to a similarly named or tagged host", () => {
  const s = state(), d = droplet(s);
  assert.equal(ownedDroplet([d], s), d);
  for (const change of [{ id: 124 }, { name: "corten-catalog-c1" }, { tags: [s.tag] }, { tags: ["corten-bench", "corten-marketplace"] }]) assert.throws(() => ownedDroplet([{ ...d, ...change }], s));
  assert.throws(() => ownedDroplet([d, d], s));
  assert.throws(() => validateState({ ...s, ip: "192.0.2.1;true" }, "r17"));
});
test("only terminal loaded non-restarting units permit collection", () => {
  assert.equal(terminalUnit(loaded), true);
  assert.equal(terminalUnit(loaded.replace("inactive", "active")), false);
  assert.equal(terminalUnit(loaded.replace("inactive", "activating")), false);
  assert.throws(() => terminalUnit(loaded.replace("loaded", "not-found")));
  assert.throws(() => terminalUnit(loaded.replace("Restart=no", "Restart=always")));
});
test("archive traversal, foreign results, symlinks and special files are refused", () => {
  const root = "repo/bench/marketplace/results/r17/summary.json";
  safeArchive(`run.log\nexit-code\n${root}\n`, "-rw-r--r-- file\ndrwxr-xr-x directory\n", "r17");
  for (const bad of ["../x", "/x", "C:/x", "a\\b", "repo/bench/fullstack/results/r17/x", "repo/bench/marketplace/results/r18/x", "repo/bench/marketplace/results/r17/../x"])
    assert.throws(() => safeArchive(bad, "-rw file", "r17"));
  for (const type of ["l", "h", "b", "c", "p"]) assert.throws(() => safeArchive(root, `${type}file`, "r17"));
});
test("remote job is pinned, detached and fail-closed without legacy measurements", () => {
  const files = remoteFiles(state());
  assert.match(files["job.sh"], new RegExp(`git checkout --detach ${commit}`));
  assert.match(files["job.sh"], /marketplace\/run.mjs r17 --build --passes 3 --duration 15 --warmup 10 --rate 150/);
  assert.match(files["job.sh"], /MARKETPLACE_APP_CPUS=1 MARKETPLACE_API_CPUS=2-3 MARKETPLACE_LOAD_CPUS=4-7/);
  assert.doesNotMatch(files["job.sh"], /run-all|catalog\/run|count.mjs|build.mjs/);
  assert.match(files[state().unit], /Restart=no/); assert.match(files[state().unit], /RuntimeMaxSec=36h/);
});
test("generated remote shell and systemd unit pass native syntax validation", { skip: process.platform !== "linux" }, (t) => {
  const temp = mkdtempSync(join(tmpdir(), "marketplace-unit-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(remoteFiles(state()))) {
    const file = join(temp, name); writeFileSync(file, content);
    const result = name.endsWith(".sh") ? spawnSync("bash", ["-n", file], { encoding: "utf8" }) : spawnSync("systemd-analyze", ["verify", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

function harness(t, { active = false, corrupt = false, missing = false, dirty = false, failCreate = false, failDelete = false, lostDelete = false, failExtract = false } = {}) {
  const temp = mkdtempSync(join(tmpdir(), "marketplace-droplet-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, "repo"), local = join(temp, "control"), remote = join(temp, "remote");
  mkdirSync(repo); mkdirSync(local); mkdirSync(remote);
  let s = state(), droplets = [droplet(s)], deleted = 0, creates = 0, extractions = 0;
  const calls = [];
  const run = (binary, args) => {
    calls.push([binary, ...args]);
    const good = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (binary === "git") return good(args[0] === "rev-parse" ? commit : dirty ? " M README.md\n" : "");
    if (binary === "doctl") {
      if (args[2] === "list") return good(JSON.stringify(droplets));
      if (args[2] === "create") {
        creates++;
        const saved = JSON.parse(readFileSync(join(local, "state.json"), "utf8")); s = { ...saved, id: "123", ip: "192.0.2.1" };
        droplets = [droplet(s)]; return failCreate ? { status: 1, stdout: "", stderr: "connection lost after create" } : good();
      }
      if (args[2] === "delete") {
        deleted++; if (failDelete && deleted === 1) throw new Error("delete temporarily unavailable");
        droplets = [];
        if (lostDelete && deleted === 1) throw new Error("delete acknowledgement lost");
        return good();
      }
    }
    if (binary === "ssh") {
      const script = args.at(-1);
      if (script.startsWith("systemctl show")) return good(missing ? loaded.replace("loaded", "not-found") : active ? loaded.replace("inactive", "active") : loaded);
      if (script === "sha256sum /bench/results.tgz") return good(`${createHash("sha256").update(readFileSync(join(remote, "results.tgz"))).digest("hex")}  /bench/results.tgz`);
      if (script.startsWith("tail")) return good("checking corten fixture\n");
      return good();
    }
    if (binary === "scp") {
      if (args.at(-2).startsWith("root@")) writeFileSync(args.at(-1), corrupt ? "corrupt archive" : readFileSync(join(remote, "results.tgz")));
      return good();
    }
    if (binary === "tar") {
      if (args[0] === "-xzf" && failExtract && ++extractions === 1) {
        writeFileSync(join(args.at(-1), "partial.txt"), "preserved partial extraction");
        throw new Error("transient extraction failure");
      }
      const r = spawnSync(binary, args, { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r;
    }
    throw new Error(`unexpected command ${binary} ${args.join(" ")}`);
  };
  return { repo, local, remote, run, calls, get deleted() { return deleted; }, get creates() { return creates; },
    reserve() { writeFileSync(join(local, "state.json"), JSON.stringify(s)); },
    empty() { droplets = []; },
    archive({ beforeRun = false } = {}) {
      if (!beforeRun) {
        const result = join(remote, "repo/bench/marketplace/results/r17"); mkdirSync(result, { recursive: true });
        writeFileSync(join(result, "summary.json"), JSON.stringify({ workload: "marketplace-v2", round: "r17", commit, complete: false, failures: ["failed checks"] }));
      }
      writeFileSync(join(remote, "exit-code"), "1\n"); writeFileSync(join(remote, "run.log"), "checks failed\n");
      const r = spawnSync("tar", ["-czf", join(remote, "results.tgz"), "-C", remote, "run.log", "exit-code", ...(beforeRun ? [] : ["repo/bench/marketplace/results/r17"])], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr);
    },
    task(extra = {}) { return controller({ round: "r17", stateDir: local, sshKey: "42", ...extra }, { run, repo, sleep: async () => {} }); },
  };
}
test("live unit: no pack, download, deletion or restart", async (t) => {
  const h = harness(t, { active: true }); h.reserve();
  assert.equal(await h.task().collect(), 3); assert.equal(h.deleted, 0);
  assert.ok(!h.calls.some((c) => c[0] === "scp" || c.at(-1) === "/bin/bash /bench/pack.sh"));
});
test("missing unit preserves droplet and evidence", async (t) => {
  const h = harness(t, { missing: true }); h.reserve();
  await assert.rejects(h.task().collect(), /unit missing/); assert.equal(h.deleted, 0);
});
test("hash mismatch preserves droplet and downloaded archive", async (t) => {
  const h = harness(t, { corrupt: true }); h.reserve(); h.archive();
  await assert.rejects(h.task().collect(), /hash mismatch/); assert.equal(h.deleted, 0);
  assert.ok(existsSync(join(h.local, "results.tgz.download")));
});
test("partial artifacts survive terminal deletion and repeated collect", async (t) => {
  const h = harness(t); h.reserve(); h.archive();
  assert.equal(await h.task().collect(), 1); assert.equal(h.deleted, 1);
  const saved = JSON.parse(readFileSync(join(h.local, "state.json"), "utf8"));
  assert.equal(saved.complete, false); assert.ok(saved.destroyedAt);
  assert.ok(existsSync(join(saved.resultFolder, "summary.json")));
  assert.ok(existsSync(saved.resultArchive));
  assert.equal(await h.task().collect(), 1); assert.equal(h.deleted, 1);
});

test("pre-measurement failure reports its actual preserved evidence directory", async (t) => {
  const h = harness(t); h.reserve(); h.archive({ beforeRun: true });
  assert.equal(await h.task().collect(), 1); assert.equal(h.deleted, 1);
  const saved = JSON.parse(readFileSync(join(h.local, "state.json"), "utf8"));
  assert.equal(saved.resultFolder, saved.evidenceFolder);
  assert.ok(existsSync(join(saved.resultFolder, "run.log")));
  assert.equal(existsSync(join(saved.resultFolder, "summary.json")), false);
});
test("cleanup failure is retried without overwriting or downloading artifacts again", async (t) => {
  const h = harness(t, { failDelete: true }); h.reserve(); h.archive();
  await assert.rejects(h.task().collect(), /temporarily unavailable/);
  const downloads = h.calls.filter((c) => c[0] === "scp").length;
  assert.equal(await h.task().collect(), 1); assert.equal(h.calls.filter((c) => c[0] === "scp").length, downloads);
});

test("interrupted extraction retries independently and preserves the failed attempt", async (t) => {
  const h = harness(t, { failExtract: true }); h.reserve(); h.archive();
  await assert.rejects(h.task().collect(), /transient extraction/); assert.equal(h.deleted, 0);
  const before = JSON.parse(readFileSync(join(h.local, "state.json"), "utf8"));
  assert.ok(existsSync(join(before.extractionAttempts[0], "partial.txt")));
  const downloads = h.calls.filter((c) => c[0] === "scp").length;
  assert.equal(await h.task().collect(), 1); assert.equal(h.deleted, 1);
  const after = JSON.parse(readFileSync(join(h.local, "state.json"), "utf8"));
  assert.equal(after.extractionAttempts.length, 2);
  assert.ok(existsSync(join(before.extractionAttempts[0], "partial.txt")));
  assert.ok(existsSync(join(after.resultFolder, "summary.json")));
  assert.equal(h.calls.filter((c) => c[0] === "scp").length, downloads);
  assert.equal(existsSync(join(h.repo, "bench/marketplace/results/r17")), false);
});

test("lost deletion acknowledgement reconciles confirmed absence without a second delete", async (t) => {
  const h = harness(t, { lostDelete: true }); h.reserve(); h.archive();
  await assert.rejects(h.task().collect(), /acknowledgement lost/);
  const before = JSON.parse(readFileSync(join(h.local, "state.json"), "utf8"));
  assert.ok(before.collectedAt && before.deletionIntentAt); assert.equal(before.destroyedAt, undefined);
  assert.equal(await h.task().collect(), 1); assert.equal(h.deleted, 1);
  assert.ok(JSON.parse(readFileSync(join(h.local, "state.json"), "utf8")).destroyedAt);
});
test("launch reserves once even when create response is ambiguous", async (t) => {
  const h = harness(t, { active: true, failCreate: true }); h.empty();
  assert.equal((await h.task().launch()).status, "running"); assert.equal(h.creates, 1);
  await assert.rejects(h.task().launch(), /already reserved/); assert.equal(h.creates, 1);
});
test("dirty checkout and existing benchmark prevent create", async (t) => {
  const h = harness(t, { dirty: true }); h.empty();
  await assert.rejects(h.task().launch(), /clean measured commit/); assert.equal(h.creates, 0);
  const busy = harness(t); await assert.rejects(busy.task().launch(), /already exists/); assert.equal(busy.creates, 0);
});
