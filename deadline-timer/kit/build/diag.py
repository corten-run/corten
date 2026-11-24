#!/usr/bin/env python3
"""Where a request's instructions go, by function, for two builds: callgrind_annotate of a run of
240 requests and one of 1,240, the difference over 1,000, and the functions whose cost differs.

    python3 diag.py <case> <binary a> <binary b>
"""

import collections
import os
import re
import signal
import socket
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import count2  # noqa: E402

CORE = os.environ.get("DIAG_CORE", "5")


def start(server, out):
    env = dict(os.environ)
    env["LD_PRELOAD"] = "libjemalloc.so.2"
    env["MALLOC_CONF"] = "background_thread:false,tcache_max:65536"
    command = ["taskset", "-c", CORE, "valgrind", "--tool=callgrind", "--callgrind-out-file=" + out, server]
    process = subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(600):
        try:
            socket.create_connection(("127.0.0.1", 8080), timeout=0.2).close()
            return process
        except OSError:
            time.sleep(0.1)
    raise SystemExit("the server did not listen")


def costs(server, case, count, out):
    process = start(server, out)
    count2.send(case, count, bool(os.environ.get("DIAG_EACH")))
    process.send_signal(signal.SIGTERM)
    process.communicate(timeout=120)
    text = subprocess.run(["callgrind_annotate", "--threshold=100", out], capture_output=True, text=True).stdout
    found = collections.Counter()
    for line in text.splitlines():
        match = re.match(r"\s*([\d,]+)\s+\(\s*[\d.]+%\)\s+(.*)$", line)
        if match:
            name = re.sub(r"\s*\[[^\]]*\]\s*$", "", match.group(2))
            found[name] += int(match.group(1).replace(",", ""))
    return found


def each(server, case, tag):
    few = costs(server, case, 240, f"/tmp/{tag}-few.cg")
    many = costs(server, case, 1240, f"/tmp/{tag}-many.cg")
    return {name: (many[name] - few.get(name, 0)) / 1000 for name in many}


def main():
    case, a, b = sys.argv[1:4]
    one, two = each(a, case, "a"), each(b, case, "b")
    print(f"total a {sum(one.values()):.0f}  b {sum(two.values()):.0f}")
    rows = []
    for name in set(one) | set(two):
        x, y = one.get(name, 0), two.get(name, 0)
        if abs(y - x) >= 1:
            rows.append((y - x, x, y, name))
    for diff, x, y, name in sorted(rows, key=lambda row: -abs(row[0]))[:45]:
        print(f"{diff:>+8.0f} {x:>8.0f} {y:>8.0f}  {name[:230]}")


if __name__ == "__main__":
    main()
