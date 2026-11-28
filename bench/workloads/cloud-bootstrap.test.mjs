import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fleetPlan, remoteFiles, reservation, supervisorBootstrap, upstreamImages } from "./cloud-contract.mjs";
import { controllerState } from "./cloud-options.mjs";
import { remoteFiles as uploadedFiles } from "./cloud-remote.mjs";
import { groupNames } from "./registry.mjs";

const state = reservation({ round: "r21", commit: "a".repeat(40), token: "0123456789abcdef" });
test("bootstrap prepares upstream stable Git and proves required immutable-query flags before clone", () => {
  const job = remoteFiles(state)["job.sh"], clone = job.indexOf("git clone");
  const ppa = job.indexOf("install -d -m 0755 /etc/apt/keyrings");
  const capability = job.indexOf("git --no-replace-objects --no-lazy-fetch --version");
  assert.ok(ppa >= 0 && capability > ppa && clone > capability);
  assert.match(job.slice(ppa, capability), /apt-get update -qq[\s\S]*apt-get install -y -qq git/);
  assert.match(job.slice(0, ppa), /apt-get install -y -qq[^\n]*gnupg/);
  assert.match(job.slice(ppa, capability), /signed-by=\/etc\/apt\/keyrings\/corten-git-ppa.asc/);
  assert.match(job.slice(ppa, capability), /test .* = F911AB184317630C59970973E363C90F8F1B6217/);
  assert.ok(!job.includes("timeout 900 add-apt-repository"));
  assert.match(job, /git --no-replace-objects --no-lazy-fetch --version >> \/bench\/host\.txt/);
  assert.match(execFileSync("git", ["--no-replace-objects", "--no-lazy-fetch", "--version"],
    { encoding: "utf8", windowsHide: true, timeout: 10000, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" } }), /^git version /);
});
test("bootstrap prepares the actual client dependency roots and Node 26 before the fixed entry", () => {
  // A launch records the bench package; states saved before it keep their uploaded bytes.
  const job = remoteFiles({ ...state, benchPackage: true })["job.sh"];
  assert.ok(!remoteFiles(state)["job.sh"].includes("npm --prefix bench ci"));
  assert.match(job, /nodesource.com\/setup_26\.x/);
  const root = job.indexOf("npm ci --no-audit --no-fund");
  // The harness's classic compiler is the bench package's, not the root's.
  const bench = job.indexOf("npm --prefix bench ci --no-audit --no-fund");
  const browser = job.indexOf("npm --prefix bench/browser ci --no-audit --no-fund");
  const entry = job.indexOf("node bench/workloads/isolated/campaign-entry.mjs");
  assert.ok(root >= 0 && bench > root && browser > bench && entry > browser);
  assert.ok(job.includes("\ntimeout 900 docker pull node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1\n"));
  assert.ok(!job.includes("setup_24.x"));
  assert.ok(job.includes('node -e \'if (process.versions.node.split(".")[0] !== "26") process.exit(1)\''));
});

test("new dedicated jobs omit the host Chromium install only when their workload does not need it", () => {
  const createdAt = "2026-11-26T00:00:00.000Z";
  const savedGroup = (group) => {
    const provider = { accountId: "user:account", context: "context" };
    const { round, commit } = state, token = "a123456789abcdef";
    const fleet = fleetPlan({ round, commit, token: state.token, tokens: { [group]: token }, provider, sshKey: "1" },
      createdAt, undefined, { stagedPlacement: true, single: { group, indexSha256: "0".repeat(64), checkout: "/local/controller" } });
    return { ...reservation({ round, commit, token, group, fleet }, createdAt), provider, fullGroupQualified: false };
  };
  const install = "bootstrap_stage=browser-install\ntimeout 900 npx --no-install playwright install --with-deps chromium\n";
  const hostBrowserGroups = ["client-heavy", "fullstack-browser", "live-delivery", "recoverable-live"];
  for (const group of groupNames) {
    const saved = savedGroup(group), before = uploadedFiles(saved), marked = { ...saved, skipHostChromium: true };
    assert.ok(before["job.sh"].includes(install), group + ": unmarked saved jobs keep the host install");
    if (hostBrowserGroups.includes(group)) {
      assert.throws(() => uploadedFiles(marked), /host Chromium skip marker/);
      continue;
    }
    const after = uploadedFiles(marked);
    assert.ok(after["job.sh"] === before["job.sh"].replace(install, ""), group + ": only the unused host install is removed");
    assert.equal(after["pack.sh"], before["pack.sh"]);
    assert.equal(after[saved.unit], before[saved.unit]);
    assert.equal(controllerState(marked, marked.round), marked);
  }
  assert.ok(uploadedFiles(state)["job.sh"].includes(install));
  assert.throws(() => uploadedFiles({ ...state, skipHostChromium: true }), /host Chromium skip marker/);
  for (const skipHostChromium of [false, "true", null])
    assert.throws(() => uploadedFiles({ ...savedGroup("hardening"), skipHostChromium }), /host Chromium skip marker/);
});

// Saved reservations without the Debian 13 marker regenerate the bytes they uploaded. These are the
// production wrapper's outputs for two unmarked shapes at be1192a7b, the commit before the marker.
const uploadedBefore = [
  [{}, { "job.sh": "fc62ed21c097fc20dc31ad78d9ab5443a3d22e7dcfa488e585891f8fcdc4a87f" }],
  [{ benchPackage: true, gitSource: true }, { "job.sh": "3424e7b180d59a488d39ee0d630df04036f1951de5eb30d63c6032336ad8770f" }],
];
const uploadedPack = "7c7f461a02557b1670385ab0f0c0632ca7f8e2738797a3d7c77673b8218be041";
const uploadedUnit = "a711ea9c145f36721052581abb489ca389a54c55f601e902aa7351d821d0fc8a";
test("a new reservation pulls the native Debian 13 upstream image; a saved one keeps its Debian 12 bytes", () => {
  const saved = reservation({ round: "r21", commit: "a".repeat(40), token: "0123456789abcdef" }, "2026-11-01T00:00:00.000Z");
  const sha256 = (text) => createHash("sha256").update(text).digest("hex");
  const native = readFileSync(new URL("../fullstack-browser/run.mjs", import.meta.url), "utf8");
  const image = native.match(/node:26\.[0-9.]+-[a-z]+-slim@sha256:[a-f0-9]{64}/)?.[0];
  assert.equal(image, upstreamImages.trixie, "native browser runner uses the Debian 13 image");
  for (const [markers, before] of uploadedBefore) {
    const legacy = uploadedFiles({ ...saved, ...markers }), marked = uploadedFiles({ ...saved, ...markers, trixieUpstream: true });
    assert.deepEqual(Object.fromEntries(Object.entries(legacy).map(([name, text]) => [name, sha256(text)])),
      { ...before, "pack.sh": uploadedPack, [saved.unit]: uploadedUnit }, "an unmarked reservation regenerates its uploaded bytes");
    // Marked, only the Docker pull line differs; the packer and unit are the same bytes.
    const was = legacy["job.sh"].split("\n"), is = marked["job.sh"].split("\n");
    const changed = was.flatMap((line, index) => line === is[index] ? [] : [[line, is[index]]]);
    assert.equal(is.length, was.length);
    assert.deepEqual(changed, [[`timeout 900 docker pull ${upstreamImages.bookworm}`, `timeout 900 docker pull ${image}`]]);
    for (const file of ["pack.sh", saved.unit]) assert.equal(marked[file], legacy[file]);
  }
  for (const trixieUpstream of [false, null, "true", 1])
    assert.throws(() => uploadedFiles({ ...saved, trixieUpstream }), /Debian 13 upstream image marker/);
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
