import assert from "node:assert/strict";
import test from "node:test";
import { remoteFiles as originalFiles, reservation } from "./cloud-contract.mjs";
import { remoteFiles, sourceUrl } from "./cloud-remote.mjs";
import { commit } from "./cloud-fixtures.mjs";

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

test("terminal packer keeps existing archives and publishes new bytes without overwrite", () => {
  const state = reservation({ round: "r21", commit, token: "0123456789abcdef" }), pack = remoteFiles(state)["pack.sh"];
  assert.ok(pack.includes("test -f \"$file\" && test ! -L \"$file\""));
  assert.ok(pack.includes("if test -e 'results.tgz' || test -L 'results.tgz'"));
  assert.ok(pack.includes("mktemp '/bench/cloud-pack.XXXXXXXX'"));
  assert.ok(pack.includes('tar --format=gnu -czf "$stage" -- "${files[@]}"'));
  assert.ok(pack.includes('ln -- "$stage" \'results.tgz\'')); assert.ok(!pack.includes("mv "));
  assert.ok(pack.indexOf('tar --format=gnu') < pack.indexOf('ln --'));
  assert.throws(() => remoteFiles({ ...state, commit: `${commit};exit` }));
});

test("native entry receives a fresh private physical campaign root, never a reused path", () => {
  const state = reservation({ round: "r21", commit, token: "0123456789abcdef" }), job = remoteFiles(state)["job.sh"];
  const create = "mkdir -m 700 -- '/bench/campaign'", entry = "node 'bench/workloads/isolated/campaign-entry.mjs'";
  // begin() calls physical(stateRoot), then checks same-UID/private permissions.
  // Exclusive mkdir rejects any existing directory, file or symlink, including dangling links.
  assert.equal(job.split(create).length, 2, "one exclusive private root creation required");
  assert.ok(job.indexOf(create) < job.indexOf(entry));
  assert.ok(job.includes(`${create}\ntest -z "$(git status --porcelain --untracked-files=all)"\n${entry}`));
  assert.ok(!/mkdir[^\n]*-p[^\n]*campaign|chmod[^\n]*campaign|rm[^\n]*campaign/.test(job));
});
