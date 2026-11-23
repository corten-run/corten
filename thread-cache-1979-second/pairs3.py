#!/usr/bin/env python3
"""Reads a tc-pair3.sh log: per-pair change (B against A) in user plus kernel cycles a request,
in user cycles, kernel cycles and user instructions, each with its median, range and the
one-sided 95% upper bound on the median (an order statistic: the k-th smallest of n sorted
changes, k the smallest rank with P(Binomial(n, 1/2) >= k) <= 5%: the 26th of 40, the 113th of
200). With --swapped it also reads the pairs with the labels turned (A against B), which is how a
comparison of a setting with itself is read twice.
Usage: pairs3.py <log> <A> <B> [skip first N pairs] [--swapped] [-v]"""
import math
import re
import statistics
import sys

args = [a for a in sys.argv[1:] if not a.startswith("-")]
log, a, b = args[0], args[1], args[2]
skip = int(args[3]) if len(args) > 3 else 1
rows = {}
for line in open(log):
    if line.startswith("#"):
        print(line.strip())
        continue
    m = re.match(r"pair (\d+): (\S+) requests=(\d+) failed=(\d+) cycles_user=(\d+) cycles_kernel=(\d+) total=(\d+) instr_user=(\d+) running=(\S+)", line)
    if not m:
        if line.strip():
            print("UNPARSED " + line.strip()[:120])
        continue
    rows.setdefault(int(m[1]), {})[m[2]] = dict(requests=int(m[3]), failed=int(m[4]), user=int(m[5]), kernel=int(m[6]),
                                                total=int(m[7]), instr=int(m[8]), running=m[9])
pairs = [(p, r[a], r[b]) for p, r in sorted(rows.items()) if p > skip and a in r and b in r]
bad = [p for p, x, y in pairs if x["failed"] or y["failed"] or x["running"] != "100.00/100.00/100.00" or y["running"] != "100.00/100.00/100.00"]
print(f"pairs used: {len(pairs)} (after the first {skip}); pairs with a failed request or a counter under 100%: {bad or 'none'}")


def rank(n):
    for k in range(1, n + 1):
        if sum(math.comb(n, i) for i in range(k, n + 1)) / 2 ** n <= 0.05:
            return k
    return None


n = len(pairs)
k = rank(n)
for key, label in (("total", "user+kernel cycles"), ("user", "user cycles"), ("kernel", "kernel cycles"), ("instr", "user instructions")):
    before = [x[key] for _, x, _ in pairs]
    after = [y[key] for _, _, y in pairs]
    changes = sorted((y[key] / x[key] - 1) * 100 for _, x, y in pairs)
    print(f"{label} a request: {a} median {statistics.median(before):,.0f} best {min(before):,} range {min(before):,} to {max(before):,}; "
          f"{b} median {statistics.median(after):,.0f} best {min(after):,} range {min(after):,} to {max(after):,}")
    print(f"  per-pair change: median {statistics.median(changes):+.2f}%, range {changes[0]:+.2f}% to {changes[-1]:+.2f}%, "
          f"bound {changes[k - 1]:+.2f}% (the {k}th of {n}); lower in {b}: {sum(c < 0 for c in changes)} of {n}")
    if "--swapped" in sys.argv:
        turned = sorted((x[key] / y[key] - 1) * 100 for _, x, y in pairs)
        print(f"  labels swapped: median {statistics.median(turned):+.2f}%, bound {turned[k - 1]:+.2f}% (the {k}th of {n})")
if "-v" in sys.argv:
    print("per-pair changes in user+kernel cycles: " + " ".join(f"{(y['total'] / x['total'] - 1) * 100:+.2f}" for _, x, y in pairs))
