"""Reads noise.sh logs: spread of cycles a request across turns. Usage: turns.py <log>..."""
import re
import statistics
import sys

for log in sys.argv[1:]:
    rows = []
    for line in open(log):
        m = re.search(r"requests=(\d+) failed=(\d+) cycles_user=(\d+) cycles_kernel=(\d+) total=(\d+) instr_user=(\d+)(?: instr_kernel=(\d+))?", line)
        if m:
            rows.append([int(x) if x else 0 for x in m.groups()])
    if len(rows) < 4:
        print(f"{log}: {len(rows)} turns")
        continue
    total = [r[4] for r in rows]
    q = statistics.quantiles(total, n=4)
    med = statistics.median(total)
    ik = [r[6] for r in rows]
    print(f"{log}: {len(rows)} turns, failed {sum(r[1] for r in rows)}; cycles/request median {med:.0f}, min {min(total)}, max {max(total)}, "
          f"sd {statistics.pstdev(total) / statistics.fmean(total) * 100:.2f}%, IQR {(q[2] - q[0]) / med * 100:.2f}%; "
          f"user {statistics.median(r[2] for r in rows):.0f}, kernel {statistics.median(r[3] for r in rows):.0f}; "
          f"requests {statistics.median(r[0] for r in rows):.0f}; kernel instr {statistics.median(ik):.0f} (sd {statistics.pstdev(ik) / max(statistics.fmean(ik), 1) * 100:.2f}%)")
