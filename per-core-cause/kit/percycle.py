#!/usr/bin/env python3
"""Cycles a request from a probe's `perf stat` (perfstat: cycles and seconds elapsed) and the
requests a second of the 30 s run it was taken in (gcannon.out), with the cores the process had
(task-clock over the time elapsed) and its context switches a second.
Usage: percycle.py <probe directory>..."""
import re
import sys

for d in sys.argv[1:]:
    stat = open(d + "/perfstat").read()

    def count(name):
        return float(re.search(r"([\d.]+)\s+(?:msec )?" + name, stat).group(1))

    secs = float(re.search(r"([\d.]+) seconds time elapsed", stat).group(1))
    load = open(d + "/gcannon.out").read()
    done, took = re.search(r"(\d+) requests in ([\d.]+)s", load).groups()
    rate = int(done) / float(took)
    print(
        f"{d.rstrip('/').split('/')[-1]:<20} {rate:>9.0f} req/s  {count('task-clock') / 1000 / secs:5.2f} cores  "
        f"{count('context-switches') / secs:>7.0f} switches/s  {count('cycles') / (rate * secs):>7.0f} cycles a request  "
        f"{count('instructions') / (rate * secs):>7.0f} instructions a request"
    )
