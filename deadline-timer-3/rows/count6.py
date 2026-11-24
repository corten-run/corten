#!/usr/bin/env python3
"""Instructions and allocations a request costs the server, counted by callgrind over HTTP/1.1.

count4.py of the tag evidence/deadline-timer (deadline-timer/kit/build/count4.py) with three
additions:

  --first <case>   on a kept-alive connection, the connection's first request is that case and
                   every later one is the counted case (a connection whose first request waits
                   and whose later requests do not)
  --first-count N  with --first: the connection's first N requests are that case (2: a
                   connection two of whose requests have waited, which has made its timer)
  allocations      calls to the allocator's entry points, read from callgrind's output file
                   (the calls= lines whose callee is malloc, calloc, realloc, posix_memalign,
                   aligned_alloc or memalign), counted as instructions are

    ARENA_MODE=default python3 count6.py <server binary> [--reps 3] [--cases get,sdelay1]
        [--each-its-own [--settle-ms 10]] [--first sdelay1 [--first-count 2]]

A count is two runs of the server under callgrind, one answering 240 requests and one 1,240, each
request sent after the answer before it: the difference over 1,000 leaves out startup and the
connection's first requests.
"""

import argparse
import os
import re
import signal
import socket
import subprocess
import sys
import time

PORT = 8080
OUT = "/tmp/count.callgrind"
ALLOCATES = {"malloc", "calloc", "realloc", "posix_memalign", "aligned_alloc", "memalign"}
FREES = {"free"}


def get(path):
    return b"GET " + path + b" HTTP/1.1\r\nHost: localhost:8080\r\n\r\n"


CASES = {
    # Staged, does not wait: typed query parameters in, a short String out.
    "get": get(b"/baseline11?a=1&b=2"),
    # Staged, the route of the handler that sleeps, asked to sleep 0 ms: it does not wait.
    "sdelay0": get(b"/sdelay/0"),
    # Staged, sleeps 1 ms: the deadline's timer is in use.
    "sdelay1": get(b"/sdelay/1"),
    # Unstaged (no deadline), sleeps 1 ms; and unstaged, does not wait.
    "delay1": get(b"/delay/1"),
    "pipeline": get(b"/pipeline"),
}


def read_answer(sock, buffered):
    data = buffered
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(65536)
        if not chunk:
            raise SystemExit("the server closed the connection")
        data += chunk
    head, rest = data.split(b"\r\n\r\n", 1)
    length = re.search(rb"(?im)^content-length:\s*(\d+)", head)
    if length is None:
        raise SystemExit("an answer without Content-Length:\n" + head.decode("latin-1"))
    length = int(length.group(1))
    while len(rest) < length:
        chunk = sock.recv(65536)
        if not chunk:
            raise SystemExit("the server closed the connection")
        rest += chunk
    return head + b"\r\n\r\n" + rest[:length], rest[length:]


def send(case, count, each_its_own=False, settle=0.0, first=None, first_count=1):
    """`count` requests, each after the answer before it: on one connection, or each on its own,
    and then `settle` seconds after a connection is closed before the next is opened, so the
    server has finished with one before it takes the next. With `first`, the connection's first
    `first_count` requests are that case, of the `count`."""
    sock = None
    for sent in range(count):
        request = CASES[first] if first is not None and sent < first_count else CASES[case]
        if sock is None:
            sock = socket.create_connection(("127.0.0.1", PORT))
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        sock.sendall(request)
        got, _ = read_answer(sock, b"")
        if not got.startswith(b"HTTP/1.1 200"):
            raise SystemExit(case + " was answered:\n" + got[:400].decode("latin-1"))
        if each_its_own:
            sock.close()
            sock = None
            if settle:
                time.sleep(settle)
    if sock is not None:
        sock.close()


def start(server, out):
    env = dict(os.environ)
    env["LD_PRELOAD"] = "libjemalloc.so.2"
    env["MALLOC_CONF"] = "background_thread:false,tcache_max:65536"
    command = ["taskset", "-c", "0", "valgrind", "--tool=callgrind", "--callgrind-out-file=" + out, server]
    process = subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(600):
        try:
            socket.create_connection(("127.0.0.1", PORT), timeout=0.2).close()
            return process
        except OSError:
            if process.poll() is not None:
                raise SystemExit("the server stopped:\n" + process.stderr.read().decode())
            time.sleep(0.1)
    process.kill()
    raise SystemExit("the server did not listen on 8080")


def calls(path):
    """Calls to each allocator entry point, summed over callgrind's calls= lines by callee."""
    names = {}
    totals = {}
    callee = None
    with open(path, errors="replace") as lines:
        for line in lines:
            if line.startswith("cfn=") or line.startswith("fn="):
                found = re.match(r"c?fn=\((\d+)\)(?: (.*))?$", line.rstrip("\n"))
                if found is None:
                    continue
                if found.group(2):
                    names[found.group(1)] = found.group(2)
                if line.startswith("cfn="):
                    callee = names.get(found.group(1))
            elif line.startswith("calls=") and callee is not None:
                totals[callee] = totals.get(callee, 0) + int(line[6:].split()[0])
                callee = None
    return totals


def stop(process):
    process.send_signal(signal.SIGTERM)
    try:
        err = process.communicate(timeout=120)[1].decode()
    except subprocess.TimeoutExpired:
        process.kill()
        raise SystemExit("the server did not stop")
    collected = re.search(r"Collected : (\d+)", err)
    if collected is None:
        raise SystemExit("no count in callgrind's output:\n" + err)
    totals = calls(OUT)
    allocated = sum(n for name, n in totals.items() if name in ALLOCATES)
    freed = sum(n for name, n in totals.items() if name in FREES)
    return int(collected.group(1)), allocated, freed, totals


def run(server, case, count, each_its_own, settle, first, first_count):
    process = start(server, OUT)
    send(case, count, each_its_own, settle, first, first_count)
    return stop(process)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("server")
    parser.add_argument("--reps", type=int, default=3)
    parser.add_argument("--cases", default=",".join(CASES))
    parser.add_argument("--each-its-own", action="store_true", help="a connection for each request")
    parser.add_argument("--settle-ms", type=float, default=0.0, help="with --each-its-own: wait after each close")
    parser.add_argument("--first", default=None, help="kept-alive: the connection's first request is this case")
    parser.add_argument("--first-count", type=int, default=1, help="with --first: how many first requests are that case")
    parser.add_argument("--names", action="store_true", help="print every callee whose name has alloc or free in it, once")
    args = parser.parse_args()
    if args.first is not None and args.each_its_own:
        raise SystemExit("--first is for a kept-alive connection")
    print(f"{'case':<14}{'median':>10}{'least':>10}{'most':>10}  runs | allocations a request: median, runs | frees: runs", flush=True)
    shown = False
    for case in args.cases.split(","):
        each, allocs, frees = [], [], []
        for _ in range(args.reps):
            few = run(args.server, case, 240, args.each_its_own, args.settle_ms / 1000, args.first, args.first_count)
            many = run(args.server, case, 1240, args.each_its_own, args.settle_ms / 1000, args.first, args.first_count)
            each.append((many[0] - few[0]) / 1000)
            allocs.append((many[1] - few[1]) / 1000)
            frees.append((many[2] - few[2]) / 1000)
            if args.names and not shown:
                shown = True
                seen = {name: (many[3].get(name, 0) - few[3].get(name, 0)) / 1000 for name in many[3] if "alloc" in name or "free" in name}
                print("  callees with alloc or free in the name, calls a request: " + ", ".join(f"{name} {n:g}" for name, n in sorted(seen.items()) if n), flush=True)
        ordered = sorted(each)
        median = ordered[len(ordered) // 2]
        runs = " ".join(f"{one:.0f}" for one in each)
        amedian = sorted(allocs)[len(allocs) // 2]
        print(f"{case:<14}{median:>10.0f}{ordered[0]:>10.0f}{ordered[-1]:>10.0f}  {runs} | {amedian:.3f}, {' '.join(f'{one:.3f}' for one in allocs)} | {' '.join(f'{one:.3f}' for one in frees)}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
