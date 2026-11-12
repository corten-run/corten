import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apps, locales, workload } from "./contract.mjs";
import { records } from "./fixtures.mjs";
import { anchors, cpuSettings, inventory, maxDroplets, parseArgs, parsePart, partName, phases, resultSchema, sources, splitApps, stageAggregate, timedProfiles } from "./run-contract.mjs";
import { leftoverDroplets, nightly, parseDropletArgs, remoteFiles, safeArchive, splitExit, splitPlan, validatePlan, validateState } from "./droplet-contract.mjs";
import { report, validateSummary } from "./report.mjs";
import { compare } from "./compare.mjs";
import { betweenDroplets, mergeParts } from "./split.mjs";
import { launcherSignals, processRuns, splitController, splitDryRun } from "./droplet.mjs";

const commit = "a".repeat(40);
// A whole round shaped like run.mjs writes it: app i serves 1000 + 37i + pass requests per phase.
function full(round = "r17") {
  const s = { schema: resultSchema, workload, round, runId: `marketplace-${round}-0000000000`, commit, dirty: false, complete: true, checksPassed: true,
    failures: [], cleanupFailures: [], finishedCommit: commit, finishedDirty: false,
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T01:00:00.000Z", options: { round, build: true, apps, checkOnly: false, ...nightly, startupTimeout: 120 }, apps: {},
    host: { cpu: "Synthetic CPU", onlineCpus: "0-7", platform: "test", release: "test", node: "test", docker: "test" }, tools: Object.fromEntries(["upstream", "checker", "k6"].map((k) => [k, { imageId: `sha256:${"b".repeat(64)}` }])),
    fixtureSha256: createHash("sha256").update(JSON.stringify(records())).digest("hex"), measurement: { profiles: timedProfiles, upstream: "Synthetic test only", cpuWindow: "Not measured", coldClock: "Synthetic test only", cpus: cpuSettings({}), encoding: "identity", fixedRate: 150, appMemoryBytes: 2 ** 30, upstreamMemoryBytes: 512 * 2 ** 20 } };
  apps.forEach((app, i) => {
    const a = s.apps[app] = { label: app, imageId: `sha256:${"b".repeat(64)}`, builtCommit: commit, builtDirty: false, checks: {}, runs: {}, phases: {} };
    for (const source of sources) {
      a.checks[source] = { workload, source, jsonRecords: 500, pages: 264, profiles: locales.flatMap((locale) => [false, true].flatMap((javaScriptEnabled) => [false, true].map((mobile) => ({ locale, javaScriptEnabled, mobile, passed: true })))),
        upstream: source === "api" ? { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true } : null };
      for (const { key, locale, target } of timedProfiles.filter((p) => p.source === source)) {
        const warmup = { requests: 1000, rps: 1000, p50: 1, p95: 2, p99: 3, failed: 0, failedRate: 0, dropped: 0, checksFailed: 0, appOutcome: false };
        a.runs[key] = [1, 2, 3].map((pass) => {
          const stats = { cpuUsec: 1000000, samples: 3, cpuAvgPct: 100, cpuMaxPct: 110, memAvgMiB: 10, memMaxMiB: 11 };
          const n = 1000 + 37 * i + pass;
          return { pass, locale, complete: true, startedAt: "2026-01-01T00:01:00.000Z", finishedAt: "2026-01-01T00:03:00.000Z",
            cold: { containerStartedAt: "2026-01-01T00:02:00.000Z", first200At: "2026-01-01T00:02:01.000Z", first200MsFromContainerStart: 1000, measuredBeforeReadinessOrWarmup: true, path: target === "json" ? "/api/marketplace/item_1" : `/marketplace/${locale}/item_1`, attempts: 1, bytes: 100, successfulRequestMs: 1 },
            warmup, phases: Object.fromEntries(phases.map((p) => [p, { ...warmup, ...stats, requests: n, rps: n, perCpuSecond: n, upstream: source === "api" ? { ...stats, cpuAvgPct: 50, highCpu: false } : null }])) };
        });
        a.phases[key] = Object.fromEntries(phases.map((p) => [p, stageAggregate(a.runs[key], p, 3)]));
      }
    }
  });
  return s;
}
// One app's numbers on a faster or slower machine: f times the requests in every phase.
function scale(a, f) {
  for (const [key, runs] of Object.entries(a.runs)) {
    for (const run of runs) for (const p of Object.values(run.phases)) { p.requests = Math.round(p.requests * f); p.rps = p.requests; p.perCpuSecond = p.requests / (p.cpuUsec / 1e6); }
    a.phases[key] = Object.fromEntries(phases.map((p) => [p, stageAggregate(runs, p, 3)]));
  }
}
// Droplet k's part of a round split n ways, as run.mjs --part k/n writes it.
function part(k, n, { round = "r17", anchorScale = {} } = {}) {
  const s = full(round), share = splitApps(n)[k - 1];
  s.options = { ...s.options, apps: share, part: { index: k, of: n } };
  s.apps = Object.fromEntries(share.map((app) => [app, s.apps[app]]));
  s.runId = `marketplace-${round}-d${k}`;
  s.host = { ...s.host, cpu: `Synthetic CPU d${k}` };
  if (k > 1) s.finishedAt = `2026-01-01T01:00:0${k}.000Z`;
  for (const [app, f] of Object.entries(anchorScale)) scale(s.apps[app], f);
  return validateSummary(s);
}
const merged = (n, options = {}) => validateSummary(mergeParts(options.round ?? "r17", Array.from({ length: n }, (_, i) => part(i + 1, n, i === 1 ? options : { round: options.round }))));

test("a split gives every droplet both anchors and each other app to exactly one droplet, in catalog order", () => {
  assert.deepEqual(anchors, ["corten", "axum-maud"]);
  for (let n = 2; n <= maxDroplets; n++) {
    const shares = splitApps(n);
    assert.equal(shares.length, n);
    for (const share of shares) {
      for (const anchor of anchors) assert.ok(share.includes(anchor));
      assert.deepEqual(share, apps.filter((app) => share.includes(app)), "catalog order");
    }
    for (const app of apps.filter((a) => !anchors.includes(a))) assert.equal(shares.filter((s) => s.includes(app)).length, 1, app);
  }
  assert.deepEqual(splitApps(2)[0].slice(0, 3), ["corten", "nextjs", "sveltekit"]);
  for (const n of [0, 1, maxDroplets + 1, 2.5, "2"]) assert.throws(() => splitApps(n));
  assert.deepEqual(parsePart("2/3"), { index: 2, of: 3 });
  for (const bad of ["4/3", "0/3", "1/1", "2", "a/b", " 1/2", { index: 1, of: 2, extra: true }]) assert.throws(() => parsePart(bad));
  assert.equal(partName("r17", { index: 2, of: 3 }), "r17-d2"); assert.equal(partName("r17", null), "r17");
});

test("run.mjs --part measures one droplet's share of an official round, and only with --part", () => {
  const options = parseArgs(["r17", "--part", "2/3", "--build", "--passes", "3"], inventory);
  assert.deepEqual(options.apps, splitApps(3)[1]); assert.deepEqual(options.part, { index: 2, of: 3 }); assert.equal(options.build, true);
  assert.equal(parseArgs(["r17", "--build"], inventory).part, undefined);
  assert.ok(!("part" in parseArgs(["r17"], inventory)), "a whole round's options are unchanged");
  for (const args of [["r17", "--apps", "corten"], ["r17", "--part", "2/3", "--apps", "corten"], ["r17", "--part", "4/3"], ["r17", "--part", "1/2", "--part", "1/2"], ["r17", "--part"]]) assert.throws(() => parseArgs(args, inventory), args.join(" "));
});

test("--droplets splits a launch, 1 is today's one-droplet round, and collect reads the plan instead", () => {
  const one = parseDropletArgs(["r17", "--detach", "--ssh-key", "42", "--state-dir", "s"]);
  assert.deepEqual(parseDropletArgs(["r17", "--detach", "--ssh-key", "42", "--state-dir", "s", "--droplets", "1"]), one);
  assert.equal(parseDropletArgs(["r17", "--plan", "--ssh-key", "42", "--state-dir", "s", "--droplets", "3"]).droplets, 3);
  for (const bad of [["--droplets", "0"], ["--droplets", "x"], ["--droplets", String(maxDroplets + 1)], ["--droplets"]]) assert.throws(() => parseDropletArgs(["r17", "--detach", "--ssh-key", "42", "--state-dir", "s", ...bad]), bad.join(" "));
  assert.throws(() => parseDropletArgs(["r17", "--collect", "--state-dir", "s", "--droplets", "2"]), /reads the split/);
});

test("a part's state, remote job and archive name its droplet and run only its share", () => {
  const s = { workload: "marketplace-v2", round: "r17", commit, options: nightly, name: "corten-marketplace-r17-d2", unit: "corten-marketplace-r17-d2.service",
    tag: "corten-marketplace-run-0123456789abcdef", part: { index: 2, of: 3 } };
  validateState(s, "r17");
  assert.throws(() => validateState({ ...s, name: "corten-marketplace-r17" }, "r17"));
  assert.throws(() => validateState({ ...s, part: { index: 4, of: 3 } }, "r17"));
  const files = remoteFiles(s);
  assert.match(files["job.sh"], /marketplace\/run.mjs r17 --part 2\/3 --build --passes 3 --duration 15 --warmup 10 --rate 150/);
  assert.match(files["job.sh"], /report.mjs bench\/marketplace\/results\/r17\/d2\/summary.json/);
  assert.match(files["pack.sh"], /files\+=\(repo\/bench\/marketplace\/results\/r17\/d2\)/);
  assert.match(files[s.unit], /Description=Localized marketplace r17 d2 of 3, 8 apps, three passes/);
  safeArchive("run.log\nexit-code\nrepo/bench/marketplace/results/r17/d2/summary.json\n", "-rw file", "r17", { index: 2, of: 3 });
  assert.throws(() => safeArchive("repo/bench/marketplace/results/r17/d1/summary.json", "-rw file", "r17", { index: 2, of: 3 }));
  assert.throws(() => safeArchive("repo/bench/marketplace/results/r17/summary.json", "-rw file", "r17", { index: 2, of: 3 }));
});

test("the plan records the commit once and must be the split of the apps", () => {
  const plan = splitPlan("r17", 2, commit, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(plan.parts.map((p) => p.name), ["corten-marketplace-r17-d1", "corten-marketplace-r17-d2"]);
  assert.equal(validatePlan(structuredClone(plan), "r17").commit, commit);
  for (const change of [(p) => { p.parts[0].apps.pop(); }, (p) => { delete p.commit; }, (p) => { p.tree = "c".repeat(40); }, (p) => { p.round = "r18"; }, (p) => { p.droplets = 3; }, (p) => { p.options = { ...nightly, passes: 1 }; }]) {
    const bad = structuredClone(plan); change(bad); assert.throws(() => validatePlan(bad, "r17"));
  }
});

test("a split collection's exit: errors, leftovers and unknown codes first, then running, then partial", () => {
  assert.equal(splitExit([0, 0]), 0);
  assert.equal(splitExit([0, 3]), 3);
  assert.equal(splitExit([1, 3]), 3);
  assert.equal(splitExit([1, 0]), 1);
  assert.equal(splitExit(["missing", 0]), 1);
  assert.equal(splitExit([2, 3]), 2);
  assert.equal(splitExit([0, 0], 1), 2);
});

test("droplets named for a part but owned by no live part are leftovers", () => {
  const plan = splitPlan("r17", 2, commit);
  const d = (id, name, tags = []) => ({ id, name, tags });
  const live = { id: "101", tag: "corten-marketplace-run-1111111111111111" };
  assert.deepEqual(leftoverDroplets([d(101, "corten-marketplace-r17-d1"), d(7, "corten-catalog-c1"), d(8, "corten-marketplace-r18-d1")], plan, [live, null]), []);
  const extra = d(103, "corten-marketplace-r17-d3"), unreserved = d(102, "corten-marketplace-r17-d2"), duplicate = d(104, "corten-marketplace-r17-d1"), gone = d(101, "corten-marketplace-r17-d1");
  assert.deepEqual(leftoverDroplets([extra, unreserved, duplicate], plan, [live, null]), [extra, unreserved, duplicate]);
  assert.deepEqual(leftoverDroplets([gone], plan, [{ ...live, destroyedAt: "2026-01-01T00:00:00Z" }, null]), [gone]);
  assert.deepEqual(leftoverDroplets([d(105, "corten-marketplace-r17-d2", [live.tag])], plan, [null, { tag: live.tag }]), [], "an ambiguous create is matched by its tag");
});

test("droplets' parts merge into one round of twenty apps, each from its own droplet, anchors on every droplet", () => {
  const parts = [part(1, 2), part(2, 2)];
  const s = validateSummary(mergeParts("r17", parts));
  assert.deepEqual(Object.keys(s.apps), apps);
  assert.equal(s.apps.corten, parts[0].apps.corten);
  assert.equal(s.apps.nextjs, parts[0].apps.nextjs); assert.equal(s.apps["tanstack-start"], parts[1].apps["tanstack-start"]);
  assert.deepEqual(s.split.parts.map((p) => p.host.cpu), ["Synthetic CPU d1", "Synthetic CPU d2"]);
  assert.equal(s.split.parts[1].anchors["axum-maud"], parts[1].apps["axum-maud"]);
  assert.equal(s.finishedAt, parts[1].finishedAt); assert.equal(s.options.part, undefined);
  for (const [k, change] of [[2, (v) => { v.commit = "d".repeat(40); }], [2, (v) => { v.options.duration = 60; }], [2, (v) => { v.options.part = { index: 1, of: 2 }; }], [2, (v) => { v.measurement = { ...v.measurement, encoding: "gzip" }; }]]) {
    const bad = structuredClone(parts); change(bad[k - 1]); assert.throws(() => mergeParts("r17", bad));
  }
  assert.throws(() => mergeParts("r18", parts));
  for (const change of [(v) => { v.split.parts[1].apps.pop(); }, (v) => { delete v.split.parts[1].anchors.corten; }, (v) => { v.split.parts[0].host = { ...v.split.parts[0].host, cpu: "other" }; },
    (v) => { v.split.parts[1].anchors.corten.phases["fixture-en-US-page"].sat64.rps.median++; }, (v) => { v.split.parts[1].startedAt = "2025-12-31T00:00:00.000Z"; }, (v) => { v.options.part = { index: 1, of: 2 }; }]) {
    const bad = structuredClone(s); change(bad); assert.throws(() => validateSummary(bad));
  }
  assert.throws(() => validateSummary({ ...parts[1], apps: { ...parts[1].apps, nextjs: undefined } }));
});

test("a merged round prints every droplet's anchors in every table, with each app's ratio to its own Corten", () => {
  const text = report(merged(2));
  assert.match(text, /^# Marketplace v2 r17 \(split across 2 droplets\)$/m);
  assert.match(text, /CPU: d1 Synthetic CPU d1 \(online CPUs 0-7\); d2 Synthetic CPU d2 \(online CPUs 0-7\)\./);
  assert.match(text, /on their own droplet before that droplet's load/);
  const tables = text.split("\n").filter((l) => l.startsWith("| Framework |"));
  assert.equal(tables.length, 8 * 4);
  for (const header of tables) assert.match(header, /^\| Framework \| Droplet \|/);
  for (const header of tables.filter((h) => h.includes("req/s |"))) assert.match(header, /req\/s ratio to Corten \| CPU us\/request ratio to Corten \|$/);
  for (const droplet of ["r17-d1", "r17-d2"]) for (const app of anchors) assert.equal(text.split("\n").filter((l) => l.startsWith(`| ${app} | ${droplet} |`)).length, 8 * 4, `${app}@${droplet}`);
  assert.equal(text.split("\n").filter((l) => l.startsWith("| nextjs |")).length, 8 * 4);
  // Corten is 1.00 of itself; axum-maud (catalog index 15) serves about 1557 to Corten's 1002.
  assert.match(text, /^\| corten \| r17-d2 \|.* \| 1\.00 \| 1\.00 \|$/m);
  assert.match(text, /^\| axum-maud \| r17-d2 \|.* \| 1\.55 \| 0\.64 \|$/m);
  assert.match(text, /^## Between droplets$/m);
  assert.match(text, /^\| r17-d2 \| Synthetic CPU d2 \| 0-7 \| corten, tanstack-start, react-router, django, laravel, spring, astro, topcoat, axum-maud, drogon, express \|$/m);
  assert.match(text, /^Flagged: none\. No two droplets' axum-maud ratios to Corten differ by more than the noise in any of the 48 stages\.$/m);
  assert.doesNotMatch(text, /^Note: the anchors' raw numbers/m);
  const part2 = report(part(2, 3));
  assert.match(part2, /^# Marketplace v2 r17 part d2 of 3$/m);
  assert.match(part2, /This part's 8 apps pass both sources/);
  assert.doesNotMatch(part2, /Droplet|Between droplets/);
  assert.doesNotMatch(report(full()), /Droplet|Between droplets|ratio to Corten/);
});

test("a droplet is flagged when its anchor ratio differs beyond the noise, not when only its machine is faster", () => {
  const flagged = merged(2, { anchorScale: { "axum-maud": 1.5 } });
  const check = betweenDroplets(flagged);
  assert.equal(check.flagged.length, 48);
  assert.ok(check.flagged.every((r) => r.differ.length === 1 && r.differ[0].join() === "1,2"));
  const text = report(flagged);
  assert.match(text, /^Flagged: 48 of 48 stages \(d1 and d2 differ\)\.$/m);
  assert.match(text, /^\| fixture-en-US-page \| sat64 \| req\/s \| 1\.55 \[1\.55-1\.56\] \| 2\.33 \[2\.33-2\.33\] \| d1 and d2 differ \|$/m);

  // Both anchors 20% faster on d2: the raw numbers differ, the ratio does not. The anchor rows in
  // every table show the raw difference; nothing else repeats it.
  const faster = merged(2, { anchorScale: { corten: 1.2, "axum-maud": 1.2 } });
  assert.equal(betweenDroplets(faster).flagged.length, 0);
  const note = report(faster);
  assert.match(note, /^Flagged: none\./m);
  assert.doesNotMatch(note, /raw numbers across droplets|^- corten req\/s|^Note:/m);
  const rps = (droplet) => note.split("\n").filter((l) => l.startsWith(`| corten | ${droplet} |`) && l.endsWith("| 1.00 | 1.00 |")).map((l) => Number(l.split("|")[3].trim().split(" ")[0]));
  assert.equal(rps("r17-d2").length, 24);
  assert.ok(rps("r17-d2").every((v, i) => Math.abs(v / rps("r17-d1")[i] - 1.2) < 0.01), "corten's rows show d2 20% faster");

  // With three droplets each pair that differs is named.
  const three = validateSummary(mergeParts("r17", [part(1, 3), part(2, 3), part(3, 3, { anchorScale: { "axum-maud": 1.5 } })]));
  assert.match(report(three), /^Flagged: 48 of 48 stages \(d1 and d3 differ; d2 and d3 differ\)\.$/m);
});

test("a split round compares only with one split the same way, droplet by droplet", () => {
  const now = merged(2, { round: "r18" }), then = merged(2);
  const same = compare(now, then, { unchangedApps: ["nextjs"] });
  assert.equal(same.compatible, true, same.warnings.join("\n"));
  assert.equal(same.rows.find((r) => r.app === "corten").metrics.rps.percentChange, 0);
  for (const [current, baseline] of [[now, full()], [full("r18"), then], [merged(3, { round: "r18" }), then]]) {
    const result = compare(current, baseline);
    assert.equal(result.compatible, false); assert.ok(result.warnings.some((w) => w.startsWith("Incompatible droplet split")), result.warnings.join("\n"));
  }
  const otherCpu = structuredClone(now); otherCpu.split.parts[1].host.cpu = "Other CPU";
  assert.equal(compare(otherCpu, then).compatible, false);
  // Droplets on mixed CPU models compare only with a baseline mixed the same way, droplet by droplet.
  const mixed = (s, d1, d2) => { const v = structuredClone(s); v.split.parts[0].host.cpu = v.host.cpu = d1; v.split.parts[1].host.cpu = d2; return validateSummary(v); };
  const x8168 = "Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz", x8280 = "Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz";
  assert.equal(compare(mixed(now, x8168, x8280), mixed(then, x8168, x8280)).compatible, true);
  const swapped = compare(mixed(now, x8280, x8168), mixed(then, x8168, x8280));
  assert.equal(swapped.compatible, false); assert.ok(swapped.warnings.some((w) => w.startsWith("Incompatible")), swapped.warnings.join("\n"));
  const piece = compare(part(1, 2, { round: "r18" }), then);
  assert.equal(piece.compatible, false); assert.match(piece.warnings.join("\n"), /current is one droplet's part of a split round, not a round/);
});

test("plan mode prints the split and every command without git, doctl or ssh", () => {
  const plan = splitDryRun({ round: "r17", droplets: 2, sshKey: "42", stateDir: join(tmpdir(), "never-created") });
  assert.deepEqual(plan.plan.parts.map((p) => p.apps), splitApps(2));
  assert.equal(plan.commands.filter((c) => c.startsWith("doctl compute droplet create")).length, 2);
  assert.ok(plan.commands.includes("doctl account get --output json"));
  assert.match(plan.files.d2["job.sh"], /--part 2\/2/);
  assert.equal(existsSync(join(tmpdir(), "never-created")), false);
});

// A fake DigitalOcean account and droplets for the split launcher: each droplet k answers SSH at
// 192.0.2.k, runs its unit until finish(k), and serves the archive a part's job would pack.
function fleet(t, { limit = 10, existing = [], failDelete = 0 } = {}) {
  const temp = mkdtempSync(join(tmpdir(), "marketplace-split-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, "repo"), local = join(temp, "control"), remote = join(temp, "remote");
  mkdirSync(repo); mkdirSync(remote);
  let droplets = [...existing];
  const active = new Set(), installed = new Set(), calls = [], deleted = [];
  const good = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const host = (args) => Number(args.find((a) => /^root@/.test(a)).split(/[@:]/)[1].split(".").at(-1));
  const run = (binary, args) => {
    calls.push([binary, ...args]);
    if (binary === "git") return good(args[0] === "rev-parse" ? commit : "");
    if (binary === "doctl") {
      if (args[0] === "account") return good(JSON.stringify({ droplet_limit: limit, email: "test" }));
      if (args[2] === "list") return good(JSON.stringify(droplets));
      if (args[2] === "create") {
        const k = Number(args[3].split("-d").at(-1));
        droplets.push({ id: 100 + k, name: args[3], tags: args[args.indexOf("--tag-names") + 1].split(","), networks: { v4: [{ type: "public", ip_address: `192.0.2.${k}` }] }, size: { price_hourly: 0.25 } });
        return good();
      }
      if (args[2] === "delete") {
        if (String(100 + failDelete) === args[3]) throw new Error("delete failed");
        droplets = droplets.filter((d) => String(d.id) !== args[3]); deleted.push(args[3]); return good();
      }
    }
    if (binary === "ssh") {
      const k = host(args), script = args.at(-1);
      if (script.includes("install -m 644")) installed.add(k);
      if (script.includes("systemctl start")) active.add(k);
      if (script.startsWith("systemctl show")) return good(installed.has(k) ? `LoadState=loaded\nActiveState=${active.has(k) ? "active" : "inactive"}\nRestart=no\n` : "LoadState=not-found\nActiveState=inactive\nRestart=no\n");
      if (script === "sha256sum /bench/results.tgz") return good(`${createHash("sha256").update(readFileSync(join(remote, String(k), "results.tgz"))).digest("hex")}  /bench/results.tgz`);
      if (script.startsWith("tail")) return good("measuring\n");
      return good();
    }
    if (binary === "scp") {
      if (args.at(-2).startsWith("root@")) writeFileSync(args.at(-1), readFileSync(join(remote, String(host(args.slice(-2))), "results.tgz")));
      return good();
    }
    if (binary === "tar") { const r = spawnSync(binary, args, { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r; }
    throw new Error(`unexpected command ${binary} ${args.join(" ")}`);
  };
  return { repo, local, run, calls, deleted, add(d) { droplets.push(d); },
    // Someone deleted droplet id by hand.
    drop(id) { droplets = droplets.filter((d) => d.id !== id); },
    // Droplet k's job finished: its unit is inactive and its archive holds its part's results.
    finish(k, n, { exitCode = 0, change = () => {} } = {}) {
      active.delete(k);
      const dir = join(remote, String(k)), results = `repo/bench/marketplace/results/r17/d${k}`;
      mkdirSync(join(dir, results), { recursive: true });
      const summary = part(k, n); change(summary);
      writeFileSync(join(dir, results, "summary.json"), JSON.stringify(summary));
      writeFileSync(join(dir, "exit-code"), `${exitCode}\n`); writeFileSync(join(dir, "run.log"), "all done\n");
      const r = spawnSync("tar", ["-czf", join(dir, "results.tgz"), "-C", dir, "run.log", "exit-code", results], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr);
    },
    task(droplets) { return splitController({ round: "r17", stateDir: local, sshKey: "42", ...(droplets ? { droplets } : {}) }, { run, repo, sleep: async () => {} }); },
  };
}
const quiet = async (t, fn) => {
  const log = console.log, error = console.error, out = [];
  console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => out.push(a.join(" "));
  try { return { value: await fn(), out: out.join("\n") }; } finally { console.log = log; console.error = error; }
};

test("a split launch plans once, creates every droplet before starting any, and refuses a second launch", async (t) => {
  const f = fleet(t);
  const { value: plan } = await quiet(t, () => f.task(2).launch());
  assert.equal(plan.commit, commit);
  assert.equal(existsSync(join(f.local, "launch.lock")), false, "a finished launch removes its lock");
  assert.deepEqual(validatePlan(JSON.parse(readFileSync(join(f.local, "split.json"), "utf8")), "r17"), plan);
  const creates = f.calls.map((c, i) => [c, i]).filter(([c]) => c[0] === "doctl" && c[3] === "create").map(([, i]) => i);
  const starts = f.calls.map((c, i) => [c, i]).filter(([c]) => c[0] === "ssh" && c.at(-1).includes("systemctl start")).map(([, i]) => i);
  assert.equal(creates.length, 2); assert.equal(starts.length, 2); assert.ok(Math.max(...creates) < Math.min(...starts));
  for (const k of [1, 2]) {
    const s = JSON.parse(readFileSync(join(f.local, `d${k}`, "state.json"), "utf8"));
    assert.equal(s.status, "running"); assert.equal(s.commit, commit); assert.deepEqual(s.part, { index: k, of: 2 });
  }
  assert.ok(f.calls.filter((c) => c[0] === "ssh").every((c) => c.some((a) => a.includes(`control/d${c.find((x) => x.startsWith("root@")).at(-1)}/known_hosts`))), "each droplet has its own known_hosts");
  const calls = f.calls.length;
  await assert.rejects(f.task(2).launch(), new RegExp(`r17 is already planned in .*split\\.json at commit ${commit}; never launch a split round twice: collect it \\(node bench/marketplace/droplet\\.mjs r17 --state-dir ".*control" --collect\\)`));
  assert.equal(f.calls.length, calls, "a second launch calls nothing");
});

test("a split launch checks the account's droplet limit, existing droplets and folders before writing its plan", async (t) => {
  const full = fleet(t, { limit: 3, existing: [{ id: 1, name: "other", tags: [] }, { id: 2, name: "other2", tags: [] }] });
  await assert.rejects(full.task(2).launch(), /droplet limit is 3 and 2 droplets exist: no room for 2 more/);
  assert.equal(existsSync(join(full.local, "split.json")), false);
  const busy = fleet(t, { existing: [{ id: 1, name: "corten-marketplace-r16", tags: ["corten-bench"] }] });
  await assert.rejects(busy.task(2).launch(), /already exists/);
  const reused = fleet(t); mkdirSync(join(reused.local, "d2"), { recursive: true });
  await assert.rejects(reused.task(2).launch(), /d2 exists/);
  const results = fleet(t); mkdirSync(join(results.repo, "bench/marketplace/results/r17"), { recursive: true });
  await assert.rejects(results.task(2).launch(), /never reuse a result folder/);
  for (const f of [full, busy, reused, results]) assert.ok(!f.calls.some((c) => c[3] === "create"));
});

test("a signal during a split launch stops it between steps and says what each droplet is left doing", async (t) => {
  // The signal arrives during d1's create.
  const f = fleet(t);
  let signal = null;
  const run = (binary, args) => { const r = f.run(binary, args); if (binary === "doctl" && args[2] === "create") signal = "SIGINT"; return r; };
  const interrupted = splitController({ round: "r17", stateDir: f.local, sshKey: "42", droplets: 2 }, { run, repo: f.repo, sleep: async () => {}, interrupted: () => signal });
  const { value: error } = await quiet(t, () => interrupted.launch().catch((e) => e));
  assert.match(error.message, /SIGINT received/);
  assert.match(error.message, /r17-d1: droplet 101 was created but its round did not start; it is billed until deleted: doctl compute droplet delete 101 --force/);
  assert.match(error.message, /r17-d2: not created\./);
  assert.ok(!f.calls.some((c) => c[0] === "ssh"));

  const g = fleet(t);
  // The signal arrives while d1's round starts.
  let starts = 0, signal2 = null;
  const run2 = (binary, args) => { const r = g.run(binary, args); if (binary === "ssh" && args.at(-1).includes("systemctl start") && ++starts === 1) signal2 = "SIGTERM"; return r; };
  const later = splitController({ round: "r17", stateDir: g.local, sshKey: "42", droplets: 2 }, { run: run2, repo: g.repo, sleep: async () => {}, interrupted: () => signal2 });
  const { value: stopped } = await quiet(t, () => later.launch().catch((e) => e));
  assert.match(stopped.message, /SIGTERM received/);
  assert.match(stopped.message, /r17-d1: droplet 101 keeps running its round until it is stopped\. Stop it: ssh -o "UserKnownHostsFile=.*\/d1\/known_hosts" root@192\.0\.2\.1 systemctl stop corten-marketplace-r17-d1\.service/);
  assert.match(stopped.message, /r17-d2: droplet 102 was created but its round did not start/);
  assert.match(stopped.message, /--collect/);
  // A closed stdout or stderr cannot lose it: the launch saves the same text.
  assert.match(stopped.message, /This is also saved in .*launch-stopped\.txt\.$/);
  assert.equal(readFileSync(join(g.local, "launch-stopped.txt"), "utf8"), `${stopped.message.replace(/\nThis is also saved in .*$/, "")}\n`);
  // Collecting it: d1 still runs, d2 never started and must be deleted by hand, and with d2
  // unable to finish, exit 2 still says how to stop d1.
  const { value: code, out } = await quiet(t, () => g.task().collect());
  assert.equal(code, 2);
  assert.match(out, /r17-d2: droplet 102 was created but never started its round \(its launch stopped before systemctl start\); nothing to collect\. Delete it: doctl compute droplet delete 102 --force/);
  assert.match(out, /r17 cannot merge: r17-d2 will not complete it\. Stop each running droplet so it stops billing:\nssh -o "UserKnownHostsFile=.*\/d1\/known_hosts" root@192\.0\.2\.1 systemctl stop corten-marketplace-r17-d1\.service\n/);
});

test("a split round finishes only when every droplet has, deleting each as it finishes, then merges", async (t) => {
  const f = fleet(t);
  await quiet(t, () => f.task(2).launch());
  f.finish(1, 2);
  const first = await quiet(t, () => f.task().collect());
  assert.equal(first.value, 3);
  assert.deepEqual(f.deleted, ["101"]);
  assert.match(first.out, /r17 is not finished: r17-d2 still running\. Finished droplets are collected and deleted; run .* --collect again later\./);
  assert.equal(existsSync(join(f.local, "round")), false);
  f.finish(2, 2);
  const done = await quiet(t, () => f.task().collect());
  assert.equal(done.value, 0, done.out);
  assert.deepEqual(f.deleted, ["101", "102"]);
  const folder = join(f.local, "round", "r17");
  const s = validateSummary(JSON.parse(readFileSync(join(folder, "summary.json"), "utf8")));
  assert.equal(s.split.droplets, 2);
  for (const k of [1, 2]) assert.ok(existsSync(join(folder, `d${k}`, "summary.json")));
  assert.deepEqual(validatePlan(JSON.parse(readFileSync(join(folder, "split.json"), "utf8")), "r17").parts.length, 2);
  assert.match(report(s), /^## Between droplets$/m);
  assert.equal((await quiet(t, () => f.task().collect())).value, 0, "collecting again reuses the merge");
});

test("a failed delete, a failed part or a leftover droplet keeps a split round from finishing", async (t) => {
  const failing = fleet(t, { failDelete: 2 });
  await quiet(t, () => failing.task(2).launch());
  failing.finish(1, 2); failing.finish(2, 2);
  const deleteFailed = await quiet(t, () => failing.task().collect());
  assert.equal(deleteFailed.value, 2);
  assert.match(deleteFailed.out, /r17-d2: collection error; its droplet and evidence are preserved: delete failed/);
  assert.match(deleteFailed.out, /collection error on r17-d2: droplets that still exist are preserved and still billed\. Fix the error and run .* --collect again; never relaunch r17\./);

  const partial = fleet(t);
  await quiet(t, () => partial.task(2).launch());
  partial.finish(1, 2); partial.finish(2, 2, { exitCode: 1 });
  const failed = await quiet(t, () => partial.task().collect());
  assert.equal(failed.value, 1);
  assert.match(failed.out, /r17 is partial: r17-d2 did not finish its part\. Every droplet's deletion is confirmed; there is no merged round\./);
  assert.equal(existsSync(join(partial.local, "round")), false);

  const extra = fleet(t);
  await quiet(t, () => extra.task(2).launch());
  extra.finish(1, 2); extra.finish(2, 2);
  extra.add({ id: 103, name: "corten-marketplace-r17-d3", tags: ["corten-bench"] });
  const leftover = await quiet(t, () => extra.task().collect());
  assert.equal(leftover.value, 2);
  assert.match(leftover.out, /leftover droplet 103 \(corten-marketplace-r17-d3\) belongs to no live part of r17; check it is not another run's, then delete it: doctl compute droplet delete 103 --force/);
});

test("a round whose start check fails stays starting, not never started, and is collected", async (t) => {
  // The first systemctl show after d1's round starts loses its SSH connection.
  const f = fleet(t);
  let started = false, thrown = false;
  const run = (binary, args) => {
    if (binary === "ssh" && started && !thrown && args.at(-1).startsWith("systemctl show")) { thrown = true; throw new Error("ssh: connection reset"); }
    const r = f.run(binary, args);
    if (binary === "ssh" && args.at(-1).includes("systemctl start")) started = true;
    return r;
  };
  const launch = splitController({ round: "r17", stateDir: f.local, sshKey: "42", droplets: 2 }, { run, repo: f.repo, sleep: async () => {} });
  const { value: error } = await quiet(t, () => launch.launch().catch((e) => e));
  assert.match(error.message, /^ssh: connection reset/);
  assert.equal(JSON.parse(readFileSync(join(f.local, "d1", "state.json"), "utf8")).status, "starting");
  assert.match(error.message, /r17-d1: droplet 101 may have started its round; if it did, it keeps running until it is stopped. Stop it: ssh -o "UserKnownHostsFile=.*\/d1\/known_hosts" root@192\.0\.2\.1 systemctl stop corten-marketplace-r17-d1\.service/);
  assert.doesNotMatch(error.message, /r17-d1: droplet 101 was created but its round did not start/);
  assert.match(error.message, /r17-d2: droplet 102 was created but its round did not start/);

  // d1's round runs; d2 never reached systemctl start, so only d2 gets a delete command. The
  // round cannot merge, so exit 2 also says how to stop d1.
  const stopD1 = /r17 cannot merge: r17-d2 will not complete it\. Stop each running droplet so it stops billing:\nssh -o "UserKnownHostsFile=.*\/d1\/known_hosts" root@192\.0\.2\.1 systemctl stop corten-marketplace-r17-d1\.service\nThen run node bench\/marketplace\/droplet\.mjs r17 --state-dir ".*" --collect again/;
  const first = await quiet(t, () => f.task().collect());
  assert.equal(first.value, 2, first.out);
  assert.match(first.out, /r17-d2: droplet 102 was created but never started its round \(its launch stopped before systemctl start\); nothing to collect\. Delete it: doctl compute droplet delete 102 --force/);
  assert.doesNotMatch(first.out, /r17-d1.*(never started|Delete it)/);
  assert.match(first.out, stopD1);
  // A loaded, active unit is not proof the launch's check passed: the state stays starting.
  assert.equal(JSON.parse(readFileSync(join(f.local, "d1", "state.json"), "utf8")).status, "starting");

  // d2 deleted by hand: d1 still runs a round that cannot merge, so collect says to stop it.
  f.drop(102);
  const running = await quiet(t, () => f.task().collect());
  assert.equal(running.value, 3, running.out);
  assert.match(running.out, /r17-d2 never started its round and has no droplet/);
  assert.match(running.out, stopD1);
  assert.doesNotMatch(running.out, /is not finished/);

  f.finish(1, 2);
  const done = await quiet(t, () => f.task().collect());
  assert.equal(done.value, 1, done.out);
  assert.deepEqual(f.deleted, ["101"]);
  assert.equal(JSON.parse(readFileSync(join(f.local, "d1", "state.json"), "utf8")).status, "done");
});

test("a merge reports a droplet whose results have no summary", async (t) => {
  const f = fleet(t);
  await quiet(t, () => f.task(2).launch());
  f.finish(1, 2); f.finish(2, 2);
  // d2's archive holds only its log: its summary is missing, so the part is partial.
  const dir = join(f.local, "..", "remote", "2");
  rmSync(join(dir, "repo"), { recursive: true, force: true });
  const r = spawnSync("tar", ["-czf", join(dir, "results.tgz"), "-C", dir, "run.log", "exit-code"], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr);
  const result = await quiet(t, () => f.task().collect());
  assert.equal(result.value, 1, result.out);
  assert.match(JSON.parse(readFileSync(join(f.local, "d2", "state.json"), "utf8")).validationError, /summary\.json/);
});

test("a failed create on d2 leaves it creating with no id, and collect looks for it by name and tag", async (t) => {
  const f = fleet(t);
  const run = (binary, args) => binary === "doctl" && args[2] === "create" && args[3].endsWith("-d2") ? { status: 1, stdout: "", stderr: "droplet limit reached" } : f.run(binary, args);
  const launch = splitController({ round: "r17", stateDir: f.local, sshKey: "42", droplets: 2 }, { run, repo: f.repo, sleep: async () => {} });
  const { value: error } = await quiet(t, () => launch.launch().catch((e) => e));
  assert.match(error.message, /^create exit 1: droplet limit reached; owned droplet missing or ambiguous.*; do not relaunch/s);
  assert.match(error.message, /r17-d1: droplet 101 was created but its round did not start; it is billed until deleted: doctl compute droplet delete 101 --force/);
  const d2 = JSON.parse(readFileSync(join(f.local, "d2", "state.json"), "utf8"));
  assert.equal(d2.status, "creating"); assert.equal(d2.id, undefined);
  assert.match(error.message, new RegExp(`r17-d2: its create may have succeeded; look for a droplet named corten-marketplace-r17-d2 tagged ${d2.tag} before deleting anything\\.`));
  assert.ok(!f.calls.some((c) => c[0] === "ssh"), "no round starts when a create fails");

  // No d2 droplet: d2 is missing, and d1 never reached systemctl start, so d1 gets a delete command.
  const first = await quiet(t, () => f.task().collect());
  assert.equal(first.value, 2, first.out);
  assert.match(first.out, /r17-d1: droplet 101 was created but never started its round \(its launch stopped before systemctl start\); nothing to collect\. Delete it: doctl compute droplet delete 101 --force/);
  assert.match(first.out, /r17-d2 never started its round and has no droplet/);
  assert.doesNotMatch(first.out, /cannot merge/, "no droplet runs, so there is nothing to stop");
  assert.ok(!f.calls.some((c) => c[0] === "ssh"), "collect needs no SSH to droplets that never started");

  // The create succeeded after all: collect finds d2's droplet by its name and its unique tag.
  f.add({ id: 102, name: d2.name, tags: ["corten-bench", "corten-marketplace", d2.tag], networks: { v4: [{ type: "public", ip_address: "192.0.2.2" }] }, size: { price_hourly: 0.25 } });
  f.add({ id: 103, name: d2.name, tags: ["corten-bench", "corten-marketplace", "corten-marketplace-run-ffffffffffffffff"] });
  const found = await quiet(t, () => f.task().collect());
  assert.equal(found.value, 2, found.out);
  assert.match(found.out, /r17-d2: droplet 102 was created but never started its round \(its launch stopped before systemctl start\); nothing to collect\. Delete it: doctl compute droplet delete 102 --force/);
  assert.doesNotMatch(found.out, /r17-d2: droplet 103/, "another run's droplet of the same name is not ours");
  assert.match(found.out, /leftover droplet 103 \(corten-marketplace-r17-d2\)/);
  assert.deepEqual(f.deleted, [], "collect deletes no droplet that never started");
});

test("a starting droplet that never answers SSH is not deleted on a guess", async (t) => {
  const f = fleet(t);
  await quiet(t, () => f.task(2).launch());
  // d2's state is rewound to its start not confirmed, and its SSH stops answering.
  const file = join(f.local, "d2", "state.json"), s = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...s, status: "starting" }));
  f.finish(1, 2);
  // As command() does: a failed ssh throws unless the caller allows it to fail.
  const run = (binary, args, timeout, allowFail) => {
    if (binary !== "ssh" || !args.includes("root@192.0.2.2")) return f.run(binary, args);
    if (!allowFail) throw new Error("ssh: timed out");
    return { status: 255, stdout: "", stderr: "timed out" };
  };
  const result = await quiet(t, () => splitController({ round: "r17", stateDir: f.local, sshKey: "42" }, { run, repo: f.repo, sleep: async () => {} }).collect());
  assert.equal(result.value, 2, result.out);
  assert.match(result.out, /r17-d2: collection error; its droplet and evidence are preserved: ssh: timed out/);
  assert.doesNotMatch(result.out, /delete 102/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).status, "starting");
});

test("a starting part whose droplet is gone may have started: it is missing, not never started", async (t) => {
  const f = fleet(t);
  await quiet(t, () => f.task(2).launch());
  const file = join(f.local, "d2", "state.json"), s = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...s, status: "starting" }));
  f.drop(102);
  const result = await quiet(t, () => f.task().collect());
  assert.equal(result.value, 3, result.out);
  assert.match(result.out, /r17-d2 may have started its round, but its droplet is gone; nothing to collect/);
  assert.doesNotMatch(result.out, /r17-d2 never started/);
  assert.match(result.out, /r17 cannot merge: r17-d2 will not complete it\. Stop each running droplet so it stops billing:\nssh .*\/d1\/known_hosts" root@192\.0\.2\.1 /);
});

test("code 3 with a partial part says to stop the running droplets, since the round cannot merge", async (t) => {
  const f = fleet(t);
  await quiet(t, () => f.task(2).launch());
  f.finish(1, 2, { exitCode: 1 });
  const running = await quiet(t, () => f.task().collect());
  assert.equal(running.value, 3, running.out);
  assert.deepEqual(f.deleted, ["101"]);
  assert.match(running.out, /r17 cannot merge: r17-d1 will not complete it\. Stop each running droplet so it stops billing:\nssh -o "UserKnownHostsFile=.*\/d2\/known_hosts" root@192\.0\.2\.2 systemctl stop corten-marketplace-r17-d2\.service\nThen run node bench\/marketplace\/droplet\.mjs r17 --state-dir ".*" --collect again/);
  assert.doesNotMatch(running.out, /is not finished/);
  // Once stopped, d2 is collected and deleted, and the round is partial.
  f.finish(2, 2);
  const stopped = await quiet(t, () => f.task().collect());
  assert.equal(stopped.value, 1, stopped.out);
  assert.deepEqual(f.deleted, ["101", "102"]);
  assert.match(stopped.out, /r17 is partial: r17-d1 did not finish its part/);
});

test("a signal while waiting for SSH stops the launch before the next try, with no round started", async (t) => {
  const f = fleet(t);
  let signal = null, tries = 0;
  const run = (binary, args) => {
    if (binary === "ssh" && args.at(-1) === "true") { tries++; signal = "SIGINT"; return { status: 255, stdout: "", stderr: "refused" }; }
    return f.run(binary, args);
  };
  const launch = splitController({ round: "r17", stateDir: f.local, sshKey: "42", droplets: 2 }, { run, repo: f.repo, sleep: async () => {}, interrupted: () => signal });
  const { value: error } = await quiet(t, () => launch.launch().catch((e) => e));
  assert.match(error.message, /^SIGINT received while waiting for SSH; droplet preserved, its round not started/);
  assert.equal(existsSync(join(f.local, "launch.lock")), false, "a stopped launch removes its lock");
  assert.equal(tries, 1);
  assert.ok(!f.calls.some((c) => c[0] === "ssh" && c.at(-1).includes("systemctl")));
  for (const k of [1, 2]) {
    assert.equal(JSON.parse(readFileSync(join(f.local, `d${k}`, "state.json"), "utf8")).status, "preparing");
    assert.match(error.message, new RegExp(`r17-d${k}: droplet 10${k} was created but its round did not start`));
  }
});

test("parts that finish but do not merge are partial, exit 1, with no merged round", async (t) => {
  const f = fleet(t);
  await quiet(t, () => f.task(2).launch());
  f.finish(1, 2); f.finish(2, 2, { change: (s) => { s.options.startupTimeout = 90; } });
  const result = await quiet(t, () => f.task().collect());
  assert.equal(result.value, 1, result.out);
  assert.deepEqual(f.deleted, ["101", "102"]);
  assert.match(result.out, /partial: every droplet finished and was deleted, but they do not merge into one round: d2's options differ from d1's: not one round/);
  assert.equal(existsSync(join(f.local, "round")), false);
});

test("a stopped launch keeps its own error when saying what each droplet is left doing fails", async (t) => {
  const f = fleet(t);
  let signal = null;
  const run = (binary, args) => {
    const r = f.run(binary, args);
    if (binary === "doctl" && args[2] === "create") { signal = "SIGINT"; writeFileSync(join(f.local, "d2", "state.json"), "{"); }
    return r;
  };
  const launch = splitController({ round: "r17", stateDir: f.local, sshKey: "42", droplets: 2 }, { run, repo: f.repo, sleep: async () => {}, interrupted: () => signal });
  const { value: error } = await quiet(t, () => launch.launch().catch((e) => e));
  assert.match(error.message, /^SIGINT received\nWhat each droplet is left doing is unknown: .*JSON.*\. Collect the round: node bench\/marketplace\/droplet\.mjs r17 --state-dir ".*" --collect\nThis is also saved in .*launch-stopped\.txt\.$/s);
  assert.equal(error.cause.message, "SIGINT received");
});

test("the command line's --plan calls no git, doctl or ssh: it runs with only node on PATH", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "marketplace-plan-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const script = join(dirname(fileURLToPath(import.meta.url)), "droplet.mjs"), stateDir = join(temp, "state");
  const env = { PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const plan = (...args) => spawnSync(process.execPath, [script, "r17", "--plan", "--ssh-key", "42", "--state-dir", stateDir, ...args], { cwd: temp, env, encoding: "utf8" });
  const split = plan("--droplets", "2");
  assert.equal(split.status, 0, split.stderr);
  const out = JSON.parse(split.stdout);
  assert.deepEqual(out.plan.parts.map((p) => p.apps), splitApps(2));
  assert.equal(out.commands.filter((c) => c.startsWith("doctl compute droplet create")).length, 2);
  const one = plan();
  assert.equal(one.status, 0, one.stderr);
  assert.deepEqual(Object.keys(JSON.parse(one.stdout).files), ["job.sh", "pack.sh", "corten-marketplace-r17.service"]);
  assert.equal(existsSync(stateDir), false, "plan mode writes no state");
});

test("collect refuses while a live launch holds launch.lock, and takes over a stale one", async (t) => {
  const f = fleet(t);
  await quiet(t, () => f.task(2).launch());
  const lock = join(f.local, "launch.lock");
  // A live launch: this test's own process.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: "2026-01-01T00:00:00.000Z" }));
  const calls = f.calls.length;
  await assert.rejects(f.task().collect(), new RegExp(`the launch of r17 \\(pid ${process.pid}, .*launch\\.lock\\) is still running: collect after it ends`));
  assert.equal(f.calls.length, calls, "collect calls nothing while a launch runs");
  assert.ok(existsSync(lock), "a live lock is never removed");
  await assert.rejects(f.task(2).launch(), /launch\.lock exists: another launch of r17 holds it/);
  assert.ok(existsSync(lock), "a refused launch leaves another's lock alone");

  // A stale lock: its process has exited, so the launch was killed; collect goes ahead.
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  assert.equal(processRuns(gone), false);
  writeFileSync(lock, JSON.stringify({ pid: gone, at: "2026-01-01T00:00:00.000Z" }));
  const result = await quiet(t, () => f.task().collect());
  assert.equal(result.value, 3, result.out);
  assert.match(result.out, new RegExp(`launch\\.lock is stale: pid ${gone} is not running, so its launch was killed; removing the lock and collecting the stopped launch`));
  assert.equal(existsSync(lock), false);
});

test("a droplet list that fails is that part's collection error, and the stop commands still print", async (t) => {
  // d1 runs its round; d2 never reached systemctl start.
  const f = fleet(t);
  let starts = 0;
  const run = (binary, args) => { const r = f.run(binary, args); if (binary === "ssh" && args.at(-1).includes("systemctl start")) starts++; return r; };
  const launch = splitController({ round: "r17", stateDir: f.local, sshKey: "42", droplets: 2 }, { run, repo: f.repo, sleep: async () => {}, interrupted: () => starts ? "SIGINT" : null });
  await quiet(t, () => launch.launch().catch((e) => e));
  const flaky = (fail) => {
    let lists = 0;
    return (binary, args) => { if (binary === "doctl" && args[2] === "list" && fail.includes(++lists)) throw new Error("doctl: connection reset"); return f.run(binary, args); };
  };
  const collect = (fail) => quiet(t, () => splitController({ round: "r17", stateDir: f.local, sshKey: "42" }, { run: flaky(fail), repo: f.repo, sleep: async () => {} }).collect());
  // d1's collect lists once; the second list is d2's, the third the leftover check.
  const part = await collect([2]);
  assert.equal(part.value, 2, part.out);
  assert.match(part.out, /r17-d2: collection error; its droplet and evidence are preserved: doctl: connection reset/);
  assert.match(part.out, /r17 cannot merge: r17-d2 will not complete it\. Stop each running droplet so it stops billing:\nssh .*\/d1\/known_hosts" root@192\.0\.2\.1 /);
  const leftovers = await collect([3]);
  assert.equal(leftovers.value, 2, leftovers.out);
  assert.match(leftovers.out, /the droplet list failed, so leftover droplets are unknown: doctl: connection reset/);
  assert.match(leftovers.out, /r17-d2: droplet 102 was created but never started its round/);
  assert.match(leftovers.out, /Stop each running droplet so it stops billing:\nssh /);

  // A droplet listed under d2's id but with another name and no tags is not deleted.
  f.drop(102); f.add({ id: 102, name: "someone-else", tags: [] });
  const other = await collect([]);
  assert.equal(other.value, 2, other.out);
  assert.match(other.out, /r17-d2: droplet 102 is listed for this part but lacks its name or ownership tags; not ours to delete: check it/);
  assert.doesNotMatch(other.out, /delete 102/);
});

test("a hangup does not stop the split launcher, as it would a plain node process", { skip: process.platform === "win32" && "Windows has no SIGHUP" }, async () => {
  const url = new URL("./droplet.mjs", import.meta.url).href;
  const child = (install) => new Promise((resolve, reject) => {
    const code = `${install ? `(await import(${JSON.stringify(url)})).launcherSignals();` : ""} console.log("ready"); setTimeout(() => console.log("alive"), 500);`;
    const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; if (out === "ready\n") p.kill("SIGHUP"); });
    p.on("error", reject); p.on("exit", (status, signal) => resolve({ status, signal, out }));
  });
  assert.deepEqual(await child(false), { status: null, signal: "SIGHUP", out: "ready\n" }, "node dies on a hangup by default");
  assert.deepEqual(await child(true), { status: 0, signal: null, out: "ready\nalive\n" });
});
