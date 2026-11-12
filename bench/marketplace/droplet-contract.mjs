import assert from "node:assert/strict";
import { groupApps, scheduledGroup } from "./groups.mjs";

export const nightly = Object.freeze({ passes: 3, duration: 15, warmup: 10, rate: 150 });
export function officialRound(round) {
  assert.match(round ?? "", /^r(?:1[7-9]|[2-9]\d|[1-9]\d{2,})$/, "official marketplace-v2 rounds start at r17");
  return round;
}
export function parseDropletArgs(args) {
  const options = { round: officialRound(args[0]), collect: false, detach: false, plan: false };
  const seen = new Set();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    assert.ok(!seen.has(flag), `duplicate ${flag}`); seen.add(flag);
    if (["--collect", "--detach", "--plan"].includes(flag)) options[flag.slice(2)] = true;
    else if (["--ssh-key", "--state-dir", "--group"].includes(flag)) {
      const value = args[++i]; assert.ok(value && !value.startsWith("--"), `${flag} needs a value`);
      options[flag === "--ssh-key" ? "sshKey" : flag === "--group" ? "group" : "stateDir"] = value;
    } else throw new Error(`unknown option ${flag}`);
  }
  assert.ok(options.stateDir, "--state-dir is required (durable launcher state, outside the checkout)");
  assert.ok(options.collect ? !options.detach && !options.plan : options.detach || options.plan, "use --detach to launch, or --collect");
  assert.ok(options.collect || /^\d+$/.test(options.sshKey ?? ""), "--ssh-key needs a DigitalOcean key id");
  assert.ok(!options.collect || options.group === undefined, "collection uses the reserved group, never a new selection");
  if (!options.collect) { options.group ??= scheduledGroup(options.round); groupApps(options.group); }
  return options;
}
export function validateState(s, round) {
  officialRound(round);
  assert.equal(s.round, round); assert.equal(s.workload, "marketplace-v2");
  assert.equal(s.name, `corten-marketplace-${round}`); assert.equal(s.unit, `${s.name}.service`);
  assert.match(s.tag, /^corten-marketplace-run-[a-f0-9]{16}$/);
  assert.match(s.commit, /^[a-f0-9]{40}$/);
  assert.deepEqual(s.options, nightly);
  if (s.group !== undefined) {
    assert.deepEqual(s.apps, groupApps(s.group), "reserved group membership changed");
  } else assert.equal(s.apps, undefined, "legacy reservations have no group selection");
  if (s.id !== undefined) assert.match(s.id, /^\d+$/);
  if (s.ip !== undefined) assert.match(s.ip, /^\d{1,3}(?:\.\d{1,3}){3}$/);
  return s;
}
export function ownedDroplet(droplets, s) {
  validateState(s, s.round);
  const matches = droplets.filter((d) => s.id ? String(d.id) === s.id : d.name === s.name && d.tags?.includes(s.tag));
  assert.equal(matches.length, 1, "owned droplet missing or ambiguous; preserve state and artifacts");
  const d = matches[0];
  assert.equal(d.name, s.name);
  for (const tag of ["corten-bench", "corten-marketplace", s.tag]) assert.ok(d.tags?.includes(tag), `missing ownership tag ${tag}`);
  return d;
}
export function terminalUnit(output) {
  const fields = Object.fromEntries(output.trim().split(/\r?\n/).map((line) => line.split("=")));
  assert.equal(fields.LoadState, "loaded", "unit missing/unloaded; refusing collection and deletion");
  assert.equal(fields.Restart, "no", "unexpected restart policy; refusing collection and deletion");
  return ["inactive", "failed"].includes(fields.ActiveState);
}
export function safeArchive(entries, verbose, round) {
  const root = `repo/bench/marketplace/results/${officialRound(round)}`;
  for (const entry of entries.trim().split(/\r?\n/)) {
    assert.ok(entry && !/[\\:]/.test(entry) && !entry.startsWith("/") && !entry.split("/").some((s) => s === ".." || s === "."), "unsafe archive member");
    assert.ok(["run.log", "host.txt", "exit-code"].includes(entry) || entry === root || entry.startsWith(`${root}/`), `unexpected archive member ${entry}`);
  }
  for (const line of verbose.trim().split(/\r?\n/)) assert.ok(/^[d-]/.test(line), "archive contains link or special file");
}
export function remoteFiles(s) {
  validateState(s, s.round);
  const pack = `#!/bin/bash
set -euo pipefail
cd /bench
test -f exit-code || systemctl show ${s.unit} --value --property=ExecMainStatus > exit-code
files=(run.log exit-code)
test ! -f host.txt || files+=(host.txt)
test ! -d repo/bench/marketplace/results/${s.round} || files+=(repo/bench/marketplace/results/${s.round})
tar -czf results.tgz.tmp "\${files[@]}"
mv results.tgz.tmp results.tgz
`;
  const job = `#!/bin/bash
set -Eeuo pipefail
exec >>/bench/run.log 2>&1
finish() { code=$?; trap - EXIT; printf '%s\\n' "$code" > /bench/exit-code; /bin/bash /bench/pack.sh || true; exit "$code"; }
trap finish EXIT
date -u --iso-8601=seconds
timeout 900 cloud-init status --wait
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer || true
timeout 900 systemd-run --quiet --property=After=apt-daily.service --property=After=apt-daily-upgrade.service --wait /bin/true
export DEBIAN_FRONTEND=noninteractive
timeout 900 apt-get update -qq
timeout 900 apt-get install -y -qq git curl ca-certificates
timeout 900 bash -o pipefail -c 'curl -fsSL https://get.docker.com | sh'
timeout 900 bash -o pipefail -c 'curl -fsSL https://deb.nodesource.com/setup_24.x | bash -'
timeout 900 apt-get install -y -qq nodejs
systemctl enable --now docker
timeout 600 git clone --quiet https://github.com/corten-run/corten.git /bench/repo
cd /bench/repo
git checkout --detach ${s.commit}
test "$(git rev-parse HEAD)" = ${s.commit}
test -z "$(git status --porcelain)"
test "$(nproc)" -ge 8
{ date -u --iso-8601=seconds; lscpu; free -m; uname -a; docker --version; node --version; df -h /; } > /bench/host.txt
timeout 900 npm ci --no-audit --no-fund
node bench/marketplace/fixtures.mjs
export MARKETPLACE_APP_CPUS=1 MARKETPLACE_API_CPUS=2-3 MARKETPLACE_LOAD_CPUS=4-7
node bench/marketplace/run.mjs ${s.round} --build --passes ${nightly.passes} --duration ${nightly.duration} --warmup ${nightly.warmup} --rate ${nightly.rate}${s.group === undefined ? "" : ` --group ${s.group}`}
node bench/marketplace/report.mjs bench/marketplace/results/${s.round}/summary.json > /bench/report.md
`;
  const unit = `[Unit]
Description=Localized marketplace ${s.round}, ${s.group ?? "full"} group, three passes
After=network-online.target
Wants=network-online.target
[Service]
Type=exec
ExecStart=/bin/bash /bench/job.sh
WorkingDirectory=/bench
Restart=no
RuntimeMaxSec=36h
TimeoutStopSec=120
KillMode=control-group
`;
  return { "job.sh": job, "pack.sh": pack, [s.unit]: unit };
}
