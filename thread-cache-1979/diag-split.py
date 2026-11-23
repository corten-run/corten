"""python3 diag-split.py <log> <A> <B>: per-pair changes of user and of kernel cycles a request,
which pairs.py gives only for their sum and for instructions. Skips the first pair, as it does."""
import re
import sys

log, a, b = sys.argv[1:4]
pairs = {}
for line in open(log):
    m = re.match(r"pair (\d+): (\S+) .*cycles_user=(\d+) cycles_kernel=(\d+)", line)
    if m:
        pairs.setdefault(int(m[1]), {})[m[2]] = (int(m[3]), int(m[4]))
rows = [pairs[i] for i in sorted(pairs) if i > 1 and a in pairs[i] and b in pairs[i]]
n = len(rows)
rank = {40: 26, 60: 37, 100: 59}[n]
for name, k in (("user", 0), ("kernel", 1)):
    changes = sorted((r[b][k] / r[a][k] - 1) * 100 for r in rows)
    median = (changes[n // 2 - 1] + changes[n // 2]) / 2
    print(f"{name}: pairs {n}, per-pair change median {median:+.2f}%, range {changes[0]:+.2f}% to {changes[-1]:+.2f}%, "
          f"one-sided 95% upper bound on the median {changes[rank - 1]:+.2f}% (the {rank}th of {n} sorted)")
