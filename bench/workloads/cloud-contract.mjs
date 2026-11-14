// Provider identity and transport boundaries only. This module cannot launch or qualify a run.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { host } from "../catalog/droplet-contract.mjs";
import { contractSha256, groupNames, registrySchema, selectedApps } from "./registry.mjs";

export { host };
export const tags = Object.freeze(["corten-bench", "corten-bench-groups"]);
const full = (value, pattern, name) => {
  assert.equal(typeof value, "string", `${name} must be a string`);
  const match = pattern.exec(value);
  assert.ok(match && match[0] === value, `invalid ${name}`);
  return value;
};
const date = (value) => {
  full(value, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/, "timestamp");
  assert.equal(new Date(value).toISOString(), value, "invalid timestamp");
};
export const roundName = (value) => full(value, /r[1-9]\d{0,8}/, "campaign round");
export function selection() {
  return { schema: registrySchema, groups: groupNames.map((group) => ({
    group, contractSha256: contractSha256(group), apps: selectedApps(group),
  })) };
}
const exact = (value, fields) => {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype, "plain object required");
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort(), "unexpected or missing fields");
};
export function fleetPlan(input, createdAt = new Date().toISOString()) {
  exact(input, ["round", "commit", "token", "tokens", "provider", "sshKey"]);
  const { round, commit, token, tokens, provider, sshKey } = input;
  roundName(round); assert.ok(Number(round.slice(1)) >= 17, "official campaigns start at r17");
  full(commit, /[a-f0-9]{40}/, "measured commit"); full(token, /[a-f0-9]{16}/, "fleet token");
  exact(tokens, groupNames); exact(provider, ["accountId", "context"]);
  full(provider.accountId, /(?:user|team):[A-Za-z0-9][A-Za-z0-9-]{0,127}/, "scoped stable account UUID required");
  full(provider.context, /[A-Za-z0-9][A-Za-z0-9_.-]{0,127}/, "explicit saved doctl context required");
  full(sshKey, /[1-9]\d*/, "SSH key ID required"); date(createdAt);
  const jobs = groupNames.map((group) => {
    const ownership = full(tokens[group], /[a-f0-9]{16}/, "ownership token");
    return { group, token: ownership, name: `corten-bench-groups-${round}-${ownership}`,
      tag: `corten-bench-groups-run-${ownership}` };
  });
  assert.equal(new Set([token, ...jobs.map((row) => row.token)]).size, jobs.length + 1, "unique fleet/host tokens required");
  const body = { schema: "benchmark-group-fleet/v1", round, commit, token, createdAt,
    provider: { ...provider }, sshKey, host: { ...host }, selection: selection(), jobs };
  return { ...body, fleetSha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}
export function validateFleet(plan) {
  assert.ok(plan && Array.isArray(plan.jobs), "complete fleet plan required");
  const expected = fleetPlan({ round: plan.round, commit: plan.commit, token: plan.token,
    tokens: Object.fromEntries(plan.jobs.map((row) => [row.group, row.token])), provider: plan.provider, sshKey: plan.sshKey }, plan.createdAt);
  assert.deepEqual(plan, expected, "fleet differs from complete fixed registry and owned hosts");
  return plan;
}
export function assertFleetCensus(droplets, plan) {
  validateFleet(plan); assert.ok(Array.isArray(droplets));
  const names = new Set(), ids = new Set();
  for (const d of droplets) {
    if (!d.name?.startsWith("corten-bench-groups-") && !d.tags?.includes(tags[0])) continue;
    const job = plan.jobs.find((row) => row.name === d.name);
    assert.ok(job, "foreign benchmark host blocks fleet launch");
    full(String(d.id), /[1-9]\d*/, "droplet ID");
    assert.ok(!names.has(d.name) && !ids.has(String(d.id)), "duplicate fleet host identity");
    names.add(d.name); ids.add(String(d.id));
    for (const tag of [...tags, job.tag]) assert.ok(d.tags?.includes(tag), "fleet ownership tag differs");
    assert.equal(d.size_slug ?? d.size?.slug, host.size); assert.equal(d.region?.slug, host.region);
  }
  return true;
}
export function reservation(input, createdAt = new Date().toISOString()) {
  const { round, commit, token, group, fleet } = input;
  exact(input, group === undefined ? ["round", "commit", "token"] : ["round", "commit", "token", "group", "fleet"]);
  roundName(round);
  full(commit, /[a-f0-9]{40}/, "measured commit");
  full(token, /[a-f0-9]{16}/, "ownership token");
  const name = `corten-bench-groups-${round}-${token}`;
  if (group !== undefined) {
    validateFleet(fleet); assert.equal(fleet.round, round); assert.equal(fleet.commit, commit);
    assert.equal(fleet.jobs.find((row) => row.group === group)?.token, token, "host not reserved in fleet");
  }
  return validateState({ schema: group === undefined ? "benchmark-group-host/v1" : "benchmark-dedicated-group-host/v1", round, commit, token, name,
    tag: `corten-bench-groups-run-${token}`, unit: `${name}.service`, host: { ...host },
    selection: group === undefined ? selection() : { schema: registrySchema, groups: selection().groups.filter((row) => row.group === group) },
    ...(group === undefined ? {} : { group, fleet: structuredClone(fleet) }), createdAt, status: "reserved" }, round);
}
export function validateState(s, round) {
  assert.ok(s && typeof s === "object" && !Array.isArray(s), "host state required");
  const dedicated = s.schema === "benchmark-dedicated-group-host/v1";
  assert.ok(dedicated || s.schema === "benchmark-group-host/v1");
  assert.equal(s.round, roundName(round));
  full(s.commit, /[a-f0-9]{40}/, "measured commit");
  full(s.token, /[a-f0-9]{16}/, "ownership token");
  assert.equal(s.name, `corten-bench-groups-${round}-${s.token}`);
  assert.equal(s.tag, `corten-bench-groups-run-${s.token}`);
  assert.equal(s.unit, `${s.name}.service`);
  assert.deepEqual(s.host, host);
  if (dedicated) {
    validateFleet(s.fleet); assert.equal(s.fleet.round, round); assert.equal(s.fleet.commit, s.commit);
    assert.ok(groupNames.includes(s.group));
    assert.equal(s.fleet.jobs.find((row) => row.group === s.group)?.token, s.token, "host not reserved in fleet");
    assert.deepEqual(s.selection, { schema: registrySchema, groups: selection().groups.filter((row) => row.group === s.group) }, "complete native group required");
  } else {
    assert.ok(!Object.hasOwn(s, "group") && !Object.hasOwn(s, "fleet"), "legacy host cannot select a group");
    assert.deepEqual(s.selection, selection(), "complete current registry selection differs");
  }
  date(s.createdAt);
  assert.ok(["reserved", "creating", "preparing", "starting", "running", "collected"].includes(s.status));
  if (["preparing", "starting", "running", "collected"].includes(s.status)) assert.ok(s.id && s.ip, "owned host identity missing");
  if (s.id !== undefined) full(s.id, /[1-9]\d*/, "droplet ID");
  if (s.ip !== undefined) assert.equal(isIP(s.ip), 4, "public IPv4 required");
  for (const key of ["archiveSha256", "evidenceSha256"]) if (s[key] !== undefined) full(s[key], /[a-f0-9]{64}/, key);
  for (const key of ["createIntentAt", "collectedAt", "deletionIntentAt", "destroyedAt"]) if (s[key] !== undefined) date(s[key]);
  if (s.extractionAttempts !== undefined) {
    assert.ok(Array.isArray(s.extractionAttempts));
    for (const path of s.extractionAttempts) full(path, /evidence-[A-Za-z0-9]+/, "extraction directory");
    assert.equal(new Set(s.extractionAttempts).size, s.extractionAttempts.length);
  }
  if (s.evidence !== undefined) assert.ok(s.extractionAttempts?.includes(s.evidence), "unrecorded extraction");
  if (s.deletionIntentAt || s.destroyedAt) {
    assert.equal(s.status, "collected");
    assert.ok(s.collectedAt && s.archiveSha256 && s.evidenceSha256 && s.evidence, "deletion requires preserved evidence");
    assert.ok(["validated", "failed", "blocked"].includes(s.evidenceOutcome), "terminal evidence outcome required");
  }
  return s;
}
export function ownedDroplet(droplets, s) {
  validateState(s, s.round);
  assert.ok(Array.isArray(droplets));
  const matches = droplets.filter((d) => s.id ? String(d.id) === s.id : d.name === s.name && d.tags?.includes(s.tag));
  assert.equal(matches.length, 1, "owned droplet missing or ambiguous; preserve reservation");
  const d = matches[0];
  full(String(d.id), /[1-9]\d*/, "droplet ID");
  assert.equal(d.name, s.name);
  for (const tag of [...tags, s.tag]) assert.ok(d.tags?.includes(tag), `missing ownership tag ${tag}`);
  assert.equal(d.size_slug ?? d.size?.slug, s.host.size);
  assert.equal(d.region?.slug, s.host.region);
  if (s.ip) assert.equal(d.networks?.v4?.filter((n) => n.type === "public").find((n) => n.ip_address === s.ip)?.ip_address, s.ip,
    "owned host public IP differs");
  return d;
}
export function terminalUnit(output, s) {
  validateState(s, s.round);
  const fields = {};
  for (const line of output.trimEnd().split(/\r?\n/)) {
    const match = /^([A-Za-z]+)=(.*)$/.exec(line);
    assert.ok(match && !Object.hasOwn(fields, match[1]), "invalid or duplicate unit property");
    fields[match[1]] = match[2];
  }
  assert.equal(fields.Id, s.unit);
  assert.equal(fields.LoadState, "loaded", "unit missing; preserve host");
  assert.equal(fields.FragmentPath, `/etc/systemd/system/${s.unit}`);
  assert.equal(fields.Restart, "no", "unit restart policy differs");
  if (!["inactive", "failed"].includes(fields.ActiveState)) return false;
  assert.equal(fields.MainPID, "0", "unit still has a process");
  full(fields.ExecMainCode, /[12]/, "terminal exit type");
  assert.ok(fields.ExecMainStartTimestamp && fields.ExecMainStartTimestamp !== "n/a", "unit never started");
  return true;
}
export const archivePathLimits = Object.freeze({ nodes: 1100000, nameBytes: 32 * 1024 ** 2, memberBytes: 64 * 1024 ** 2 });

// A compact trie, not one retained JS string/map per full path or implicit prefix.
// Each node is 12 bytes; the fixed hash table is 16 MiB and the name arena 32 MiB.
// Limits may only be lowered by local tests, never raised by evidence or the CLI.
export function archivePaths(bounds = {}) {
  const limits = { ...archivePathLimits, ...bounds };
  for (const key of Object.keys(limits)) assert.ok(Object.hasOwn(archivePathLimits, key)
    && Number.isSafeInteger(limits[key]) && limits[key] >= 1 && limits[key] <= archivePathLimits[key], "archive index bound");
  const nodes = Buffer.alloc(limits.nodes * 12), names = Buffer.alloc(limits.nameBytes), slots = new Uint32Array(2 ** 22);
  const seed = randomBytes(32), parentBytes = Buffer.alloc(4);
  let count = 1, used = 0, memberBytes = 0, pathBytes = 0, entries = 0;
  const chargePath = (bytes) => { pathBytes += bytes; assert.ok(pathBytes <= limits.memberBytes, "archive index physical path budget"); };
  const child = (parent, part, length) => {
    parentBytes.writeUInt32LE(parent);
    let slot = createHash("sha256").update(seed).update(parentBytes).update(part.toLowerCase(), "ascii").digest().readUInt32LE() & (slots.length - 1);
    while (slots[slot]) {
      const id = slots[slot], at = id * 12, offset = nodes.readUInt32LE(at + 4), length = nodes.readUInt16LE(at + 8);
      if (nodes.readUInt32LE(at) === parent && length === part.length) {
        const saved = names.toString("ascii", offset, offset + length);
        if (saved.toLowerCase() === part.toLowerCase()) {
          assert.equal(saved, part, "archive path casing differs"); return id;
        }
      }
      slot = (slot + 1) & (slots.length - 1);
    }
    assert.ok(count < limits.nodes, "evidence tree limit");
    assert.ok(used + part.length + 1 <= limits.nameBytes, "archive index name budget");
    chargePath(length);
    const id = count++, at = id * 12;
    nodes.writeUInt32LE(parent, at); nodes.writeUInt32LE(used, at + 4); nodes.writeUInt16LE(part.length, at + 8);
    names.write(part, used, part.length, "ascii"); used += part.length + 1; slots[slot] = id; return id;
  };
  const required = new Set(["run.log", "host.txt", "exit-code"]);
  return {
    add(name, directory) {
      assert.equal(typeof name, "string"); assert.equal(typeof directory, "boolean");
      assert.ok(++entries <= limits.nodes, "archive entry limit");
      assert.ok(name.length <= 4096, "archive member size limit");
      memberBytes += name.length; assert.ok(memberBytes <= limits.memberBytes, "archive index member budget");
      assert.equal(directory, name.endsWith("/"), "archive path/type mismatch");
      const path = name.replace(/\/$/, ""), parts = path.split("/");
      assert.ok(parts.length <= 64 && parts.every((p) => p.length <= 255 && portableEvidenceSegment(p)), "unsafe archive path/component");
      assert.ok(path === "campaign" || path.startsWith("campaign/") || ["run.log", "host.txt", "exit-code"].includes(path), "foreign archive member");
      if (path === "campaign") assert.ok(directory, "campaign root must be a directory");
      if (!path.includes("/") && path !== "campaign") assert.ok(!directory, "metadata must be a regular file");
      let id = 0, length = 0;
      for (const part of parts) {
        const at = id * 12 + 10;
        assert.ok(!(nodes[at] & 4), "archive file used as parent");
        if (id && !(nodes[at] & 3)) chargePath(1); // An implicit directory's trailing slash.
        nodes[at] |= 1;
        length += part.length + (length ? 1 : 0); id = child(id, part, length);
      }
      const at = id * 12 + 10;
      assert.ok(!(nodes[at] & 6), "duplicate archive path");
      assert.ok(directory || !(nodes[at] & 1), "archive parent replaces existing child");
      if (directory && !(nodes[at] & 1)) chargePath(1);
      nodes[at] |= directory ? 2 : 4;
      if (!directory) required.delete(path);
    },
    finish() { assert.equal(required.size, 0, "missing required archive metadata"); return { entries, nodes: count, nameBytes: used, memberBytes, pathBytes }; },
  };
}

export function safeArchive(entries, verbose) {
  assert.equal(typeof entries, "string"); assert.equal(typeof verbose, "string");
  assert.ok(entries.length <= 16 * 1024 ** 2 && verbose.length <= 32 * 1024 ** 2, "archive listing size limit");
  // Remove only one listing terminator, never whitespace belonging to a filename.
  const lines = (value) => value.replace(/\r?\n$/, "").split(/\r?\n/);
  const names = lines(entries), types = lines(verbose);
  assert.ok(names.length <= 100000, "archive entry limit");
  assert.equal(names.length, types.length, "archive listings differ");
  const paths = archivePaths();
  for (let i = 0; i < names.length; i++) {
    assert.ok(/^[d-]/.test(types[i]), "archive link or special file");
    paths.add(names[i], types[i][0] === "d");
  }
  paths.finish();
}

// Native source snapshots include route brackets, npm scopes, Cargo versions
// and the literal-percent asset fixture. Never decode or normalize these names.
export function portableEvidenceSegment(name) {
  return typeof name === "string" && /^[A-Za-z0-9_.@$%+\[\]-]+$/.test(name)
    && name !== "." && name !== ".." && !name.endsWith(".")
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

// Shared with the local kernel fixture. Older systemd ignores DelegateSubgroup;
// only this unit's sole wrapper PID may establish the equivalent leaf layout.
export function supervisorBootstrap(unit) {
  full(unit, /corten-bench-groups-r[1-9]\d{0,8}-[a-f0-9]{16}\.service/, "owned unit");
  return `IFS= read -r scope < /proc/self/cgroup
case "$scope" in
  0::*/${unit}/supervisor) parent="/sys/fs/cgroup\${scope#0::}"; parent="\${parent%/supervisor}" ;;
  0::*/${unit})
    parent="/sys/fs/cgroup\${scope#0::}"
    while IFS= read -r member; do test "$member" = "$$"; done < "$parent/cgroup.procs"
    mkdir "$parent/supervisor"
    printf '%s' "$$" > "$parent/supervisor/cgroup.procs"
    ;;
  *) exit 2 ;;
esac
test -d "$parent" && test ! -L "$parent" && test ! -L "$parent/supervisor"
while IFS= read -r member; do test -z "$member"; done < "$parent/cgroup.procs"
IFS= read -r controllers < "$parent/cgroup.controllers"
for controller in cpu cpuset memory pids; do
  case " $controllers " in *" $controller "*) ;; *) exit 2 ;; esac
done
printf '%s' '+cpu +cpuset +memory +pids' > "$parent/cgroup.subtree_control"
IFS= read -r controllers < "$parent/cgroup.subtree_control"
for controller in cpu cpuset memory pids; do
  case " $controllers " in *" $controller "*) ;; *) exit 2 ;; esac
done
while IFS= read -r member; do test "$member" = "$$"; done < "$parent/supervisor/cgroup.procs"
`;
}

// Fixed source-bound entry point. No caller-provided command or adapter filtering.
export function remoteFiles(s) {
  validateState(s, s.round);
  const pack = `#!/bin/bash
set -euo pipefail
cd /bench
test -f exit-code
files=(run.log host.txt exit-code)
test ! -d campaign || files+=(campaign)
tar -czf results.tgz.tmp "\${files[@]}"
mv results.tgz.tmp results.tgz
`;
  const job = `#!/bin/bash
set -Eeuo pipefail
exec >>/bench/run.log 2>&1
{ date -u --iso-8601=seconds; uname -a; lscpu; free -m; df -h /; } > /bench/host.txt
finish() { code=$?; trap - EXIT; printf '%s\\n' "$code" > /bench/exit-code; timeout 600 /bin/bash /bench/pack.sh || true; exit "$code"; }
trap finish EXIT
${supervisorBootstrap(s.unit)}
timeout 900 cloud-init status --wait
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer || true
timeout 900 systemd-run --quiet --property=After=apt-daily.service --property=After=apt-daily-upgrade.service --wait /bin/true
export DEBIAN_FRONTEND=noninteractive
timeout 900 apt-get update -qq
timeout 900 apt-get install -y -qq software-properties-common curl ca-certificates build-essential
# https://git-scm.com/install/linux: Ubuntu's upstream stable Git PPA.
# Distribution Git may lack --no-lazy-fetch; never weaken immutable native queries.
timeout 900 add-apt-repository --yes ppa:git-core/ppa
timeout 900 apt-get update -qq
timeout 900 apt-get install -y -qq git
timeout 30 git --no-replace-objects --no-lazy-fetch --version >> /bench/host.txt
timeout 900 bash -o pipefail -c 'curl -fsSL https://get.docker.com | sh'
timeout 900 bash -o pipefail -c 'curl -fsSL https://deb.nodesource.com/setup_26.x | bash -'
timeout 900 apt-get install -y -qq nodejs
node -e 'if (process.versions.node.split(".")[0] !== "26") process.exit(1)'
systemctl enable --now docker
export GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1
timeout 600 git clone --quiet https://github.com/corten-run/corten.git /bench/repo
cd /bench/repo
git checkout --detach ${s.commit}
test "$(git rev-parse HEAD)" = ${s.commit}
test -z "$(git status --porcelain --untracked-files=all)"
test "$(nproc)" -ge 8
timeout 900 npm ci --no-audit --no-fund
timeout 900 npm --prefix bench/browser ci --no-audit --no-fund
timeout 900 npx --no-install playwright install --with-deps chromium
timeout 900 docker pull node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
timeout 900 bash -o pipefail -c 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal'
export PATH=/root/.cargo/bin:$PATH
{ docker --version; node --version; npm --version; rustc --version; cargo --version; } >> /bench/host.txt
# The entry derives all nine groups and their native settings from this measured source.
# Popular/performance views reuse the same evidence; no second workload execution.
unset BENCH_APPS BENCH_TIER BENCH_EDGE PROFILE
node bench/workloads/isolated/campaign-entry.mjs ${s.round} --commit ${s.commit} --state-dir /bench/campaign${s.group === undefined ? "" : ` --group ${s.group}`}
`;
  return { "job.sh": job, "pack.sh": pack, [s.unit]: `[Unit]
Description=Official grouped benchmark ${s.round}, pinned ${s.commit}
After=network-online.target
Wants=network-online.target
[Service]
Type=exec
ExecStart=/bin/bash /bench/job.sh
WorkingDirectory=/bench
Delegate=cpu cpuset memory pids
DelegateSubgroup=supervisor
Restart=no
RuntimeMaxSec=48h
TimeoutStopSec=120
KillMode=control-group
` };
}
