#!/usr/bin/env python3
"""Where a scenario's instructions are, by function, and a row 7 with more first waits.

    ARENA_MODE=default python3 attr.py count <server> --first 2 [--reps 3]
    ARENA_MODE=default python3 attr.py funcs <server> <scenario> <out file>
    python3 attr.py diff <funcs file> <funcs file> [--least 3]

count: row 7 with `--first` waiting requests (`sdelay1`) before the counted ones (`get`).
funcs: instructions a request by function (callgrind's own cost, callees left out): the
difference of 1,240 and 240 requests over 1,000. Scenarios: get, sdelay1, each-get, each-sdelay1,
row7 (one waiting request first), row7x2 (two).
diff: the functions whose figure differs between two such files by `--least` or more.
"""

import argparse
import collections
import re
import sys

import count2
import extra

SCENARIOS = {
    "get": ("get", 0, False),
    "sdelay1": ("sdelay1", 0, False),
    "delay1": ("delay1", 0, False),
    "each-get": ("get", 0, True),
    "each-sdelay1": ("sdelay1", 0, True),
    "row7": ("get", 1, False),
    "row7x2": ("get", 2, False),
}


def send(case, count, first, each_its_own):
    sock = None
    if first:
        sock = extra.connect()
        for _ in range(first):
            extra.ask(sock, "sdelay1")
    for _ in range(count):
        if sock is None:
            sock = extra.connect()
        extra.ask(sock, case)
        if each_its_own:
            sock.close()
            sock = None
    if sock is not None:
        sock.close()


def own(path):
    """Each function's own cost in a callgrind out file."""
    names, cost, current, skip = {}, collections.Counter(), None, False
    with open(path, errors="replace") as lines:
        for line in lines:
            if line.startswith("fn="):
                number, name = re.match(r"fn=\((\d+)\)(?: (.*))?", line).groups()
                if name:
                    names[number] = name.strip()
                current = names[number]
            elif line.startswith("cfn="):
                number, name = re.match(r"cfn=\((\d+)\)(?: (.*))?", line).groups()
                if name:
                    names[number] = name.strip()
            elif line.startswith("calls="):
                skip = True
            elif line[0] in "0123456789+-*":
                if skip:
                    skip = False
                    continue
                cost[current] += int(line.split()[1])
    return cost


def funcs(server, scenario, out):
    case, first, each_its_own = SCENARIOS[scenario]
    costs = []
    for count in (240, 1240):
        process = count2.start(server, "/tmp/attr.callgrind")
        send(case, count, first, each_its_own)
        total = count2.stop(process)
        costs.append((total, own("/tmp/attr.callgrind")))
    (few_total, few), (many_total, many) = costs
    with open(out, "w") as file:
        file.write(f"{(many_total - few_total) / 1000:.1f}\tTOTAL\n")
        for name in sorted(set(few) | set(many), key=lambda name: few[name] - many[name]):
            each = (many[name] - few[name]) / 1000
            if each:
                file.write(f"{each:.1f}\t{name}\n")
    print(f"{scenario}: {(many_total - few_total) / 1000:.0f} a request, in {out}", flush=True)


def read(path):
    table = {}
    with open(path) as file:
        for line in file:
            each, name = line.rstrip("\n").split("\t", 1)
            table[name] = float(each)
    return table


def diff(one, other, least):
    a, b = read(one), read(other)
    rows = [(b.get(name, 0.0) - a.get(name, 0.0), a.get(name, 0.0), b.get(name, 0.0), name) for name in set(a) | set(b)]
    for change, was, now, name in sorted(rows, key=lambda row: -abs(row[0])):
        if abs(change) >= least:
            print(f"{change:>+9.1f} {was:>9.1f} {now:>9.1f}  {name[:150]}")


def count(server, first, reps):
    print(f"{'case':<14}{'median':>10}{'least':>10}{'most':>10}  runs", flush=True)
    each = []
    for _ in range(reps):
        counts = []
        for requests in (240, 1240):
            process = count2.start(server, "/tmp/attr.callgrind")
            send("get", requests, first, False)
            counts.append(count2.stop(process))
        each.append((counts[1] - counts[0]) / 1000)
    ordered = sorted(each)
    runs = " ".join(f"{one:.0f}" for one in each)
    print(f"{'row7x' + str(first):<14}{extra.median(each):>10.0f}{ordered[0]:>10.0f}{ordered[-1]:>10.0f}  {runs}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("what", choices=["count", "funcs", "diff"])
    parser.add_argument("args", nargs="+")
    parser.add_argument("--first", type=int, default=2)
    parser.add_argument("--reps", type=int, default=3)
    parser.add_argument("--least", type=float, default=3.0)
    args = parser.parse_args()
    if args.what == "count":
        count(args.args[0], args.first, args.reps)
    elif args.what == "funcs":
        funcs(*args.args)
    else:
        diff(args.args[0], args.args[1], args.least)


if __name__ == "__main__":
    sys.exit(main())
