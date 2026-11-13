import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { quote, shellTransport } from "./cloud-transport.mjs";

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

test("spawn throws, timeouts, signal exits and output overflows never masquerade as success", () => {
  for (const result of [null, { status: 0, signal: "SIGTERM" }, { status: null, error: { code: "ETIMEDOUT" } }, { status: null, error: { code: "ENOBUFS" } }, { status: 1 }]) {
    let calls = 0; const run = shellTransport({ repo: resolve("."), spawn: () => { calls++; if (!result) throw new Error("synthetic-private-value"); return { ...result, stderr: "synthetic-private-value" }; } });
    assert.throws(() => run("doctl", []), (e) => !e.message.includes("synthetic-private-value")); assert.equal(calls, 1);
    const allowed = run("ssh", ["root@192.0.2.10", "true"], 30000, true);
    assert.notEqual(allowed.status, 0); assert.ok(allowed.error); assert.equal(allowed.stderr, ""); assert.equal(calls, 2);
  }
});

test("existing provider token is inherited only by doctl, never SSH or Git", () => {
  const previous = process.env.DIGITALOCEAN_ACCESS_TOKEN, envs = [];
  process.env.DIGITALOCEAN_ACCESS_TOKEN = "synthetic-token-not-a-credential";
  try {
    const run = shellTransport({ repo: resolve("."), spawn: (_binary, _args, options) => { envs.push(options.env); return { status: 0 }; } });
    run("doctl", []); run("git", ["rev-parse", "HEAD"]); run("ssh", ["root@192.0.2.10", "true"]);
    assert.equal(envs[0].DIGITALOCEAN_ACCESS_TOKEN, "synthetic-token-not-a-credential");
    assert.equal(envs[1].DIGITALOCEAN_ACCESS_TOKEN, undefined); assert.equal(envs[2].DIGITALOCEAN_ACCESS_TOKEN, undefined);
  } finally {
    if (previous === undefined) delete process.env.DIGITALOCEAN_ACCESS_TOKEN;
    else process.env.DIGITALOCEAN_ACCESS_TOKEN = previous;
  }
});
