// Synthetic fixtures only. No native benchmark, provider or SSH process runs.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { controller } from "./droplet.mjs";
import { host, reservation, selection, tags } from "./cloud-contract.mjs";
import { digest } from "./cloud-local.mjs";
import { descriptor } from "../json-api/contract.mjs";
import { selectedApps } from "./registry.mjs";

export const commit = "a".repeat(40), campaign = "r21-0123456789abcdef", subject = "d".repeat(64);
export const userId = "synthetic-user-0001", accountId = `user:${userId}`, context = "synthetic-cloud-control";
export function syntheticDelivery(group = "json-api", subjectSha256 = subject) {
  const mixed = group === "mixed-production", prefix = mixed ? "mixed" : "json";
  const identities = mixed ? selectedApps(group).map((app) => ({ app, key: "mixed-native-source", payload: "marketplace-v2" }))
    : descriptor().apps.flatMap((app) => descriptor().cases.map((profile) => ({ app, ...profile })));
  return { schema: `benchmark-${prefix}-audit-delivery/v1`, subjectSha256,
    review: { reviewer: "synthetic-independent-reviewer", reviewedAt: "2026-11-13T12:00:00Z", subjectSha256, decision: "approved", findings: [] },
    bundle: { schema: mixed ? "mixed-native-source-audits/v1" : "json-api-native-audits/v1", receipts: identities.map((identity) => ({ identity })) } };
}
export function syntheticInspection(status = "blocked") {
  const selected = selection();
  const common = { schema: "benchmark-isolated-campaign-inspection/v1", scope: "intrinsic-evidence", status,
    round: "r21", commit, campaign, campaignSha256: "a".repeat(64), sourceSha256: "b".repeat(64), selection: selected,
    groups: selected.groups.map(({ group, apps }) => ({ group, outcome: "native-validated", bindingSha256: "c".repeat(64),
      nativeManifestSha256: "d".repeat(64), appOutcomes: apps.map((app) => ({ app, outcome: "passed", comparisonEligible: true })) })),
    blockers: [], collectionIntegrity: "manifest-verified", commandLifecycle: "observed-terminal", uncollectedNativeRoots: [],
    archiveTreeSha256: "e".repeat(64), reservationSha256: "f".repeat(64) };
  return status === "verified" ? common : { ...common, qualified: false, controllerReady: false, isolation: "unverified", deletionAuthorized: false, diagnostics: [] };
}
export function archive(entries = []) {
  const pieces = [];
  for (const { name, body = "", type = name.endsWith("/") ? "5" : "0", target = "" } of entries) {
    const bytes = Buffer.from(body), h = Buffer.alloc(512);
    h.write(name, 0, 100, "ascii"); h.write("0000600\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124); h.write("00000000000\0", 136);
    h.fill(32, 148, 156); h.write(type, 156); h.write(target, 157, 100, "ascii"); h.write("ustar\0", 257); h.write("00", 263);
    const sum = h.reduce((a, b) => a + b, 0); h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    pieces.push(h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...pieces, Buffer.alloc(1024)]));
}
export const metadata = () => [{ name: "run.log", body: "synthetic fake-only evidence\n" }, { name: "host.txt", body: "not a real host\n" }, { name: "exit-code", body: "1\n" }];
export function harness(t, flags = {}) {
  const temp = mkdtempSync(join(tmpdir(), "groups-cloud-test-"));
  t.after(() => { assert.ok(temp.startsWith(join(tmpdir(), "groups-cloud-test-"))); rmSync(temp, { recursive: true, force: true }); });
  const repo = join(temp, "repo"), base = join(temp, "control"), local = join(base, "groups-r21"), statePath = join(local, "state.json");
  mkdirSync(repo); mkdirSync(base);
  let s = { ...reservation({ round: "r21", commit, token: "0123456789abcdef" }), createIntentAt: new Date().toISOString(),
    status: "running", id: "123", ip: "192.0.2.10", provider: { accountId, context }, fullGroupQualified: false };
  const d = () => ({ id: 123, name: s.name, tags: [...tags, s.tag], size_slug: host.size, region: { slug: host.region },
    networks: { v4: [{ type: "public", ip_address: "192.0.2.10" }] } });
  const calls = []; let droplets = [], creates = 0, deletes = 0, units = 0, downloads = 0, inspections = 0;
  let bytes = archive([...metadata(), { name: "campaign/" }, { name: "campaign/fake.json", body: "{}" }]);
  const good = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const report = () => syntheticInspection(flags.reportStatus);
  const run = (binary, args, timeout, allowFail) => {
    calls.push([binary, ...args]); assert.ok(timeout > 0 && timeout <= 15 * 60000);
    if (flags.cancelAt?.(binary, args, calls)) flags.cancelled = true;
    if (flags.hook) flags.hook(binary, args);
    if (binary === "git") {
      if (flags.gitError) throw new Error("fake git failure");
      if (args[0] === "rev-parse") return good(args[1] === "HEAD" ? flags.wrongHead ? "b".repeat(40) : commit : repo);
      if (args[0] === "status") return good(flags.dirty ? " M README.md" : "");
      return good();
    }
    if (binary === "doctl") {
      assert.equal(args[args.indexOf("--context") + 1], context, "synthetic provider context must be pinned");
      if (args[0] === "auth" && args[1] === "token") return good("SYNTHETIC_ONLY_CREDENTIAL_A\n");
      if (args[0] === "account") return good(JSON.stringify({ uuid: flags.accountId ?? userId,
        ...(flags.teamId === undefined ? {} : { team: { uuid: flags.teamId } }), droplet_limit: flags.noCapacity ? 0 : 20 }));
      if (args[2] === "list") { if (flags.listError) throw new Error("fake list failure"); return good(JSON.stringify(droplets)); }
      if (args[2] === "create") {
        creates++; s = JSON.parse(readFileSync(statePath)); assert.equal(s.status, "creating"); assert.ok(s.createIntentAt);
        droplets = flags.createMissing ? [] : flags.createAmbiguous ? [d(), { ...d(), id: 124 }] : [d()];
        if (flags.createCrash) throw new Error("simulated crash after create");
        return flags.createLost ? { status: null, error: new Error("fake timeout"), stdout: "", stderr: "" } : flags.createRejected ? { ...good(), status: 1 } : good();
      }
      if (args[2] === "delete") {
        deletes++; assert.equal(args[3], "123"); const saved = JSON.parse(readFileSync(statePath));
        assert.ok(saved.archiveSha256 && saved.evidenceSha256 && saved.deletionIntentAt); assert.equal(saved.fullGroupQualified, false);
        if (flags.deleteError) throw new Error("fake deletion error");
        if (!flags.deleteUnconfirmed) droplets = [];
        if (flags.deleteLost) throw new Error("fake deletion acknowledgement lost"); return flags.deleteRejected ? { ...good(), status: 1 } : good();
      }
    }
    if (binary === "ssh") {
      const script = args.at(-1);
      assert.ok(args.includes(`root@${JSON.parse(readFileSync(statePath)).ip}`));
      if (script === "true") return flags.noSsh ? { ...good(), status: 255 } : good();
      if (script.startsWith("systemctl show")) {
        units++; if (flags.unitError) throw new Error("fake unit failure");
        return good(`Id=${flags.wrongUnit ? "foreign.service" : s.unit}\nLoadState=${flags.missingUnit ? "not-found" : "loaded"}\nFragmentPath=/etc/systemd/system/${s.unit}\nActiveState=${flags.active || flags.activeAfterDownload && downloads ? "active" : "inactive"}\nRestart=${flags.restart ? "always" : "no"}\nMainPID=${flags.livePid ? "1" : "0"}\nExecMainCode=1\nExecMainStartTimestamp=Fri 2026-11-13 00:00:00 UTC\n`);
      }
      if (script === "sha256sum /bench/results.tgz") return good(`${flags.wrongHash ? "f".repeat(64) : digest(bytes)}  /bench/results.tgz\n`);
      if (script.startsWith("systemctl start") && flags.startLost) throw new Error("fake start acknowledgement lost");
      if (script.startsWith("node -e")) { if (flags.auditCollision) throw new Error("fake inbox collision"); return good(`${subject}\n`); }
      if (script.includes("pack.sh") && flags.packError) throw new Error("fake pack failure");
      return good();
    }
    if (binary === "scp") {
      if (args.at(-2).startsWith("root@")) {
        downloads++; assert.ok(existsSync(args.at(-1))); writeFileSync(args.at(-1), flags.corrupt ? "corrupt" : bytes);
        if (flags.downloadError) throw new Error("fake interrupted download");
      }
      return good();
    }
    assert.fail(`unexpected fake process ${binary}; allowFail=${allowFail}`);
  };
  return { temp, repo, base, local, statePath, flags, calls, report, run,
    get creates() { return creates; }, get deletes() { return deletes; }, get units() { return units; }, get inspections() { return inspections; },
    seed() { mkdirSync(local); writeFileSync(statePath, JSON.stringify(s)); droplets = [d()]; },
    saved() { return JSON.parse(readFileSync(statePath)); },
    change(fn) { const value = this.saved(); fn(value); writeFileSync(statePath, JSON.stringify(value)); },
    hosts(value) { droplets = value ?? [d()]; }, setArchive(value) { bytes = value; },
    task(deps = {}, options = {}) {
      return controller({ round: "r21", stateDir: base, collect: true, ...options }, { run, repo, sleep: async () => {}, interrupted: () => flags.cancelled,
        inspect: async (input) => { inspections++; assert.deepEqual(input, { folder: join(local, this.saved().evidence, "campaign"), round: "r21", commit }); return report(); }, ...deps });
    },
    launch(deps = {}) { return this.task(deps, { collect: undefined, detach: true, commit, sshKey: "42", accountId, context }); },
  };
}

// REST boundary for production-composition tests. All calls remain synthetic;
// translating back to the original fake preserves its state/ownership assertions.
export function syntheticProviderRequest(h, run = h.run) {
  let created;
  return async ({ method, path, body, timeout, credential }) => {
    assert.ok(credential === "SYNTHETIC_ONLY_CREDENTIAL_A");
    let args;
    if (path === "/v2/account") args = ["account", "get", "--output", "json"];
    else if (method === "GET" && path.startsWith("/v2/droplets?")) args = ["compute", "droplet", "list", "--output", "json"];
    else if (method === "POST" && path === "/v2/droplets") args = ["compute", "droplet", "create", body.name, "--size", body.size, "--region", body.region,
      "--image", body.image, "--ssh-keys", String(body.ssh_keys[0]), "--tag-names", body.tags.join(","), "--wait", "--output", "json"];
    else if (method === "DELETE") args = ["compute", "droplet", "delete", path.split("/").at(-1), "--force"];
    else {
      assert.equal(path, "/v2/actions/456");
      return { status: 200, value: { action: { id: 456, type: "create", resource_id: created.id, resource_type: "droplet", status: "completed" } } };
    }
    const result = await run("doctl", [...args, "--context", context], timeout, true);
    if (result.error || result.signal || !Number.isInteger(result.status)) throw new Error("synthetic request uncertain");
    if (result.status !== 0) return { status: 500, value: null };
    if (path === "/v2/account") return { status: 200, value: { account: JSON.parse(result.stdout) } };
    if (method === "GET") {
      const droplets = JSON.parse(result.stdout); return { status: 200, value: { droplets, meta: { total: droplets.length }, links: {} } };
    }
    if (method === "DELETE") return { status: 204, value: null };
    const state = h.saved();
    created = { id: 123, name: state.name, tags: [...tags, state.tag], size_slug: state.host.size,
      region: { slug: state.host.region }, networks: { v4: [{ type: "public", ip_address: "192.0.2.10" }] } };
    return { status: 202, value: { droplet: created, links: { actions: [{ id: 456, rel: "create", href: "https://api.digitalocean.com/v2/actions/456" }] } } };
  };
}
