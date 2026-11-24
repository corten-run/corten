#!/usr/bin/env python3
"""Cycles a request by group, from `perf report --no-children --sort dso,symbol` text and the
requests a second of the same run. Usage: cyc.py <name=self.txt:rps:seconds>..."""
import re, sys

GROUPS = [
    ("kernel futex+sched", r"futex|schedule|sched_|try_to_wake|ttwu|wake_up_q|wake_q|dequeue_|enqueue_|pick_next|update_curr|update_load|psi_|__switch|finish_task|select_task|available_idle|put_prev|set_next|prepare_task|update_rq|idle|newidle|osq_|rwsem|mm_cid|task_work|pick_task|update_se|update_cfs|place_entity|cpuacct|__update_load|reweight|check_preempt|wakeup_preempt|resched|raw_spin_rq"),
    ("kernel epoll/eventfd", r"ep_|epoll|eventfd"),
    ("kernel syscall entry", r"entry_SYSCALL|do_syscall|syscall_|x64_sys_call|__x64_sys|entry_SYSRETQ|srso|retbleed|native_"),
    ("kernel tcp/net", r".*"),  # every other kernel symbol
]
USER = [
    ("tokio time (wheel, sleep)", r"tokio::runtime::time|tokio::time::|time_alt|TimerEntry|runtime::Timer"),
    ("std mutex/futex (user)", r"sync::mutex|lock_contended|futex|Mutex|syscall$|^syscall|pthread|lll_"),
    ("tokio scheduler", r"multi_thread|current_thread|scheduler|runtime::task|runtime::park|runtime::context|coop|runtime::driver|runtime::io::driver|BlockingTask|inject|waker"),
    ("tokio io/net/sync", r"tokio::"),
    ("hyper", r"hyper"),
    ("corten + app", r"corten|httparena"),
    ("malloc", r"^malloc|^free|je_|calloc|realloc|sdallocx|mallocx"),
    ("other user", r".*"),
]


def load(path):
    total = None
    rows = []
    for line in open(path, encoding="utf-8", errors="replace"):
        m = re.match(r"# Event count \(approx\.\): (\d+)", line)
        if m:
            total = int(m.group(1))
        m = re.match(r"\s+([\d.]+)%\s+(\S+)\s+\[(.)\]\s+(.*)$", line)
        if m:
            rows.append((float(m.group(1)), m.group(2), m.group(3), m.group(4).strip()))
    return total, rows


cols = []
for arg in sys.argv[1:]:
    name, rest = arg.split("=")
    path, rps, secs = rest.split(":")
    total, rows = load(path)
    reqs = float(rps) * float(secs)
    g = {}
    for pct, dso, kind, sym in rows:
        table = GROUPS if kind == "k" else USER
        for gname, pat in table:
            if re.search(pat, sym):
                g[gname] = g.get(gname, 0) + pct / 100 * total / reqs
                break
    cols.append((name, total / reqs, g))

names = [n for n, _ in GROUPS] + [n for n, _ in USER]
print(f"{'cycles a request':<28}" + "".join(f"{c[0]:>12}" for c in cols))
for n in names:
    print(f"{n:<28}" + "".join(f"{c[2].get(n, 0):>12.0f}" for c in cols))
print(f"{'total':<28}" + "".join(f"{c[1]:>12.0f}" for c in cols))
