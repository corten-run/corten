// The catalog count's pairs with its own A/A (count-pairs.mjs): its order, its validity checks, the
// reading that holds or clears a change only where its A/A resolves the default band, and the
// runner, with a stand-in for Docker and count.mjs: its ledger, its locks and its failure paths.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as countPairs from "./count-pairs.mjs";
import { BAND, compare, complete, COUNTS, inside, invalid, lock, MARGIN, markdown, MIN_PAIRS, optionsError, parsePairs, readRun, reading, resolution, runPairs, schedule } from "./count-pairs.mjs";

/** n recorded pairs whose changes are spread evenly from lo to hi. */
const spread = (lo, hi, n = 100) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
const pairsOf = (changes) => changes.map((c, i) => ({ pair: i + 1, base: 100000, head: 100000 * (1 + c) }));
const of = (lo, hi) => compare(pairsOf(spread(lo, hi)));
const running = Object.fromEntries(Object.values(COUNTS).map((e) => [e, 100]));
const goodRow = (over = {}) => ({ requests: 5000, failed: 0, userPerRequest: 75000, kernelPerRequest: 26000, userCyclesPerRequest: 100000, kernelCyclesPerRequest: 60000, userL1iMissesPerRequest: 5000, perfRunningPct: { ...running }, perfDiagnostics: {}, ...over });
const notDecided = { verdict: "not decided: the count's A/A does not resolve the default band, so the change is read as one inside the band, neither held nor cleared", decided: false, holds: false, clears: false, failed: false };
const aaFailed = "failed: the count's A/A has no bound, so the count does not pass until the maintainer decides";
const changeFailed = "failed: the change's pairs have no bound, so the count does not pass until the maintainer decides";

/**
 * A stand-in host: Docker images by name and ID, the tag count.mjs reads, the daemon and the
 * containers made on it, perf and the kernel, and count.mjs, which writes its round's records as
 * the real one does. `row(round, image, target)` gives each count's row (cycles 6% more on the
 * head's image by default), `rc` its exit status, `tagRc` the tag's, and `launch(round)` the
 * image the counted container was started from (the tagged one by default).
 */
function host(results, { row = () => ({}), rc = () => 0, tagRc = () => 0, onCount = () => {}, launch = () => null } = {}) {
  const ids = { "cb-corten-base": "sha256:base", "cb-corten-head": "sha256:head" };
  const state = { tagged: "", counted: [], tags: [], calls: 0, daemon: { id: "daemon-1", version: "29.1.0", kernel: "6.8.0-test", name: "bench" }, perf: "perf version 6.8.12", kernel: "6.8.0-test", containers: new Map(), made: 0 };
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
      state.containers.set(name, { id, labels, image: args.at(-1) });
      return { status: 0, stdout: id + "\n" };
    }
    if (cmd === "docker" && args[0] === "inspect") {
      const c = state.containers.get(args.at(-1));
      if (!c) return { status: 1, stdout: "" };
      return { status: 0, stdout: args[2] === "{{.Id}}" ? c.id + "\n" : JSON.stringify(c.labels) };
    }
    if (cmd === "docker" && args[0] === "rm") {
      for (const [name, c] of state.containers) if (c.id === args[1]) { state.containers.delete(name); return { status: 0 }; }
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
    writeFileSync(join(dir, `count-corten-${target}-0.json`), JSON.stringify({ metrics: { checks: { passes: 5000, fails: 0 } } }));
    writeFileSync(join(dir, "count-images.json"), JSON.stringify({ [`corten/${target}`]: { container: hex(1000 + n), image: launch(round) ?? image } }));
    return { status: rc(round) };
  };
  return { ids, state, exec, paths, which: (name) => paths[name] ?? null };
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
const options = (s, h, over = {}) => ({ prefix: "t1", images: { base: "cb-corten-base", head: "cb-corten-head" }, last: 6, targets: ["json"], results: s.results, kit: s.kit, exec: h.exec, which: h.which, env, now: () => 0, ...over });
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

test("an invocation is valid only with a clean tag, exit 0, 5,000 requests, none failed, every count a number at 100%, its k6 checks and the side's image", () => {
  const summary = { metrics: { checks: { passes: 5000, fails: 0 } } };
  const ok = { row: [goodRow()], summary, want: "sha256:a", before: "sha256:a", after: "sha256:a", launched: { container: "c".repeat(64), image: "sha256:a" }, rc: 0, tagRc: 0, fresh: true };
  assert.deepEqual(invalid(ok), []);
  assert.deepEqual(invalid({ ...ok, after: "sha256:b" }), ["the image counted was not the side's"]);
  assert.deepEqual(invalid({ ...ok, rc: 1 }), ["count.mjs exited 1"]);
  assert.deepEqual(invalid({ ...ok, rc: null, signal: "SIGINT" }), ["count.mjs was stopped by SIGINT"]);
  assert.deepEqual(invalid({ ...ok, tagRc: 1 }), ["docker tag exited 1, so count.mjs was not run"]);
  assert.deepEqual(invalid({ ...ok, fresh: false }), ["its output path existed before it ran, so count.mjs was not run"]);
  assert.deepEqual(invalid({ ...ok, row: [goodRow({ failed: 2, userCyclesPerRequest: null })] }), ["2 failed requests", "userCyclesPerRequest is null, not a number"]);
  assert.deepEqual(invalid({ ...ok, row: [goodRow({ userCyclesPerRequest: "100000" })] }), ["userCyclesPerRequest is \"100000\", not a number"]);
  assert.deepEqual(invalid({ ...ok, row: [goodRow({ kernelPerRequest: Infinity })] }), ["kernelPerRequest is Infinity, not a number"]);
  assert.deepEqual(invalid({ ...ok, row: [goodRow({ perfRunningPct: { ...running, "cycles:k": 88 } })] }), ["perf ran cycles:k 88% of its enabled time, not 100%"]);
  assert.deepEqual(invalid({ ...ok, row: [goodRow({ perfRunningPct: undefined })] }), Object.values(COUNTS).map((e) => `perf's running percentage for ${e} is not recorded`));
  assert.deepEqual(invalid({ ...ok, row: { failed: "never answered" } }), ["count.mjs recorded failed: never answered"]);
  assert.deepEqual(invalid({ ...ok, summary: { metrics: { checks: { passes: 4999, fails: 1 } } } }), ["1 failed status checks", "4999 passed status checks, not 5000"]);
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
    for (const label of ["user cycles", "kernel cycles", "user instructions", "kernel instructions", "user L1i misses"]) assert.match(md, new RegExp(`\\| the change \\| ${label} \\|`));
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
    await assert.rejects(second, /locked by process \d+ on .*, since .*, for .*t1.*remove it with docker rm corten-count-pairs-lock/);
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
    assert.deepEqual(Object.keys(end.artifacts).sort(), ["count-corten-json-0.json", "count-images.json", "instructions.json"]);
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
  const summary = { metrics: { checks: { passes: 5000, fails: 0 } } };
  const ok = { summary, want: "sha256:a", before: "sha256:a", after: "sha256:a", launched: { container: "c".repeat(64), image: "sha256:a" }, rc: 0, tagRc: 0, fresh: true };
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
  const summary = { metrics: { checks: { passes: 5000, fails: 0 } } };
  const ok = { summary, want: "sha256:a", before: "sha256:a", after: "sha256:a", launched: { container: "c".repeat(64), image: "sha256:a" }, rc: 0, tagRc: 0, fresh: true };
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
const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { names: {}, calls: [], made: 0 };
const a = process.argv.slice(2), hex = (n) => n.toString(16).padStart(64, "0");
s.calls.push(a);
let out = "", status = 0;
const env = {};
for (let i = 0; i < a.length; i++) if (a[i] === "-e") { const [k, ...v] = a[i + 1].split("="); env[k] = v.join("="); }
if (a[0] === "image") out = JSON.stringify([{ Id: "sha256:" + "a".repeat(64), RepoDigests: [process.env.FAKE_K6], Os: "linux", Architecture: "amd64" }]);
else if (a[0] === "run" && a.at(-1) === "version") out = "k6 v2.4.0 (stand-in)";
else if (a[0] === "run" && a[1] === "-d") { const id = hex(++s.made); s.names[a[a.indexOf("--name") + 1]] = id; out = id; }
else if (a[0] === "run") {
  const summary = a[a.indexOf("--summary-export") + 1].replace("/bench", a[a.indexOf("-v") + 1].split(":/bench")[0]);
  const n = Number(env.ITERATIONS ?? 100);
  fs.writeFileSync(summary, JSON.stringify({ metrics: { http_reqs: { count: n }, http_req_failed: { passes: 0 }, checks: { passes: n, fails: 0 } } }));
  // Another container takes the name, as a second runner or a hand would.
  if (env.MODE === process.env.FAKE_REPLACE) s.names["fsw-corten"] = hex(++s.made);
} else if (a[0] === "inspect") {
  const key = a.at(-1), id = s.names[key] ?? (Object.values(s.names).includes(key) ? key : null);
  if (a[2] === "{{.Image}}") out = "sha256:" + "b".repeat(64);
  else if (id) out = id;
  else status = 1;
} else if (a[0] === "rm") for (const [n, id] of Object.entries(s.names)) if (n === a.at(-1) || id === a.at(-1)) delete s.names[n];
fs.writeFileSync(file, JSON.stringify(s));
if (out) process.stdout.write(out + "\\n");
process.exit(status);
`;
const fakePerf = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const a = process.argv.slice(2);
if (a.includes("sleep")) { process.stderr.write("1000,,instructions:u,1000000,100.00,,\\n"); process.exit(0); }
fs.appendFileSync(path.join(process.env.FAKE_DIR, "perf.jsonl"), JSON.stringify(a) + "\\n");
const events = a[a.indexOf("-e") + 1].split(","), cgroup = a[a.indexOf("-G") + 1].split(",")[0];
process.on("SIGINT", () => { process.stdout.write(events.map((e) => \`500000000,,\${e},\${cgroup},1000000,100.00,,\`).join("\\n") + "\\n"); process.exit(0); });
setInterval(() => {}, 1000);
`;

test("count.mjs attaches perf to the container docker run gave by its ID, and an invocation whose fsw-corten is another container after its load is recorded failed", { skip: process.platform === "win32" && "the stand-in docker and perf are #! scripts, which a spawn without a shell runs only on POSIX" }, async () => {
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
    const { k6Image } = await import("../load-tool.mjs");
    const count = async (/** @type {string} */ round, /** @type {string} */ replace) => {
      const dir = join(root, round);
      mkdirSync(dir);
      const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: dir, FAKE_K6: k6Image, FAKE_REPLACE: replace, HOME: process.env.HOME ?? root };
      const child = spawn(process.execPath, [join(kit, "count.mjs"), round, "1", "corten", "json"], { env, stdio: "ignore" });
      const code = await new Promise((resolve) => child.on("close", resolve));
      const docker = JSON.parse(readFileSync(join(dir, "docker.json"), "utf8"));
      const perf = readFileSync(join(dir, "perf.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const row = JSON.parse(readFileSync(join(kit, "results", round, "instructions.json"), "utf8"))["corten/json"];
      const receipt = JSON.parse(readFileSync(join(kit, "results", round, "count-images.json"), "utf8"))["corten/json"];
      return { code, docker, perf, row, receipt };
    };
    const first = "0".repeat(63) + "1";
    // Nothing replaced: perf counts that container's cgroup, the load is counted, and it is removed by its ID.
    const kept = await count("kept", "none");
    assert.equal(kept.code, 0);
    assert.equal(kept.receipt.container, first);
    assert.ok(kept.perf.every((args) => args[args.indexOf("-G") + 1].split(",").every((g) => g === `system.slice/docker-${first}.scope`)));
    assert.ok(Array.isArray(kept.row) && kept.row[0].requests === 5000 && kept.row[0].userPerRequest === 100000, JSON.stringify(kept.row));
    assert.deepEqual(kept.docker.calls.at(-1), ["rm", "-f", first]);
    // Another container takes the name after the receipt: in the warmup, before perf attaches, or under the counted load.
    for (const replace of ["closed", "iterations"]) {
      const got = await count(`replaced-${replace}`, replace);
      assert.equal(got.code, 0, replace);
      assert.equal(got.receipt.container, first, replace);
      assert.ok(got.perf.length > 0 && got.perf.every((args) => args[args.indexOf("-G") + 1].split(",").every((g) => g === `system.slice/docker-${first}.scope`)), replace);
      assert.deepEqual(got.row, { failed: "fsw-corten is not the counted container after the load, so the load may have reached another" }, replace);
      assert.deepEqual(got.docker.calls.at(-1), ["rm", "-f", first], replace);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
