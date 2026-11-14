import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { remoteFiles, reservation, supervisorBootstrap } from "./cloud-contract.mjs";

const state = reservation({ round: "r21", commit: "a".repeat(40), token: "0123456789abcdef" });
test("bootstrap prepares upstream stable Git and proves required immutable-query flags before clone", () => {
  const job = remoteFiles(state)["job.sh"], clone = job.indexOf("git clone");
  const ppa = job.indexOf("add-apt-repository --yes ppa:git-core/ppa");
  const capability = job.indexOf("git --no-replace-objects --no-lazy-fetch --version");
  assert.ok(ppa >= 0 && capability > ppa && clone > capability);
  assert.match(job.slice(ppa, capability), /apt-get update -qq[\s\S]*apt-get install -y -qq git/);
  assert.match(job.slice(0, ppa), /apt-get install -y -qq[^\n]*software-properties-common/);
  assert.match(job, /git --no-replace-objects --no-lazy-fetch --version >> \/bench\/host\.txt/);
  assert.match(execFileSync("git", ["--no-replace-objects", "--no-lazy-fetch", "--version"],
    { encoding: "utf8", windowsHide: true, timeout: 10000, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" } }), /^git version /);
});
test("bootstrap prepares the actual client dependency roots and Node 26 before the fixed entry", () => {
  const job = remoteFiles(state)["job.sh"];
  assert.match(job, /nodesource.com\/setup_26\.x/);
  const root = job.indexOf("npm ci --no-audit --no-fund");
  const browser = job.indexOf("npm --prefix bench/browser ci --no-audit --no-fund");
  const entry = job.indexOf("node bench/workloads/isolated/campaign-entry.mjs");
  assert.ok(root >= 0 && browser > root && entry > browser);
  assert.ok(job.includes("node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1"));
  assert.ok(!job.includes("setup_24.x"));
  assert.ok(job.includes('node -e \'if (process.versions.node.split(".")[0] !== "26") process.exit(1)\''));
  const native = readFileSync(new URL("../fullstack-browser/run.mjs", import.meta.url), "utf8");
  const image = native.match(/node:26\.[0-9.]+-bookworm-slim@sha256:[a-f0-9]{64}/)?.[0];
  assert.ok(image && job.includes(`docker pull ${image}`), "fresh host prepares the current native upstream image");
});

test("owned service delegates accounting and establishes its supervisor before provisioning", () => {
  const files = remoteFiles(state), job = files["job.sh"], unit = files[state.unit];
  assert.match(unit, /Delegate=cpu cpuset memory pids\n/);
  assert.match(unit, /DelegateSubgroup=supervisor\n/);
  assert.ok(job.indexOf("cgroup.subtree_control") < job.indexOf("cloud-init status"));
  assert.ok(job.includes("/sys/fs/cgroup"));
  assert.match(unit, /Restart=no\n/);
  assert.ok(job.includes(supervisorBootstrap(state.unit)));
  assert.ok(!/CPUQuota|MemoryMax|AllowedCPUs|cpuset.cpus=|cpu.max=|memory.max=/.test(unit));
});

test("supervisor bootstrap cannot name a foreign unit or accept shell/path syntax", () => {
  for (const unit of ["other.service", state.unit + "\n", state.unit + ";true", "../" + state.unit,
    state.unit.replace("r21", "r021"), state.unit.replace("0123456789abcdef", "x"), state.unit + "/supervisor"])
    assert.throws(() => supervisorBootstrap(unit));
  const script = supervisorBootstrap(state.unit);
  assert.ok(script.includes('mkdir "$parent/supervisor"'));
  assert.ok(!script.includes("mkdir -p") && !script.includes("rm "));
  assert.ok(script.includes('test "$member" = "$$"'));
});

for (const file of ["campaign.mjs", "worker.mjs"]) test(`${file} retains only fixed Cargo and system executable directories`, () => {
  const source = readFileSync(new URL(`isolated/${file}`, import.meta.url), "utf8");
  assert.ok(source.includes('PATH: "/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"'));
  assert.ok(!source.includes("PATH: process.env.PATH"));
});
