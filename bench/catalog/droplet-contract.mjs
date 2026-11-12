// Explicit, independent catalog-page host contract. Never used by nightly or legacy c1.
import assert from "node:assert/strict";
import { isIP } from "node:net";
import { cpuSettings, parseArgs } from "./contract.mjs";
import { groupDescriptor } from "./group.mjs";

export const host = Object.freeze({ size: "c-8", region: "sfo2", image: "ubuntu-24-04-x64" });
export const cpuEnv = Object.freeze({ CATALOG_APP_CPUS: "1", CATALOG_API_CPUS: "2-3", CATALOG_LOAD_CPUS: "4-7" });
export const tags = ["corten-bench", "corten-catalog-page"];
export function roundName(round) {
  assert.match(round ?? "", /^c[1-9]\d*$/, "round must be cN");
  assert.notEqual(round, "c1", "historical c1 is reserved");
  return round;
}
export function measurements(round) {
  const group = groupDescriptor("catalog-page");
  return parseArgs([roundName(round), "--group", group.group, "--build"], Object.fromEntries(group.apps.map((app) => [app, {}])));
}
export function parseDropletArgs(args) {
  const options = { round: roundName(args[0]) }, seen = new Set();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    assert.ok(!seen.has(flag), `duplicate ${flag}`); seen.add(flag);
    if (["--detach", "--collect"].includes(flag)) options[flag.slice(2)] = true;
    else if (["--group", "--commit", "--state-dir", "--ssh-key"].includes(flag)) {
      const value = args[++i]; assert.ok(value && !value.startsWith("--"), `${flag} needs a value`);
      options[{ "--group": "group", "--commit": "commit", "--state-dir": "stateDir", "--ssh-key": "sshKey" }[flag]] = value;
    } else throw new Error(`unknown option ${flag}`);
  }
  assert.equal(options.group, "catalog-page", "explicit --group catalog-page required");
  assert.ok(options.stateDir, "--state-dir required, outside checkout");
  assert.ok(Boolean(options.detach) !== Boolean(options.collect), "use exactly one of --detach or --collect");
  if (options.detach) {
    assert.match(options.commit ?? "", /^[a-f0-9]{40}$/, "--commit needs the full measured SHA");
    assert.match(options.sshKey ?? "", /^[1-9]\d*$/, "--ssh-key needs a key id");
  } else assert.ok(options.commit === undefined && options.sshKey === undefined, "collection uses reserved identity");
  return options;
}
export function reservation(round, commit, token, createdAt = new Date().toISOString()) {
  const name = `corten-catalog-page-${roundName(round)}-${token}`;
  return validateState({ schema: "catalog-page-host/v1", round, commit, token, name, unit: `${name}.service`,
    tag: `corten-catalog-page-run-${token}`, group: groupDescriptor("catalog-page"), options: measurements(round),
    cpus: cpuSettings(cpuEnv), host, createdAt, status: "creating" }, round);
}
export function validateState(s, round) {
  assert.equal(s.schema, "catalog-page-host/v1"); assert.equal(s.round, roundName(round));
  assert.match(s.commit ?? "", /^[a-f0-9]{40}$/); assert.match(s.token ?? "", /^[a-f0-9]{16}$/);
  assert.equal(s.name, `corten-catalog-page-${round}-${s.token}`);
  assert.equal(s.tag, `corten-catalog-page-run-${s.token}`); assert.equal(s.unit, `${s.name}.service`);
  assert.deepEqual(s.group, groupDescriptor("catalog-page")); assert.deepEqual(s.options, measurements(round));
  assert.deepEqual(s.host, host); assert.deepEqual(s.cpus, cpuSettings(cpuEnv));
  assert.ok(["creating", "preparing", "starting", "running", "collected"].includes(s.status));
  if (s.status !== "creating") assert.ok(s.id && s.ip, "created host identity missing");
  if (s.id !== undefined) assert.match(s.id, /^[1-9]\d*$/);
  if (s.ip !== undefined) assert.equal(isIP(s.ip), 4, "invalid public IPv4");
  if (s.archiveSha256 !== undefined) assert.match(s.archiveSha256, /^[a-f0-9]{64}$/);
  if (s.evidenceSha256 !== undefined) assert.match(s.evidenceSha256, /^[a-f0-9]{64}$/);
  for (const path of s.extractionAttempts ?? []) assert.match(path, /^evidence-[A-Za-z0-9]+$/);
  if (s.evidence !== undefined) assert.ok(s.extractionAttempts.includes(s.evidence));
  if (s.deletionIntentAt || s.destroyedAt) {
    assert.equal(s.status, "collected");
    assert.ok(s.collectedAt && s.archiveSha256 && s.evidence && s.evidenceSha256, "deletion without durable evidence receipt");
    assert.equal(typeof s.complete, "boolean");
  }
  return s;
}
export function ownedDroplet(droplets, s) {
  validateState(s, s.round); assert.ok(Array.isArray(droplets), "invalid droplet list");
  const matches = droplets.filter((d) => s.id ? String(d.id) === s.id : d.name === s.name && d.tags?.includes(s.tag));
  assert.equal(matches.length, 1, "owned droplet missing or ambiguous; preserve host and reservation");
  const d = matches[0]; assert.match(String(d.id), /^[1-9]\d*$/); assert.equal(d.name, s.name);
  for (const tag of [...tags, s.tag]) assert.ok(d.tags?.includes(tag), `missing ownership tag ${tag}`);
  assert.equal(d.size_slug ?? d.size?.slug, s.host.size); assert.equal(d.region?.slug, s.host.region);
  return d;
}
export function terminalUnit(output, s) {
  const fields = {};
  for (const line of output.trim().split(/\r?\n/)) {
    const match = /^([A-Za-z]+)=(.*)$/.exec(line); assert.ok(match && !Object.hasOwn(fields, match[1]), "invalid/duplicate unit property");
    fields[match[1]] = match[2];
  }
  assert.equal(fields.Id, s.unit, "unit identity differs"); assert.equal(fields.LoadState, "loaded", "unit missing/unloaded");
  assert.equal(fields.Restart, "no", "unit restart policy differs");
  assert.equal(fields.FragmentPath, `/etc/systemd/system/${s.unit}`, "unit file differs");
  if (!["inactive", "failed"].includes(fields.ActiveState)) return false;
  assert.equal(fields.MainPID, "0", "unit still has a running process");
  assert.match(fields.ExecMainCode, /^[12]$/, "unit has not exited");
  assert.ok(fields.ExecMainStartTimestamp?.length > 0 && fields.ExecMainStartTimestamp !== "n/a", "unit never started");
  return true;
}
export function safeArchive(entries, verbose, round) {
  const root = `repo/bench/catalog/results/${roundName(round)}`;
  const names = entries.trimEnd().split(/\r?\n/), types = verbose.trimEnd().split(/\r?\n/), seen = new Set();
  assert.equal(names.length, types.length, "archive listing mismatch");
  names.forEach((name, i) => {
    assert.match(name, /^[A-Za-z0-9_./-]+$/, "unsafe archive member");
    const path = name.replace(/\/$/, "");
    assert.ok(!path.startsWith("/") && !path.split("/").some((p) => !p || p.endsWith(".")
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), "unsafe archive path");
    assert.ok(!seen.has(path.toLowerCase()), "duplicate archive path"); seen.add(path.toLowerCase());
    assert.match(types[i], /^[d-]/, "archive link or special file");
    assert.equal(types[i][0] === "d", name.endsWith("/"), "archive type/path mismatch");
    assert.ok(["run.log", "host.txt", "exit-code", "report.md"].includes(path) || path === root || path.startsWith(`${root}/`), "foreign archive member");
    if (!path.startsWith(`${root}/`) && path !== root) assert.equal(types[i][0], "-", "metadata must be regular files");
  });
  for (const name of ["run.log", "exit-code"]) assert.ok(seen.has(name), `missing ${name}`);
}
export function validateCollected(summary, s, inspect) {
  assert.equal(summary.round, s.round); assert.equal(summary.commit, s.commit);
  assert.deepEqual(summary.group, s.group); assert.deepEqual(summary.options, s.options);
  assert.deepEqual(summary.measurement?.cpus, s.cpus, "CPU placement/budget differs from reservation");
  const report = inspect(summary, s.commit);
  assert.equal(report.baseline, true, `strict catalog report incomplete: ${report.warnings?.join("; ")}`);
  return report;
}
export function remoteFiles(s) {
  validateState(s, s.round);
  const root = `repo/bench/catalog/results/${s.round}`;
  const pack = `#!/bin/bash
set -euo pipefail
cd /bench
test -f exit-code || systemctl show ${s.unit} --value --property=ExecMainStatus > exit-code
files=(run.log exit-code)
for file in host.txt report.md ${root}; do test ! -e "$file" || files+=("$file"); done
tar -czf results.tgz.tmp "\${files[@]}"
mv results.tgz.tmp results.tgz
`;
  const job = `#!/bin/bash
set -Eeuo pipefail
exec >>/bench/run.log 2>&1
finish() { code=$?; trap - EXIT; printf '%s\\n' "$code" > /bench/exit-code; timeout 600 /bin/bash /bench/pack.sh || true; exit "$code"; }
trap finish EXIT
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
test -z "$(git status --porcelain --untracked-files=all)"
test "$(nproc)" -ge 8
{ date -u --iso-8601=seconds; lscpu; free -m; uname -a; docker --version; node --version; df -h /; } > /bench/host.txt
timeout 900 npm ci --no-audit --no-fund
node bench/catalog/fixtures.mjs
unset BENCH_APPS BENCH_TIER PROFILE
export ${Object.entries(cpuEnv).map(([k, v]) => `${k}=${v}`).join(" ")}
# Native runner gates ALL selected apps, both sources, page AND JSON before page-only timing.
node bench/catalog/run.mjs ${s.round} --build --group catalog-page
node bench/catalog/report.mjs bench/catalog/results/${s.round}/summary.json --commit ${s.commit} --require-complete > /bench/report.md
`;
  return { "job.sh": job, "pack.sh": pack, [s.unit]: `[Unit]
Description=Explicit catalog-page ${s.round}, pinned ${s.commit}
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
` };
}
