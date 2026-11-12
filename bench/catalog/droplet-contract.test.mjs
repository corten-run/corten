import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cpuSettings, parseArgs } from "./contract.mjs";
import { groupDescriptor } from "./group.mjs";
import { cpuEnv, host, measurements, ownedDroplet, parseDropletArgs, remoteFiles, reservation, roundName, safeArchive, tags, terminalUnit, validateState } from "./droplet-contract.mjs";

const commit = "a".repeat(40), token = "0123456789abcdef";
const state = () => reservation("c2", commit, token);
const droplet = (s) => ({ id: 123, name: s.name, tags: [...tags, s.tag], size_slug: host.size, region: { slug: host.region } });
const unit = (s) => `Id=${s.unit}\nLoadState=loaded\nFragmentPath=/etc/systemd/system/${s.unit}\nActiveState=inactive\nRestart=no\nMainPID=0\nExecMainCode=1\nExecMainStartTimestamp=Thu 2026-11-12 10:00:00 UTC\n`;

test("CLI requires explicit catalog-page, distinct round, full SHA and one mode; no measurement overrides", () => {
  const launch = ["c2", "--group", "catalog-page", "--detach", "--commit", commit, "--ssh-key", "42", "--state-dir", "../control"];
  assert.equal(parseDropletArgs(launch).commit, commit);
  assert.equal(parseDropletArgs(["c2", "--group", "catalog-page", "--collect", "--state-dir", "../control"]).collect, true);
  for (const args of [launch.map((a) => a === "c2" ? "c1" : a), launch.filter((a) => a !== "--detach"),
    launch.map((a) => a === commit ? "main" : a), launch.map((a) => a === "catalog-page" ? "json-api" : a),
    launch.filter((a, i) => ![1, 2].includes(i)), [...launch, "--collect"], [...launch, "--passes", "1"],
    [...launch, "--apps", "corten"], [...launch, "--detach"], [...launch, "--keep"],
    ["c2", "--group", "catalog-page", "--collect", "--state-dir", "x", "--commit", commit]]) assert.throws(() => parseDropletArgs(args));
  for (const round of ["c1", "c02", "c2\n", "r20", "c2;true", "../c2"]) assert.throws(() => roundName(round));
});

test("reservation derives exact registry, current native defaults and disjoint CPU budgets, not an app count", () => {
  const s = state(), group = groupDescriptor("catalog-page");
  assert.deepEqual(s.group, group); assert.equal(s.group.apps.length, 7);
  assert.deepEqual(s.options, parseArgs(["c2", "--build", "--group", "catalog-page"], Object.fromEntries(group.apps.map((a) => [a, {}]))));
  assert.deepEqual(s.options, measurements("c2")); assert.deepEqual(s.cpus, cpuSettings(cpuEnv));
  assert.deepEqual(Object.fromEntries(Object.entries(s.cpus).map(([k, v]) => [k, [v.quota, v.cpuset]])), { app: [1, "1"], load: [4, "4-7"], api: [2, "2-3"] });
  const other = reservation("c2", commit, "fedcba9876543210");
  assert.notEqual(s.name, other.name); assert.notEqual(s.tag, other.tag); assert.notEqual(s.unit, other.unit);
  for (const change of [(s) => s.group.apps.pop(), (s) => { s.options.duration = 1; }, (s) => { s.cpus.load.cpuset = "1"; },
    (s) => { s.name = "corten-catalog-c1"; }, (s) => { s.ip = "999.0.0.1"; }, (s) => { s.id = "123;true"; },
    (s) => { s.evidence = "../x"; s.extractionAttempts = ["../x"]; }]) { const changed = state(); change(changed); assert.throws(() => validateState(changed, "c2")); }
});

test("ownership requires exact ID/name/all tags and dedicated host type; never substitutes another host", () => {
  const s = state(), d = droplet(s); assert.equal(ownedDroplet([d], s), d);
  assert.throws(() => ownedDroplet([d, d], s));
  s.id = "123";
  for (const change of [{ id: 124 }, { name: "corten-catalog-c1" }, { tags: [s.tag] }, { size_slug: "s-8vcpu-16gb" }, { region: { slug: "nyc1" } }])
    assert.throws(() => ownedDroplet([{ ...d, ...change }], s));
  assert.throws(() => ownedDroplet([], s));
});

test("unit must be exact loaded non-restarting AND genuinely exited; active/uncertain hosts cannot be deleted", () => {
  const s = state(), output = unit(s); assert.equal(terminalUnit(output, s), true);
  for (const active of ["active", "activating", "deactivating", "reloading", "unknown"]) assert.equal(terminalUnit(output.replace("ActiveState=inactive", `ActiveState=${active}`), s), false);
  for (const [before, after] of [[s.unit, "foreign.service"], ["LoadState=loaded", "LoadState=not-found"], ["Restart=no", "Restart=always"],
    ["MainPID=0", "MainPID=22"], ["ExecMainCode=1", "ExecMainCode=0"], ["FragmentPath=/etc/systemd/system/", "FragmentPath=/tmp/"],
    ["Thu 2026-11-12 10:00:00 UTC", ""], ["Thu 2026-11-12 10:00:00 UTC", "n/a"]]) assert.throws(() => terminalUnit(output.replace(before, after), s));
  assert.throws(() => terminalUnit(`${output}Restart=no\n`, s));
});

test("archive allows only unique regular metadata and this round's result tree, no links/traversal/foreign data", () => {
  const good = ["run.log", "exit-code", "repo/bench/catalog/results/c2/", "repo/bench/catalog/results/c2/summary.json"];
  const verbose = ["-rw file", "-rw file", "drw dir", "-rw file"].join("\n");
  safeArchive(good.join("\n"), verbose, "c2");
  for (const bad of ["../x", "/x", "C:/x", "x\\y", "repo/bench/catalog/results/c1/x", "repo/bench/marketplace/results/r20/x",
    "repo/bench/catalog/results/c2/../x", "repo/bench/catalog/results/c2/./x", "repo/bench/catalog/results/c2//x", "repo/bench/catalog/results/c2/a b", "run.log",
    "repo/bench/catalog/results/c2/NUL", "repo/bench/catalog/results/c2/con.json", "repo/bench/catalog/results/c2/file.", "repo/bench/catalog/results/c2/SUMMARY.JSON"])
    assert.throws(() => safeArchive([...good, bad].join("\n"), `${verbose}\n-rw file`, "c2"));
  for (const type of ["l", "h", "b", "c", "p", "s"]) assert.throws(() => safeArchive(good.join("\n"), verbose.replace("-rw file", `${type}rw file`), "c2"));
  assert.throws(() => safeArchive(good.join("\n"), `${verbose}\n-rw file`, "c2"));
  assert.throws(() => safeArchive("run.log", "-rw file", "c2"));
});

test("remote script pins SHA, current defaults/group and all gates; unit is detached/bounded with no reboot restart", () => {
  const s = state(), files = remoteFiles(s), job = files["job.sh"], service = files[s.unit];
  assert.ok(job.includes(`git checkout --detach ${commit}`));
  assert.match(job, /node bench\/catalog\/run.mjs c2 --build --group catalog-page\n/);
  assert.match(job, /report.mjs .*--commit [a-f0-9]{40} --require-complete/);
  assert.match(job, /CATALOG_APP_CPUS=1 CATALOG_API_CPUS=2-3 CATALOG_LOAD_CPUS=4-7/);
  assert.match(job, /unset BENCH_APPS BENCH_TIER PROFILE/);
  assert.match(job, /test "\$\(nproc\)" -ge 8/);
  assert.doesNotMatch(job, /--apps|--check-only|--passes|--duration|--warmup|--rate|marketplace\/run|fullstack\/run|catalog\/results\/c1/);
  assert.match(service, /Restart=no\nRuntimeMaxSec=36h/); assert.doesNotMatch(service, /\[Install\]/);
  assert.match(files["pack.sh"], /repo\/bench\/catalog\/results\/c2/);
  assert.match(job, /trap finish EXIT/);
});

const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
test("generated shell files pass bash syntax validation without running provisioning", { skip: process.platform === "win32" && !existsSync(bash) }, () => {
  for (const [name, input] of Object.entries(remoteFiles(state())).filter(([name]) => name.endsWith(".sh"))) {
    const r = spawnSync(bash, ["-n"], { input, encoding: "utf8" }); assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  }
});
test("generated systemd unit passes native syntax validation", { skip: process.platform !== "linux" }, (t) => {
  const temp = mkdtempSync(join(tmpdir(), "catalog-host-syntax-")); t.after(() => rmSync(temp, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(remoteFiles(state())).filter(([name]) => name.endsWith(".service"))) {
    const path = join(temp, name); writeFileSync(path, content);
    const r = spawnSync("systemd-analyze", ["verify", path], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
});
