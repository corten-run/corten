import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { records } from "./fixtures.mjs";
import { aggregate, articleHtml, cpuSettings, expectedArticle, filterPrefixes, parseArgs, readLoad, representativeIds, validateCatalog, validateRecord } from "./contract.mjs";
import { memoryMiB, summarizeSamples } from "./stats.mjs";
import { readCpu, usageUsec } from "./cgroup.mjs";

test("CLI stays in the independent catalog namespace and selects only distinct page apps", () => {
  const apps = { corten: {}, other: {} };
  assert.deepEqual(parseArgs(["c1"], apps).apps, ["corten", "other"]);
  assert.deepEqual(parseArgs(["c15", "--apps", "other", "--passes", "3", "--build", "--check-only"], apps), { round: "c15", apps: ["other"], passes: 3, build: true, checkOnly: true, duration: 60, warmup: 30, rate: 150, startupTimeout: 120 });
  for (const args of [["r1"], ["m1"], ["../c1"], ["c0"], ["c01"], ["c1", "--apps", "unknown"], ["c1", "--apps", ""], ["c1", "--apps", "corten,corten"], ["c1", "--passes", "2"], ["c1", "--duration", "301"], ["c1", "--passes", "1.0"], ["c1", "--rate"], ["c1", "--unknown"], ["c1", "--build", "--build"]]) assert.throws(() => parseArgs(args, apps), args.join(" "));
});
test("CPU placement is catalog-only, explicit, recorded, and cannot overlap pinned roles", () => {
  const defaults = cpuSettings({ BENCH_APP_CPUS: "0", BENCH_LOAD_CPUS: "1-4" });
  assert.equal(defaults.app.cpuset, null);
  assert.match(defaults.app.placement, /not pinned/);
  const pinned = cpuSettings({ CATALOG_APP_CPUS: "0", CATALOG_LOAD_CPUS: "4-7", CATALOG_API_CPUS: "2-3" });
  assert.deepEqual(pinned.app.args, ["--cpus", "1", "--cpuset-cpus", "0"]);
  assert.deepEqual(pinned.load.args, ["--cpus", "4", "--cpuset-cpus", "4-7"]);
  assert.equal(pinned.api.cpuset, "2-3");
  for (const env of [{ CATALOG_APP_CPUS: "2-0" }, { CATALOG_APP_CPUS: "0,0" }, { CATALOG_LOAD_CPUS: "-1" }, { CATALOG_API_CPUS: "0;stop" }, { CATALOG_APP_CPUS: "0", CATALOG_LOAD_CPUS: "0-1" }]) assert.throws(() => cpuSettings(env));
});
test("schema checks every key, record, nested string, array, and related reference", () => {
  assert.equal(Object.keys(validateCatalog(records())).length, 500);
  for (const mutate of [
    (c) => delete c.record_500,
    (c) => c.record_500.title = 500,
    (c) => c.record_500.extra = "extra",
    (c) => c.record_1.fields[0].value = true,
    (c) => c.record_1.fields[0].extra = "extra",
    (c) => c.record_1.tags.push(null),
    (c) => c.record_1.related[0].id = "missing",
    (c) => c.record_1.id = "record_2",
    (c) => c.record_1.related = {},
  ]) { const c = records(); mutate(c); assert.throws(() => validateCatalog(c)); }
  assert.throws(() => validateRecord(null));
});
test("expected native article fixes source ordering, empty containers, and case-sensitive non-trimmed prefixes", () => {
  const c = records();
  const article = expectedArticle(c.record_1, "A");
  assert.deepEqual(article.children.map((n) => n.tag), ["h1", "p", "p", "ul", "form", "table", "nav"]);
  assert.equal(article.children[4].attrs.action, "/catalog/record_1");
  assert.equal(article.children[4].children[0].children[0].attrs.value, "A");
  const rows = (prefix) => expectedArticle(c.record_1, prefix).children[5].children[2].children;
  assert.deepEqual(rows("A").map((r) => r.children[0].text), ["Access", "Area", "Archive", "Access"]);
  assert.notEqual(rows("A")[0].children[1].text, rows("A")[3].children[1].text);
  for (const prefix of ["a", " A", "A ", "missing"]) assert.deepEqual(rows(prefix), []);
  assert.ok(filterPrefixes(c.record_1).some((p) => p.includes("<&")));
  assert.ok(representativeIds(c).includes("record_1"));
  assert.ok(representativeIds(c).includes("record_500"));
  const empty = expectedArticle(c.record_500);
  assert.deepEqual(empty.children[3].children, []);
  assert.deepEqual(empty.children[5].children[2].children, []);
  assert.deepEqual(empty.children[6].children[0].children, []);
  const html = articleHtml(c.record_1, '<&"\' +');
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&quot;&#39; +"));
});
function load() {
  return { metrics: { http_reqs: { count: 100, rate: 10 }, http_req_duration: { avg: 1, "p(50)": 1, "p(95)": 2, "p(99)": 3, max: 4 }, http_req_failed: { value: 0 }, checks: { passes: 200, fails: 0 } } };
}
test("missing load summaries, HTTP errors, failed checks, and dropped work fail closed", () => {
  assert.equal(readLoad(load()).rps, 10);
  const modern = { metrics: Object.fromEntries(Object.entries(load().metrics).map(([key, values]) => [key, { values }])) };
  assert.equal(readLoad(modern).requests, 100);
  for (const mutate of [
    (s) => delete s.metrics,
    (s) => s.metrics.http_reqs.count = 0,
    (s) => s.metrics.http_req_duration["p(99)"] = null,
    (s) => s.metrics.http_req_failed.value = 0.01,
    (s) => s.metrics.checks.fails = 1,
    (s) => delete s.metrics.checks,
    (s) => s.metrics.dropped_iterations = { count: 1 },
  ]) { const s = load(); mutate(s); assert.throws(() => readLoad(s)); }
  assert.throws(() => readLoad(null));
});
test("pass aggregation retains measured medians/ranges and missing fields stay null", () => {
  assert.equal(aggregate([]).passes, 0);
  assert.equal(aggregate([]).rps, null);
  const out = aggregate([{ rps: 30 }, { rps: 10 }, { rps: 20 }]);
  assert.deepEqual(out.rps, { median: 20, min: 10, max: 30 });
  assert.equal(out.p50, null);
  assert.equal(out.passes, 3);
});
test("stats parser handles small memory and refuses missing or invalid samples", () => {
  assert.equal(memoryMiB("512KiB"), 0.5);
  assert.equal(memoryMiB("1.5 GiB"), 1536);
  assert.equal(memoryMiB("1B"), 1 / 2 ** 20);
  assert.throws(() => memoryMiB("?"));
  assert.throws(() => summarizeSamples([]));
  assert.throws(() => summarizeSamples([{ mem: NaN, cpu: 1 }]));
  assert.equal(summarizeSamples([{ mem: 1, cpu: 2 }, { mem: 3, cpu: 4 }]).memMaxMiB, 3);
});
test("bounded cgroup reader accepts both Docker drivers and never substitutes zero for missing counters", () => {
  assert.equal(usageUsec("usage_usec 123\nuser_usec 100\n"), 123);
  assert.throws(() => usageUsec("user_usec 1"));
  const dir = mkdtempSync(join(tmpdir(), "catalog-cgroup-"));
  const id = "a".repeat(64);
  try {
    const path = join(dir, "system.slice", `docker-${id}.scope`);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "cpu.stat"), "usage_usec 1234\n");
    assert.equal(readCpu(id, dir), 1234);
    assert.throws(() => readCpu("b".repeat(64), dir));
    assert.throws(() => readCpu("not-an-id", dir));
  } finally {
    assert.ok(dir.startsWith(join(tmpdir(), "catalog-cgroup-")), "temporary cleanup stays in its named directory");
    rmSync(dir, { recursive: true, force: true });
  }
});
