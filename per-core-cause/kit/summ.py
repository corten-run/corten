#!/usr/bin/env python3
"""Summarizes results.tsv: per label and profile, the runs, the best and the median.
Usage: summ.py <results.tsv> [label-prefix]"""
import sys, statistics, collections

rows = collections.OrderedDict()
for line in open(sys.argv[1]):
    f = line.rstrip("\n").split("\t")
    if len(f) < 9:
        continue
    key = (f[0], f[1])
    rows.setdefault(key, []).append(f)
prefix = sys.argv[2] if len(sys.argv) > 2 else ""
print(f"{'label':<26} {'profile':<18} {'n':>2} {'best':>9} {'median':>9}  {'p99(best)':>9} {'us/req':>6} {'sys%':>4} {'cores busy min/med/max':>22}  runs")
for (label, prof), rs in rows.items():
    if not label.startswith(prefix):
        continue
    rps = [int(r[3]) for r in rs]
    best = max(rs, key=lambda r: int(r[3]))
    print(f"{label:<26} {prof:<18} {len(rs):>2} {max(rps):>9} {int(statistics.median(rps)):>9}  {best[5]:>9} {best[6]:>6} {best[7]:>4} {best[8]:>22}  {' '.join(map(str, rps))} {best[9] if 'xx' in best[9] and any(c.isdigit() and c != '0' for c in best[9].split('rc=')[0].replace('4xx=','').replace('5xx=','')) else ''}")
