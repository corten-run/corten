#!/usr/bin/env python3
"""Reads a probe's two per-thread snapshots (threads0, threads1: thread id, name, schedstat's
time on a CPU and time waiting for one in ns and its slices, voluntary and involuntary context
switches) and the times they were taken (t0, t1): each busy thread's share of the window on a
CPU and waiting for one, and its switches a second. The same reading probe.sh prints at the end
of a probe, whose output was not kept. Usage: threads.py <probe directory>..."""
import sys


def read(path):
    rows = {}
    for line in open(path):
        f = line.split()
        rows[f[0]] = (" ".join(f[1:-5]), int(f[-5]), int(f[-4]), int(f[-3]), int(f[-2]), int(f[-1]))
    return rows


for d in sys.argv[1:]:
    a, b = read(d + "/threads0"), read(d + "/threads1")
    dt = float(open(d + "/t1").read()) - float(open(d + "/t0").read())
    rows = []
    for tid in b:
        if tid in a:
            rows.append(
                (
                    b[tid][0],
                    (b[tid][1] - a[tid][1]) / 1e9 / dt * 100,
                    (b[tid][2] - a[tid][2]) / 1e9 / dt * 100,
                    (b[tid][4] - a[tid][4]) / dt,
                    (b[tid][5] - a[tid][5]) / dt,
                )
            )
    rows.sort(key=lambda r: -r[1])
    print(f"== {d.rstrip('/').split('/')[-1]}: window {dt:.2f}s; thread, on a CPU %, waiting for one %, voluntary switches/s, involuntary/s")
    for r in rows:
        if r[1] > 0.5:
            print(f"  {r[0]:<18} {r[1]:6.1f} {r[2]:6.1f} {r[3]:9.0f} {r[4]:7.0f}")
    print(f"  all threads: {sum(r[1] for r in rows) / 100:.2f} cores on a CPU; {sum(r[3] for r in rows):.0f} voluntary switches/s")
