// The catalog count's pairs with its own A/A (count-pairs.mjs): its order, its validity checks, the
// reading that holds or clears a change only where its A/A resolves the default band, and the
// runner, with a stand-in for Docker and count.mjs: its ledger, its locks and its failure paths.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mock, test } from "node:test";
import * as countPairs from "./count-pairs.mjs";
import { readCount } from "./count-admission.mjs";
import { EventEmitter } from "node:events";
import { BAND, compare, complete, COUNTS, DAEMON_LOCK, inside, invalid, lock, MARGIN, markdown, MIN_PAIRS, optionsError, parsePairs, readRun, reading, RELEASE_MS, resolution, runPairs, schedule, spawnBounded, spawnExec, within } from "./count-pairs.mjs";

/** n recorded pairs whose changes are spread evenly from lo to hi. */
const spread = (lo, hi, n = 100) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
const pairsOf = (changes) => changes.map((c, i) => ({ pair: i + 1, base: 100000, head: 100000 * (1 + c) }));
const of = (lo, hi) => compare(pairsOf(spread(lo, hi)));
const running = Object.fromEntries(Object.values(COUNTS).map((e) => [e, 100]));
const goodRow = (over = {}) => ({ requests: 5000, failed: 0, kernelPass: { requests: 5000, failed: 0 }, userPerRequest: 75000, kernelPerRequest: 26000, userCyclesPerRequest: 100000, kernelCyclesPerRequest: 60000, userL1iMissesPerRequest: 5000, perfRunningPct: { ...running }, perfDiagnostics: {}, ...over });
const notDecided = { verdict: "not decided: the count's A/A does not resolve the default band, so the change is read as one inside the band, neither held nor cleared", decided: false, holds: false, clears: false, failed: false };
const aaFailed = "failed: the count's A/A has no bound, so the count does not pass until the maintainer decides";
const changeFailed = "failed: the change's pairs have no bound, so the count does not pass until the maintainer decides";

/** A load's k6 summary as count.mjs seals it: its requests, failed requests and status checks. */
const sealedSummary = (requests = 5000, failed = 0, checks = { passes: 5000, fails: 0 }) => ({ metrics: { http_reqs: { count: requests }, http_req_failed: { passes: failed }, checks } });

/**
 * A stand-in host: Docker images by name and ID, the tag count.mjs reads, the daemon and the
 * containers made on it, perf and the kernel, and count.mjs, which writes its round's records as
 * the real one does. `row(round, image, target)` gives each count's row (cycles 6% more on the
 * head's image by default), `rc` its exit status, `signal` the signal that stopped it (none by
 * default), `tagRc` the tag's, and `launch(round)` the image the counted container was started
 * from (the tagged one by default).
 */
function host(results, { row = () => ({}), rc = () => 0, signal = () => null, tagRc = () => 0, onCount = () => {}, launch = () => null } = {}) {
  const ids = { "cb-corten-base": "sha256:base", "cb-corten-head": "sha256:head" };
  const state = { tagged: "", counted: [], tags: [], calls: 0, startRc: 0, daemon: { id: "daemon-1", version: "29.1.0", kernel: "6.8.0-test", name: "bench" }, perf: "perf version 6.8.12", kernel: "6.8.0-test", containers: new Map(), made: 0 };
  const paths = { docker: "/usr/bin/docker", perf: "/usr/bin/perf" };
  const hex = (n) => n.toString(16).padStart(64, "0");
  const exec = (cmd, args, options = {}) => {
    state.calls += 1;
    if (cmd === "perf") return state.perf ? { status: 0, stdout: state.perf + "\n" } : { status: 1, stdout: "" };
    if (cmd === "uname") return { status: 0, stdout: state.kernel + "\n" };
    if (cmd === "docker" && args[0] === "image") {
      const id = args[4] === "cb-corten" ? state.tagged : ids[args[4]] ?? "";
      return { status: id ? 0 : 1, stdout: id };
    }
    if (cmd === "docker" && args[0] === "info") return state.daemon ? { status: 0, stdout: JSON.stringify(state.daemon) } : { status: 1, stdout: "" };
    if (cmd === "docker" && args[0] === "version") return { status: 0, stdout: "29.1.0\n" };
    if (cmd === "docker" && args[0] === "create") {
      const name = args[args.indexOf("--name") + 1];
      if (state.containers.has(name)) return { status: 125, stdout: "" };
      const labels = {};
      for (let i = 0; i < args.length; i++) if (args[i] === "--label") { const [k, ...v] = args[i + 1].split("="); labels[k] = v.join("="); }
      const id = hex(++state.made);
      state.containers.set(name, { id, labels, image: args[args.indexOf("--entrypoint") + 2], command: args.slice(args.indexOf("--entrypoint") + 1).filter((_, i) => i !== 1), running: false });
      return { status: 0, stdout: id + "\n" };
    }
    if (cmd === "docker" && args[0] === "start") {
      for (const c of state.containers.values()) if (c.id === args[1] && state.startRc === 0) { c.running = true; return { status: 0 }; }
      return { status: state.startRc || 1 };
    }
    if (cmd === "docker" && args[0] === "inspect") {
      const c = state.containers.get(args.at(-1));
      if (!c) return { status: 1, stdout: "" };
      return { status: 0, stdout: args[2] === "{{.Id}} {{.State.Running}}" ? `${c.id} ${c.running === true}\n` : JSON.stringify(c.labels) };
    }
    if (cmd === "docker" && args[0] === "rm") {
      // Without -f the daemon removes no running container.
      for (const [name, c] of state.containers) if (c.id === args.at(-1)) { if (c.running && args[1] !== "-f") return { status: 1 }; state.containers.delete(name); return { status: 0 }; }
      return { status: 1 };
    }
    if (cmd === "docker" && args[0] === "tag") {
      state.tags.push(args[1]);
      const status = tagRc(args[1]);
      if (status === 0) state.tagged = args[1];
      return { status };
    }
    const [, round, , , target] = args;
    state.counted.push([round, state.tagged, options.env]);
    onCount(round);
    const dir = join(results, round);
    mkdirSync(dir, { recursive: true });
    const image = state.tagged;
    const n = state.counted.length;
    const r = goodRow({ userCyclesPerRequest: Math.round((image === "sha256:head" ? 106000 : 100000) * (1 + 0.001 * ((n % 5) - 2))), kernelCyclesPerRequest: 0, ...row(round, image, target) });
    writeFileSync(join(dir, "instructions.json"), JSON.stringify({ [`corten/${target}`]: [r] }));
    writeFileSync(join(dir, `count-corten-${target}-0.json`), JSON.stringify(sealedSummary(r.requests, r.failed)));
    writeFileSync(join(dir, `count-corten-${target}-0-kernel.json`), JSON.stringify(sealedSummary(r.kernelPass?.requests, r.kernelPass?.failed)));
    writeFileSync(join(dir, "count-images.json"), JSON.stringify({ [`corten/${target}`]: { container: hex(1000 + n), image: launch(round) ?? image } }));
    const stopped = signal(round);
    return stopped ? { status: null, signal: stopped } : { status: rc(round) };
  };
  /** What `docker container prune` does: removes every container not running. */
  const prune = () => { for (const [name, c] of state.containers) if (!c.running) state.containers.delete(name); };
  /** The daemon's lock's removal, as the runner makes it: the same stand-in, answered without blocking. */
  const bounded = async (cmd, args, options) => exec(cmd, args, options);
  return { ids, state, exec, bounded, paths, prune, which: (name) => paths[name] ?? null };
}

/** A temporary results directory and count kit for one test. */
function scratch() {
  const results = mkdtempSync(join(tmpdir(), "count-pairs-"));
  const kit = join(results, "kit");
  mkdirSync(join(kit, "fixtures"), { recursive: true });
  writeFileSync(join(kit, "count.mjs"), 'import { apps } from "./apps.mjs";\nimport { join } from "node:path";\n');
  writeFileSync(join(kit, "apps.mjs"), "export const apps = {};\n");
  writeFileSync(join(kit, "ssr-load.js"), 'import http from "k6/http";\n');
  writeFileSync(join(kit, "fixtures", "items.json"), "[]\n");
  return { results, kit, done: () => rmSync(results, { recursive: true, force: true }) };
}
const env = { BENCH_APP_CPUS: "1", BENCH_LOAD_CPUS: "4-7", PATH: "/usr/bin" };
const options = (s, h, over = {}) => ({ prefix: "t1", images: { base: "cb-corten-base", head: "cb-corten-head" }, last: 6, targets: ["json"], results: s.results, kit: s.kit, exec: h.exec, bounded: h.bounded, which: h.which, env, now: () => 0, ...over });
/** The calls that change what is counted: a tag or a count. */
const counts = (h) => h.state.tags.length + h.state.counted.length;

test("a run is four invocations a pair and target, the A/A the change with the base's image under both names", () => {
  const plan = schedule(100, ["page", "json"], "p1");
  assert.equal(plan.length, 101 * 2 * 4);
  // Even pairs: the change first and the side named head first; odd pairs: the A/A and base first.
  assert.deepEqual(plan.slice(0, 8).map((i) => [i.target, i.comparison, i.side, i.image]), [
    ["page", "ab", "head", "head"], ["page", "ab", "base", "base"], ["page", "aa", "head", "base"], ["page", "aa", "base", "base"],
    ["json", "ab", "head", "head"], ["json", "ab", "base", "base"], ["json", "aa", "head", "base"], ["json", "aa", "base", "base"],
  ]);
  assert.deepEqual(plan.slice(8, 12).map((i) => [i.pair, i.comparison, i.side]), [[1, "aa", "base"], [1, "aa", "head"], [1, "ab", "base"], [1, "ab", "head"]]);
  assert.ok(plan.filter((i) => i.comparison === "aa").every((i) => i.image === "base"));
  assert.equal(plan.filter((i) => !i.recorded).length, 8);
  // Every round name is new and of one length, so neither side's name nor its comparison's makes a path longer.
  assert.equal(new Set(plan.map((i) => i.name)).size, plan.length);
  assert.equal(new Set(plan.map((i) => i.name.length)).size, 1);
  assert.equal(plan[0].name, "p1-page-ab-000-head");
});

test("an invocation is valid only with a clean tag, exit 0, 5,000 requests in each of its two loads, none failed, every count a number at 100%, both loads' k6 checks and the side's image", () => {
  const summary = sealedSummary();
  const ok = { row: [goodRow()], summary, kernelSummary: summary, want: "sha256:a", before: "sha256:a", after: "sha256:a", launched: { container: "c".repeat(64), image: "sha256:a" }, rc: 0, tagRc: 0, fresh: true };
  assert.deepEqual(invalid(ok), []);
  assert.deepEqual(invalid({ ...ok, after: "sha256:b" }), ["the image counted was not the side's"]);
  assert.deepEqual(invalid({ ...ok, rc: 1 }), ["count.mjs exited 1"]);
  assert.deepEqual(invalid({ ...ok, rc: 4 }), ["count.mjs exited 4: a perf it started was not seen to end, so no further count runs on that host"]);
  assert.deepEqual(invalid({ ...ok, rc: null, signal: "SIGINT" }), ["count.mjs was stopped by SIGINT"]);
  assert.deepEqual(invalid({ ...ok, tagRc: 1 }), ["docker tag exited 1, so count.mjs was not run"]);
  assert.deepEqual(invalid({ ...ok, fresh: false }), ["its output path existed before it ran, so count.mjs was not run"]);
  assert.deepEqual(invalid({ ...ok, row: [goodRow({ failed: 2, userCyclesPerRequest: null })] }), ["2 failed requests", "userCyclesPerRequest is null, not a number", "its k6 summary gives 0 failed requests where the row has 2"]);
  assert.deepEqual(invalid({ ...ok, row: [goodRow({ userCyclesPerRequest: "100000" })] }), ["userCyclesPerRequest is \"100000\", not a number"]);
  assert.deepEqual(invalid({ ...ok, row: [goodRow({ kernelPerRequest: Infinity })] }), ["kernelPerRequest is Infinity, not a number"]);
  assert.deepEqual(invalid({ ...ok, row: [goodRow({ perfRunningPct: { ...running, "cycles:k": 88 } })] }), ["perf ran cycles:k 88% of its enabled time, not 100%"]);
  assert.deepEqual(invalid({ ...ok, row: [goodRow({ perfRunningPct: undefined })] }), Object.values(COUNTS).map((e) => `perf's running percentage for ${e} is not recorded`));
  assert.deepEqual(invalid({ ...ok, row: { failed: "never answered" } }), ["count.mjs recorded failed: never answered"]);
  assert.deepEqual(invalid({ ...ok, summary: sealedSummary(5000, 0, { passes: 4999, fails: 1 }) }), ["1 failed status checks", "4999 passed status checks, not 5000"]);
  // Kernel instructions come from a second load (#2151): it must be whole too, by its row and its summary.
  assert.deepEqual(invalid({ ...ok, kernelSummary: sealedSummary(5000, 0, { passes: 4999, fails: 1 }) }), ["1 failed status checks in the kernel instructions' load", "4999 passed status checks in the kernel instructions' load, not 5000"]);
  // A sealed summary that disagrees with a clean row, in either load: its requests or its failures.
  assert.deepEqual(invalid({ ...ok, summary: sealedSummary(4999) }), ["its k6 summary gives 4999 requests where the row has 5000"]);
  assert.deepEqual(invalid({ ...ok, kernelSummary: sealedSummary(4999) }), ["its k6 summary gives 4999 requests in the kernel instructions' load where the row has 5000"]);
  assert.deepEqual(invalid({ ...ok, summary: sealedSummary(5000, 3) }), ["its k6 summary gives 3 failed requests where the row has 0"]);
  assert.deepEqual(invalid({ ...ok, kernelSummary: sealedSummary(5000, 2) }), ["its k6 summary gives 2 failed requests in the kernel instructions' load where the row has 0"]);
  assert.deepEqual(invalid({ ...ok, kernelSummary: { metrics: { checks: { passes: 5000, fails: 0 } } } }), ["its k6 summary gives no requests in the kernel instructions' load where the row has 5000", "its k6 summary gives no failed requests in the kernel instructions' load where the row has 0"]);
  // A kernel load of 4,999 requests with failures, its row and summary agreeing: not valid.
  assert.deepEqual(invalid({ ...ok, row: [goodRow({ kernelPass: { requests: 4999, failed: 2 } })], kernelSummary: sealedSummary(4999, 2, { passes: 4997, fails: 2 }) }), ["4999 requests in the kernel instructions' load, not 5000", "2 failed requests in the kernel instructions' load", "2 failed status checks in the kernel instructions' load", "4997 passed status checks in the kernel instructions' load, not 5000"]);
  assert.deepEqual(invalid({ ...ok, kernelSummary: undefined }), ["no k6 summary of the counted load in the kernel instructions' load"]);
  assert.deepEqual(invalid({ ...ok, row: [goodRow({ kernelPass: { requests: 4990, failed: 3 } })] }), ["4990 requests in the kernel instructions' load, not 5000", "3 failed requests in the kernel instructions' load", "its k6 summary gives 5000 requests in the kernel instructions' load where the row has 4990", "its k6 summary gives 0 failed requests in the kernel instructions' load where the row has 3"]);
  assert.deepEqual(invalid({ ...ok, row: [goodRow({ kernelPass: undefined })] }), ["undefined requests in the kernel instructions' load, not 5000", "undefined failed requests in the kernel instructions' load", "its k6 summary gives 5000 requests in the kernel instructions' load where the row has undefined", "its k6 summary gives 0 failed requests in the kernel instructions' load where the row has undefined"]);
  assert.deepEqual(invalid({ ...ok, interrupted: true }), ["started and never ended; not run again"]);
});

test("a change is read by the default band where its A/A's two bounds less +1% are inside it", () => {
  const aa = of(-0.02, 0.02);
  assert.equal(resolution(aa), "resolved");
  assert.ok(inside(/** @type {number} */ (aa.bound)) && inside(/** @type {number} */ (aa.swappedBound)));
  assert.deepEqual(reading(of(0.04, 0.08), aa), { verdict: "a miss", decided: true, holds: true, clears: false, failed: false });
  assert.deepEqual(reading(of(-0.08, -0.05), aa), { verdict: "meets +1%", decided: true, holds: false, clears: true, failed: false });
  assert.deepEqual(reading(of(-0.01, 0.03), aa), { verdict: "inside the default band: not decided", decided: false, holds: false, clears: false, failed: false });
  // The band's ends are inside.
  assert.ok(inside(BAND.high + MARGIN - 1e-12) && inside(BAND.low + MARGIN + 1e-12));
  assert.ok(!inside(BAND.high + MARGIN + 1e-9) && !inside(BAND.low + MARGIN - 1e-9));
});

test("where the A/A has both bounds and reads outside the band, as recorded or swapped, above or below, the change is not decided, read as inside, and not failed", () => {
  const above = of(0.05, 0.15), below = of(-0.08, -0.04);
  // Recorded inside, swapped outside: 42 pairs read -10% and 58 read 0 to +1%.
  const skewed = compare(pairsOf([...Array(42).fill(-0.1), ...spread(0, 0.01, 58)]));
  assert.ok(inside(/** @type {number} */ (skewed.bound)) && !inside(/** @type {number} */ (skewed.swappedBound)));
  for (const aa of [above, below, skewed]) {
    assert.equal(resolution(aa), "not resolved");
    for (const change of [of(0.04, 0.08), of(-0.08, -0.05), of(-0.01, 0.03)]) assert.deepEqual(reading(change, aa), notDecided);
  }
});

test("an A/A or a change with a pair not valid, or too few pairs, has no bound: the count failed, and does not pass until the maintainer decides", () => {
  const broken = pairsOf(spread(-0.02, 0.02)).map((p, i) => (i === 7 ? { ...p, head: null } : p));
  const aa = compare(broken);
  assert.equal(aa.bound, null);
  assert.equal(resolution(aa), "no bound");
  assert.deepEqual(reading(of(0.04, 0.08), aa), { verdict: aaFailed, decided: false, holds: false, clears: false, failed: true });
  assert.deepEqual(reading(compare(broken), of(-0.02, 0.02)), { verdict: changeFailed, decided: false, holds: false, clears: false, failed: true });
  assert.equal(resolution(compare(pairsOf(spread(-0.02, 0.02, 4)))), "no bound");
  // A string where a count should be is not a value.
  assert.equal(compare([{ pair: 1, base: "100000", head: 100000 }, ...pairsOf(spread(-0.02, 0.02, 9))]).bound, null);
});

// User plus kernel cycles a request of each recorded pair, [the side named base, the side named
// head], as the kit's reports posted them on #2066: the base's image against itself, then against
// the head's (https://github.com/corten-run/corten/pull/2066#issuecomment-7193965628 and
// #issuecomment-7187087634).
const pr2066 = {
  aaPage: [[207205, 130678], [130978, 131973], [173565, 188961], [198808, 131892], [131858, 131489], [134885, 131284], [205614, 204500], [130166, 129709], [139189, 174827], [159396, 147831], [172402, 151551], [185832, 175872], [145751, 165078], [200024, 177558], [157141, 156947], [154555, 128498], [203952, 185741], [162283, 206018], [132829, 199487], [203066, 201342], [204291, 170490], [130410, 171931], [158208, 209293], [172966, 158691], [172067, 131280], [203546, 195880], [185287, 180923], [173310, 133602], [133796, 130232], [129935, 206128], [193436, 139401], [209236, 189754], [130063, 130091], [146046, 152853], [129366, 209965], [171615, 134105], [209487, 131072], [129196, 161081], [132337, 133542], [128693, 177190], [147717, 206350], [182810, 129729], [131414, 133177], [130487, 128970], [148218, 132227], [132926, 129558], [164101, 131152], [198886, 131142], [148713, 210557], [133330, 130826], [134338, 132288], [145927, 144704], [131673, 134509], [176707, 134788], [145888, 126980], [136854, 170123], [132067, 146276], [150025, 132995], [168249, 129233], [183433, 163437], [173094, 211455], [211079, 168343], [176232, 132033], [200412, 205257], [129987, 213752], [141959, 175764], [208863, 190826], [130487, 161618], [130340, 133877], [204855, 170960], [150542, 198455], [181874, 130491], [131938, 207199], [127556, 206817], [179474, 154051], [155896, 158714], [151918, 132127], [168270, 199797], [139673, 167956], [139049, 168633], [129206, 198235], [131204, 209910], [154880, 186175], [184365, 153486], [171492, 178504], [133386, 182651], [182061, 185913], [196311, 129750], [210029, 209080], [203225, 129396], [141870, 155656], [206422, 200826], [188991, 155803], [128891, 210026], [132797, 212601], [142602, 156529], [153662, 155768], [189091, 131240], [130914, 130400], [179281, 169505]],
  aaJson: [[107648, 108123], [107950, 159899], [135247, 135972], [177384, 110392], [108107, 173610], [108030, 167270], [122591, 141488], [136801, 173777], [168509, 177104], [170787, 106130], [134691, 109645], [179023, 112766], [166808, 117103], [175536, 128575], [133238, 127240], [134997, 152726], [161290, 177178], [178052, 116262], [109690, 148666], [110587, 119133], [177483, 173561], [105802, 111363], [111818, 112799], [158069, 123920], [179867, 109338], [140025, 166914], [170588, 151861], [106864, 106544], [170221, 119307], [107682, 128488], [107671, 169530], [132014, 106818], [125028, 141773], [107093, 172341], [107493, 107985], [105557, 109000], [109181, 174200], [176341, 148241], [159932, 174585], [174031, 109915], [173688, 112159], [111892, 145590], [167903, 111153], [138934, 106473], [108286, 140008], [108625, 109172], [141426, 172654], [109281, 105933], [153694, 115632], [111180, 144295], [115457, 172553], [117059, 147631], [159502, 111914], [112412, 108761], [175934, 179653], [153599, 172400], [111311, 168627], [107920, 145925], [106800, 170077], [117656, 113139], [149399, 169885], [113325, 110213], [173996, 120194], [112136, 113269], [133596, 147401], [127673, 152850], [105741, 109179], [147682, 177575], [172685, 177772], [105387, 171839], [153774, 155568], [105993, 107593], [106458, 139073], [103209, 159161], [110448, 153979], [106231, 121396], [107414, 108744], [147336, 143942], [139918, 133865], [109698, 107384], [109099, 143965], [159491, 108519], [141875, 105623], [163932, 177978], [105425, 175626], [136179, 143770], [179904, 181568], [108723, 163878], [108053, 144848], [183356, 109124], [107750, 177825], [174477, 161980], [108479, 139471], [107668, 106899], [141812, 111422], [125838, 113518], [175876, 115624], [110599, 143619], [109202, 139999], [115048, 173318]],
  abPage: [[196094, 133454], [210774, 170861], [170278, 162248], [133180, 173867], [159154, 129050], [197736, 206728], [198207, 147205], [135459, 207839], [160840, 162047], [207585, 143185], [159489, 135094], [205102, 181960], [182795, 196533], [136075, 173382], [202871, 144873], [203030, 213249], [188258, 209659], [185500, 178924], [141630, 127948], [176701, 162769], [155752, 140161], [207502, 155100], [134612, 149615], [192944, 211741], [201417, 209885], [186692, 175594], [134589, 141150], [173477, 133884], [185161, 137224], [190093, 215323], [130748, 142568], [204734, 195902], [176306, 195119], [192862, 132183], [180971, 128430], [187028, 163525], [131920, 150470], [151337, 209685], [201504, 143533], [157438, 175022], [133029, 165197], [150389, 199022], [198990, 135275], [210694, 210065], [158322, 205379], [199628, 132020], [176999, 173165], [188697, 141993], [167024, 132872], [204822, 137639], [206979, 195293], [196417, 211779], [181138, 213730], [208424, 173196], [144407, 211453], [134415, 175862], [163739, 178061], [203674, 186473], [134474, 135818], [207086, 139628], [167595, 209997], [202473, 141781], [171045, 133863], [179396, 173485], [132379, 198178], [215845, 175592], [201287, 132795], [180803, 160749], [130729, 180389], [155488, 166928], [214953, 151669], [155350, 128973], [166972, 128112], [130056, 157994], [131932, 179975], [132312, 133871], [133378, 137456], [131725, 134601], [205354, 129051], [195117, 151313], [135575, 129705], [188016, 127528], [129951, 188807], [133457, 149138], [152052, 129566], [210872, 151157], [133578, 191833], [141596, 127461], [186343, 159623], [203834, 179035], [221331, 165194], [199569, 194119], [171808, 191866], [188490, 198861], [160971, 129052], [129879, 206929], [133970, 190119], [128818, 131381], [205285, 193859], [135563, 133223]],
  abJson: [[136249, 172688], [112041, 110850], [155247, 179646], [134304, 148303], [174987, 177949], [154729, 120986], [139803, 152325], [179121, 127940], [140624, 164006], [174246, 184294], [135738, 167508], [174036, 110197], [139244, 113509], [181427, 109146], [108526, 110375], [111775, 112740], [177770, 133595], [124337, 160613], [114986, 109651], [178640, 134015], [129680, 128162], [142137, 137767], [109608, 162526], [124099, 174038], [177123, 152639], [123324, 176414], [126433, 169507], [116888, 111383], [165315, 175678], [151196, 173002], [113734, 159086], [147710, 146823], [140804, 173450], [114168, 167761], [112320, 176172], [111002, 153810], [179920, 106736], [136377, 113548], [145401, 150937], [116185, 119978], [109679, 111066], [108086, 114723], [116532, 174995], [114127, 168340], [158524, 150681], [145311, 175090], [150337, 111056], [117547, 134992], [121919, 113863], [147647, 109387], [174012, 150761], [176320, 145759], [162268, 166208], [110577, 168335], [111262, 177668], [157268, 130832], [110311, 159907], [139594, 167963], [136777, 163018], [156487, 167882], [133821, 128779], [131906, 156512], [133729, 131352], [144752, 157244], [150708, 117635], [171094, 114385], [146766, 176419], [143665, 151925], [144874, 113982], [158073, 173422], [130479, 107241], [113795, 145072], [122644, 179955], [171546, 170013], [112033, 114059], [116026, 117152], [145221, 128414], [145005, 171743], [171259, 108662], [106629, 111338], [108969, 158653], [136774, 177621], [109178, 106954], [110848, 113271], [111565, 174609], [172497, 144224], [128710, 184402], [107419, 146363], [160224, 163614], [157900, 147216], [106924, 107656], [173387, 175683], [154397, 149075], [128844, 149079], [115450, 117419], [177207, 106245], [133450, 135823], [145132, 179577], [145260, 107437], [116063, 138627]],
};

test("on #2066's counts json's A/A does not resolve, so its miss is not decided, and page's resolves and stays inside the band", () => {
  const c = (rows) => compare(rows.map(([base, head], i) => ({ pair: i + 1, base, head })));
  const aa = { page: c(pr2066.aaPage), json: c(pr2066.aaJson) }, change = { page: c(pr2066.abPage), json: c(pr2066.abJson) };
  const near = (got, want) => assert.ok(Math.abs(/** @type {number} */ (got) - want) < 5e-6, `${got} is not ${want}`);
  // The posted bounds, from these rows.
  near(aa.json.bound, 0.098506); near(aa.json.swappedBound, -0.005332);
  near(aa.page.bound, 0.013416); near(aa.page.swappedBound, 0.027367);
  near(change.json.bound, 0.072818); near(change.page.bound, 0.011783);
  assert.equal(resolution(aa.json), "not resolved");
  assert.deepEqual(reading(change.json, aa.json), notDecided);
  assert.equal(resolution(aa.page), "resolved");
  assert.equal(reading(change.page, aa.page).verdict, "inside the default band: not decided");
});

test("the runner pins each image's ID, tags by it, runs each invocation once and reads the change against its own A/A", async () => {
  const s = scratch();
  try {
    const h = host(s.results);
    const first = await runPairs(options(s, h));
    assert.equal(h.state.counted.length, 7 * 4);
    // Tagged by the pinned ID, never by the image's name.
    assert.ok(h.state.tags.every((t) => t === "sha256:base" || t === "sha256:head"));
    for (const [round, image] of h.state.counted) assert.equal(image, round.includes("-ab-") && round.endsWith("-head") ? "sha256:head" : "sha256:base", round);
    // count.mjs is given the run's environment.
    assert.ok(h.state.counted.every(([, , e]) => e === env));
    const json = first.targets.json;
    assert.equal(json.change.n, 6);
    assert.ok(json.change.bound > 0.05 && json.aa.bound < 0.01);
    // Six pairs give a 95% rank, the 6th: P(Binomial(6, 1/2) >= 6) = 1/64.
    assert.equal(json.change.rank, 6);
    assert.equal(json.reading.verdict, "a miss");
    assert.ok(complete(first.targets));
    assert.match(first.md, /## `json`/);
    const report = JSON.parse(readFileSync(join(s.results, "t1", "report.json"), "utf8"));
    assert.equal(report.targets.json.aa.n, 6);
    const ledger = JSON.parse(readFileSync(join(s.results, "t1", "run.json"), "utf8"));
    assert.deepEqual(ledger.ids, { base: "sha256:base", head: "sha256:head" });
    assert.deepEqual([ledger.pairs, ledger.targets, ledger.env.BENCH_APP_CPUS, ledger.env.BENCH_LOAD_CPUS, ledger.env.BENCH_TIER, ledger.count.args], [6, ["json"], "1", "4-7", null, ["<round>", "1", "corten", "<target>"]]);
    assert.equal(ledger.schedule.length, 7 * 4);
    // Both locks are gone once it ends.
    assert.ok(!existsSync(join(s.results, "t1", "run.lock")) && h.state.containers.size === 0);
    // Run again, nothing is counted again.
    await runPairs(options(s, h));
    assert.equal(h.state.counted.length, 7 * 4);
  } finally {
    s.done();
  }
});

test("the report keeps the user and kernel cycle split, kernel instructions and user L1 instruction-cache misses of each side, and names each failure's comparison, pair and side", async () => {
  const s = scratch();
  try {
    const h = host(s.results, { row: (round) => ({ kernelCyclesPerRequest: 54000, kernelPerRequest: round.endsWith("-head") ? 26500 : 26000, userL1iMissesPerRequest: 4100 }), rc: (round) => (round === "t1-json-aa-003-head" ? 1 : 0) });
    const { md, targets } = await runPairs(options(s, h));
    const d = targets.json.diagnostics;
    assert.deepEqual(Object.keys(d.ab), Object.keys(COUNTS));
    assert.equal(d.ab.kernelCyclesPerRequest.base, 54000);
    assert.equal(d.ab.kernelPerRequest.head, 26500);
    assert.ok(Math.abs(d.ab.kernelPerRequest.change - (26500 / 26000 - 1)) < 1e-12);
    assert.equal(d.aa.userL1iMissesPerRequest.head, 4100);
    // Each measure names the load it is counted over: kernel instructions are a second load's.
    for (const label of ["user cycles, first load", "kernel cycles, first load", "user instructions, first load", "kernel instructions, second load", "user L1i misses, first load"]) assert.match(md, new RegExp(`\\| the change \\| ${label} \\|`));
    assert.match(md, /user and kernel cycles \(the reading above\), user instructions and user L1i misses over the first, kernel instructions alone over the second, each over its own load's requests/);
    assert.match(md, /- its A\/A, pair 3, side head: count\.mjs exited 1/);
  } finally {
    s.done();
  }
});

test("a failed command or a record not to be trusted yields no bound: exit 1 with valid-looking output, a failed tag, a string cycle count, a counter at 88%", async () => {
  const cases = {
    "count.mjs exited 1": { rc: (round) => (round === "t1-json-ab-002-base" ? 1 : 0) },
    "docker tag exited 1, so count.mjs was not run": { tagRc: (() => { let n = 0; return () => (++n === 9 ? 1 : 0); })() },
    "userCyclesPerRequest is \"100000\", not a number": { row: (round) => (round === "t1-json-aa-004-base" ? { userCyclesPerRequest: "100000" } : {}) },
    "perf ran cycles:u 88% of its enabled time, not 100%": { row: (round) => (round === "t1-json-ab-005-head" ? { perfRunningPct: { ...running, "cycles:u": 88 } } : {}) },
  };
  for (const [why, how] of Object.entries(cases)) {
    const s = scratch();
    try {
      const h = host(s.results, how);
      const { targets } = await runPairs(options(s, h));
      const json = targets.json;
      assert.ok(json.change.bound == null || json.aa.bound == null, why);
      assert.equal(json.reading.failed, true, why);
      assert.equal(json.reading.holds || json.reading.clears, false, why);
      assert.ok(!complete(targets), why);
      assert.ok(Object.values(json.pairs).flat().some((p) => p.why.some((w) => w.endsWith(why))), why);
    } finally {
      s.done();
    }
  }
});

test("a count.mjs that could not see its perf end (exit 4) stops the run: no further invocation on that host, now or when the command is run again", async () => {
  const s = scratch();
  try {
    const stuck = "t1-json-ab-002-base";
    const h = host(s.results, { rc: (round) => (round === stuck ? 4 : 0) });
    await assert.rejects(runPairs(options(s, h)), /count\.mjs exited 4 in t1-json-ab-002-base: a perf it started was not seen to end, so no further count runs on this host; stopped with no report/);
    const ran = h.state.counted.map(([round]) => round);
    assert.equal(ran.at(-1), stuck);
    const tags = h.state.tags.length;
    // Run again: refused before any tag or count.
    await assert.rejects(runPairs(options(s, h)), /count\.mjs exited 4 in t1-json-ab-002-base/);
    assert.deepEqual(h.state.counted.map(([round]) => round), ran);
    assert.equal(h.state.tags.length, tags);
  } finally {
    s.done();
  }
});

test("a count.mjs exit 4 is in the ledger before anything that can fail: a failed image read or seal after it still stops the run, now and when run again", async () => {
  const stuck = "t1-json-ab-002-base";
  const records = (/** @type {string} */ results) => readFileSync(join(results, "t1", "invocations.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  // What fails once count.mjs has returned 4: the read of the tag's image, or reading an output to seal it.
  for (const where of ["image", "seal"]) {
    const s = scratch();
    let armed = false;
    try {
      const h = host(s.results, { rc: (round) => (round === stuck ? ((armed = true), 4) : 0) });
      const exec = h.exec;
      const failing = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ options) => {
        if (armed && where === "image" && cmd === "docker" && args[0] === "image" && args[4] === "cb-corten") throw Object.assign(new Error("EIO: i/o error, docker image inspect"), { code: "EIO" });
        return exec(cmd, args, options);
      };
      const read = fs.readFileSync;
      mock.method(fs, "readFileSync", function (/** @type {any} */ path, /** @type {any[]} */ ...rest) {
        if (armed && where === "seal" && String(path).endsWith(join(stuck, "count-corten-json-0-kernel.json"))) throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
        return read.call(this, path, ...rest);
      });
      syncBuiltinESMExports();
      await assert.rejects(runPairs(options(s, { ...h, exec: failing })), /count\.mjs exited 4 in t1-json-ab-002-base: a perf it started was not seen to end/, where);
      mock.restoreAll();
      syncBuiltinESMExports();
      armed = false;
      // Its exit is in the ledger, though its end is not.
      const mine = records(s.results).filter((r) => r.name === stuck);
      assert.deepEqual(mine.map((r) => Object.keys(r).find((k) => ["started", "dispatched", "exited", "ended"].includes(k))), ["started", "dispatched", "exited"], where);
      assert.equal(mine[2].rc, 4, where);
      const ran = h.state.counted.length, tags = h.state.tags.length;
      assert.equal(h.state.counted.at(-1)?.[0], stuck, where);
      // Run again: refused before any tag or count.
      await assert.rejects(runPairs(options(s, h)), /count\.mjs exited 4 in t1-json-ab-002-base/, where);
      assert.equal(h.state.counted.length, ran, where);
      assert.equal(h.state.tags.length, tags, where);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
      s.done();
    }
  }
});

test("a count.mjs stopped by a signal stops the run as an exit 4 does: no further invocation on that host, now or when the command is run again", async () => {
  const stuck = "t1-json-ab-002-base";
  const records = (/** @type {string} */ results) => readFileSync(join(results, "t1", "invocations.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const why = /count\.mjs was stopped by SIGKILL in t1-json-ab-002-base before it saw each perf and probe it started end: one may still count, so no further count runs on this host; stopped with no report\. Count on a fresh host under a new prefix/;
  for (const signal of ["SIGKILL", "SIGTERM"]) {
    const s = scratch();
    try {
      const h = host(s.results, { signal: (round) => (round === stuck ? signal : null) });
      await assert.rejects(runPairs(options(s, h)), new RegExp(why.source.replace("SIGKILL", signal)), signal);
      assert.equal(h.state.counted.at(-1)?.[0], stuck, signal);
      // Its exit is in the ledger and its end is not: nothing of it is sealed or read.
      const mine = records(s.results).filter((r) => r.name === stuck);
      assert.deepEqual(mine.map((r) => Object.keys(r).find((k) => ["started", "dispatched", "exited", "ended"].includes(k))), ["started", "dispatched", "exited"], signal);
      assert.equal(mine[2].signal, signal);
      const ran = h.state.counted.length, tags = h.state.tags.length;
      // Run again: refused before any tag or count.
      await assert.rejects(runPairs(options(s, h)), new RegExp(why.source.replace("SIGKILL", signal)), signal);
      assert.equal(h.state.counted.length, ran, signal);
      assert.equal(h.state.tags.length, tags, signal);
    } finally {
      s.done();
    }
  }
  // A ledger in which a signalled count's end was recorded, as the runner before this change wrote
  // one (and told the operator to run again): the replay refuses it too, rather than counting on.
  const s = scratch();
  try {
    const h = host(s.results);
    let n = 0;
    await assert.rejects(runPairs(options(s, h, { stop: () => ++n > 3 })), /stopped before/);
    const name = schedule(6, ["json"], "t1")[3].name;
    for (const row of [{ name, want: "sha256:base", started: 0 }, { name, dispatched: 0 }, { name, exited: 0, rc: null, signal: "SIGKILL" }, { name, want: "sha256:base", started: 0, ended: 0, fresh: true, tagRc: 0, rc: null, signal: "SIGKILL", before: "sha256:base", after: "sha256:base", artifacts: {} }]) {
      appendFileSync(join(s.results, "t1", "invocations.jsonl"), JSON.stringify(row) + "\n");
    }
    const ran = h.state.counted.length;
    await assert.rejects(runPairs(options(s, h)), new RegExp(why.source.replace("t1-json-ab-002-base", name)));
    assert.equal(h.state.counted.length, ran);
    // The control: the same ledger with that invocation exiting 1 goes on past it.
    const lines = readFileSync(join(s.results, "t1", "invocations.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    writeFileSync(join(s.results, "t1", "invocations.jsonl"), lines.map((r) => JSON.stringify(r.name === name && "signal" in r ? { ...r, rc: 1, signal: null } : r)).join("\n") + "\n");
    const { targets } = await runPairs(options(s, h));
    assert.equal(h.state.counted.length, 7 * 4 - 1);
    assert.equal(targets.json.aa.bound, null);
    assert.notEqual(targets.json.change.bound, null);
  } finally {
    s.done();
  }
});

test("past a count.mjs exit 4 or a signal the runner asks Docker only to remove its lock, and waits for that no longer than RELEASE_MS, however Docker answers", async (t) => {
  const stuck = "t1-json-ab-002-base";
  for (const [how, over] of [["exit 4", { rc: (/** @type {string} */ round) => (round === stuck ? 4 : 0) }], ["SIGKILL", { signal: (/** @type {string} */ round) => (round === stuck ? "SIGKILL" : null) }]]) {
    // withheld: a docker client that does not exit, even after its SIGKILL (one stuck in the kernel).
    for (const answer of ["withheld", "failed", "removed"]) {
      const s = scratch();
      t.mock.timers.enable({ apis: ["setTimeout"] });
      try {
        const h = host(s.results, over);
        /** @type {string[][]} */
        const after = [];
        /** @type {[string[], any][]} */
        const removals = [];
        let returned = false;
        let held = "";
        /** @type {() => void} */
        let asked = () => {};
        const asking = new Promise((/** @type {(v?: unknown) => void} */ r) => (asked = r));
        const exec = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts = {}) => {
          if (returned) {
            after.push([cmd, ...args]);
            // A removal made by a call that returns once its child exits waits on that child, past
            // any SIGKILL its timeout sends: here, a while past RELEASE_MS.
            if (answer === "withheld" && args[0] === "rm") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RELEASE_MS + 2000);
            return { status: null, signal: "SIGKILL" };
          }
          const r = h.exec(cmd, args, opts);
          if (String(args[0]).endsWith("count.mjs") && args[1] === stuck) { returned = true; held = h.state.containers.get(DAEMON_LOCK)?.id ?? ""; }
          return r;
        };
        const bounded = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
          removals.push([[cmd, ...args], opts]);
          asked();
          if (answer === "withheld") return new Promise(() => {});
          return Promise.resolve(answer === "failed" ? { status: null } : h.exec(cmd, args, opts));
        };
        /** @type {string[]} */
        const said = [];
        const started = Date.now();
        const run = runPairs(options(s, { ...h, exec, bounded }, { log: (/** @type {string} */ l) => said.push(l) }));
        await Promise.race([asking, run.then(() => {}, () => {})]);
        t.mock.timers.tick(RELEASE_MS);
        await assert.rejects(run, how === "exit 4" ? /count\.mjs exited 4 in t1-json-ab-002-base/ : /stopped by SIGKILL in t1-json-ab-002-base/, how);
        const where = `${how}, ${answer}`;
        assert.ok(Date.now() - started < RELEASE_MS, `${where}: returned ${Date.now() - started} ms after it started`);
        assert.ok(returned, where);
        // No image read, seal or lock check after it, and no call that waits on its child: one
        // removal of the lock by its ID, not waited for past its bound.
        assert.deepEqual(after, [], where);
        assert.deepEqual(removals.map(([c]) => c), [["docker", "rm", "-f", held]], where);
        assert.equal(removals[0][1].timeout, RELEASE_MS, where);
        if (answer === "removed") assert.equal(h.state.containers.size, 0, where);
        else assert.ok(said.some((l) => l.includes(`the daemon's lock was not removed: remove it with docker rm -f ${DAEMON_LOCK}`)), `${where}: ${said.join("\n")}`);
        // run.lock is released all the same.
        assert.ok(!existsSync(join(s.results, "t1", "run.lock")), where);
      } finally {
        t.mock.timers.reset();
        s.done();
      }
    }
  }
  // The bound is the runner's exec's for every other call: a command past it is killed and given a null status.
  const started = Date.now();
  const r = spawnExec(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeout: 500, output: false });
  assert.equal(r.status, null);
  assert.ok(Date.now() - started < 20_000, `returned ${Date.now() - started} ms after it started`);
  assert.equal(spawnExec(process.execPath, ["-e", "process.exit(0)"], { timeout: 20_000, output: false }).status, 0);
});

test("the lock's removal settles at its deadline whether or not its command exits, and does not keep the process for it", async () => {
  // A docker client that ignores its SIGKILL and never exits, as one stuck in the kernel does.
  const child = Object.assign(new EventEmitter(), { signals: /** @type {string[]} */ ([]), unrefd: false, kill(/** @type {string} */ signal) { this.signals.push(signal); return true; }, unref() { this.unrefd = true; } });
  const started = Date.now();
  assert.deepEqual(await spawnBounded("docker", ["rm", "-f", "x"], { timeout: 300 }, /** @type {any} */ (() => child)), { status: null });
  assert.ok(Date.now() - started < 10_000, `settled ${Date.now() - started} ms after it started`);
  assert.deepEqual(child.signals, ["SIGKILL"]);
  assert.ok(child.unrefd, "the child is unref'd, so it keeps neither the runner nor its caller");
  // A real command: one past its bound is killed and given a null status; one that exits gives its status; one not found, null.
  const t0 = Date.now();
  assert.deepEqual(await spawnBounded(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeout: 500 }), { status: null });
  assert.ok(Date.now() - t0 < 20_000, `settled ${Date.now() - t0} ms after it started`);
  assert.deepEqual(await spawnBounded(process.execPath, ["-e", "process.exit(3)"], { timeout: 20_000 }), { status: 3 });
  assert.deepEqual(await spawnBounded(join(tmpdir(), "no-such-docker-here"), [], { timeout: 20_000 }), { status: null });
  // The deadline itself does not wait on what it bounds: a promise that never settles, or rejects, gives the fallback.
  assert.equal(await within(new Promise(() => {}), 50, false), false);
  assert.equal(await within(Promise.reject(new Error("EIO")), 20_000, false), false);
  assert.equal(await within(Promise.resolve(true), 20_000, false), true);
});

test("a ledger that kept a halt is refused when run again before any Docker call: no image, lock, environment or count", async () => {
  const stuck = "t1-json-ab-002-base";
  for (const [kind, over, why] of [
    ["exit 4", { rc: (/** @type {string} */ round) => (round === stuck ? 4 : 0) }, /count\.mjs exited 4 in t1-json-ab-002-base/],
    ["SIGTERM", { signal: (/** @type {string} */ round) => (round === stuck ? "SIGTERM" : null) }, /count\.mjs was stopped by SIGTERM in t1-json-ab-002-base/],
    ["no exit", { onCount: (/** @type {string} */ round) => { if (round === stuck) throw new Error("the runner died"); } }, /count\.mjs was started in t1-json-ab-002-base and its exit was not recorded/],
  ]) {
    const s = scratch();
    try {
      const h = host(s.results, /** @type {any} */ (over));
      await assert.rejects(runPairs(options(s, h)), kind === "no exit" ? /the runner died/ : why, kind);
      const calls = h.state.calls;
      let removals = 0;
      const bounded = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => { removals += 1; return h.bounded(cmd, args, opts); };
      await assert.rejects(runPairs(options(s, { ...h, bounded })), why, kind);
      assert.equal(h.state.calls - calls, 0, `${kind}: ${h.state.calls - calls} calls on the host when run again`);
      assert.equal(removals, 0, kind);
      // Refused under run.lock: another runner's lock is reported as before, and this one's is released.
      assert.ok(!existsSync(join(s.results, "t1", "run.lock")), kind);
      writeFileSync(join(s.results, "t1", "run.lock"), JSON.stringify({ pid: 1, host: "elsewhere", started: "then", ledger: "t1" }) + "\n");
      await assert.rejects(runPairs(options(s, h)), /is locked by process 1 on elsewhere/, kind);
      assert.equal(h.state.calls - calls, 0, kind);
    } finally {
      s.done();
    }
  }
});

test("a count.mjs started with no end recorded stops the run when run again: its exit not kept may have been 4, and one kept was not sealed", async () => {
  const stuck = "t1-json-ab-002-base";
  // The runner dies while count.mjs runs (its exit never comes back), or once count.mjs has exited 0
  // and before its end is recorded (a seal that fails).
  for (const [kind, why] of [
    ["died", /count\.mjs was started in t1-json-ab-002-base and its exit was not recorded: it may have exited 4, a perf it started not seen to end, so no further count runs on this host; stopped with no report/],
    ["unsealed", /count\.mjs exited 0 in t1-json-ab-002-base and the end of that invocation \(the image it counted and its sealed outputs\) was not recorded; stopped with no report/],
  ]) {
    const s = scratch();
    let armed = false;
    try {
      const h = host(s.results, { onCount: (round) => { if (kind === "died" && round === stuck) throw new Error("the runner died"); }, rc: (round) => ((armed = round === stuck), 0) });
      const exec = h.exec;
      const failing = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ options) => {
        if (armed && cmd === "docker" && args[0] === "image" && args[4] === "cb-corten") throw new Error("EIO: i/o error, docker image inspect");
        return exec(cmd, args, options);
      };
      await assert.rejects(runPairs(options(s, { ...h, exec: failing })), kind === "died" ? /the runner died/ : /EIO/, kind);
      armed = false;
      const ran = h.state.counted.length, tags = h.state.tags.length;
      await assert.rejects(runPairs(options(s, h)), why, kind);
      assert.equal(h.state.counted.length, ran, kind);
      assert.equal(h.state.tags.length, tags, kind);
    } finally {
      s.done();
    }
  }
  // The control: a start row with nothing after it (the runner stopped before count.mjs started)
  // is the interrupted invocation it always was, not run again, and the run goes on past it.
  const s = scratch();
  try {
    const h = host(s.results);
    let n = 0;
    await assert.rejects(runPairs(options(s, h, { stop: () => ++n > 3 })), /stopped before/);
    appendFileSync(join(s.results, "t1", "invocations.jsonl"), JSON.stringify({ name: schedule(6, ["json"], "t1")[3].name, want: "sha256:base", started: 0 }) + "\n");
    const { targets } = await runPairs(options(s, h));
    assert.equal(h.state.counted.length, 7 * 4 - 1);
    assert.ok(targets.json);
  } finally {
    s.done();
  }
});

test("an output path that exists before its invocation runs is not counted into, and leaves its comparison with no bound", async () => {
  const s = scratch();
  try {
    // The run refuses to start where any of its output paths exists.
    mkdirSync(join(s.results, "t1-json-aa-002-base"), { recursive: true });
    const h0 = host(s.results);
    await assert.rejects(runPairs(options(s, h0)), /output paths exist already/);
    assert.equal(h0.state.counted.length, 0);
    rmSync(join(s.results, "t1-json-aa-002-base"), { recursive: true });
    // Once it is going, a path made by something else before its invocation is skipped, not merged into.
    rmSync(join(s.results, "t1"), { recursive: true, force: true });
    const reused = "t1-json-ab-004-head";
    const made = () => {
      mkdirSync(join(s.results, reused), { recursive: true });
      writeFileSync(join(s.results, reused, "instructions.json"), JSON.stringify({ "corten/json": [goodRow()] }));
    };
    const h = host(s.results, { onCount: (round) => { if (round === "t1-json-ab-002-base") made(); } });
    const { targets } = await runPairs(options(s, h));
    assert.ok(!h.state.counted.some(([round]) => round === reused));
    assert.equal(targets.json.change.bound, null);
    assert.equal(targets.json.reading.verdict, changeFailed);
    assert.ok(targets.json.pairs.ab.find((p) => p.pair === 4).why.includes("the change, pair 4, side head: its output path existed before it ran, so count.mjs was not run"));
  } finally {
    s.done();
  }
});

test("an invocation started and never ended is not run again and leaves its comparison with no bound: a failed count", async () => {
  const s = scratch();
  try {
    const h = host(s.results);
    // A first run stopped after 12 invocations, the 13th started and never ended.
    let n = 0;
    await assert.rejects(runPairs(options(s, h, { last: 100, targets: ["page"], stop: () => ++n > 12 })), /stopped before/);
    const name = schedule(100, ["page"], "t1")[12].name;
    appendFileSync(join(s.results, "t1", "invocations.jsonl"), JSON.stringify({ name, want: "sha256:base", started: 0 }) + "\n");
    const { targets } = await runPairs(options(s, h, { last: 100, targets: ["page"] }));
    assert.equal(h.state.counted.length, 101 * 4 - 1);
    // The pair it falls in is pair 3, which starts with the A/A's side named base.
    assert.match(name, /-aa-003-base$/);
    assert.equal(targets.page.aa.bound, null);
    assert.notEqual(targets.page.change.bound, null);
    assert.equal(targets.page.reading.verdict, aaFailed);
  } finally {
    s.done();
  }
});

test("a run going on refuses another experiment's ledger: other images, pairs, targets or environment", async () => {
  const s = scratch();
  try {
    const h = host(s.results);
    let n = 0;
    await assert.rejects(runPairs(options(s, h, { stop: () => ++n > 3 })), /stopped before/);
    const before = h.state.counted.length;
    const refused = [
      [{ last: 8 }, /pairs, schedule differ/],
      [{ targets: ["json", "page"] }, /targets, schedule differ/],
      [{ env: { ...env, BENCH_APP_CPUS: "2" } }, /env differ/],
      [{ images: { base: "cb-corten-base", head: "cb-corten-base" } }, /images, the images' IDs now/],
    ];
    for (const [over, why] of refused) await assert.rejects(runPairs(options(s, h, over)), why);
    // A tag moved to another image since the run started.
    h.ids["cb-corten-head"] = "sha256:other";
    await assert.rejects(runPairs(options(s, h)), /the images' IDs now \(cb-corten-base sha256:base, cb-corten-head sha256:other\)/);
    assert.equal(h.state.counted.length, before);
    h.ids["cb-corten-head"] = "sha256:head";
    // A ledger with invocations and no settings is not gone on with either.
    rmSync(join(s.results, "t1", "run.json"));
    await assert.rejects(runPairs(options(s, h)), /has no run\.json beside it/);
    assert.equal(h.state.counted.length, before);
  } finally {
    s.done();
  }
});

test("two runners cannot share a ledger, or one daemon's cb-corten tag whatever their temporary directories, and a lock is removed only by the runner that made it", async () => {
  const s = scratch(), other = scratch();
  try {
    // A second runner, its ledger and temporary directory elsewhere, starts on the same daemon while the first counts.
    let second, starting = false, during = -1;
    const h = host(s.results, { onCount: (round) => {
      if (starting) return;
      starting = true;
      const before = counts(h);
      // tagLock is where 30411fdf7 kept its lock, under each runner's temporary directory; it is no longer read.
      second = runPairs({ ...options(other, h), tagLock: join(other.results, "cb-corten.lock") }).then(() => assert.fail("the second runner was not refused"), (e) => { throw e; });
      second.catch(() => {});
      during = counts(h) - before;
      assert.ok(round);
    } });
    await runPairs({ ...options(s, h), tagLock: join(s.results, "cb-corten.lock") });
    await assert.rejects(second, /locked by process \d+ on .*, since .*, for .*t1.*remove it with docker rm -f corten-count-pairs-lock/);
    assert.equal(during, 0);
    assert.ok(!existsSync(join(other.results, "t1", "run.lock")));
    assert.equal(h.state.containers.size, 0);
    // The lock is a container named on the daemon, made from the base's pinned image and removed by its ID.
    const stale = { id: "e".repeat(64), labels: {}, image: "sha256:base" };
    h.state.containers.set("corten-count-pairs-lock", stale);
    await assert.rejects(runPairs(options(other, h)), /locked by an unlabeled holder/);
    assert.equal(h.state.containers.get("corten-count-pairs-lock"), stale);
    h.state.containers.clear();
    mkdirSync(join(s.results, "t2"), { recursive: true });
    writeFileSync(join(s.results, "t2", "run.lock"), "left by a runner that is gone\n");
    const before = counts(h);
    await assert.rejects(runPairs(options(s, h, { prefix: "t2" })), /t2.run\.lock\)\. .*stale/);
    assert.equal(readFileSync(join(s.results, "t2", "run.lock"), "utf8"), "left by a runner that is gone\n");
    assert.equal(counts(h), before);
    assert.equal(h.state.containers.size, 0);
    // A lock pruned and taken by another runner while this one counts: this one stops at once, with
    // no more invocations and no report, and its release does not remove the other's lock.
    let swapped = false;
    const h3 = host(other.results, { onCount: () => {
      if (swapped) return;
      swapped = true;
      h3.state.containers.set("corten-count-pairs-lock", { id: "f".repeat(64), labels: {}, image: "x" });
    } });
    await assert.rejects(runPairs(options(other, h3, { prefix: "t3" })), /the daemon's lock was lost: corten-count-pairs-lock is not the container this runner made.*\(in t3-json-ab-000-head\); stopped with no report/);
    assert.equal(h3.state.counted.length, 1);
    assert.ok(!existsSync(join(other.results, "t3", "report.json")));
    assert.equal(h3.state.containers.get("corten-count-pairs-lock")?.id, "f".repeat(64));
    // Removed (pruned) with none in its place, the next run stops before its first invocation.
    const h4 = host(other.results);
    let pruned = false;
    await assert.rejects(runPairs(options(other, h4, { prefix: "t4", stop: () => { if (!pruned) { pruned = true; h4.state.containers.clear(); } return false; } })), /the daemon's lock was lost.*\(before t4-json-ab-000-head\)/);
    assert.equal(h4.state.counted.length + h4.state.tags.length, 0);
    // And the ledger's file lock likewise.
    const file = join(s.results, "file.lock");
    const release = lock(file, "mine");
    writeFileSync(file, JSON.stringify({ token: "theirs" }));
    release();
    assert.ok(existsSync(file));
  } finally {
    s.done();
    other.done();
  }
});

test("the daemon's lock runs a bounded sleep while a run goes on, so a prune during a count leaves it and a second runner is still refused; one that stops is lost", async () => {
  const s = scratch(), other = scratch();
  try {
    let second, checked = false;
    const h = host(s.results, { onCount: () => {
      if (checked) return;
      checked = true;
      const lock = h.state.containers.get("corten-count-pairs-lock");
      assert.equal(lock?.running, true);
      assert.deepEqual(lock.command, ["sleep", String(countPairs.LOCK_SECONDS)]);
      assert.equal(lock.image, "sha256:base");
      h.prune();
      assert.equal(h.state.containers.get("corten-count-pairs-lock"), lock);
      second = runPairs(options(other, h));
      second.catch(() => {});
    } });
    const before = h.state.counted.length;
    await runPairs(options(s, h));
    await assert.rejects(second, /locked by process \d+ on .*remove it with docker rm -f corten-count-pairs-lock/);
    assert.equal(h.state.counted.length - before, schedule(6, ["json"], "t1").length);
    assert.equal(h.state.containers.size, 0);
    // The lock's sleep ended (its bound, or a hand stopping it): the run stops at the next check, with no report.
    let stoppedOnce = false;
    const h2 = host(other.results, { onCount: () => {
      if (stoppedOnce) return;
      stoppedOnce = true;
      h2.state.containers.get("corten-count-pairs-lock").running = false;
    } });
    await assert.rejects(runPairs(options(other, h2, { prefix: "t5" })), /the daemon's lock was lost: corten-count-pairs-lock is not the container this runner made, or it has stopped.*\(in t5-json-ab-000-head\)/);
    assert.equal(h2.state.counted.length, 1);
    // A lock that cannot start is removed by its ID and no count is run.
    const h3 = host(other.results);
    h3.state.startRc = 125;
    await assert.rejects(runPairs(options(other, h3, { prefix: "t6" })), /could not start the daemon's lock: docker start exited 125$/);
    assert.equal(counts(h3), 0);
    assert.equal(h3.state.containers.size, 0);
  } finally {
    s.done();
    other.done();
  }
});

test("the options are checked before Docker: a pair count that is not a whole number or gives no 95% bound, no target, a target twice", async () => {
  assert.equal(MIN_PAIRS, 5);
  for (const text of ["abc", "1e2", "-3", "7.5", ""]) assert.ok(Number.isNaN(parsePairs(text)), text);
  assert.equal(parsePairs("100"), 100);
  const s = scratch();
  try {
    const h = host(s.results);
    for (const [over, why] of [[{ last: NaN }, /whole number/], [{ last: 4 }, /4 recorded pairs give no 95% bound: at least 5/], [{ targets: [] }, /no target/], [{ targets: ["json", "json"] }, /named twice/], [{ targets: ["feed"] }, /unknown target/], [{ prefix: "../x" }, /prefix/]]) {
      assert.match(/** @type {string} */ (optionsError(options(s, h, over))), why);
      await assert.rejects(runPairs(options(s, h, over)), why);
    }
    assert.equal(h.state.calls, 0);
    assert.equal(optionsError(options(s, h, { last: 5 })), null);
    // An empty reading is not a complete one.
    assert.equal(complete({}), false);
    assert.equal(complete(readRun([], new Map(), () => ({}))), false);
  } finally {
    s.done();
  }
});

test("the runner refuses one image for both sides, since the A/A is the run's own", async () => {
  const s = scratch();
  try {
    const exec = () => ({ status: 0, stdout: "sha256:same" });
    await assert.rejects(runPairs({ prefix: "t3", images: { base: "a", head: "b" }, last: 5, targets: ["page"], results: s.results, kit: s.kit, exec }), /one image/);
  } finally {
    s.done();
  }
});

test("the report says the count failed where it has no bound, and not decided where its A/A does not resolve", () => {
  const md = markdown({ json: { change: of(0.04, 0.08), aa: of(0.05, 0.15), resolution: "not resolved", reading: reading(of(0.04, 0.08), of(0.05, 0.15)), diagnostics: {}, pairs: {} } }, { prefix: "p", base: "b", head: "h" });
  assert.match(md, /## `json`: not decided: the count's A\/A does not resolve the default band, so the change is read as one inside the band/);
});

test("an invocation's row, summary and launched image are sealed when it ends: bytes replaced, removed or never written give no bound on replay", async () => {
  const s = scratch();
  try {
    const h = host(s.results);
    const first = await runPairs(options(s, h));
    assert.equal(first.targets.json.reading.verdict, "a miss");
    const counted = h.state.counted.length;
    const end = [...readFileSync(join(s.results, "t1", "invocations.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))].find((r) => r.name === "t1-json-ab-002-head" && r.ended != null);
    assert.deepEqual(Object.keys(end.artifacts).sort(), ["count-corten-json-0-kernel.json", "count-corten-json-0.json", "count-images.json", "instructions.json"]);
    assert.match(end.artifacts["instructions.json"].sha256, /^[0-9a-f]{64}$/);
    // Every change's head row replaced by one at the base's level: a run that read them would clear the change.
    for (let pair = 1; pair <= 6; pair++) {
      const dir = join(s.results, `t1-json-ab-${String(pair).padStart(3, "0")}-head`);
      writeFileSync(join(dir, "instructions.json"), JSON.stringify({ "corten/json": [goodRow({ userCyclesPerRequest: 90000, kernelCyclesPerRequest: 0 })] }));
    }
    const again = await runPairs(options(s, h));
    assert.equal(h.state.counted.length, counted);
    assert.equal(again.targets.json.change.bound, null);
    assert.equal(again.targets.json.reading.failed, true);
    assert.ok(again.targets.json.pairs.ab.find((p) => p.pair === 2).why.includes("the change, pair 2, side head: instructions.json changed since the invocation ended"));
    // A summary removed is as bad.
    const s2 = scratch();
    try {
      const h2 = host(s2.results);
      await runPairs(options(s2, h2));
      rmSync(join(s2.results, "t1-json-aa-003-base", "count-corten-json-0.json"));
      const read = await runPairs(options(s2, h2));
      assert.equal(read.targets.json.aa.bound, null);
      assert.ok(read.targets.json.pairs.aa.find((p) => p.pair === 3).why.includes("its A/A, pair 3, side base: count-corten-json-0.json is gone since the invocation ended"));
      // So is the kernel instructions' load's summary.
      rmSync(join(s2.results, "t1-json-ab-004-head", "count-corten-json-0-kernel.json"));
      const kernel = await runPairs(options(s2, h2));
      assert.equal(kernel.targets.json.change.bound, null);
      assert.ok(kernel.targets.json.pairs.ab.find((p) => p.pair === 4).why.includes("the change, pair 4, side head: count-corten-json-0-kernel.json is gone since the invocation ended"));
    } finally {
      s2.done();
    }
  } finally {
    s.done();
  }
});

test("a run going on refuses where what the count runs or the host it runs on is not the ledger's, or cannot be established", async () => {
  const s = scratch();
  try {
    const h = host(s.results);
    let n = 0;
    await assert.rejects(runPairs(options(s, h, { stop: () => ++n > 3 })), /stopped before/);
    const before = counts(h);
    const ledger = JSON.parse(readFileSync(join(s.results, "t1", "run.json"), "utf8"));
    for (const file of ["count.mjs", "apps.mjs", "ssr-load.js", "fixtures/items.json"]) assert.match(ledger.kit[file]?.sha256 ?? "", /^[0-9a-f]{64}$/, file);
    assert.ok(Object.keys(ledger.kit).some((f) => f.endsWith("count-pairs.mjs")) && Object.keys(ledger.kit).some((f) => f.endsWith("placement/stats.mjs")));
    assert.deepEqual([ledger.environment.daemon.id, ledger.environment.docker.path, ledger.environment.perf.version, ledger.environment.kernel], ["daemon-1", "/usr/bin/docker", "perf version 6.8.12", "6.8.0-test"]);
    const kit = (f) => join(s.kit, ...f.split("/"));
    const refused = [
      [() => writeFileSync(kit("apps.mjs"), "export const apps = { x: 1 };\n"), () => writeFileSync(kit("apps.mjs"), "export const apps = {};\n"), /kit \(apps\.mjs\) differ/],
      [() => writeFileSync(kit("fixtures/items.json"), "[1]\n"), () => writeFileSync(kit("fixtures/items.json"), "[]\n"), /kit \(fixtures\/items\.json\) differ/],
      [() => writeFileSync(kit("ssr-load.js"), 'import http from "k6/http";\nimport "./more.js";\n'), () => writeFileSync(kit("ssr-load.js"), 'import http from "k6/http";\n'), /cannot establish what the count runs: more\.js is missing/],
      [() => { h.state.daemon = { ...h.state.daemon, id: "daemon-2" }; }, () => { h.state.daemon = { ...h.state.daemon, id: "daemon-1" }; }, /environment \(daemon\) differ/],
      [() => { h.paths.docker = "/opt/bin/docker"; }, () => { h.paths.docker = "/usr/bin/docker"; }, /environment \(docker\) differ/],
      [() => { h.state.kernel = "6.9.0"; }, () => { h.state.kernel = "6.8.0-test"; }, /environment \(kernel\) differ/],
      [() => { h.state.perf = ""; }, () => { h.state.perf = "perf version 6.8.12"; }, /cannot establish the host the count runs on: perf --version/],
      [() => { h.state.daemon = null; }, () => { h.state.daemon = { id: "daemon-1", version: "29.1.0", kernel: "6.8.0-test", name: "bench" }; }, /cannot establish the host the count runs on: docker info/],
    ];
    for (const [change, restore, why] of refused) {
      change();
      await assert.rejects(runPairs(options(s, h)), why);
      restore();
    }
    await assert.rejects(runPairs(options(s, h, { env: { ...env, DOCKER_HOST: "tcp://elsewhere:2375" } })), /environment \(dockerHost\) differ/);
    assert.equal(counts(h), before);
    // Restored, it goes on.
    await runPairs(options(s, h));
    assert.equal(h.state.counted.length, 7 * 4);
  } finally {
    s.done();
  }
  // A run whose kit lacks its fixture does not start.
  const s2 = scratch();
  try {
    rmSync(join(s2.kit, "fixtures", "items.json"));
    const h2 = host(s2.results);
    await assert.rejects(runPairs(options(s2, h2)), /cannot establish what the count runs: fixtures\/items\.json is missing/);
    assert.equal(counts(h2), 0);
    assert.ok(!existsSync(join(s2.results, "t1", "run.json")));
  } finally {
    s2.done();
  }
});

test("an invocation whose counted container was started from another image than the side's is not valid, whatever the tag read before and after", async () => {
  const s = scratch();
  try {
    const h = host(s.results, { launch: (round) => (round === "t1-json-ab-004-base" ? "sha256:head" : null) });
    const { targets } = await runPairs(options(s, h));
    assert.equal(targets.json.change.bound, null);
    assert.equal(targets.json.reading.verdict, changeFailed);
    assert.ok(targets.json.pairs.ab.find((p) => p.pair === 4).why.includes("the change, pair 4, side base: the container counted was not started from the side's image"));
  } finally {
    s.done();
  }
});

test("a pair 0 invocation that fails fails its comparison, though pair 0 gives no sample", async () => {
  for (const round of ["t1-json-ab-000-head", "t1-json-aa-000-base"]) {
    const s = scratch();
    try {
      const h = host(s.results, { rc: (r) => (r === round ? 1 : 0) });
      const { targets } = await runPairs(options(s, h));
      const json = targets.json, comparison = round.includes("-ab-") ? json.change : json.aa;
      assert.equal(comparison.n, 6, round);
      assert.equal(comparison.bound, null, round);
      assert.equal(json.reading.failed, true, round);
      assert.ok(!complete(targets), round);
      assert.ok(Object.values(json.pairs).flat().some((p) => p.pair === 0 && p.why.some((w) => w.endsWith("pair 0, side " + round.split("-").at(-1) + ": count.mjs exited 1"))), round);
    } finally {
      s.done();
    }
  }
});

test("a stop asked for after the last invocation is honored before the report is written", async () => {
  const s = scratch();
  try {
    const h = host(s.results);
    let n = 0;
    await assert.rejects(runPairs(options(s, h, { stop: () => ++n > 7 * 4 })), /stopped before the report/);
    assert.equal(h.state.counted.length, 7 * 4);
    assert.ok(!existsSync(join(s.results, "t1", "report.json")));
    assert.equal(h.state.containers.size, 0);
    const { targets } = await runPairs(options(s, h));
    assert.equal(h.state.counted.length, 7 * 4);
    assert.equal(targets.json.reading.verdict, "a miss");
    assert.ok(existsSync(join(s.results, "t1", "report.json")));
  } finally {
    s.done();
  }
});

test("the pair count is a safe whole number from 5 to 999, checked before a lock or a directory is made", async () => {
  assert.equal(countPairs.MAX_PAIRS, 999);
  const s = scratch();
  try {
    const h = host(s.results);
    for (const [last, why] of [[1000, /1000 pairs: at most 999/], [2 ** 53 + 2, /whole number/], [1e21, /whole number/], [parsePairs("99999999999999999999"), /whole number/]]) {
      assert.match(/** @type {string} */ (optionsError(options(s, h, { last }))), why, String(last));
      await assert.rejects(runPairs(options(s, h, { last })), why);
    }
    assert.equal(h.state.calls, 0);
    assert.ok(!existsSync(join(s.results, "t1")));
    assert.equal(optionsError(options(s, h, { last: 999 })), null);
    assert.equal(new Set(schedule(999, ["page"], "p").map((i) => i.name.length)).size, 1);
  } finally {
    s.done();
  }
});

test("the band's ends are read exactly from the cycle counts: a bound at an end is inside, one count past it is outside", () => {
  const five = (head, base) => compare(Array.from({ length: 5 }, (_, i) => ({ pair: i + 1, base, head })));
  const aa = of(-0.02, 0.02);
  // 9802 / 10000 - 1 is -1.98%, less +1% exactly the band's low end, -2.98%.
  assert.equal(inside({ num: 9802, den: 10000 }), true);
  assert.equal(reading(five(9802, 10000), aa).verdict, "inside the default band: not decided");
  assert.equal(reading(five(9801, 10000), aa).verdict, "meets +1%");
  // 10433 / 10000 - 1 is +4.33%, less +1% exactly the high end, +3.33%.
  assert.equal(reading(five(10433, 10000), aa).verdict, "inside the default band: not decided");
  assert.equal(reading(five(10434, 10000), aa).verdict, "a miss");
  // An A/A at the low end, its labels swapped +1.02% less +1%: resolved.
  assert.equal(resolution(five(9802, 10000)), "resolved");
  assert.equal(resolution(five(9801, 10000)), "not resolved");
  // Sums of user and kernel cycles: whole counts, so the bound is exact too.
  const split = compare(Array.from({ length: 5 }, (_, i) => ({ pair: i + 1, base: 6000 + 4000, head: 5802 + 4000 })));
  assert.equal(reading(split, aa).verdict, "inside the default band: not decided");
  // A count that is not a whole number is not valid.
  const summary = sealedSummary();
  const ok = { summary, kernelSummary: summary, want: "sha256:a", before: "sha256:a", after: "sha256:a", launched: { container: "c".repeat(64), image: "sha256:a" }, rc: 0, tagRc: 0, fresh: true };
  assert.deepEqual(invalid({ ...ok, row: [goodRow({ kernelCyclesPerRequest: 60000.5 })] }), ["kernelCyclesPerRequest is 60000.5, not a whole count"]);
});

test("a file the count runs that changes while the run goes on stops it, naming the file, with no report, and the invocation it changed under is not valid", async () => {
  const s = scratch();
  try {
    const apps = join(s.kit, "apps.mjs");
    const h = host(s.results, { onCount: (round) => { if (round === "t1-json-aa-001-base") writeFileSync(apps, "export const apps = { x: 1 };\n"); } });
    await assert.rejects(runPairs(options(s, h)), /apps\.mjs changed since the run started \(in t1-json-aa-001-base\); stopped with no report/);
    assert.equal(h.state.counted.length, 5);
    assert.ok(!existsSync(join(s.results, "t1", "report.json")));
    // Changed back, the run goes on, but what ran under the change is not known: that comparison has no bound.
    writeFileSync(apps, "export const apps = {};\n");
    const { targets } = await runPairs(options(s, h));
    assert.equal(h.state.counted.length, 7 * 4);
    assert.equal(targets.json.aa.bound, null);
    assert.equal(targets.json.reading.verdict, aaFailed);
    assert.ok(targets.json.pairs.aa.find((p) => p.pair === 1).why.includes("its A/A, pair 1, side base: while it ran: apps.mjs changed since the run started"));
  } finally {
    s.done();
  }
  // Changed after the last invocation, before the report: no report.
  const s2 = scratch();
  try {
    const h2 = host(s2.results);
    const stop = () => { if (h2.state.counted.length === 7 * 4) writeFileSync(join(s2.kit, "fixtures", "items.json"), "[1]\n"); return false; };
    await assert.rejects(runPairs(options(s2, h2, { stop })), /fixtures\/items\.json changed since the run started \(before the report\); stopped with no report/);
    assert.ok(!existsSync(join(s2.results, "t1", "report.json")));
  } finally {
    s2.done();
  }
});

test("a replay reads each invocation against the image run.json pins for its slot, so head slots whose records carry the base's image are not valid, not a meet", async () => {
  const s = scratch();
  try {
    const h = host(s.results);
    assert.equal((await runPairs(options(s, h))).targets.json.reading.verdict, "a miss");
    // Each recorded head slot of the change rewritten as a count of the base's image that reads 10% below the base, record, receipt and seal agreeing.
    const forged = (/** @type {string} */ name) => /^t1-json-ab-00[1-6]-head$/.test(name);
    for (let pair = 1; pair <= 6; pair++) {
      const dir = join(s.results, `t1-json-ab-00${pair}-head`);
      writeFileSync(join(dir, "instructions.json"), JSON.stringify({ "corten/json": [goodRow({ userCyclesPerRequest: 90000, kernelCyclesPerRequest: 0 })] }));
      writeFileSync(join(dir, "count-images.json"), JSON.stringify({ "corten/json": { container: "d".repeat(64), image: "sha256:base" } }));
    }
    const ledger = join(s.results, "t1", "invocations.jsonl");
    const records = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    writeFileSync(ledger, records.map((r) => JSON.stringify(!forged(r.name) ? r : { ...r, want: "sha256:base", ...(r.ended == null ? {} : { before: "sha256:base", after: "sha256:base", artifacts: countPairs.seal(join(s.results, r.name), countPairs.artifactsOf("json")) }) })).join("\n") + "\n");
    const before = h.state.counted.length;
    const { targets } = await runPairs(options(s, h));
    assert.equal(h.state.counted.length, before);
    assert.notEqual(targets.json.reading.verdict, "meets +1%");
    assert.equal(targets.json.change.bound, null);
    assert.equal(targets.json.reading.verdict, changeFailed);
    const why = targets.json.pairs.ab.find((p) => p.pair === 2).why;
    assert.ok(why.includes("the change, pair 2, side head: the image counted was not the side's"));
    assert.ok(why.includes("the change, pair 2, side head: the container counted was not started from the side's image"));
  } finally {
    s.done();
  }
});

test("user plus kernel cycles past 2^53 - 1 are not an exact count, so a sum that would round to the band's end is not valid rather than read inside it", async () => {
  const summary = sealedSummary();
  const ok = { summary, kernelSummary: summary, want: "sha256:a", before: "sha256:a", after: "sha256:a", launched: { container: "c".repeat(64), image: "sha256:a" }, rc: 0, tagRc: 0, fresh: true };
  assert.deepEqual(invalid({ ...ok, row: [goodRow({ userCyclesPerRequest: 5216500000000000, kernelCyclesPerRequest: 5216500000000001 })] }), ["user plus kernel cycles a request is above 2^53 - 1, so not an exact count"]);
  assert.deepEqual(invalid({ ...ok, row: [goodRow({ userCyclesPerRequest: Number.MAX_SAFE_INTEGER - 1, kernelCyclesPerRequest: 1 })] }), []);
  // 10433000000000001 / 10000000000000000 - 1 is past the band's high end less +1%; added as doubles it is 10433000000000000, at that end.
  const s = scratch();
  try {
    const big = (/** @type {string} */ round, /** @type {string} */ image) => (!round.includes("-ab-") ? {} : image === "sha256:head" ? { userCyclesPerRequest: 5216500000000000, kernelCyclesPerRequest: 5216500000000001 } : { userCyclesPerRequest: 5e15, kernelCyclesPerRequest: 5e15 });
    const { targets } = await runPairs(options(s, host(s.results, { row: big })));
    assert.equal(resolution(targets.json.aa), "resolved");
    assert.notEqual(targets.json.reading.verdict, "inside the default band: not decided");
    assert.equal(targets.json.reading.verdict, changeFailed);
  } finally {
    s.done();
  }
});

// count.mjs itself, with stand-ins for docker and perf on its PATH and the app's port answered here:
// what perf attaches to, what the load reached, and what is removed. POSIX only: the stand-ins are
// scripts that a spawn without a shell runs by their #! line.
const fakeDocker = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const file = path.join(process.env.FAKE_DIR, "docker.json");
const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { names: {}, aliases: {}, calls: [], made: 0 };
// The network's name, by which Docker keys a container's endpoints, whatever BENCH_NETWORK gives.
const net = process.env.FAKE_NET_NAME ?? process.env.BENCH_NETWORK ?? "rustbench";
// A container that is not fsw-corten but holds that name (in FAKE_ALIAS_TEXT's case) as its alias on the load's network, as a leftover would.
const leftover = () => { const id = hex(++s.made); s.names["leftover"] = id; s.aliases[id] = [process.env.FAKE_ALIAS_TEXT ?? "fsw-corten"]; };
const a = process.argv.slice(2), hex = (n) => n.toString(16).padStart(64, "0");
s.calls.push(a);
let out = "", status = 0;
const env = {};
for (let i = 0; i < a.length; i++) if (a[i] === "-e") { const [k, ...v] = a[i + 1].split("="); env[k] = v.join("="); }
if (a[0] === "image") out = JSON.stringify([{ Id: "sha256:" + "a".repeat(64), RepoDigests: [process.env.FAKE_K6], Os: "linux", Architecture: "amd64" }]);
else if (a[0] === "run" && a.at(-1) === "version") out = "k6 v2.4.0 (stand-in)";
else if (a[0] === "run" && a[1] === "-d") { const id = hex(++s.made); s.names[a[a.indexOf("--name") + 1]] = id; out = id; if (process.env.FAKE_ALIAS === "start") leftover(); }
else if (a[0] === "network" && a[1] === "inspect") out = JSON.stringify(net) + " " + JSON.stringify(Object.fromEntries(Object.values(s.names).map((id) => [id, { Name: "x" }])));
else if (a[0] === "run") {
  const summary = a[a.indexOf("--summary-export") + 1].replace("/bench", a[a.indexOf("-v") + 1].split(":/bench")[0]);
  const n = Number(env.ITERATIONS ?? 100);
  // A counted load (MODE iterations) takes FAKE_LOAD_MS, and its start and end are recorded.
  const counted = env.MODE === "iterations", started = Date.now();
  if (counted && process.env.FAKE_LOAD_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_LOAD_MS));
  fs.writeFileSync(summary, JSON.stringify({ metrics: { http_reqs: { count: n }, http_req_failed: { passes: 0 }, checks: { passes: n, fails: 0 } } }));
  if (counted) fs.appendFileSync(path.join(process.env.FAKE_DIR, "loads.jsonl"), JSON.stringify({ start: started, end: Date.now() }) + "\\n");
  // Another container takes the name, as a second runner or a hand would.
  if (env.MODE === process.env.FAKE_REPLACE) s.names["fsw-corten"] = hex(++s.made);
  if (env.MODE === process.env.FAKE_ALIAS) leftover();
} else if (a[0] === "inspect" && a[2].startsWith("{{.Id}} {{json .Name}}")) {
  const named = Object.fromEntries(Object.entries(s.names).map(([n, id]) => [id, n]));
  const lines = a.slice(3).map((id) => named[id] && [id, JSON.stringify("/" + named[id]), JSON.stringify({ [net]: { Aliases: s.aliases[id] ?? null, DNSNames: [named[id], ...(s.aliases[id] ?? [])] } })].join(" "));
  if (lines.some((l) => !l)) status = 1;
  out = lines.filter(Boolean).join("\\n");
} else if (a[0] === "inspect") {
  const key = a.at(-1), id = s.names[key] ?? (Object.values(s.names).includes(key) ? key : null);
  if (a[2] === "{{.Image}}") out = "sha256:" + "b".repeat(64);
  else if (id) out = id;
  else status = 1;
} else if (a[0] === "rm") for (const [n, id] of Object.entries(s.names)) if (n === a.at(-1) || id === a.at(-1)) delete s.names[n];
fs.writeFileSync(file, JSON.stringify(s));
// With FAKE_DOCKER_RM_STALL, removing a container by its ID does not answer: it records itself and waits a minute.
if (a[0] === "rm" && process.env.FAKE_DOCKER_RM_STALL && /^[0-9a-f]{64}$/.test(a.at(-1))) { fs.writeFileSync(path.join(process.env.FAKE_DIR, "rm-stall.pid"), String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); }
if (out) process.stdout.write(out + "\\n");
process.exit(status);
`;
const fakePerf = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), net = require("node:net");
const a = process.argv.slice(2);
// The probe (perf stat -e <set> -- sleep 1, no cgroup) answers on --log-fd 1 for each event it names.
// With FAKE_PROBE_HOLD naming its set, it leaves a self-bounded child holding its output as it exits.
// With FAKE_BREAK too, it first makes that path a directory, so count.mjs's next write there fails.
if (a.includes("sleep") && process.env.FAKE_PROBE_HOLD === a[a.indexOf("-e") + 1] && process.env.FAKE_BREAK) { fs.rmSync(process.env.FAKE_BREAK, { force: true }); fs.mkdirSync(process.env.FAKE_BREAK); }
if (a.includes("sleep") && process.env.FAKE_PROBE_HOLD === a[a.indexOf("-e") + 1]) require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 9000)"], { stdio: ["ignore", "inherit", "inherit"] }).unref();
if (a.includes("sleep")) { fs.appendFileSync(path.join(process.env.FAKE_DIR, "probe.jsonl"), JSON.stringify(a) + "\\n"); process.stdout.write(a[a.indexOf("-e") + 1].split(",").map((e) => \`1000,,\${e},1000000,100.00,,\`).join("\\n") + "\\n"); process.exit(0); }
fs.appendFileSync(path.join(process.env.FAKE_DIR, "perf.jsonl"), JSON.stringify(a) + "\\n");
const events = a[a.indexOf("-e") + 1].split(","), cgroup = a[a.indexOf("-G") + 1].split(",")[0];
const set = events.join(",");
const named = (knob) => (process.env[knob] ?? "").split("|").includes(set);
// With -A a row a CPU, for -C's CPUs or every online one, their counts summing to a whole count's;
// in a set FAKE_PERF_CPU_GAP names the last CPU's counter never ran, printed as perf 6.1 prints one
// (its total would still read 100%).
const cpuList = a.includes("-C") ? a[a.indexOf("-C") + 1] : fs.readFileSync("/sys/devices/system/cpu/online", "utf8").trim();
const cpus = cpuList.split(",").flatMap((p) => { const [x, y = x] = p.split("-").map(Number); return Array.from({ length: y - x + 1 }, (_, i) => x + i); });
const counting = named("FAKE_PERF_CPU_GAP") ? cpus.length - 1 : cpus.length;
const share = (i) => Math.floor(500000000 / counting) + (i === 0 ? 500000000 % counting : 0);
const rows = (e) => a.includes("-A")
  ? cpus.map((c, i) => "CPU" + c + "," + (i >= counting ? "<not counted>" : share(i)) + ",," + e + "," + cgroup + "," + (i >= counting ? 0 : 1000000) + ",100.00,,").join("\\n")
  : "500000000,," + e + "," + cgroup + ",1000000,100.00,,";
// When this perf counted from ("enable") and to ("disable", "exit"), for each load to be held against.
const mark = (what) => fs.appendFileSync(path.join(process.env.FAKE_DIR, "perf-times.jsonl"), JSON.stringify({ set, what, at: Date.now() }) + "\\n");
const print = () => process.stdout.write(events.map(rows).join("\\n") + "\\n");
// A set FAKE_PERF_LATE names starts counting 1.5 s late; one FAKE_PERF_EARLY names ("|" between
// sets) exits by itself 0.8 s after it started, printing rows a whole count's would have.
const late = (process.env.FAKE_PERF_LATE ?? "").split("|").includes(set) ? 1500 : 0;
const early = (process.env.FAKE_PERF_EARLY ?? "").split("|").includes(set);
const start = () => { mark("enable"); if (early) setTimeout(() => { print(); mark("exit"); process.exit(0); }, 800); };
// perf stat --delay=-1 --control=fd:<ctl>,<ack>: counting starts at "enable", and each command is
// acknowledged as perf 6.1 does, "ack\\n" and a NUL byte; a set FAKE_PERF_DOUBLE_ACK names
// acknowledges enable twice and disable not at all.
const double = named("FAKE_PERF_DOUBLE_ACK");
const control = a.find((x) => x.startsWith("--control=fd:"));
if (control) {
  const [ctl, ack] = control.slice("--control=fd:".length).split(",").map(Number);
  let buffered = "";
  new net.Socket({ fd: ctl, readable: true, writable: false }).on("data", (d) => {
    buffered += d;
    for (let at; (at = buffered.indexOf("\\n")) >= 0; buffered = buffered.slice(at + 1)) {
      const command = buffered.slice(0, at);
      if (command === "enable") setTimeout(() => { start(); fs.writeSync(ack, double ? "ack\\n\\0ack\\n\\0" : "ack\\n\\0"); }, late);
      else if (command === "disable") { mark("disable"); if (!double) fs.writeSync(ack, "ack\\n\\0"); }
    }
  });
} else setTimeout(start, late);
// A set FAKE_PERF_HOLD names leaves a process holding its output open as it exits, so its end is never seen;
// with FAKE_BREAK too, it first makes that path a directory, so count.mjs's next write there fails.
process.on("SIGINT", () => {
  if (named("FAKE_PERF_HOLD") && process.env.FAKE_BREAK) { fs.rmSync(process.env.FAKE_BREAK, { force: true, recursive: true }); fs.mkdirSync(process.env.FAKE_BREAK, { recursive: true }); }
  if (named("FAKE_PERF_HOLD")) require("node:child_process").spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(" + JSON.stringify(path.join(process.env.FAKE_DIR, "holder.pid")) + ", String(process.pid)); setTimeout(() => {}, 50000)"], { stdio: ["ignore", "inherit", "inherit"] }).unref();
  print(); mark("exit"); process.exit(0);
});
setInterval(() => {}, 1000);
`;

test("count.mjs attaches perf to the container docker run gave by its ID, and refuses a load fsw-corten may route to another container, by its name or an alias, before perf attaches or after it stops", { skip: process.platform === "win32" && "the stand-in docker and perf are #! scripts, which a spawn without a shell runs only on POSIX" }, async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "count-mjs-"));
  const server = createServer((_, res) => res.end("{}")).listen(18410);
  try {
    // The count's kit as count-pairs.mjs binds it, each file copied as kitOf names it missing, so its
    // results go under the copy; the fixture, fetched and not in Git, stands in empty.
    const kit = join(root, "kit", "fullstack");
    mkdirSync(join(kit, "fixtures"), { recursive: true });
    writeFileSync(join(kit, "fixtures", "items.json"), "[]\n");
    for (let copied = 0; ; copied++) {
      try { countPairs.kitOf(kit); break; } catch (e) {
        const name = /^cannot establish what the count runs: (.+) is missing$/.exec(/** @type {Error} */ (e).message)?.[1];
        if (!name || copied > 100) throw e;
        mkdirSync(dirname(join(kit, name)), { recursive: true });
        copyFileSync(join(here, name), join(kit, name));
      }
    }
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), fakeDocker);
    writeFileSync(join(bin, "perf"), fakePerf);
    chmodSync(join(bin, "docker"), 0o755);
    chmodSync(join(bin, "perf"), 0o755);
    const { k6Image, k6Platform, k6Version } = await import("../load-tool.mjs");
    const seed = (/** @type {string} */ dir) => {
      const k6 = { image: k6Image, imageId: `sha256:${"a".repeat(64)}`, platform: k6Platform, version: k6Version, versionOutput: "k6 v2.4.0 (stand-in)" };
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "tools.json"), JSON.stringify({ k6 }));
      writeFileSync(join(dir, "instructions.json"), JSON.stringify({ "gin/page": [{ userPerRequest: 123456 }] }));
    };
    const count = async (/** @type {string} */ round, /** @type {string} */ replace, alias = "none", /** @type {Record<string, string>} */ extra = {},
      /** @type {string[] | null} */ managed = null) => {
      const dir = join(root, round);
      mkdirSync(dir);
      const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: dir, FAKE_K6: k6Image, FAKE_REPLACE: replace, FAKE_ALIAS: alias, HOME: process.env.HOME ?? root, ...extra };
      const child = spawn(process.execPath, managed ?? [join(kit, "count.mjs"), round, "1", "corten", "json"], { env, stdio: ["ignore", "pipe", "pipe"] });
      let log = "";
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (d) => (log += d));
      const code = await new Promise((resolve) => child.on("close", resolve));
      assert.ok(existsSync(join(kit, "results", round, "count-images.json")), log);
      const docker = JSON.parse(readFileSync(join(dir, "docker.json"), "utf8"));
      const perf = existsSync(join(dir, "perf.jsonl")) ? readFileSync(join(dir, "perf.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      const row = JSON.parse(readFileSync(join(kit, "results", round, "instructions.json"), "utf8"))["corten/json"];
      const receipt = JSON.parse(readFileSync(join(kit, "results", round, "count-images.json"), "utf8"))["corten/json"];
      const probe = existsSync(join(dir, "probe.jsonl")) ? readFileSync(join(dir, "probe.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      return { code, docker, perf, probe, row, receipt, log };
    };
    const first = "0".repeat(63) + "1";
    // A standalone recount still merges the one app/target into its existing file.
    const keptDir = join(kit, "results", "kept");
    const unrelated = [{ userPerRequest: 123456 }];
    seed(keptDir);
    const kept = await count("kept", "none");
    assert.equal(kept.code, 0, kept.log);
    assert.deepEqual(JSON.parse(readFileSync(join(keptDir, "instructions.json"), "utf8"))["gin/page"], unrelated);
    assert.equal(readCount(keptDir), null);
    // The managed driver instead starts from empty output, even with that row already present.
    const seen = new Set();
    const copy = (/** @type {string} */ source) => {
      if (seen.has(source)) return;
      seen.add(source);
      const target = join(kit, relative(here, source));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      for (const [, name] of readFileSync(source, "utf8").matchAll(/^\s*import\s+(?:[^"']*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/gm)) copy(resolve(dirname(source), name));
    };
    for (const file of ["run-all.mjs", "summarize.mjs"]) copy(join(here, file));
    const managedDir = join(kit, "results", "r999995");
    seed(managedDir);
    const managed = await count("r999995", "none", "none", { BENCH_APPS: "corten", BENCH_TIER: "defaults" },
      [join(kit, "run-all.mjs"), "r999995", "10", "count", "count"]);
    assert.equal(managed.code, 0, managed.log);
    const proof = readCount(managedDir);
    assert.deepEqual(Object.keys(proof?.rows ?? {}).sort(), ["corten/json", "corten/page"]);
    assert.deepEqual(proof?.rows["corten/json"].map((r) => r.userPerRequest), [100000, 100000, 100000]);
    assert.equal(JSON.parse(readFileSync(join(managedDir, "summary.json"), "utf8")).instructions["corten/json"].user, 100000);
    // Nothing replaced: perf counts that container's cgroup, the load is counted, and it is removed by its ID.
    assert.equal(kept.receipt.container, first);
    assert.ok(kept.perf.every((args) => args[args.indexOf("-G") + 1].split(",").every((g) => g === `system.slice/docker-${first}.scope`)));
    assert.ok(Array.isArray(kept.row) && kept.row[0].requests === 5000 && kept.row[0].userPerRequest === 100000, JSON.stringify(kept.row));
    // Kernel instructions over a load of their own, so no perf session, probe or count, holds both
    // instructions:u and instructions:k (#2151); every set a count gives perf was probed first.
    assert.deepEqual(kept.row[0].kernelPass, { requests: 5000, failed: 0 });
    assert.equal(kept.row[0].kernelPerRequest, 100000);
    const sets = (/** @type {string[][]} */ calls) => calls.map((args) => args[args.indexOf("-e") + 1]);
    assert.deepEqual(sets(kept.perf), ["cycles:u,cycles:k,instructions:u,L1-icache-load-misses:u", "instructions:k"]);
    assert.deepEqual(sets(kept.probe), ["instructions:u", "instructions:k", "cycles:u,cycles:k,instructions:u,L1-icache-load-misses:u"]);
    for (const set of [...sets(kept.perf), ...sets(kept.probe)]) assert.ok(!(set.includes("instructions:u") && set.includes("instructions:k")), set);
    assert.deepEqual(kept.docker.calls.at(-1), ["rm", "-f", first]);
    // The ID is logged before perf attaches; in the counted window the log names the container.
    const lines = kept.log.split("\n");
    const attach = lines.findIndex((l) => l.includes(" perf stat ") && l.endsWith(` -G ${first}`));
    const counting = lines.findIndex((l) => l.includes(" counting "));
    assert.ok(attach >= 0 && counting > attach, kept.log);
    assert.match(lines[counting], / counting fsw-corten$/);
    const refused = (/** @type {string} */ when, /** @type {number} */ n, net = "rustbench") => ({ failed: `${when} the load: fsw-corten on ${net} answers for ${n} running containers where it must answer for the counted one alone, so the load may reach another` });
    // Another container takes the name after the receipt: in the warmup, so before perf attaches,
    // which it then never does, or under the counted load, which is then not counted.
    for (const [replace, when] of [["closed", "before"], ["iterations", "after"]]) {
      const got = await count(`replaced-${replace}`, replace);
      assert.equal(got.code, 0, replace);
      assert.equal(got.receipt.container, first, replace);
      if (when === "before") assert.deepEqual(got.perf, [], replace);
      else assert.ok(got.perf.length > 0 && got.perf.every((args) => args[args.indexOf("-G") + 1].split(",").every((g) => g === `system.slice/docker-${first}.scope`)), replace);
      assert.deepEqual(got.row, refused(when, 1), replace);
      assert.deepEqual(got.docker.calls.at(-1), ["rm", "-f", first], replace);
    }
    // A leftover container holding fsw-corten as an alias on the load's network while the name
    // fsw-corten is still the counted container's: refused before perf attaches. One that takes the
    // alias under the counted load fails the count after it.
    for (const [alias, when] of [["start", "before"], ["iterations", "after"]]) {
      const got = await count(`alias-${alias}`, "none", alias);
      assert.equal(got.code, 0, alias);
      assert.equal(got.receipt.container, first, alias);
      // fsw-corten itself was never another container's: the leftover holds it only as an alias.
      assert.notEqual(got.docker.names.leftover, first, alias);
      assert.deepEqual(got.docker.aliases[got.docker.names.leftover], ["fsw-corten"], alias);
      if (when === "before") assert.deepEqual(got.perf, [], alias);
      else assert.ok(got.perf.length > 0, alias);
      assert.deepEqual(got.row, refused(when, 2), alias);
      assert.deepEqual(got.docker.calls.at(-1), ["rm", "-f", first], alias);
    }
    // Docker's DNS answers a name in any case, so a leftover holding FSW-CORTEN is refused too; and
    // BENCH_NETWORK given as the network's ID still finds the endpoints Docker keys by its name.
    const byId = "f".repeat(64);
    for (const [round, extra, net] of [["alias-case", { FAKE_ALIAS_TEXT: "FSW-CORTEN" }, "rustbench"], ["alias-by-id", { BENCH_NETWORK: byId, FAKE_NET_NAME: "rustbench" }, byId]]) {
      const got = await count(round, "none", "start", extra);
      assert.equal(got.code, 0, round);
      assert.deepEqual(got.perf, [], round);
      assert.deepEqual(got.row, refused("before", 2, net), round);
    }
    // The control: the counted container alone, with the network given by its ID, is counted.
    const alone = await count("alone-by-id", "none", "none", { BENCH_NETWORK: byId, FAKE_NET_NAME: "rustbench" });
    assert.equal(alone.code, 0);
    assert.ok(Array.isArray(alone.row) && alone.row[0].requests === 5000, JSON.stringify(alone.row));
    // A probe whose perf exits while a process it started holds its output: its end is not seen, so
    // count.mjs exits 4 with nothing counted and no later probe run, a grace after the exit.
    {
      const dir = join(root, "probe-held");
      mkdirSync(dir);
      const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: dir, FAKE_K6: k6Image, FAKE_REPLACE: "none", FAKE_ALIAS: "none", FAKE_PROBE_HOLD: "instructions:k", HOME: process.env.HOME ?? root };
      const started = Date.now();
      const child = spawn(process.execPath, [join(kit, "count.mjs"), "probe-held", "1", "corten", "json"], { env, stdio: ["ignore", "ignore", "pipe"] });
      let said = "";
      child.stderr.on("data", (d) => (said += d));
      const code = await new Promise((resolve) => child.on("close", resolve));
      assert.equal(code, 4, said);
      assert.ok(Date.now() - started < 8500, `settled after ${Date.now() - started} ms, not when the held output closed`);
      assert.match(said, /cleanup unconfirmed.*nothing more is counted on this host/);
      const probes = readFileSync(join(dir, "probe.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      assert.deepEqual(probes.map((args) => args[args.indexOf("-e") + 1]), ["instructions:u", "instructions:k"]);
      assert.ok(!existsSync(join(dir, "perf.jsonl")), "no count after an unconfirmed probe");
      assert.ok(!existsSync(join(kit, "results", "probe-held", "instructions.json")));
      assert.match(readFileSync(join(kit, "results", "probe-held", "count-kernel.txt"), "utf8"), /refused: .*cleanup unconfirmed[\s\S]*stopped: the probe's perf was not seen to end/);
    }
    // Each pass's perf must be counting before its load starts and still counting when it ends
    // (#2183): one that starts late is waited for, and one that exits during its load fails the
    // pass, the first load after its repeat.
    const timed = async (/** @type {string} */ round, /** @type {Record<string, string>} */ extra) => {
      const got = await count(round, "none", "none", { FAKE_LOAD_MS: "1500", ...extra });
      const lines = (/** @type {string} */ f) => existsSync(join(root, round, f)) ? readFileSync(join(root, round, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      const marks = lines("perf-times.jsonl");
      // Each perf in turn: when it started counting and when it stopped, by a disable or its exit.
      const sessions = [];
      for (const m of marks) {
        if (m.what === "enable") sessions.push({ set: m.set, from: m.at, to: null });
        else if (sessions.at(-1) && sessions.at(-1).to === null) sessions.at(-1).to = m.at;
      }
      const loads = lines("loads.jsonl");
      // The loads perf counted over whole: each in its turn inside its perf's counting.
      const covered = loads.map((load, i) => sessions[i] !== undefined && sessions[i].from <= load.start && sessions[i].to !== null && load.end <= sessions[i].to);
      return { ...got, sessions, loads, covered };
    };
    const mainSet = "cycles:u,cycles:k,instructions:u,L1-icache-load-misses:u";
    for (const [round, set] of [["late-main", mainSet], ["late-kernel", "instructions:k"]]) {
      const got = await timed(round, { FAKE_PERF_LATE: set });
      assert.equal(got.code, 0, round);
      assert.ok(Array.isArray(got.row) && got.row[0].requests === 5000 && got.row[0].kernelPass.requests === 5000, `${round}: ${JSON.stringify(got.row)}`);
      assert.equal(got.loads.length, 2, round);
      assert.deepEqual(got.covered, [true, true], `${round}: a kept count's load started before its perf counted: ${JSON.stringify({ sessions: got.sessions, loads: got.loads })}`);
    }
    for (const [round, sets, why] of [
      ["early-main", `${mainSet}|instructions:u`, /^instructions-only perf failed: perf did not count the full load: perf ended before its load did/],
      ["early-kernel", "instructions:k", /^kernel instructions' perf failed: perf did not count the full load: perf ended before its load did/],
    ]) {
      const got = await timed(round, { FAKE_PERF_EARLY: sets });
      assert.equal(got.code, 0, round);
      assert.ok(!Array.isArray(got.row), `${round}: a count whose perf exited during its load was kept: ${JSON.stringify({ row: got.row, sessions: got.sessions, loads: got.loads })}`);
      assert.match(got.row.failed, why, round);
      // Its perf did exit during the load, before the load's end.
      assert.ok(got.covered.includes(false), round);
    }
    // Each CPU perf is given must count, read from its own row (-A): perf 6.1 sums every CPU's
    // enabled and running times, so a CPU whose counter never ran leaves its total at 100%. Given
    // CPUs 0 and 1, both counting is kept, their counts summed; CPU 1 never running is not.
    {
      const both = await count("cpus-both", "none", "none", { BENCH_APP_CPUS: "0-1" });
      assert.equal(both.code, 0);
      assert.ok(Array.isArray(both.row) && both.row[0].userPerRequest === 100000 && both.row[0].kernelPerRequest === 100000, JSON.stringify(both.row));
      assert.ok(both.perf.length === 2 && both.perf.every((args) => args.includes("-A") && args[args.indexOf("-C") + 1] === "0-1"), JSON.stringify(both.perf));
      const gap = await count("cpus-gap", "none", "none", { BENCH_APP_CPUS: "0-1", FAKE_PERF_CPU_GAP: "instructions:k" });
      assert.equal(gap.code, 0);
      assert.ok(!Array.isArray(gap.row), `a count with a CPU that never counted was kept: ${JSON.stringify(gap.row)}`);
      assert.match(gap.row.failed, /^kernel instructions' perf failed: instructions:k: CPU 1: <not counted>/);
    }
    // An acknowledgment answers one command: a perf that acknowledges enable twice and disable not
    // at all has not acknowledged its disable, and its count is not kept.
    {
      const doubled = await count("acks-double", "none", "none", { FAKE_PERF_DOUBLE_ACK: "instructions:k" });
      assert.equal(doubled.code, 0);
      assert.ok(!Array.isArray(doubled.row), `a count whose perf acknowledged enable twice was kept: ${JSON.stringify(doubled.row)}`);
      assert.match(doubled.row.failed, /^kernel instructions' perf failed: perf did not count the full load: perf acknowledged 2 commands where it had been given 1/);
    }
    // A count's perf whose end is not seen halts the step with exit 4 as soon as it is given up,
    // whatever Docker does then: the counted container's removal is asked for and not waited for,
    // so a docker that does not answer cannot hold the exit back.
    {
      const round = "halt-docker-stalled";
      const dir = join(root, round);
      mkdirSync(dir);
      const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: dir, FAKE_K6: k6Image, FAKE_REPLACE: "none", FAKE_ALIAS: "none", FAKE_PERF_HOLD: mainSet, FAKE_DOCKER_RM_STALL: "1", HOME: process.env.HOME ?? root };
      const started = Date.now();
      const child = spawn(process.execPath, [join(kit, "count.mjs"), round, "1", "corten", "json"], { env, stdio: ["ignore", "ignore", "pipe"] });
      let said = "";
      child.stderr.on("data", (d) => (said += d));
      const code = await new Promise((resolve) => child.on("close", resolve));
      const took = Date.now() - started;
      const pid = (/** @type {string} */ f) => existsSync(join(dir, f)) ? Number(readFileSync(join(dir, f), "utf8")) : null;
      try {
        assert.equal(code, 4, said);
        // perf is given 30 s to stop and 5 s once killed, then the halt: not the stalled docker's minute.
        assert.ok(took < 50_000, `exit 4 came ${took} ms after the start, held by the docker rm: ${said}`);
        assert.match(said, /asked docker to remove [0-9a-f]{64}, not waiting for it/);
        assert.match(JSON.parse(readFileSync(join(kit, "results", round, "instructions.json"), "utf8"))["corten/json"].failed, /perf did not count the full load: no answer/);
        // The removal was asked for: the stalled docker rm started.
        for (let i = 0; i < 50 && pid("rm-stall.pid") === null; i++) await new Promise((r) => setTimeout(r, 100));
        assert.notEqual(pid("rm-stall.pid"), null, "no docker rm was started");
      } finally {
        for (const f of ["rm-stall.pid", "holder.pid"]) try { const p = pid(f); if (p) process.kill(p, "SIGKILL"); } catch {}
      }
    }
    // A write that fails as count.mjs records a count's perf it could not see end leaves its exit 4
    // and still asks for the counted container's removal.
    {
      const round = "halt-unwritable";
      const dir = join(root, round);
      mkdirSync(dir);
      const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: dir, FAKE_K6: k6Image, FAKE_REPLACE: "none", FAKE_ALIAS: "none", FAKE_PERF_HOLD: mainSet, FAKE_BREAK: join(kit, "results", round, "instructions.json"), HOME: process.env.HOME ?? root };
      const child = spawn(process.execPath, [join(kit, "count.mjs"), round, "1", "corten", "json"], { env, stdio: ["ignore", "ignore", "pipe"] });
      let said = "";
      child.stderr.on("data", (d) => (said += d));
      const code = await new Promise((resolve) => child.on("close", resolve));
      const holder = join(dir, "holder.pid");
      try {
        assert.equal(code, 4, said);
        assert.match(said, /the halt's diagnostics were not all written: EISDIR/);
        assert.match(said, /asked docker to remove [0-9a-f]{64}, not waiting for it/);
        const removed = () => JSON.parse(readFileSync(join(dir, "docker.json"), "utf8")).calls.some((/** @type {string[]} */ c) => c.join(" ") === `rm -f ${first}`);
        for (let i = 0; i < 50 && !removed(); i++) await new Promise((r) => setTimeout(r, 100));
        assert.ok(removed(), "the counted container's removal was not asked for");
      } finally {
        try { if (existsSync(holder)) process.kill(Number(readFileSync(holder, "utf8")), "SIGKILL"); } catch {}
      }
    }
    // A write that fails as count.mjs records a probe it could not see end leaves its exit 4, so
    // count-pairs.mjs starts no next invocation.
    {
      const round = "probe-held-unwritable";
      const dir = join(root, round);
      mkdirSync(dir);
      const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: dir, FAKE_K6: k6Image, FAKE_REPLACE: "none", FAKE_ALIAS: "none", FAKE_PROBE_HOLD: "instructions:k", FAKE_BREAK: join(kit, "results", round, "count-kernel.txt"), HOME: process.env.HOME ?? root };
      const child = spawn(process.execPath, [join(kit, "count.mjs"), round, "1", "corten", "json"], { env, stdio: ["ignore", "ignore", "pipe"] });
      let said = "";
      child.stderr.on("data", (d) => (said += d));
      const code = await new Promise((resolve) => child.on("close", resolve));
      assert.equal(code, 4, said);
      assert.match(said, /the halt's diagnostics were not all written: EISDIR/);
      assert.ok(!existsSync(join(dir, "perf.jsonl")), "no count after an unconfirmed probe");
      // That exit, as count-pairs.mjs's runner sees it: the run stops there, now and when run again.
      const s = scratch();
      try {
        const stuck = "t1-json-ab-002-base";
        const h = host(s.results, { rc: (name) => (name === stuck ? /** @type {number} */ (code) : 0) });
        await assert.rejects(runPairs(options(s, h)), /count\.mjs exited 4 in t1-json-ab-002-base/);
        assert.equal(h.state.counted.at(-1)?.[0], stuck);
        const ran = h.state.counted.length;
        await assert.rejects(runPairs(options(s, h)), /count\.mjs exited 4 in t1-json-ab-002-base/);
        assert.equal(h.state.counted.length, ran);
      } finally {
        s.done();
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
