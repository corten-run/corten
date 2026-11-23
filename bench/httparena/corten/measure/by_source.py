#!/usr/bin/env python3
"""Where a profile's instructions are, by the source function that wrote them.

    python3 measure/by_source.py <profile> [<other profile>] [--top 40] [--crates]
    python3 measure/by_source.py <profile> --within 'compress::finish'

The profile is `count.py --profile`'s (callgrind, 1,000 requests, built with line tables:
`CARGO_PROFILE_RELEASE_DEBUG=line-tables-only`). A release build inlines most of a request into
a few symbols, so the cost is read by source line, which callgrind keeps for inlined code, and
each line is given to the `fn` written above it in its file. With two profiles, the difference
(first minus second), largest first. Numbers are instructions a request.
"""

import argparse
import collections
import functools
import os
import re

FN = re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+\"[^\"]*\"\s+)?fn\s+(\w+)")


@functools.lru_cache(maxsize=None)
def functions(path):
    """The line each `fn` of a file starts at, in order."""
    try:
        with open(path, encoding="utf-8", errors="replace") as source:
            return [(number, found.group(1)) for number, line in enumerate(source, 1) if (found := FN.match(line))]
    except OSError:
        return None


def enclosing(path, line):
    starts = functions(path)
    if starts is None:
        return None
    name = "(top)"
    for at, each in starts:
        if at > line:
            break
        name = each
    return name


def short(path):
    """A crate and a file, from where the build read the source."""
    found = re.search(r"/registry/src/[^/]+/([^/]+)/(.*)", path)
    if found:
        return re.sub(r"-\d+\.\d+\.\d+.*$", "", found.group(1)), found.group(2)
    found = re.search(r"/rustc/[0-9a-f]+/library/([^/]+)/(.*)", path)
    if found:
        return found.group(1), found.group(2)
    found = re.search(r"/crates/([^/]+)/(.*)", path)
    if found:
        return found.group(1), found.group(2)
    found = re.search(r"/bench/httparena/corten/(.*)", path)
    if found:
        return "app", found.group(1)
    return None, path


def read(profile, within=None):
    """Self cost by (crate, file, function); with `within`, only in the symbols whose name has
    that text, and what each of them calls, with all it runs (`->`)."""
    costs = collections.Counter()
    lines = collections.Counter()
    file = symbol = obj = callee = None
    held = None
    with open(profile, encoding="utf-8", errors="replace") as text:
        for line in text:
            if line.startswith("fl="):
                file = held = line[3:].strip()
            elif line.startswith(("fi=", "fe=")):
                file = line[3:].strip()
            elif line.startswith("fn="):
                symbol = line[3:].strip()
                file = held
            elif line.startswith("ob="):
                obj = os.path.basename(line[3:].strip())
            elif line.startswith("cfn="):
                callee = line[4:].strip()
            elif line.startswith("calls="):
                pass
            elif line[:1].isdigit():
                if within is not None and within not in (symbol or ""):
                    callee = None
                    continue
                at, cost = line.split()[:2]
                if callee is not None:
                    if within is not None:
                        costs[("->", "", plain(callee))] += int(cost)
                    callee = None
                    continue
                lines[(file, int(at), symbol, obj)] += int(cost)
    for (file, at, symbol, obj), cost in lines.items():
        crate, name = short(file)
        function = enclosing(file, at) if crate else None
        if crate is None or function is None:
            if crate is None:
                # No line tables: a C library, by its symbol.
                crate, name = obj or "?", ""
            function = plain(symbol or "?") if not name else "(source not here)"
        costs[(crate, name, function)] += cost
    return costs


def plain(symbol):
    return re.sub(r"::h[0-9a-f]{16}$", "", symbol)[:150]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("profile")
    parser.add_argument("other", nargs="?")
    parser.add_argument("--top", type=int, default=40)
    parser.add_argument("--crates", action="store_true", help="totals by crate")
    parser.add_argument("--requests", type=int, default=1000)
    parser.add_argument("--within", help="only the symbols whose name has this text, and their calls")
    args = parser.parse_args()
    costs = read(args.profile, args.within)
    if args.other:
        other = read(args.other, args.within)
        costs = collections.Counter({key: costs[key] - other[key] for key in set(costs) | set(other)})
    if args.crates:
        by_crate = collections.Counter()
        for (crate, _, _), cost in costs.items():
            by_crate[crate] += cost
        costs = collections.Counter({(crate, "", ""): cost for crate, cost in by_crate.items()})
    total = sum(cost for (crate, _, _), cost in costs.items() if crate != "->")
    print(f"{total / args.requests:>9.0f}  total" + (" of its own (calls, `->`, not counted)" if args.within else ""))
    ordered = sorted(costs.items(), key=lambda item: -abs(item[1]))
    for (crate, name, function), cost in ordered[: args.top]:
        if round(cost / args.requests) == 0:
            continue
        where = f"{crate} {name}".strip()
        print(f"{cost / args.requests:>9.0f}  {where}  {function}")
    rest = sum(cost for (crate, _, _), cost in ordered[args.top :] if crate != "->")
    print(f"{rest / args.requests:>9.0f}  (the rest)")


if __name__ == "__main__":
    main()
