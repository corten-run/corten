// Reads run48.sh's results.tsv as tp48-plan.md says: for each workload, condition and value, each
// build's median and range, its ratio to a reference build of the same round (median, range, rounds
// above and below 1), the noise bar (the largest |base2/base - 1|) and whether it is resolved.
// Usage: node sum48.mjs <results.tsv> [workload...]
import fs from "node:fs";

const ms = (text) => {
    const m = /^([\d.]+)(us|ms|s)$/.exec(text ?? "");
    return m ? +m[1] * { us: 0.001, ms: 1, s: 1000 }[m[2]] : NaN;
};
const median = (list) => {
    const s = [...list].sort((a, b) => a - b);
    return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const pct = (x) => (x >= 1 ? "+" : "") + ((x - 1) * 100).toFixed(2) + "%";
const want = process.argv.slice(3);
const runs = [];
for (const line of fs.readFileSync(process.argv[2], "utf8").split("\n")) {
    const f = line.split("\t");
    if (f.length < 14) continue;
    runs.push({ w: f[0], round: +f[1], pos: +f[2], build: f[3], cond: f[4], rps: +f[5], avg: ms(f[6]), p50: ms(f[7]), p99: ms(f[8]), cpu: +f[9], cycles: +f[10], instr: +f[11], threads: +f[12], note: f[13] });
}
// VALUES in the environment names the values to print (rps,p50,p99,cpu,cycles,instr); all when unset.
const only = (process.env.VALUES ?? "").split(",").filter(Boolean);
const VALUES = [["rps", "requests a second", 0], ["p50", "p50 ms", 3], ["p99", "p99 ms", 3], ["cpu", "CPU us a request", 2], ["cycles", "cycles a request", 0], ["instr", "instructions a request", 0]].filter(([key]) => !only.length || only.includes(key));
const workloads = [...new Set(runs.map((r) => r.w))].filter((w) => !want.length || want.includes(w));

// The ratios of two series by round, and the reading of them against a noise bar.
function ratios(get, a, b, rounds) {
    return rounds.map((i) => get(a, i) / get(b, i)).filter((x) => Number.isFinite(x));
}
function reading(r, bar) {
    if (!r.length) return "no rounds";
    const m = median(r);
    const up = r.filter((x) => x > 1).length, down = r.filter((x) => x < 1).length;
    const side = m > 1 ? up : down;
    const need = Math.ceil(r.length * 0.9);
    const resolved = bar !== null && Math.abs(m - 1) > bar && side >= need;
    return `${pct(m)} (${pct(Math.min(...r))} to ${pct(Math.max(...r))}), ${up} up ${down} down of ${r.length}${bar === null ? "" : resolved ? "  RESOLVED" : "  not resolved"}`;
}

for (const w of workloads) {
    const mine = runs.filter((r) => r.w === w);
    const conds = [...new Set(mine.map((r) => r.cond))];
    const builds = [...new Set(mine.map((r) => r.build))].sort((a, b) => ["base", "head", "old", "oldbase", "base2"].indexOf(a) - ["base", "head", "old", "oldbase", "base2"].indexOf(b));
    const rounds = [...new Set(mine.map((r) => r.round))].sort((a, b) => a - b);
    const bad = mine.filter((r) => r.note !== "ok");
    console.log(`\n================ ${w}: ${rounds.length} rounds, ${mine.length} runs, ${bad.length} failed, threads ${[...new Set(mine.map((r) => r.threads))].join("/")}`);
    for (const r of bad) console.log(`  FAILED r${r.round} ${r.build} ${r.cond}: ${r.note}`);
    const at = (cond, key) => (build, i) => mine.find((r) => r.cond === cond && r.build === build && r.round === i)?.[key] ?? NaN;
    for (const cond of conds) {
        for (const [key, label, digits] of VALUES) {
            const get = at(cond, key);
            if (!rounds.some((i) => Number.isFinite(get("base", i)))) continue;
            const noise = ratios(get, "base2", "base", rounds);
            const bar = noise.length ? Math.max(...noise.map((x) => Math.abs(x - 1))) : null;
            console.log(`\n  ${w} ${cond}: ${label}; noise bar ${bar === null ? "none" : (bar * 100).toFixed(2) + "%"} (base2 over base ${reading(noise, null)})`);
            for (const b of builds) {
                const v = rounds.map((i) => get(b, i)).filter((x) => Number.isFinite(x));
                if (!v.length) continue;
                let line = `    ${b.padEnd(8)} median ${median(v).toFixed(digits)} (${Math.min(...v).toFixed(digits)} to ${Math.max(...v).toFixed(digits)})`;
                if (b !== "base" && b !== "base2") line += `  over base ${reading(ratios(get, b, "base", rounds), bar)}`;
                console.log(line);
            }
            if (builds.includes("oldbase")) console.log(`    old over oldbase   ${reading(ratios(get, "old", "oldbase", rounds), bar)}`);
            if (builds.includes("old")) console.log(`    head over old      ${reading(ratios(get, "head", "old", rounds), bar)}`);
        }
    }
    if (conds.length === 2) {
        // The condition's cost for each build, by round, and a build's excess over the base.
        const [plain, loaded] = conds.includes("quiet") ? ["quiet", "wait"] : ["none", "idle3"];
        for (const [key, label] of VALUES) {
            const k = (build, i) => at(loaded, key)(build, i) / at(plain, key)(build, i);
            if (!rounds.some((i) => Number.isFinite(k("base", i)))) continue;
            const noise = rounds.map((i) => k("base2", i) / k("base", i)).filter((x) => Number.isFinite(x));
            const bar = noise.length ? Math.max(...noise.map((x) => Math.abs(x - 1))) : null;
            console.log(`\n  ${w} ${loaded} over ${plain}: ${label}; noise bar of the excess ${bar === null ? "none" : (bar * 100).toFixed(2) + "%"}`);
            for (const b of builds) {
                const own = rounds.map((i) => k(b, i)).filter((x) => Number.isFinite(x));
                let line = `    ${b.padEnd(8)} ${loaded}/${plain} ${reading(own, null)}`;
                if (b !== "base" && b !== "base2") line += `   excess over base ${reading(rounds.map((i) => k(b, i) / k("base", i)).filter((x) => Number.isFinite(x)), bar)}`;
                console.log(line);
            }
        }
    }
}
