#!/usr/bin/env python3
"""Reads pair.sh output: per-pair change in user plus kernel cycles per request (B against A),
with pairs, best, median, range, the user and kernel split, and the one-sided 95% upper bound
on the median per-pair change (an order statistic: the 59th of 100 sorted changes).
Usage: pairs.py <log> <imageA> <imageB> [skip first N pairs]"""
import math
import re
import statistics
import sys

log, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
skip = int(sys.argv[4]) if len(sys.argv) > 4 else 0
rows = {}
notes = []
for line in open(log):
    if line.startswith("#"):
        notes.append(line.strip())
        continue
    m = re.match(r"pair (\d+): (\S+) requests=(\d+) failed=(\d+) cycles_user=(\d+) cycles_kernel=(\d+) total=(\d+) instr_user=(\d+) running=(\S+)", line)
    if not m:
        if line.strip():
            notes.append("UNPARSED " + line.strip()[:120])
        continue
    pair, image = int(m.group(1)), m.group(2)
    rows.setdefault(pair, {})[image] = dict(
        failed=int(m.group(4)), user=int(m.group(5)), kernel=int(m.group(6)), total=int(m.group(7)),
        instr=int(m.group(8)), running=m.group(9))
for n in notes:
    print(n)
pairs = [(p, r[a], r[b]) for p, r in sorted(rows.items()) if p > skip and a in r and b in r]
bad = [p for p, x, y in pairs if x["failed"] or y["failed"] or x["running"] != "100.00/100.00/100.00" or y["running"] != "100.00/100.00/100.00"]
print(f"pairs used: {len(pairs)} (skipped the first {skip}); pairs with failed requests or a counter under 100%: {bad or 'none'}")


def upper_index(n):
    """Smallest k (1-based) with P(Bin(n, 1/2) >= k) <= 0.05: the k-th smallest change is a
    one-sided 95% upper bound on the median."""
    for k in range(1, n + 1):
        tail = sum(math.comb(n, i) for i in range(k, n + 1)) / 2 ** n
        if tail <= 0.05:
            return k
    return None


def summary(key, label):
    before = [x[key] for _, x, _ in pairs]
    after = [y[key] for _, _, y in pairs]
    print(f"{label}: before median {statistics.median(before):,.0f} best {min(before):,} range {min(before):,}-{max(before):,}; "
          f"after median {statistics.median(after):,.0f} best {min(after):,} range {min(after):,}-{max(after):,}")


for key, label in (("total", "user+kernel cycles/request"), ("user", "user cycles/request"), ("kernel", "kernel cycles/request"), ("instr", "user instructions/request")):
    summary(key, label)
for key in ("total", "instr"):
    changes = sorted((y[key] - x[key]) / x[key] * 100 for _, x, y in pairs)
    k = upper_index(len(changes))
    bound = f"{changes[k - 1]:+.2f}% (the {k}th of {len(changes)} sorted)" if k else "none (too few pairs)"
    print(f"{key}: per-pair change median {statistics.median(changes):+.2f}%, range {changes[0]:+.2f}% to {changes[-1]:+.2f}%, "
          f"one-sided 95% upper bound on the median {bound}; pairs lower in B: {sum(c < 0 for c in changes)} of {len(changes)}")
if "-v" in sys.argv:
    print("per-pair total changes: " + " ".join(f"{(y['total'] - x['total']) / x['total'] * 100:+.2f}" for _, x, y in pairs))
