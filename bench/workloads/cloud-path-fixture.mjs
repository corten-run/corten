// Synthetic filesystem failures only. No provider or native benchmark runs.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controller } from "./droplet.mjs";
import { productionMain } from "./cloud-production.mjs";

const parent = process.argv[3];
assert.ok(parent.startsWith(join(tmpdir(), "groups-cloud-test-")));
const temp = fs.mkdtempSync(join(parent, "cloud-path-test-")), repo = join(temp, "repo");
fs.mkdirSync(repo);
const code = process.argv[2], stateDir = code === "windows" ? process.argv[4] : join(temp, "missing", "state");
const exists = fs.existsSync, stat = fs.statSync;
let calls = 0;
try {
  if (code !== "windows") {
    assert.ok(["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"].includes(code));
    fs.existsSync = () => false;
    fs.statSync = () => { throw Object.assign(new Error("synthetic filesystem failure"), { code }); };
    syncBuiltinESMExports();
  }
  const options = { round: "r21", stateDir, detach: true, commit: "a".repeat(40), sshKey: "42", accountId: "user:synthetic-user-0001", context: "synthetic-cloud-control" };
  await assert.rejects(productionMain(["r21", "--state-dir", stateDir, "--detach", "--commit", options.commit, "--ssh-key", "42", "--account-id", options.accountId, "--context", options.context, "--print-approval"],
    { repo, spawn() { calls++; assert.fail("unexpected process"); }, write() { assert.fail("unexpected approval"); } }), /state path missing or inaccessible/);
  assert.throws(() => controller(options, { repo, run() { calls++; assert.fail("unexpected process"); } }), /state path missing or inaccessible/);
  assert.equal(calls, 0);
  console.log(JSON.stringify({ code, calls, bounded: true }));
} finally {
  fs.existsSync = exists; fs.statSync = stat; syncBuiltinESMExports();
  assert.ok(temp.startsWith(join(parent, "cloud-path-test-")));
  fs.rmSync(temp, { recursive: true, force: true });
}
