// Native fake CLI. Reads only this test's synthetic store/ledger, never a real
// credential store, provider, SSH endpoint or network connection.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";

const [original, ledgerPath, statePath, ...args] = process.argv.slice(2);
assert.ok(isAbsolute(original) && basename(dirname(original)).startsWith("groups-cloud-test-"));
assert.equal(basename(original), "synthetic-config.yaml");
assert.equal(dirname(original), dirname(ledgerPath));
const selected = args.includes("--config") ? args[args.indexOf("--config") + 1] : original;
const config = JSON.parse(readFileSync(selected)), ledger = JSON.parse(readFileSync(ledgerPath));
const context = args[args.indexOf("--context") + 1];
const credential = args.includes("--synthetic-rest-stdin") ? JSON.parse(readFileSync(0, "utf8")).credential : config["auth-contexts"]?.[context];
const account = credential === "SYNTHETIC_ONLY_CREDENTIAL_A" ? "A" : credential === "SYNTHETIC_ONLY_CREDENTIAL_B" ? "B" : null;
assert.ok(account, "unrecognized synthetic context");
let output;
if (args[0] === "auth" && args[1] === "token") output = credential;
else if (args[0] === "account" && args[1] === "get") {
  output = { uuid: account === "A" ? "synthetic-user-0001" : "synthetic-user-0002", droplet_limit: 20 };
} else {
  assert.deepEqual(args.slice(0, 2), ["compute", "droplet"]);
  if (args[2] === "list") output = ledger.hosts[account];
  else if (args[2] === "create") {
    const state = JSON.parse(readFileSync(statePath));
    const host = { id: 123, name: state.name, tags: ["corten-bench", "corten-bench-groups", state.tag],
      size_slug: state.host.size, region: { slug: state.host.region }, networks: { v4: [{ type: "public", ip_address: "192.0.2.10" }] } };
    ledger.hosts[account].push(host); ledger.mutations.push({ operation: "create", account }); output = [host];
  } else assert.fail("unsupported synthetic CLI operation");
  // Models another local actor restoring the saved context before the parent's
  // post-command account probe. It never writes an immutable --config view.
  if (ledger.restoreOriginal) {
    const restored = JSON.parse(readFileSync(original));
    restored["auth-contexts"][context] = "SYNTHETIC_ONLY_CREDENTIAL_A";
    writeFileSync(original, JSON.stringify(restored));
  }
}
ledger.calls.push({ command: args[0] === "auth" ? "consume" : args[0] === "account" ? "account" : args[2], account });
writeFileSync(ledgerPath, JSON.stringify(ledger));
process.stdout.write(args[0] === "auth" ? `${output}\n` : JSON.stringify(output));
