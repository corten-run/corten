import assert from "node:assert/strict";
import test from "node:test";
import { apps } from "./contract.mjs";
import { cohorts, groupApps, groupNames, scheduledGroup } from "./groups.mjs";
import { inventory, parseArgs } from "./run-contract.mjs";
import { nightly, parseDropletArgs, remoteFiles, validateState } from "./droplet-contract.mjs";

test("popular and performance candidates form one deduplicated production run, without an axum anchor", () => {
  assert.deepEqual(groupApps("production"), [...new Set(["corten", ...Object.values(cohorts).flat()])]);
  assert.deepEqual(groupApps("production-qualify"), [...apps]);
  for (const group of groupNames) {
    const selected = groupApps(group);
    assert.equal(new Set(selected).size, selected.length);
    assert.ok(selected.includes("corten"));
    if (group !== "production-qualify") { assert.ok(selected.length < apps.length); assert.ok(!selected.includes("axum-maud")); }
  }
  assert.ok([20, 21, 22, 23].every((n) => scheduledGroup(`r${n}`) === "production"));
  assert.throws(() => groupApps("best"));
});
test("official groups are exact, never arbitrary adapter filters", () => {
  for (const group of groupNames) {
    assert.deepEqual(parseArgs(["r20", "--group", group], inventory).apps, groupApps(group));
    assert.throws(() => parseArgs(["r20", "--group", group, "--apps", "corten"], inventory));
  }
  for (const flags of [["--group"], ["--group", "native", "--group", "full"], ["--group", "absent"]]) {
    assert.throws(() => parseArgs(["r20", ...flags], inventory));
  }
});
test("launcher reserves exact membership and carries selection through the remote command", () => {
  const flags = ["r20", "--detach", "--ssh-key", "42", "--state-dir", "../state"];
  assert.equal(parseDropletArgs(flags).group, "production");
  assert.equal(parseDropletArgs([...flags, "--group", "production-popular"]).group, "production-popular");
  assert.throws(() => parseDropletArgs(["r20", "--collect", "--state-dir", "../state", "--group", "production"]));
  const s = { round: "r20", workload: "marketplace-v2", name: "corten-marketplace-r20", unit: "corten-marketplace-r20.service",
    tag: "corten-marketplace-run-0123456789abcdef", commit: "a".repeat(40), options: nightly,
    group: "production", apps: groupApps("production") };
  validateState(s, "r20");
  assert.match(remoteFiles(s)["job.sh"], / --group production\n/);
  assert.throws(() => validateState({ ...s, apps: ["corten"] }, "r20"));
  assert.throws(() => validateState({ ...s, group: "full" }, "r20"));
});
