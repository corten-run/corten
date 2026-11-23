#!/usr/bin/env python3
"""`crates/corten/tests/router_cost.rs` under callgrind: instructions a request costs in process,
through the router with no socket, as CONTRIBUTING.md (Pull requests, item 2) counts it.

    cargo test --release -p corten-run --test router_cost --no-run
    python3 measure/router.py <the test binary cargo names> [--reps 3] [--targets item,write]

Each count is the run of 1,200 requests less the run of 200, over 1,000.
"""

import argparse
import os
import re
import subprocess

# Each target's environment (`router_cost.rs` says what each counts).
TARGETS = {
    "item": {},
    "write": {"ROUTER_TARGET": "write"},
    "unstaged": {"ROUTER_TARGET": "unstaged"},
    "missing": {"ROUTER_TARGET": "missing"},
    "kept-page": {"ROUTER_TARGET": "kept", "ROUTER_PUBLIC": "page"},
}


def run(binary, target, requests, allocator):
    env = dict(os.environ, ROUTER_REQUESTS=str(requests), **TARGETS[target])
    if allocator == "jemalloc":
        env["LD_PRELOAD"] = "libjemalloc.so.2"
        env["MALLOC_CONF"] = "background_thread:false,tcache_max:65536"
    command = ["valgrind", "--tool=callgrind", "--callgrind-out-file=/tmp/router.callgrind", binary]
    done = subprocess.run(command + ["--ignored", "--exact", "request_cost"], env=env, capture_output=True, text=True)
    collected = re.search(r"Collected : (\d+)", done.stderr)
    if done.returncode != 0 or collected is None:
        raise SystemExit(f"{target} failed:\n{done.stdout}\n{done.stderr}")
    return int(collected.group(1))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary")
    parser.add_argument("--reps", type=int, default=3)
    parser.add_argument("--targets", default=",".join(TARGETS))
    parser.add_argument("--allocator", default="jemalloc", choices=["jemalloc", "system"])
    args = parser.parse_args()
    print(f"{'target':<14}{'median':>10}{'least':>10}{'most':>10}  runs")
    for target in args.targets.split(","):
        each = []
        for _ in range(args.reps):
            few = run(args.binary, target, 200, args.allocator)
            many = run(args.binary, target, 1200, args.allocator)
            each.append((many - few) / 1000)
        ordered = sorted(each)
        runs = " ".join(f"{one:.0f}" for one in each)
        print(f"{target:<14}{ordered[len(ordered) // 2]:>10.0f}{ordered[0]:>10.0f}{ordered[-1]:>10.0f}  {runs}", flush=True)


if __name__ == "__main__":
    main()
