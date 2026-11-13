import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { commit, harness } from "./cloud-fixtures.mjs";
import { controllerPaths, nativePaths, parseProductionArgs, productionMain } from "./cloud-production.mjs";

function productionHarness(t, flags = {}) {
  const h = harness(t, flags), calls = [], stdout = [];
  const spawn = (binary, argv, options) => {
    calls.push([binary, argv, options]);
    if (binary === "git") {
      if (argv[0] === "show") {
        const path = argv[1].slice(41);
        return { status: 0, stdout: flags.wrongSource ? "wrong" : readFileSync(resolve(path), "utf8").replaceAll("\r\n", "\n") };
      }
      if (argv[0] === "cat-file" && flags.missingNative) return { status: 1, stderr: "private" };
      if (argv[0] === "merge-base" && flags.unmerged) return { status: 1, stderr: "private" };
      if (argv[0] === "fetch" && flags.fetchError) return { status: 1, stderr: "private" };
      if (argv[0] === "fetch" && flags.afterFetch) flags.afterFetch();
      if (argv[0] === "status" && flags.dirty) return { status: 0, stdout: " M private-file" };
      return h.run(binary, argv, options.timeout);
    }
    const args = [...argv];
    if (binary === "doctl") args.splice(args.indexOf("--http-retry-max"));
    if (binary === "ssh") args[args.length - 1] = options.input.replace(/^set -euo pipefail\n/, "").replace(/\n$/, "");
    if (flags.uploadHashError && binary === "ssh" && args.at(-1).includes("sha256sum --check")) return { status: 1, stderr: "private" };
    return h.run(binary, args, options.timeout);
  };
  const deps = { spawn, repo: h.repo, inspect: async () => h.report(), sleep: async () => {}, interrupted: () => flags.cancelled, write: (v) => stdout.push(JSON.parse(v)) };
  const args = (mode = "--collect") => ["r21", "--state-dir", h.base, mode, ...(mode === "--detach" ? ["--commit", commit, "--ssh-key", "42"] : [])];
  async function approve(mode) { const values = args(mode); await productionMain([...values, "--print-approval"], deps); return [...values, "--approve-reviewed-merged-ready", stdout.at(-1).approvalSha256]; }
  return { h, calls, stdout, deps, args, approve };
}

test("preview is local/read-only, missing isolated integration is explicit and cannot allocate", async (t) => {
  const p = productionHarness(t, { missingNative: true });
  assert.equal(await productionMain([...p.args("--detach"), "--print-approval"], p.deps), 2);
  assert.deepEqual(p.stdout[0].missing, nativePaths); assert.equal(p.stdout[0].fullGroupQualified, false);
  assert.ok(p.calls.every(([b, a]) => b === "git" && a[0] !== "fetch")); assert.ok(!existsSync(p.h.local));
  await assert.rejects(productionMain(await p.approve("--detach"), p.deps), /integration missing/); assert.equal(p.h.creates, 0);
});

test("state aliases with resolved SSH expansion characters refuse preview and approved launch before provider access", async (t) => {
  for (const approved of [false, true]) {
    for (const nested of [false, true]) {
      const p = productionHarness(t);
      const values = p.args("--detach");
      if (nested) values[values.indexOf("--state-dir") + 1] = join(p.h.base, "new", "state");
      await productionMain([...values, "--print-approval"], p.deps);
      const args = approved ? [...values, "--approve-reviewed-merged-ready", p.stdout.at(-1).approvalSha256] : [...values, "--print-approval"];
      const target = `${p.h.base}$physical`;
      renameSync(p.h.base, target); symlinkSync(target, p.h.base, process.platform === "win32" ? "junction" : "dir");
      p.calls.length = 0; p.stdout.length = 0;
      await assert.rejects(productionMain(args, p.deps), /SSH config expansion/);
      assert.equal(p.h.creates, 0); assert.equal(p.h.deletes, 0);
      assert.deepEqual(p.calls, []); assert.deepEqual(p.stdout, []); assert.ok(!existsSync(p.h.local));
      if (nested) assert.ok(!existsSync(join(target, "new")));
    }
  }
});

test("ordinary state alias preserves preview and approved composed launch", async (t) => {
  const p = productionHarness(t, { active: true }), target = `${p.h.base} ordinary 'physical'`;
  renameSync(p.h.base, target); symlinkSync(target, p.h.base, process.platform === "win32" ? "junction" : "dir");
  const approval = await p.approve("--detach");
  assert.ok(!existsSync(p.h.local));
  assert.equal(await productionMain(approval, p.deps), 3);
  assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0); assert.equal(p.h.saved().status, "running");
  assert.equal(p.calls.filter(([b, , o]) => b === "ssh" && o.input.includes("systemctl start")).length, 1);
});

test("missing or inaccessible physical roots reject before child timeout and any process call", (t) => {
  for (const code of ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"]) {
    const h = harness(t);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("cloud-path-fixture.mjs", import.meta.url)), code, h.temp],
      { encoding: "utf8", windowsHide: true, timeout: 5000 });
    assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { code, calls: 0, bounded: true });
  }
});

test("nonexistent Windows drive rejects before child timeout", { skip: process.platform !== "win32" }, (t) => {
  const drive = [..."ZYXWVUTSRQPONMLKJIHGFED"].find((letter) => !existsSync(`${letter}:\\`));
  if (!drive) { t.skip("no missing local drive available"); return; }
  const h = harness(t);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("cloud-path-fixture.mjs", import.meta.url)), "windows", h.temp, `${drive}:\\state`],
    { encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { code: "windows", calls: 0, bounded: true });
});

test("normal new state directories preview without writes and create a bounded core root", async (t) => {
  const p = productionHarness(t), stateDir = join(p.h.base, "new", "state"), values = p.args("--detach");
  values[values.indexOf("--state-dir") + 1] = stateDir;
  assert.equal(await productionMain([...values, "--print-approval"], p.deps), 3);
  assert.ok(!existsSync(join(p.h.base, "new"))); assert.ok(p.calls.every(([b]) => b === "git"));
  const { controller } = await import("./droplet.mjs");
  controller({ round: "r21", stateDir, detach: true, commit, sshKey: "42" }, { repo: p.h.repo, run() { assert.fail("unexpected process"); } });
  assert.ok(existsSync(stateDir)); assert.ok(!existsSync(join(stateDir, "groups-r21"))); assert.equal(p.h.creates, 0);
});

test("no/mismatched approval, dirty/mismatched source, unmerged head and fetch failure make no cloud calls", async (t) => {
  for (const flags of [{}, { dirty: true }, { wrongSource: true }, { unmerged: true }, { fetchError: true }]) {
    const p = productionHarness(t, flags);
    await assert.rejects(productionMain(p.args("--detach"), p.deps));
    if (!flags.dirty && !flags.wrongSource) {
      await assert.rejects(productionMain([...p.args("--detach"), "--approve-reviewed-merged-ready", "f".repeat(64)], p.deps));
      if (flags.unmerged || flags.fetchError) await assert.rejects(productionMain(await p.approve("--detach"), p.deps));
    }
    assert.ok(p.calls.every(([binary]) => binary === "git")); assert.ok(!existsSync(p.h.local));
  }
});

test("approved composed transport provisions fixed files and starts exactly once", async (t) => {
  const p = productionHarness(t, { active: true, createLost: true }), approval = await p.approve("--detach");
  assert.equal(await productionMain(approval, p.deps), 3); assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
  assert.equal(p.calls.filter(([b, , o]) => b === "ssh" && o.input.includes("systemctl start")).length, 1);
  assert.equal(p.calls.filter(([b, , o]) => b === "ssh" && o.input.includes("sha256sum --check")).length, 3);
  assert.equal(p.h.saved().fullGroupQualified, false);
  assert.ok(readFileSync(join(p.h.local, "job.sh"), "utf8").includes("git merge-base --is-ancestor"));
  await assert.rejects(productionMain(approval, p.deps), /reserved/); assert.equal(p.h.creates, 1);
});

test("failed upload verification never starts or deletes the owned host", async (t) => {
  const p = productionHarness(t, { uploadHashError: true });
  await assert.rejects(productionMain(await p.approve("--detach"), p.deps));
  assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
  assert.ok(!p.calls.some(([b, , o]) => b === "ssh" && o.input.includes("systemctl start")));
  assert.ok(existsSync(join(p.h.local, "job.sh"))); assert.equal(p.h.saved().status, "preparing");
});

test("approved running collect observes once; terminal blocked collect retains evidence before one delete", async (t) => {
  for (const active of [true, false]) {
    const p = productionHarness(t, { active }); p.h.seed();
    assert.equal(await productionMain(await p.approve(), p.deps), active ? 3 : 1);
    assert.equal(p.h.deletes, active ? 0 : 1); assert.equal(p.h.saved().fullGroupQualified, false);
    if (active) assert.equal(p.h.units, 1);
    else { assert.ok(p.h.saved().destroyedAt); assert.ok(existsSync(join(p.h.local, "results.tgz"))); }
  }
});

test("approval binds saved identity and detects state changes during merge verification", async (t) => {
  const flags = {}, p = productionHarness(t, flags); p.h.seed(); const approval = await p.approve();
  flags.afterFetch = () => p.h.change((s) => { s.token = "f".repeat(16); });
  await assert.rejects(productionMain(approval, p.deps)); assert.ok(p.calls.every(([binary]) => binary === "git")); assert.equal(p.h.deletes, 0);
});

test("production deletion uncertainty is retained and a new approved collection never repeats delete", async (t) => {
  for (const deleteLost of [true, false]) {
    const p = productionHarness(t, deleteLost ? { deleteLost: true } : { deleteUnconfirmed: true }); p.h.seed();
    await assert.rejects(productionMain(await p.approve(), p.deps));
    assert.equal(p.h.deletes, 1); assert.ok(p.h.saved().deletionIntentAt); assert.ok(!p.h.saved().destroyedAt);
    assert.ok(existsSync(join(p.h.local, "results.tgz")));
    if (deleteLost) assert.equal(await productionMain(await p.approve(), p.deps), 1);
    else await assert.rejects(productionMain(await p.approve(), p.deps), /uncertain/);
    assert.equal(p.h.deletes, 1);
  }
});

test("production foreign identity and cancellation before provider access preserve resources", async (t) => {
  const p = productionHarness(t); p.h.seed(); p.h.hosts([]);
  await assert.rejects(productionMain(await p.approve(), p.deps)); assert.equal(p.h.deletes, 0);
  assert.ok(p.calls.every(([binary]) => !["ssh", "scp"].includes(binary)));
  const flags = {}, cancelled = productionHarness(t, flags); const approval = await cancelled.approve("--detach"); flags.cancelled = true;
  await assert.rejects(productionMain(approval, cancelled.deps)); assert.equal(cancelled.h.creates, 0); assert.ok(!existsSync(cancelled.h.local));
});

test("production grammar permits authorization only, never arbitrary settings/adapters", () => {
  assert.equal(controllerPaths.length, 10);
  const args = ["r21", "--collect", "--state-dir", resolve("outside")];
  for (const suffix of [["--adapter", "evil"], ["--duration", "1"], ["--print-approval", "--print-approval"], ["--approve-reviewed-merged-ready", "not-a-hash"]])
    assert.throws(() => parseProductionArgs([...args, ...suffix]));
});

test("current saved-verifier checkout requirement fails before any provider access", async (t) => {
  const p = productionHarness(t); p.h.seed(); p.h.change((s) => { s.commit = "b".repeat(40); });
  await assert.rejects(productionMain([...p.args(), "--print-approval"], p.deps), /measured integrated checkout/);
  assert.ok(p.calls.every(([binary]) => binary === "git")); assert.equal(p.h.deletes, 0);
});
