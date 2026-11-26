// The catalog count's pairs with its own A/A (count-pairs.mjs): its order, its validity checks, the
// reading that holds or clears a change only where its A/A resolves the default band, and the
// runner, with a stand-in for Docker and count.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BAND, compare, inside, invalid, MARGIN, reading, resolution, runPairs, schedule } from "./count-pairs.mjs";

/** n recorded pairs whose changes are spread evenly from lo to hi. */
const spread = (lo, hi, n = 100) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
const pairsOf = (changes) => changes.map((c, i) => ({ pair: i + 1, base: 100000, head: 100000 * (1 + c) }));
const of = (lo, hi) => compare(pairsOf(spread(lo, hi)));

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

test("an invocation is valid only with 5,000 requests, none failed, every count, its k6 checks and the side's image", () => {
  const row = { requests: 5000, failed: 0, userPerRequest: 1, kernelPerRequest: 1, userCyclesPerRequest: 1, kernelCyclesPerRequest: 1, userL1iMissesPerRequest: 1 };
  const summary = { metrics: { checks: { passes: 5000, fails: 0 } } };
  const ok = { row: [row], summary, want: "sha256:a", before: "sha256:a", after: "sha256:a", rc: 0 };
  assert.deepEqual(invalid(ok), []);
  assert.deepEqual(invalid({ ...ok, after: "sha256:b" }), ["the image counted was not the side's"]);
  assert.deepEqual(invalid({ ...ok, row: [{ ...row, failed: 2, userCyclesPerRequest: null }] }), ["2 failed requests", "userCyclesPerRequest is null"]);
  assert.deepEqual(invalid({ ...ok, row: { failed: "never answered" } }), ["count.mjs recorded failed: never answered"]);
  assert.deepEqual(invalid({ ...ok, summary: { metrics: { checks: { passes: 4999, fails: 1 } } } }), ["1 failed status checks", "4999 passed status checks, not 5000"]);
  assert.deepEqual(invalid({ ...ok, interrupted: true }), ["started and never ended; not run again"]);
});

test("a change is read by the default band where its A/A's two bounds less +1% are inside it", () => {
  const aa = of(-0.02, 0.02);
  assert.equal(resolution(aa), "resolved");
  assert.ok(inside(/** @type {number} */ (aa.bound)) && inside(/** @type {number} */ (aa.swappedBound)));
  assert.deepEqual(reading(of(0.04, 0.08), aa), { verdict: "a miss", decided: true, holds: true, clears: false });
  assert.deepEqual(reading(of(-0.08, -0.05), aa), { verdict: "meets +1%", decided: true, holds: false, clears: true });
  assert.deepEqual(reading(of(-0.01, 0.03), aa), { verdict: "inside the default band: not decided", decided: false, holds: false, clears: false });
  // The band's ends are inside.
  assert.ok(inside(BAND.high + MARGIN - 1e-12) && inside(BAND.low + MARGIN + 1e-12));
  assert.ok(!inside(BAND.high + MARGIN + 1e-9) && !inside(BAND.low + MARGIN - 1e-9));
});

test("where the A/A reads outside the band, as recorded or swapped, above or below, the change is neither held nor cleared", () => {
  const notDecided = { verdict: "not decided: the count's A/A does not resolve the default band, so it neither holds nor clears", decided: false, holds: false, clears: false };
  const above = of(0.05, 0.15), below = of(-0.08, -0.04);
  // Recorded inside, swapped outside: 42 pairs read -10% and 58 read 0 to +1%.
  const skewed = compare(pairsOf([...Array(42).fill(-0.1), ...spread(0, 0.01, 58)]));
  assert.ok(inside(/** @type {number} */ (skewed.bound)) && !inside(/** @type {number} */ (skewed.swappedBound)));
  for (const aa of [above, below, skewed]) {
    assert.equal(resolution(aa), "not resolved");
    for (const change of [of(0.04, 0.08), of(-0.08, -0.05), of(-0.01, 0.03)]) assert.deepEqual(reading(change, aa), notDecided);
  }
});

test("an A/A or a change with a pair not valid has no bound and decides nothing", () => {
  const broken = pairsOf(spread(-0.02, 0.02)).map((p, i) => (i === 7 ? { ...p, head: null } : p));
  const aa = compare(broken);
  assert.equal(aa.bound, null);
  assert.equal(resolution(aa), "no bound");
  assert.equal(reading(of(0.04, 0.08), aa).verdict, "not decided: the count's A/A has no bound, so it neither holds nor clears");
  assert.equal(reading(compare(broken), of(-0.02, 0.02)).verdict, "no bound: does not pass");
  assert.equal(resolution(compare(pairsOf(spread(-0.02, 0.02, 4)))), "no bound");
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
  assert.equal(reading(change.json, aa.json).holds, false);
  assert.equal(reading(change.json, aa.json).decided, false);
  assert.equal(resolution(aa.page), "resolved");
  assert.equal(reading(change.page, aa.page).verdict, "inside the default band: not decided");
});

test("the runner tags each side's image before its count, runs each invocation once and reads the change against its own A/A", () => {
  const results = mkdtempSync(join(tmpdir(), "count-pairs-"));
  try {
    const ids = { "cb-corten-base": "sha256:base", "cb-corten-head": "sha256:head" };
    let tagged = "", counted = [];
    // The head's image costs 6% more cycles; turns alternate a little around it.
    const exec = (cmd, args) => {
      if (cmd === "docker" && args[0] === "image") return { status: 0, stdout: args[4] === "cb-corten" ? ids[tagged] ?? "" : ids[args[4]] ?? "" };
      if (cmd === "docker" && args[0] === "tag") { tagged = args[1]; return { status: 0 }; }
      const [, round, , , target] = args;
      counted.push([round, tagged]);
      const cyclesU = (tagged === "cb-corten-head" ? 106000 : 100000) * (1 + 0.001 * ((counted.length % 5) - 2));
      const dir = join(results, round);
      mkdirSync(dir, { recursive: true });
      const row = { requests: 5000, failed: 0, userPerRequest: 75000, kernelPerRequest: 26000, userCyclesPerRequest: cyclesU, kernelCyclesPerRequest: 0, userL1iMissesPerRequest: 5000 };
      writeFileSync(join(dir, "instructions.json"), JSON.stringify({ [`corten/${target}`]: [row] }));
      writeFileSync(join(dir, `count-corten-${target}-0.json`), JSON.stringify({ metrics: { checks: { passes: 5000, fails: 0 } } }));
      return { status: 0 };
    };
    const o = { prefix: "t1", images: { base: "cb-corten-base", head: "cb-corten-head" }, last: 6, targets: ["json"], results, exec, now: () => 0 };
    const first = runPairs(o);
    assert.equal(counted.length, 7 * 4);
    for (const [round, image] of counted) assert.equal(image, round.includes("-ab-") && round.endsWith("-head") ? "cb-corten-head" : "cb-corten-base", round);
    const json = first.targets.json;
    assert.equal(json.change.n, 6);
    assert.ok(json.change.bound > 0.05 && json.aa.bound < 0.01);
    // Six pairs give a 95% rank, the 6th: P(Binomial(6, 1/2) >= 6) = 1/64.
    assert.equal(json.change.rank, 6);
    assert.equal(json.reading.verdict, "a miss");
    assert.match(first.md, /## `json`/);
    const report = JSON.parse(readFileSync(join(results, "t1", "report.json"), "utf8"));
    assert.equal(report.targets.json.aa.n, 6);
    // Run again, nothing is counted again.
    runPairs(o);
    assert.equal(counted.length, 7 * 4);
  } finally {
    rmSync(results, { recursive: true, force: true });
  }
});

test("an invocation started and never ended is not run again and leaves its comparison with no bound", () => {
  const results = mkdtempSync(join(tmpdir(), "count-pairs-"));
  try {
    const ids = { "cb-corten-base": "sha256:base", "cb-corten-head": "sha256:head" };
    let tagged = "", counted = 0;
    const exec = (cmd, args) => {
      if (cmd === "docker" && args[0] === "image") return { status: 0, stdout: args[4] === "cb-corten" ? ids[tagged] ?? "" : ids[args[4]] ?? "" };
      if (cmd === "docker" && args[0] === "tag") { tagged = args[1]; return { status: 0 }; }
      counted += 1;
      const [, round, , , target] = args;
      mkdirSync(join(results, round), { recursive: true });
      const row = { requests: 5000, failed: 0, userPerRequest: 1, kernelPerRequest: 1, userCyclesPerRequest: 100000, kernelCyclesPerRequest: 1, userL1iMissesPerRequest: 1 };
      writeFileSync(join(results, round, "instructions.json"), JSON.stringify({ [`corten/${target}`]: [row] }));
      writeFileSync(join(results, round, `count-corten-${target}-0.json`), JSON.stringify({ metrics: { checks: { passes: 5000, fails: 0 } } }));
      return { status: 0 };
    };
    mkdirSync(join(results, "t2"), { recursive: true });
    const name = schedule(100, ["page"], "t2")[12].name;
    appendFileSync(join(results, "t2", "invocations.jsonl"), JSON.stringify({ name, want: "sha256:base", started: 0 }) + "\n");
    const { targets } = runPairs({ prefix: "t2", images: { base: "cb-corten-base", head: "cb-corten-head" }, last: 100, targets: ["page"], results, exec, now: () => 0 });
    assert.equal(counted, 101 * 4 - 1);
    // The pair it falls in is pair 3, which starts with the A/A's side named base.
    assert.match(name, /-aa-003-base$/);
    assert.equal(targets.page.aa.bound, null);
    assert.notEqual(targets.page.change.bound, null);
    assert.equal(targets.page.reading.verdict, "not decided: the count's A/A has no bound, so it neither holds nor clears");
  } finally {
    rmSync(results, { recursive: true, force: true });
  }
});

test("the runner refuses one image for both sides, since the A/A is the run's own", () => {
  const results = mkdtempSync(join(tmpdir(), "count-pairs-"));
  try {
    const exec = () => ({ status: 0, stdout: "sha256:same" });
    assert.throws(() => runPairs({ prefix: "t3", images: { base: "a", head: "b" }, last: 2, targets: ["page"], results, exec }), /one image/);
  } finally {
    rmSync(results, { recursive: true, force: true });
  }
});
