#!/usr/bin/env python3
"""Calls a request to the functions whose name matches a pattern, by caller, and those functions'
own instructions a request, from callgrind's output files of a few-requests and a many-requests run.

    python3 callsof.py <requests between> <few> <many> <regex>
"""

import collections
import re
import sys


def read(path, pattern):
    names = {}
    calls = collections.Counter()
    own = collections.Counter()
    current = None
    callee = None
    after_call = False
    with open(path, errors="replace") as lines:
        for line in lines:
            if line.startswith("fn=") or line.startswith("cfn="):
                found = re.match(r"c?fn=\((\d+)\)(?: (.*))?$", line.rstrip("\n"))
                if found is None:
                    continue
                if found.group(2):
                    names[found.group(1)] = found.group(2)
                name = names.get(found.group(1), found.group(1))
                if line.startswith("fn="):
                    current = name
                else:
                    callee = name
            elif line.startswith("calls="):
                if callee is not None and pattern.search(callee):
                    calls[(current, callee)] += int(line[6:].split()[0])
                callee = None
                after_call = True
            elif line[:1].isdigit() or line[:1] in "+-*":
                if after_call:
                    after_call = False
                    continue
                parts = line.split()
                if len(parts) >= 2 and current is not None and pattern.search(current):
                    own[current] += int(parts[1])
    return calls, own


def short(name):
    name = re.sub(r"::h[0-9a-f]{16}$", "", name)
    return name[:170]


def main():
    between = float(sys.argv[1])
    pattern = re.compile(sys.argv[4])
    few_calls, few_own = read(sys.argv[2], pattern)
    many_calls, many_own = read(sys.argv[3], pattern)
    print("own instructions a request:")
    for name in sorted(set(few_own) | set(many_own)):
        print(f"  {(many_own[name] - few_own[name]) / between:>9.2f}  {short(name)}")
    print("calls a request (caller -> callee):")
    for key in sorted(set(few_calls) | set(many_calls), key=str):
        each = (many_calls[key] - few_calls[key]) / between
        print(f"  {each:>9.3f}  {short(str(key[0]))}\n             -> {short(key[1])}")


if __name__ == "__main__":
    main()
