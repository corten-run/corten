// Provider identity and transport boundaries only. This module cannot launch or qualify a run.
import assert from "node:assert/strict";
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
export function reservation({ round, commit, token }, createdAt = new Date().toISOString()) {
  roundName(round);
  full(commit, /[a-f0-9]{40}/, "measured commit");
  full(token, /[a-f0-9]{16}/, "ownership token");
  const name = `corten-bench-groups-${round}-${token}`;
  return validateState({ schema: "benchmark-group-host/v1", round, commit, token, name,
    tag: `corten-bench-groups-run-${token}`, unit: `${name}.service`, host: { ...host },
    selection: selection(), createdAt, status: "reserved" }, round);
}
export function validateState(s, round) {
  assert.ok(s && typeof s === "object" && !Array.isArray(s), "host state required");
  assert.equal(s.schema, "benchmark-group-host/v1");
  assert.equal(s.round, roundName(round));
  full(s.commit, /[a-f0-9]{40}/, "measured commit");
  full(s.token, /[a-f0-9]{16}/, "ownership token");
  assert.equal(s.name, `corten-bench-groups-${round}-${s.token}`);
  assert.equal(s.tag, `corten-bench-groups-run-${s.token}`);
  assert.equal(s.unit, `${s.name}.service`);
  assert.deepEqual(s.host, host);
  assert.deepEqual(s.selection, selection(), "complete current registry selection differs");
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
export function safeArchive(entries, verbose) {
  assert.equal(typeof entries, "string"); assert.equal(typeof verbose, "string");
  assert.ok(entries.length <= 16 * 1024 ** 2 && verbose.length <= 32 * 1024 ** 2, "archive listing size limit");
  const names = entries.trimEnd().split(/\r?\n/), types = verbose.trimEnd().split(/\r?\n/), seen = new Set(), files = new Set(), parents = new Set();
  assert.ok(names.length <= 100000, "archive entry limit");
  assert.equal(names.length, types.length, "archive listings differ");
  for (let i = 0; i < names.length; i++) {
    const name = names[i], path = name.endsWith("/") ? name.slice(0, -1) : name;
    full(name, /[A-Za-z0-9_./-]+/, "archive member");
    assert.ok(name.length <= 4096, "archive member size limit");
    const parts = path.split("/");
    assert.ok(parts.length <= 64 && parts.every((p) => p && p !== "." && p !== ".." && !p.endsWith(".")
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), "unsafe archive path");
    assert.ok(!seen.has(path.toLowerCase()), "duplicate archive path"); seen.add(path.toLowerCase());
    assert.ok(/^[d-]/.test(types[i]), "archive link or special file");
    assert.equal(types[i][0] === "d", name.endsWith("/"), "archive path/type mismatch");
    assert.ok(path === "campaign" || path.startsWith("campaign/") || ["run.log", "host.txt", "exit-code"].includes(path), "foreign archive member");
    if (path === "campaign") assert.equal(types[i][0], "d", "campaign root must be a directory");
    if (!path.startsWith("campaign/") && path !== "campaign") assert.equal(types[i][0], "-", "metadata must be a regular file");
    // A file cannot later become a parent; likewise a directory cannot replace a file.
    for (let j = 1; j < parts.length; j++) {
      const parent = parts.slice(0, j).join("/").toLowerCase();
      assert.ok(!files.has(parent), "archive file used as parent"); parents.add(parent);
    }
    if (types[i][0] === "-") {
      assert.ok(!parents.has(path.toLowerCase()), "archive parent replaces existing child");
      files.add(path.toLowerCase());
    }
  }
  for (const name of ["run.log", "host.txt", "exit-code"]) assert.ok(seen.has(name), `missing ${name}`);
}
