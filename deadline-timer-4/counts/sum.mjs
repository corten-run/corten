// Reads the count host's c3/out/*.txt (sets.sh's labelled lines of count7.py's output) and prints,
// for each row and runtime: each build's median instructions a request in each round, its
// difference from the base of the same round, and the parks a request (median of the runs).
// Usage: node sum.mjs <dir> [label prefix]
import fs from "node:fs";

const dir = process.argv[2];
const only = process.argv[3] || "";
const rows = new Map();
const order = [];
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".txt") && f !== "host.txt").sort()) {
    for (const line of fs.readFileSync(`${dir}/${file}`, "utf8").split("\n")) {
        const m = line.match(/^(\S+) (\S+) (\S+) r(\d) \| (\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d ]+)\| ([\d.]+), ([\d. ]+)\| ([\d. ]+)$/);
        if (!m) {
            if (/Traceback|SystemExit|closed the connection|did not|was answered/.test(line)) console.log(`!! ${file}: ${line}`);
            continue;
        }
        const [, label, mode, name, round, kase, median, least, most, , allocs, , parks] = m;
        const key = `${label} ${mode}`;
        if (!rows.has(key)) {
            rows.set(key, new Map());
            order.push(key);
        }
        const p = parks.trim().split(/\s+/).map(Number).sort((a, b) => a - b);
        rows.get(key).set(`${name} ${round}`, { median: +median, least: +least, most: +most, allocs: +allocs, parks: p[p.length >> 1], kase });
    }
}
const names = ["base", "head", "out1", "out8", "req1", "req8", "rq1", "rq8", "far", "soon", "soon2", "soon2h"];
for (const key of order) {
    if (!key.startsWith(only)) continue;
    const got = rows.get(key);
    console.log(`\n${key}`);
    for (const name of names) {
        const cells = [];
        for (const round of ["1", "2"]) {
            const here = got.get(`${name} ${round}`);
            const base = got.get(`base ${round}`);
            if (!here) continue;
            const diff = base ? here.median - base.median : NaN;
            cells.push(`r${round} ${here.median} (${here.least}..${here.most}) ${name === "base" ? "" : (diff >= 0 ? "+" : "") + diff} allocs ${here.allocs} parks ${here.parks.toFixed(3)}`);
        }
        if (cells.length) console.log(`  ${name.padEnd(5)} ${cells.join("  |  ")}`);
    }
}
