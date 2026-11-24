#!/usr/bin/env python3
"""Best and median of the runs in results.tsv, by pass, profile and variant.

    python3 agg.py results.tsv [pass...]
"""

import collections
import re
import statistics
import sys


def millis(text):
    match = re.fullmatch(r"([\d.]+)(us|µs|ms|s)", text)
    if not match:
        return float("nan")
    return float(match.group(1)) * {"us": 0.001, "µs": 0.001, "ms": 1, "s": 1000}[match.group(2)]


def main():
    rows = collections.defaultdict(list)
    for line in open(sys.argv[1], encoding="utf-8"):
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 9:
            continue
        which, label, profile, _run, rps, avg, p99, cpu, notes = parts[:9]
        name = which.split(".")[0]
        if which.endswith(".long"):
            name += ".long"
        errors = sum(int(n) for n in re.findall(r"[45]xx=(\d+)", notes))
        rows[(name, profile, label)].append((int(rps), millis(avg), millis(p99), float(cpu) if cpu != "na" else float("nan"), errors))
    wanted = sys.argv[2:]
    # A run that was answered with errors is left out and counted in the last column.
    failed = {key: sum(1 for run in runs if run[4]) for key, runs in rows.items()}
    rows = {key: [run for run in runs if not run[4]] for key, runs in rows.items()}
    rows = {key: runs for key, runs in rows.items() if runs}
    base = {}
    for (name, profile, label), runs in rows.items():
        if label == "base":
            base[(name, profile)] = statistics.median(run[0] for run in runs)
    print(f"{'pass':<8}{'profile':<16}{'variant':<8}{'n':>3}{'best rps':>10}{'median rps':>11}{'vs base':>9}{'least':>9}{'p99 med':>9}{'p99 best':>9}{'p99 worst':>10}{'avg med':>9}{'cpu us':>8}{'failed':>7}")
    for (name, profile, label) in sorted(rows, key=lambda key: (key[0], key[1], key[2] != "base", key[2])):
        if wanted and name not in wanted:
            continue
        runs = rows[(name, profile, label)]
        rps = [run[0] for run in runs]
        p99 = [run[2] for run in runs]
        median = statistics.median(rps)
        against = base.get((name, profile))
        versus = f"{(median / against - 1) * 100:+.1f}%" if against else ""
        print(
            f"{name:<8}{profile:<16}{label:<8}{len(runs):>3}{max(rps):>10}{median:>11.0f}{versus:>9}{min(rps):>9}"
            f"{statistics.median(p99):>9.1f}{min(p99):>9.1f}{max(p99):>10.1f}{statistics.median(run[1] for run in runs):>9.2f}"
            f"{statistics.median(run[3] for run in runs):>8.2f}{failed[(name, profile, label)]:>7}"
        )


if __name__ == "__main__":
    main()
