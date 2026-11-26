import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fleetPlan, remoteFiles as originalFiles, reservation } from "./cloud-contract.mjs";
import { bootstrapMarker, bootstrapReadScript, remoteFiles, sourceUrl } from "./cloud-remote.mjs";
import { archiveLimit, archiveMembers, expandedLimit, fileHash } from "./cloud-local.mjs";
import { groupNames } from "./registry.mjs";
import { fixtureGitEnv } from "../../scripts/fixture-git.mjs";

const commit = "a".repeat(40);
const sourceSetup = (job) => {
  const start = job.indexOf("export GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1\n"), end = job.indexOf('test "$(nproc)"');
  assert.ok(start >= 0 && end > start); return job.slice(start, end);
};

test("production files preserve fixed unit/packages/all-nine entry and require merged exact remote source", () => {
  const state = reservation({ round: "r21", commit, token: "0123456789abcdef" }), original = originalFiles(state), files = remoteFiles(state);
  assert.deepEqual(Object.keys(files), ["job.sh", "pack.sh", state.unit]); assert.equal(files[state.unit], original[state.unit]);
  const job = files["job.sh"];
  assert.ok(job.includes(`clone --quiet --no-checkout '${sourceUrl}' '/bench/repo'`));
  assert.ok(job.includes(`test "$(git config --get remote.origin.url)" = '${sourceUrl}'`));
  assert.ok(job.includes(`git merge-base --is-ancestor '${commit}' 'origin/main'`));
  assert.ok(job.includes(`git -c core.autocrlf=false checkout --detach '${commit}'`));
  assert.ok(job.includes(`source-commit=%s\\n' '${commit}'`));
  assert.ok(job.includes(`node 'bench/workloads/isolated/campaign-entry.mjs' 'r21' --commit '${commit}' --state-dir '/bench/campaign'`));
  for (const line of original["job.sh"].split("\n").filter((line) => /apt-get|playwright install|rustup|enable --now docker|finish\(\)|trap finish/.test(line))) assert.ok(job.includes(line));
  assert.ok(!/--apps|--adapter|--duration|systemctl (stop|restart|reboot)/.test(job));
  assert.match(files[state.unit], /Restart=no/); assert.match(files[state.unit], /RuntimeMaxSec=48h/);
});

test("common bootstrap marker is source-bound and produced only after tooling, before native entry", () => {
  const state = reservation({ round: "r21", commit, token: "0123456789abcdef" }), job = remoteFiles(state)["job.sh"];
  const marker = bootstrapMarker(state);
  assert.deepEqual(marker, { schema: "benchmark-common-bootstrap/v1", round: "r21", commit, token: state.token, group: "all" });
  const at = job.indexOf('writeFileSync("/bench/bootstrap-ready.json"');
  assert.ok(at > job.indexOf("cargo --version"));
  assert.ok(at < job.indexOf("node 'bench/workloads/isolated/campaign-entry.mjs'"));
  assert.ok(job.includes('flag: "wx"')); assert.ok(job.includes('mode: 0o600'));
  assert.ok(bootstrapReadScript.includes("test ! -L")); assert.ok(bootstrapReadScript.includes("-le 1024"));
});

test("terminal packer keeps existing archives and publishes new bytes without overwrite", () => {
  const state = reservation({ round: "r21", commit, token: "0123456789abcdef" }), pack = remoteFiles(state)["pack.sh"];
  assert.ok(pack.includes("test -f \"$file\" && test ! -L \"$file\""));
  assert.ok(pack.includes("if test -e 'results.tgz' || test -L 'results.tgz'"));
  assert.ok(pack.includes("mktemp '/bench/cloud-pack.XXXXXXXX'"));
  assert.ok(pack.includes('tar --format=gnu -czf "$stage" -- "${files[@]}"'));
  assert.ok(pack.includes('checkPackage("/bench")'));
  assert.ok(pack.indexOf('checkPackage("/bench")') < pack.indexOf('tar --format=gnu'));
  assert.ok(pack.includes(`-le ${archiveLimit}`));
  assert.ok(pack.includes('ln -- "$stage" \'results.tgz\'')); assert.ok(!pack.includes("mv "));
  assert.ok(pack.indexOf('tar --format=gnu') < pack.indexOf('ln --'));
  assert.throws(() => remoteFiles({ ...state, commit: `${commit};exit` }));
});

test("generated terminal packer executes GNU framing and preserves existing and oversized evidence", { skip: process.platform !== "linux" }, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cloud-pack-")));
  t.after(() => { assert.equal(dirname(root), realpathSync(tmpdir())); rmSync(root, { recursive: true }); });
  symlinkSync(resolve("."), join(root, "repo"), "dir");
  for (const [name, body] of [["run.log", "log"], ["host.txt", "host"], ["exit-code", "1\n"]]) writeFileSync(join(root, name), body);
  mkdirSync(join(root, "campaign")); const name = "x".repeat(120); writeFileSync(join(root, "campaign", name), "proof");
  const pack = remoteFiles(reservation({ round: "r21", commit, token: "0123456789abcdef" }))["pack.sh"]
    .replaceAll("'/bench", `'${root}`).replaceAll('"/bench', `"${root}`);
  const script = join(root, "pack.sh"); writeFileSync(script, pack);
  const run = () => spawnSync("bash", [script], { encoding: "utf8", timeout: 30000 });
  assert.equal(run().status, 0); const archive = join(root, "results.tgz"), sha = fileHash(archive);
  const index = await archiveMembers(archive, sha); assert.equal(index.bytes, 14);
  writeFileSync(join(root, "run.log"), "changed after packaging");
  assert.equal(run().status, 0); assert.equal(fileHash(archive), sha);
  unlinkSync(archive); const fd = openSync(join(root, "campaign", "too-large"), "wx");
  try { ftruncateSync(fd, expandedLimit + 1); } finally { closeSync(fd); }
  assert.notEqual(run().status, 0); assert.ok(!existsSync(archive));
  assert.ok(!readdirSync(root).some((name) => name.startsWith("cloud-pack.") || name.startsWith(".cloud-spool-")));
});

test("pre-entry package checks need neither Node nor a cloned repository", (t) => {
  const python = process.platform === "win32" ? "python" : "python3";
  if (spawnSync(python, ["--version"], { timeout: 3000, windowsHide: true }).status !== 0) { t.skip("Python unavailable"); return; }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cloud-setup-pack-")));
  t.after(() => { assert.equal(dirname(root), realpathSync(tmpdir())); rmSync(root, { recursive: true }); });
  const pack = remoteFiles(reservation({ round: "r21", commit, token: "0123456789abcdef" }))["pack.sh"];
  const program = pack.split("<<'CORTEN_SETUP_PACKAGE'\n")[1].split("\nCORTEN_SETUP_PACKAGE")[0]
    .replace("pathlib.Path('/bench')", "pathlib.Path(__import__('sys').argv[1])");
  const run = () => spawnSync(python, ["-c", program, root], { encoding: "utf8", timeout: 5000, windowsHide: true });
  for (const [name, body] of [["run.log", "setup failed before Node"], ["host.txt", "host"], ["exit-code", "1\n"]]) writeFileSync(join(root, name), body);
  assert.equal(run().status, 0);
  mkdirSync(join(root, "campaign")); assert.equal(run().status, 0);
  for (const value of ["0\n", "256\n", "1\\n", "1\nextra"]) {
    writeFileSync(join(root, "exit-code"), value); assert.notEqual(run().status, 0, JSON.stringify(value));
  }
  writeFileSync(join(root, "exit-code"), "1\n");
  writeFileSync(join(root, "bootstrap-ready.json"), "{}"); assert.notEqual(run().status, 0); unlinkSync(join(root, "bootstrap-ready.json"));
  writeFileSync(join(root, "campaign", ".host-attempt.json"), "{}"); assert.notEqual(run().status, 0); unlinkSync(join(root, "campaign", ".host-attempt.json"));
  linkSync(join(root, "run.log"), join(root, "hardlink")); assert.notEqual(run().status, 0); unlinkSync(join(root, "hardlink"));
  assert.equal(run().status, 0);
  assert.ok(!existsSync(join(root, "repo")), "early failure must not need a clone");
});

test("the exact common bootstrap marker does not make an empty campaign native evidence", (t) => {
  const python = process.platform === "win32" ? "python" : "python3";
  if (spawnSync(python, ["--version"], { timeout: 3000, windowsHide: true }).status !== 0) { t.skip("Python unavailable"); return; }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cloud-marked-pack-")));
  t.after(() => { assert.equal(dirname(root), realpathSync(tmpdir())); rmSync(root, { recursive: true }); });
  const state = reservation({ round: "r21", commit, token: "0123456789abcdef" });
  const program = remoteFiles(state)["pack.sh"].split("<<'CORTEN_SETUP_PACKAGE'\n")[1].split("\nCORTEN_SETUP_PACKAGE")[0]
    .replace("pathlib.Path('/bench')", "pathlib.Path(__import__('sys').argv[1])");
  for (const [name, body] of [["run.log", "entry import failed"], ["host.txt", "host"], ["exit-code", "1\n"]]) writeFileSync(join(root, name), body);
  mkdirSync(join(root, "campaign"));
  const marker = `${JSON.stringify(bootstrapMarker(state))}\n`;
  const run = () => spawnSync(python, ["-c", program, root], { encoding: "utf8", timeout: 5000, windowsHide: true });
  writeFileSync(join(root, "bootstrap-ready.json"), marker); assert.equal(run().status, 0);
  writeFileSync(join(root, "bootstrap-ready.json"), marker.replace(commit, "b".repeat(40))); assert.notEqual(run().status, 0);
  writeFileSync(join(root, "bootstrap-ready.json"), marker);
  writeFileSync(join(root, "campaign", ".host-attempt.json"), "{}"); assert.notEqual(run().status, 0);
});

test("early setup failure packs a validated archive with no usable Node or source clone", { skip: process.platform !== "linux" }, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cloud-early-pack-")));
  t.after(() => { assert.equal(dirname(root), realpathSync(tmpdir())); rmSync(root, { recursive: true }); });
  for (const [name, body] of [["run.log", "early setup failed"], ["host.txt", "host"], ["exit-code", "1\n"]]) writeFileSync(join(root, name), body);
  const script = join(root, "pack.sh"), nodeMarker = join(root, "node-was-called");
  const pack = remoteFiles(reservation({ round: "r21", commit, token: "0123456789abcdef" }))["pack.sh"]
    .replaceAll("/bench", root);
  writeFileSync(script, `node() { touch '${nodeMarker}'; return 99; }\n${pack}`);
  const result = spawnSync("bash", [script], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(nodeMarker)); assert.ok(!existsSync(join(root, "repo")));
  const archive = join(root, "results.tgz"); await archiveMembers(archive, fileHash(archive));
});

test("native entry receives a fresh private physical campaign root, never a reused path", () => {
  const state = reservation({ round: "r21", commit, token: "0123456789abcdef" }), job = remoteFiles(state)["job.sh"];
  const create = "mkdir -m 700 -- '/bench/campaign'", entry = "node 'bench/workloads/isolated/campaign-entry.mjs'";
  // begin() calls physical(stateRoot), then checks same-UID/private permissions.
  // Exclusive mkdir rejects any existing directory, file or symlink, including dangling links.
  assert.equal(job.split(create).length, 2, "one exclusive private root creation required");
  assert.ok(job.indexOf(create) < job.indexOf(entry));
  const clean = 'test -z "$(git status --porcelain --untracked-files=all)"';
  const cleanAt = job.indexOf(clean, job.indexOf(create));
  assert.ok(job.indexOf(create) < cleanAt);
  assert.ok(cleanAt < job.indexOf('writeFileSync("/bench/bootstrap-ready.json"'));
  assert.ok(job.indexOf('writeFileSync("/bench/bootstrap-ready.json"') < job.indexOf(entry));
  assert.ok(!/mkdir[^\n]*-p[^\n]*campaign|chmod[^\n]*campaign|rm[^\n]*campaign/.test(job));
});

test("legacy and every dedicated group share the same scoped public checkout and private job defaults", () => {
  const tokens = Object.fromEntries(groupNames.map((group, i) => [group, (i + 1).toString(16).padStart(16, "0")]));
  const fleet = fleetPlan({ round: "r21", commit, token: "f".repeat(16), tokens,
    provider: { accountId: "user:synthetic-fixture", context: "synthetic-fixture" }, sshKey: "42" });
  const states = [reservation({ round: "r21", commit, token: "0123456789abcdef" }),
    ...groupNames.map((group) => reservation({ round: "r21", commit, token: tokens[group], group, fleet }))];
  const expected = sourceSetup(remoteFiles(states[0])["job.sh"]);
  assert.match(expected, /\(\numask 022\ntimeout 600 git/);
  assert.match(expected, /test -z "\$\(git status --porcelain --untracked-files=all\)"\n\)\ncd '\/bench\/repo'\n/);
  for (const state of states) {
    const files = remoteFiles(state), job = files["job.sh"];
    assert.equal(sourceSetup(job) === expected, true, state.group ?? "all groups");
    assert.ok(job.startsWith("#!/bin/bash\nset -Eeuo pipefail\numask 077\n"));
    assert.equal(job.split("umask 022").length, 2);
    assert.ok(files["pack.sh"].startsWith("#!/bin/bash\nset -euo pipefail\numask 077\n"));
    assert.ok(!job.includes("chmod"));
  }
});

test("official Git checkout is nonroot-readable under a private job umask without opening control or campaign state", {
  skip: process.platform !== "linux" ? "requires Linux filesystem permissions and real Git"
    : process.getuid() !== 0 ? "requires root solely to launch the nonroot reader" : false,
}, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cloud-source-permissions-")));
  t.after(() => { assert.equal(dirname(root), realpathSync(tmpdir())); rmSync(root, { recursive: true }); });
  const source = join(root, "source"); mkdirSync(source);
  const env = fixtureGitEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file" });
  const run = (command, args, options = {}) => spawnSync(command, args,
    { encoding: "utf8", windowsHide: true, timeout: 15000, env, ...options });
  const git = (...args) => {
    const result = run("git", ["-C", source, ...args]);
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git("init", "--initial-branch=main");
  const scripts = ["catalog/load.js", "marketplace/load.js", "json-api/load.js", "fullstack/ssr-load.js", "fullstack/mixed-load.js"];
  for (const path of scripts) {
    const target = join(source, "bench", path); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(new URL(`../${path}`, import.meta.url)));
  }
  git("add", "bench");
  const commitFixture = (message) => git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", message);
  commitFixture("committed public benchmark scripts"); const measured = git("rev-parse", "HEAD");
  writeFileSync(join(source, "bench", scripts[0]), "different main head\n");
  git("add", "bench"); commitFixture("advance main to exercise detached checkout");
  assert.notEqual(git("rev-parse", "HEAD"), measured);
  // Keep the official URL and origin validation intact; real Git rewrites only
  // transport to this local repository, with every network protocol prohibited.
  const cloneEnv = { ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${source}.insteadOf`, GIT_CONFIG_VALUE_0: sourceUrl };
  const state = reservation({ round: "r21", commit: measured, token: "0123456789abcdef" });
  const files = remoteFiles(state), job = files["job.sh"];
  const end = job.indexOf('test "$(nproc)"');
  const campaignStart = job.indexOf("mkdir -m 700 -- '/bench/campaign'"), campaignEnd = job.indexOf("node 'bench/workloads/isolated/campaign-entry.mjs'");
  assert.ok(campaignStart > end && campaignEnd > campaignStart);
  const mode = (path) => statSync(path).mode & 0o777;
  for (const control of [true, false]) {
    const folder = join(root, control ? "private-control" : "official"); mkdirSync(folder, { mode: 0o700 });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(folder, name), body, { mode: 0o600 });
    writeFileSync(join(folder, "state.json"), JSON.stringify(state), { mode: 0o600 });
    let checkout = sourceSetup(job);
    if (control) checkout = checkout.replace("\numask 022\n", "\numask 077\n");
    const script = `set -euo pipefail\numask 077\n: > /bench/run.log\n${checkout}${job.slice(campaignStart, campaignEnd)}
pwd > /bench/parent-cwd.txt
printf 'private\\n' > /bench/campaign/state.json
mkdir /bench/campaign/evidence
printf 'private\\n' > /bench/campaign/evidence/result.json
printf 'private\\n' > /bench/post-checkout.json
`;
    const result = run("bash", ["-c", script.replaceAll("/bench", folder)], { env: cloneEnv });
    assert.equal(result.status, 0, result.stderr);
    const repo = join(folder, "repo"), bench = join(repo, "bench");
    assert.equal(readFileSync(join(folder, "parent-cwd.txt"), "utf8"), `${repo}\n`);
    const status = run("git", ["-C", repo, "status", "--porcelain", "--untracked-files=all"]);
    assert.equal(status.status, 0, status.stderr); assert.equal(status.stdout, "", "source must stay clean");
    for (const path of [repo, bench]) assert.equal(mode(path), control ? 0o700 : 0o755);
    for (const name of ["", "campaign", "campaign/evidence"]) assert.equal(mode(join(folder, name)), 0o700, name || "private job root");
    for (const name of [...Object.keys(files), "state.json", "run.log", "host.txt", "bootstrap-ready.json", "campaign/state.json",
      "campaign/evidence/result.json", "post-checkout.json", "parent-cwd.txt"]) assert.equal(mode(join(folder, name)), 0o600, name);
    for (const path of scripts) {
      const file = join(bench, path), parent = dirname(file);
      // cwd is established before dropping UID, just as a bind mount bypasses
      // private host ancestors. The reader still needs search access within bench.
      const reader = run(process.execPath, ["--max-old-space-size=256", "--input-type=module", "-e",
        `import { readFileSync } from "node:fs"; if (process.getuid() === 0 || process.getgroups().includes(0)) process.exit(2);
try { process.stdout.write(readFileSync(process.argv[1])); } catch (error) { process.stderr.write(error.code); process.exit(1); }`, path],
      { cwd: bench, uid: 65534, gid: 65534 });
      if (control) {
        assert.equal(reader.status, 1, reader.stderr); assert.equal(reader.stderr, "EACCES");
        assert.equal(mode(parent), 0o700); assert.equal(mode(file), 0o600);
      } else {
        assert.equal(reader.status, 0, reader.stderr);
        assert.equal(reader.stdout === readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), true, "exact committed script bytes");
        assert.equal(mode(parent), 0o755); assert.equal(mode(file), 0o644);
      }
    }
    t.diagnostic(`${control ? "private control" : "official checkout"}: source ${mode(bench).toString(8)}/${mode(join(bench, scripts[0])).toString(8)}, private roots 700, private files 600, clean Git`);
  }
  for (const failure of ["clone", "checkout"]) {
    const folder = join(root, `failed-${failure}`); mkdirSync(folder, { mode: 0o700 });
    let checkout = sourceSetup(job);
    if (failure === "checkout") checkout = checkout.replace("git -c core.autocrlf=false checkout --detach",
      ": > '/bench/repo/.git/index.lock'\ngit -c core.autocrlf=false checkout --detach");
    const script = `set -Eeuo pipefail
umask 077
cd '/bench'
finish() {
  code=$?; trap - EXIT
  printf '%s\\n' "$code" > /bench/exit-code
  mkdir /bench/failed-control
  printf 'private\\n' > /bench/failed-control/state.json
  pwd > /bench/failure-cwd.txt
  exit "$code"
}
trap finish EXIT
${checkout}
printf 'must not run\\n' > /bench/source-ready
`;
    const failureEnv = failure === "clone" ? { ...cloneEnv, GIT_CONFIG_KEY_0: `url.file://${source}-missing.insteadOf` } : cloneEnv;
    const result = run("bash", ["-c", script.replaceAll("/bench", folder)], { env: failureEnv });
    assert.equal(result.status, 128, result.stderr);
    assert.equal(existsSync(join(folder, "source-ready")), false, "source failure must abort the job");
    assert.equal(readFileSync(join(folder, "exit-code"), "utf8"), "128\n");
    assert.equal(readFileSync(join(folder, "failure-cwd.txt"), "utf8"), `${folder}\n`, "failed subshell cannot change parent cwd");
    for (const name of ["", "failed-control"]) assert.equal(mode(join(folder, name)), 0o700);
    for (const name of ["exit-code", "failed-control/state.json", "failure-cwd.txt"]) assert.equal(mode(join(folder, name)), 0o600);
    if (failure === "clone") assert.equal(existsSync(join(folder, "repo")), false);
    else assert.equal(result.stderr.includes("index.lock"), true, "real Git checkout must refuse the locked index");
    t.diagnostic(`failed ${failure}: original exit 128, EXIT-handler roots 700/files 600, parent cwd unchanged`);
  }
});
