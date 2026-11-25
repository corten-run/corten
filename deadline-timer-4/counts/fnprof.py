#!/usr/bin/env python3
"""Instructions a request by function, from callgrind's output files of count7.py --keep, and the
difference between two builds.

    python3 fnprof.py <requests between> <a.few> <a.many> <b.few> <b.many> [least]

For each function: its own instructions (not its callees') in the many-requests run less the
few-requests run, over the requests between, for build a and for build b, and b less a. Functions
whose difference is under `least` (2 unless given) are summed in one line.
"""

import collections
import re
import sys


def own(path):
    """Each function's own instruction count."""
    names = {}
    totals = collections.Counter()
    current = None
    after_call = False
    with open(path, errors="replace") as lines:
        for line in lines:
            if line.startswith("fn="):
                found = re.match(r"fn=\((\d+)\)(?: (.*))?$", line.rstrip("\n"))
                if found.group(2):
                    names[found.group(1)] = found.group(2)
                current = names.get(found.group(1), found.group(1))
            elif line.startswith(("cfn=", "cfi=", "cfl=", "cob=")):
                found = re.match(r"cfn=\((\d+)\)(?: (.*))?$", line.rstrip("\n"))
                if found is not None and found.group(2):
                    names[found.group(1)] = found.group(2)
            elif line.startswith("calls="):
                after_call = True
            elif line[:1].isdigit() or line[:1] in "+-*":
                if after_call:
                    # The line after calls= is the callee's inclusive cost.
                    after_call = False
                    continue
                parts = line.split()
                if len(parts) >= 2 and current is not None:
                    totals[current] += int(parts[1])
    return totals


def short(name):
    name = re.sub(r"::h[0-9a-f]{16}$", "", name)
    # A long list of type arguments is cut; a type's own path is kept.
    name = re.sub(r"<([^<>]|<[^<>]*>){60,}>", "<..>", name)
    return name[:150]


def main():
    between = float(sys.argv[1])
    a_few, a_many, b_few, b_many = (own(path) for path in sys.argv[2:6])
    least = float(sys.argv[6]) if len(sys.argv) > 6 else 2.0
    rows = []
    for name in set(a_few) | set(a_many) | set(b_few) | set(b_many):
        a = (a_many[name] - a_few[name]) / between
        b = (b_many[name] - b_few[name]) / between
        rows.append((b - a, a, b, name))
    rows.sort(key=lambda row: -abs(row[0]))
    rest = 0.0
    print(f"{'b less a':>9}{'a':>9}{'b':>9}  function")
    for diff, a, b, name in rows:
        if abs(diff) >= least:
            print(f"{diff:>+9.1f}{a:>9.1f}{b:>9.1f}  {short(name)}")
        else:
            rest += diff
    print(f"{rest:>+9.1f}{'':>18}  (all others)")
    print(f"{sum(row[0] for row in rows):>+9.1f}{sum(row[1] for row in rows):>9.1f}{sum(row[2] for row in rows):>9.1f}  total")


if __name__ == "__main__":
    main()
