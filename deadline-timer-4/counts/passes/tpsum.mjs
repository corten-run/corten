// Reads tp.sh's results.tsv: for each pass and build, the runs, the median, least and most requests
// a second, the median over the base's median, the median of the build's ratio to the base of the
// same round, and the median and worst p99. Usage: node tpsum.mjs <results.tsv>
import fs from "node:fs";

const ms = (text) => {
    const m = text.match(/^([\d.]+)(us|ms|s)$/);
    return m ? +m[1] * { us: 0.001, ms: 1, s: 1000 }[m[2]] : NaN;
};
const median = (list) => {
    const s = [...list].sort((a, b) => a - b);
    return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const passes = new Map();
for (const line of fs.readFileSync(process.argv[2], "utf8").split("\n")) {
    const [tag, name, rps, p50, p99, bad] = line.split("\t");
    if (!bad) continue;
    const [pass, round] = tag.split(".");
    if (!passes.has(pass)) passes.set(pass, new Map());
    const builds = passes.get(pass);
    if (!builds.has(name)) builds.set(name, []);
    builds.get(name).push({ round, rps: +rps, p50: ms(p50), p99: ms(p99), bad });
}
for (const [pass, builds] of passes) {
    const base = builds.get("base");
    const baseMedian = median(base.map((r) => r.rps));
    console.log(`\n${pass}: build, runs, median requests a second (least to most), over the base's median, median of the ratios to the base of the same round (least to most), p99 median and worst in ms, runs with errors`);
    for (const [name, runs] of builds) {
        const rps = runs.map((r) => r.rps);
        const ratios = runs.filter((r) => base.some((b) => b.round === r.round)).map((r) => r.rps / base.find((b) => b.round === r.round).rps);
        const pct = (x) => ((x - 1) * 100).toFixed(1) + "%";
        const p99 = runs.map((r) => r.p99);
        console.log(
            `  ${name.padEnd(7)} ${runs.length}  ${median(rps).toFixed(0)} (${Math.min(...rps).toFixed(0)} to ${Math.max(...rps).toFixed(0)})  ${pct(median(rps) / baseMedian)}  ${pct(median(ratios))} (${pct(Math.min(...ratios))} to ${pct(Math.max(...ratios))})  p99 ${median(p99).toFixed(2)}, ${Math.max(...p99).toFixed(2)}  ${runs.filter((r) => r.bad !== "none").length}`,
        );
    }
}
