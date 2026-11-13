import assert from "node:assert/strict";
import test from "node:test";
import { host, ownedDroplet, reservation, roundName, safeArchive, selection, tags, terminalUnit, validateState } from "./cloud-contract.mjs";
import { groupNames, selectedApps } from "./registry.mjs";

const state = () => reservation({ round: "r21", commit: "a".repeat(40), token: "0123456789abcdef" }, "2026-11-13T00:00:00.000Z");
const droplet = (s) => ({ id: 123, name: s.name, tags: [...tags, s.tag], size_slug: host.size, region: { slug: host.region },
  networks: { v4: [{ type: "public", ip_address: "192.0.2.10" }] } });
const unit = (s) => `Id=${s.unit}\nLoadState=loaded\nFragmentPath=/etc/systemd/system/${s.unit}\nActiveState=inactive\nRestart=no\nMainPID=0\nExecMainCode=1\nExecMainStartTimestamp=Fri 2026-11-13 00:00:00 UTC\n`;
test("campaign identity retains the complete current registry, without qualifying it", () => {
  const s = state(); assert.equal(validateState(s, "r21"), s);
  assert.deepEqual(s.selection, selection()); assert.deepEqual(s.selection.groups.map((g) => g.group), groupNames);
  for (const g of s.selection.groups) assert.deepEqual(g.apps, selectedApps(g.group));
  assert.equal(s.ready, undefined); assert.equal(s.complete, undefined);
  for (const value of ["r0", "r01", "r21\n", "r21/../", "r1;true", "c2", "r9999999999"]) assert.throws(() => roundName(value));
  for (const change of [(s) => s.selection.groups.pop(), (s) => s.selection.groups[0].apps.pop(), (s) => s.name = "corten-catalog-c1",
    (s) => s.commit += "\n", (s) => s.token += "\n", (s) => s.createdAt = "2026-02-30T00:00:00.000Z",
    (s) => s.id = "123\n", (s) => s.ip = "999.0.0.1", (s) => s.extractionAttempts = ["../x"]]) {
    const changed = state(); change(changed); assert.throws(() => validateState(changed, "r21"));
  }
});
test("owned host requires exact ID/name/tags/type/region and known IP", () => {
  const s = state(), d = droplet(s); assert.equal(ownedDroplet([d], s), d);
  s.id = "123"; s.ip = "192.0.2.10";
  assert.equal(ownedDroplet([d], s), d);
  for (const changed of [{ id: 124 }, { name: "other" }, { tags: [s.tag] }, { size_slug: "s-8vcpu-16gb" }, { region: { slug: "nyc1" } },
    { networks: { v4: [{ type: "private", ip_address: s.ip }] } }]) assert.throws(() => ownedDroplet([{ ...d, ...changed }], s));
  assert.throws(() => ownedDroplet([d, d], s)); assert.throws(() => ownedDroplet([], s));
});
test("terminal identity never treats an active or unstarted unit as safe for deletion", () => {
  const s = state(), output = unit(s); assert.equal(terminalUnit(output, s), true);
  assert.equal(terminalUnit(output.replace("ActiveState=inactive", "ActiveState=active"), s), false);
  for (const [before, after] of [[s.unit, "other.service"], ["Restart=no", "Restart=always"], ["LoadState=loaded", "LoadState=not-found"],
    ["MainPID=0", "MainPID=1"], ["ExecMainCode=1", "ExecMainCode=0"], ["Fri 2026-11-13 00:00:00 UTC", "n/a"]])
    assert.throws(() => terminalUnit(output.replace(before, after), s));
  assert.throws(() => terminalUnit(output + "MainPID=0\n", s));
});
test("deletion state needs a preserved terminal evidence outcome, never a success boolean", () => {
  const s = state(); s.status = "collected"; s.id = "123"; s.ip = "192.0.2.10"; s.deletionIntentAt = s.createdAt;
  assert.throws(() => validateState(s, s.round));
  Object.assign(s, { collectedAt: s.createdAt, archiveSha256: "b".repeat(64), evidenceSha256: "c".repeat(64),
    extractionAttempts: ["evidence-abc"], evidence: "evidence-abc", evidenceOutcome: "blocked" });
  assert.equal(validateState(s, s.round), s); // Preserved blocked data is not a validated baseline.
  s.evidenceOutcome = true; assert.throws(() => validateState(s, s.round));
});
test("archive keeps raw campaign and required host metadata but rejects hostile filesystem entries", () => {
  const metadata = ["run.log", "host.txt", "exit-code"], names = [...metadata, "campaign/", "campaign/group/native/summary.json"];
  const check = (entries, types = entries.map((p) => `${p.endsWith("/") ? "d" : "-"}rwxr-xr-x entry`)) => safeArchive(entries.join("\n") + "\n", types.join("\n") + "\n");
  check(names);
  for (const path of ["/root/secret", "campaign/../x", "campaign/a/../../x", "campaign/./x", "campaign//x", "campaign/con.txt", "campaign/x.",
    "campaign", "campaign/x:stream", "campaign\\x", "repo/code", "campaign/a\nb", "campaign/link -> /tmp", `campaign/${"x/".repeat(65)}z`, `campaign/${"x".repeat(4096)}`])
    assert.throws(() => check([...metadata, path]));
  for (const additions of [["campaign/a", "campaign/a/b"], ["campaign/a/b", "campaign/a"], ["campaign/A", "campaign/a"], ["campaign/a/", "campaign/a"]])
    assert.throws(() => check([...metadata, ...additions]));
  for (const type of ["l", "h", "b", "c", "p", "s"]) assert.throws(() => check(names, names.map((p, i) => `${i === 4 ? type : p.endsWith("/") ? "d" : "-"}rwx entry`)));
  assert.throws(() => check(names.slice(1))); assert.throws(() => safeArchive(names.join("\n"), "-one"));
});
test("listing terminators cannot erase hostile member bytes and implicit parents retain casing", () => {
  const check = (names) => safeArchive(names.join("\n") + "\n", names.map(() => "-rwxr-xr-x entry").join("\n") + "\n");
  for (const last of ["exit-code ", "exit-code\t", "exit-code\v", "exit-code\f"])
    assert.throws(() => check(["run.log", "host.txt", last]));
  for (const paths of [["campaign/A/x.json", "campaign/a/y.json"], ["campaign/A/x.json", "campaign/a/"],
    ["campaign/a/", "campaign/A/y.json"]]) {
    const names = ["run.log", "host.txt", "exit-code", ...paths];
    assert.throws(() => safeArchive(names.join("\n") + "\n", names.map((p) => `${p.endsWith("/") ? "d" : "-"}rwx entry`).join("\n") + "\n"));
  }
});
