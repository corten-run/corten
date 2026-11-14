import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { controlEnvironment, quote, shellTransport } from "./cloud-transport.mjs";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { harness } from "./cloud-fixtures.mjs";

test("production shell boundary uses argv, fixed provider endpoint, no HTTP retry or raw errors", () => {
  const calls = [], run = shellTransport({ repo: resolve("."), spawn: (...args) => { calls.push(args); return { status: 0, stdout: "[]", stderr: "synthetic-private-value" }; } });
  const result = run("doctl", ["compute", "droplet", "create", "fixed-name"], 600000);
  const [binary, args, options] = calls[0]; assert.equal(binary, "doctl"); assert.equal(options.shell, false);
  assert.equal(args[args.indexOf("--http-retry-max") + 1], "0"); assert.ok(args.includes("https://api.digitalocean.com"));
  assert.ok(args.includes("--trace=false")); assert.equal(options.timeout, 600000); assert.equal(options.maxBuffer, 16 * 1024 ** 2);
  assert.equal(options.killSignal, "SIGKILL");
  assert.equal(result.stderr, ""); assert.ok(!JSON.stringify(result).includes("synthetic-private-value"));
  assert.ok(!Object.keys(options.env).some((key) => /^BENCH_|^CATALOG_|^PROFILE$/.test(key)));
  assert.throws(() => run("powershell", [])); assert.throws(() => run("doctl", [], 0)); assert.throws(() => run("doctl", [], 900001));
});

test("SSH sends literal scripts over stdin, isolates config, and quotes known_hosts paths", () => {
  let call; const run = shellTransport({ repo: resolve("."), spawn: (...args) => { call = args; return { status: 0, stdout: "ok" }; } });
  const path = resolve("state with 'apostrophe'", "known_hosts").replaceAll("\\", "/"), script = `printf '%s' 'a;$(false)'`;
  run("ssh", ["-o", `UserKnownHostsFile=${path}`, "root@192.0.2.10", script]);
  assert.equal(call[1].at(-1), "/bin/bash -s"); assert.equal(call[2].input, `set -euo pipefail\n${script}\n`);
  assert.ok(call[1].includes(`UserKnownHostsFile="${path}"`)); assert.ok(call[1].includes("ForwardAgent=no"));
  assert.deepEqual(call[1].slice(0, 2), ["-F", "none"]); assert.equal(call[2].stdio[0], "pipe");
  assert.throws(() => run("ssh", ["-o", "UserKnownHostsFile=/tmp/${HOME}", "root@192.0.2.10", "true"]));
  assert.equal(quote("a'b"), "'a'\\''b'");
});

test("SCP stays in batch SFTP mode with one remote and one absolute local endpoint", () => {
  const calls = [], run = shellTransport({ repo: resolve("."), spawn: (...args) => { calls.push(args); return { status: 0 }; } });
  const path = resolve("local ' file");
  for (const pair of [[path, "root@192.0.2.10:/bench/job.sh"], ["root@192.0.2.10:/bench/results.tgz", path]]) run("scp", ["-q", ...pair]);
  for (const call of calls) { assert.ok(call[1].includes("-B")); assert.ok(!call[1].includes("-O")); assert.ok(call[1].includes(path)); }
  assert.throws(() => run("scp", ["relative", "root@192.0.2.10:/bench/job.sh"]));
});

test("unsettled control process retains both lifecycle locks and forbids retries", async (t) => {
  for (const result of [null, { status: null, error: { code: "ETIMEDOUT" } }, { status: null, error: { code: "ENOBUFS" } }, { status: 0, signal: "SIGTERM" }]) {
    const h = harness(t), run = shellTransport({ repo: h.repo, spawn: () => { if (!result) throw new Error("synthetic spawn failure"); return result; } });
    await assert.rejects(h.launch({ run: (binary, ...args) => binary === "git" ? h.run(binary, ...args) : run(binary, ...args) }).launch(),
      (error) => error.controlTreeUncertain === true);
    assert.ok(existsSync(join(h.local, "operation.lock"))); assert.ok(existsSync(join(h.base, ".groups-launch.lock")));
    await assert.rejects(h.task().collect()); await assert.rejects(h.launch().launch());
    assert.equal(h.creates, 0); assert.equal(h.deletes, 0);
  }
});

test("real timed-out Linux child cannot release locks while its descendant can still write", { skip: process.platform !== "linux", timeout: 10000 }, async (t) => {
  const h = harness(t), ready = join(h.temp, "descendant-ready"), late = join(h.temp, "descendant-write");
  let spawned = false;
  const run = shellTransport({ repo: h.repo, spawn: (_binary, _argv, options) => {
    spawned = true;
    return spawnSync(process.execPath, ["-e", `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      spawn(process.execPath, ['-e', 'setTimeout(() => { require("node:fs").writeFileSync(process.argv[1], "synthetic descendant"); }, 1800)', ${JSON.stringify(late)}], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(ready)}, 'synthetic parent');
      setInterval(() => {}, 1000);
    `], { ...options, timeout: 1000 });
  } });
  try {
    await assert.rejects(h.launch({ run: (binary, ...args) => binary === "git" ? h.run(binary, ...args) : run(binary, ...args) }).launch(),
      (error) => error.controlTreeUncertain === true);
    assert.ok(existsSync(ready), "parent ran before the timeout");
    assert.ok(existsSync(join(h.local, "operation.lock"))); assert.ok(existsSync(join(h.base, ".groups-launch.lock")));
    await assert.rejects(h.task().collect()); await assert.rejects(h.launch().launch());
  } finally {
    // The synthetic descendant exits on its own; leave no test process behind.
    if (spawned) for (let i = 0; i < 60 && !existsSync(late); i++) await delay(50);
  }
  assert.equal(readFileSync(late, "utf8"), "synthetic descendant");
  assert.ok(existsSync(join(h.local, "operation.lock"))); assert.equal(h.creates, 0); assert.equal(h.deletes, 0);
});

test("spawn throws, timeouts, signal exits and output overflows never masquerade as success", () => {
  for (const result of [null, { status: 0, signal: "SIGTERM" }, { status: null, error: { code: "ETIMEDOUT" } }, { status: null, error: { code: "ENOBUFS" } }, { status: 1 }]) {
    let calls = 0; const run = shellTransport({ repo: resolve("."), spawn: () => { calls++; if (!result) throw new Error("synthetic-private-value"); return { ...result, stderr: "synthetic-private-value" }; } });
    assert.throws(() => run("doctl", []), (e) => !e.message.includes("synthetic-private-value")); assert.equal(calls, 1);
    if (result?.status === 1) {
      const allowed = run("ssh", ["root@192.0.2.10", "true"], 30000, true);
      assert.notEqual(allowed.status, 0); assert.ok(allowed.error); assert.equal(allowed.stderr, "");
    } else assert.throws(() => run("ssh", ["root@192.0.2.10", "true"], 30000, true), (error) => error.controlTreeUncertain === true);
    assert.equal(calls, 2);
  }
});

test("control children never inherit a provider token override", () => {
  const envs = [];
  const run = shellTransport({ repo: resolve("."), spawn: (_binary, _args, options) => { envs.push(options.env); return { status: 0 }; } });
  run("doctl", []); run("git", ["rev-parse", "HEAD"]); run("ssh", ["root@192.0.2.10", "true"]);
  assert.equal(envs[0].DIGITALOCEAN_ACCESS_TOKEN, undefined);
  assert.equal(envs[1].DIGITALOCEAN_ACCESS_TOKEN, undefined); assert.equal(envs[2].DIGITALOCEAN_ACCESS_TOKEN, undefined);
});

test("control environment locations are frozen for the lifetime of a transport", () => {
  const previous = process.env.HOME, envs = [];
  const run = shellTransport({ repo: resolve("."), spawn: (_binary, _args, options) => { envs.push(options.env); return { status: 0 }; } });
  try {
    process.env.HOME = resolve("synthetic-changed-home"); run("doctl", []); run("doctl", []);
    assert.ok(envs.every((env) => env.HOME === previous));
  } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; }
});

test("SSH/SCP alone capture ProgramData without widening other control environments", () => {
  const keys = ["ProgramData", "SSH_AUTH_SOCK", "DIGITALOCEAN_ACCESS_TOKEN", "NODE_OPTIONS", "UNLISTED_CLOUD_TEST"];
  const previous = new Map(keys.map((key) => [key, process.env[key]])), calls = [];
  try {
    for (const key of keys) process.env[key] = `synthetic-${key}`;
    const expected = new Map(["git", "doctl"].map((binary) => [binary, controlEnvironment(binary)]));
    const run = shellTransport({ repo: resolve("."), spawn: (binary, _args, options) => {
      calls.push({ binary, env: options.env }); return { status: 0 };
    } });
    process.env.ProgramData = "synthetic-changed-ProgramData";
    process.env.SSH_AUTH_SOCK = "synthetic-changed-SSH_AUTH_SOCK";
    for (let i = 0; i < 2; i++) {
      run("git", ["rev-parse", "HEAD"]); run("doctl", []);
      run("ssh", ["root@192.0.2.10", "true"]);
      run("scp", [resolve("synthetic-file"), "root@192.0.2.10:/bench/job.sh"]);
    }
    for (const { binary, env } of calls) {
      if (binary === "git" || binary === "doctl") {
        assert.equal(env.ProgramData, undefined); assert.equal(env.SSH_AUTH_SOCK, undefined);
        assert.deepEqual(env, expected.get(binary));
      } else {
        assert.equal(env.ProgramData, "synthetic-ProgramData"); assert.equal(env.SSH_AUTH_SOCK, "synthetic-SSH_AUTH_SOCK");
        assert.deepEqual(Object.keys(env).sort(), [...Object.keys(expected.get("git")), "ProgramData", "SSH_AUTH_SOCK"].sort());
      }
      for (const key of keys.slice(2)) assert.equal(env[key], undefined);
    }
  } finally {
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("installed Windows OpenSSH consumes the sanitized environment without a connection", { skip: process.platform !== "win32" }, (t) => {
  const executable = join(process.env.SystemRoot, "System32", "OpenSSH", "ssh.exe");
  if (!existsSync(executable)) { t.skip("Windows OpenSSH is not installed"); return; }
  const env = controlEnvironment("ssh");
  assert.ok(process.env.ProgramData, "Windows ProgramData source path required");
  const result = spawnSync(executable, ["-G", "-F", "none", "127.0.0.1"], {
    cwd: resolve("."), env, shell: false, windowsHide: true, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], timeout: 10000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0);
  assert.equal(env.ProgramData, process.env.ProgramData, "use the captured system path, not a fallback");
  assert.match(result.stdout, /^hostname 127\.0\.0\.1\r?$/m);
  assert.match(result.stdout, /^globalknownhostsfile /m);
});
