#!/usr/bin/env python3
"""Instructions, allocations and parks a request costs the server, counted by callgrind over
HTTP/1.1.

count6.py of the tag evidence/deadline-timer-3 (deadline-timer-3/rows/count6.py) with these
additions:

  --other-count N  before the counted connection opens, another connection sends N requests of
                   the --other case (sdelay1 unless given) and then stays open, idle, until the
                   count ends
  --pause-ms P     after the requests of --first or of --other, the client waits P ms before the
                   counted requests (to let a timer's time pass)
  --alternate C    on a kept-alive connection the requests alternate, the counted case then C
  --conns N        N connections in a closed loop (each sends its next request when its answer
                   has come), each sending its --first requests and then the counted ones; the
                   count is over all their requests
  --cpu N          the CPU the server is pinned to (0 unless given)
  --keep DIR       callgrind's output files of the last count of each case are kept there
  parks            calls to epoll_wait a request, read from callgrind's output file

    ARENA_MODE=default python3 count7.py <server binary> [--reps 3] [--cases get,sdelay1] ...

A count is two runs of the server under callgrind, one answering 240 requests and one 1,240 (with
--conns N, the nearest whole numbers a connection), each request sent after the answer before it:
the difference over the requests between leaves out startup and the connection's first requests.
"""

import argparse
import os
import re
import selectors
import shutil
import signal
import socket
import subprocess
import sys
import time

PORT = 8080
ALLOCATES = {"malloc", "calloc", "realloc", "posix_memalign", "aligned_alloc", "memalign"}
FREES = {"free"}
PARKS = {"epoll_wait", "epoll_pwait", "epoll_pwait2"}


def get(path):
    return b"GET " + path + b" HTTP/1.1\r\nHost: localhost:8080\r\n\r\n"


CASES = {
    "get": get(b"/baseline11?a=1&b=2"),
    "sdelay0": get(b"/sdelay/0"),
    "sdelay1": get(b"/sdelay/1"),
    "sdelay150": get(b"/sdelay/150"),
    "sdelay2500": get(b"/sdelay/2500"),
    "delay1": get(b"/delay/1"),
    "pipeline": get(b"/pipeline"),
}


def parse(data):
    """One whole answer off the front of `data` and the rest, or None while it is not all there."""
    if b"\r\n\r\n" not in data:
        return None
    head, rest = data.split(b"\r\n\r\n", 1)
    length = re.search(rb"(?im)^content-length:\s*(\d+)", head)
    if length is None:
        raise SystemExit("an answer without Content-Length:\n" + head.decode("latin-1"))
    length = int(length.group(1))
    if len(rest) < length:
        return None
    return head + b"\r\n\r\n" + rest[:length], rest[length:]


def read_answer(sock):
    data = b""
    while True:
        found = parse(data)
        if found is not None:
            return found[0]
        chunk = sock.recv(65536)
        if not chunk:
            raise SystemExit("the server closed the connection")
        data += chunk


def connect():
    sock = socket.create_connection(("127.0.0.1", PORT))
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    return sock


def ask(sock, name):
    sock.sendall(CASES[name])
    got = read_answer(sock)
    if not got.startswith(b"HTTP/1.1 200"):
        raise SystemExit(name + " was answered:\n" + got[:400].decode("latin-1"))


def send(args, case, count):
    """`count` requests of one connection, each after the answer before it; or each on a
    connection of its own."""
    other = None
    if args.other_count:
        other = connect()
        for _ in range(args.other_count):
            ask(other, args.other)
        if args.pause_ms:
            time.sleep(args.pause_ms / 1000)
    sock = None
    for sent in range(count):
        name = case
        if args.first is not None and sent < args.first_count:
            name = args.first
        elif args.alternate is not None and sent % 2 == 1:
            name = args.alternate
        if sock is None:
            sock = connect()
        ask(sock, name)
        if args.first is not None and sent + 1 == args.first_count and args.pause_ms:
            time.sleep(args.pause_ms / 1000)
        if args.gap_ms:
            time.sleep(args.gap_ms / 1000)
        if args.each_its_own:
            sock.close()
            sock = None
            if args.settle_ms:
                time.sleep(args.settle_ms / 1000)
    if sock is not None:
        sock.close()
    if other is not None:
        other.close()


def closed_loop(args, case, each):
    """`args.conns` connections, each sending `each` requests, the next when its answer has come.
    Each connection's first requests are the --first case, sent before any counted request of any
    connection."""
    first = args.first_count if args.first is not None else 0
    socks = [connect() for _ in range(args.conns)]
    for sock in socks:
        for _ in range(first):
            ask(sock, args.first)
    if first and args.pause_ms:
        time.sleep(args.pause_ms / 1000)
    selector = selectors.DefaultSelector()
    states = []
    for sock in socks:
        state = {"sock": sock, "sent": first, "data": b""}
        states.append(state)
        selector.register(sock, selectors.EVENT_READ, state)
    for state in states:
        if state["sent"] < each:
            state["sock"].sendall(CASES[case])
            state["sent"] += 1
    waiting = sum(1 for state in states if state["sent"] > first)
    while waiting:
        ready = selector.select(timeout=120)
        if not ready:
            raise SystemExit("no answer in 120 s")
        for key, _ in ready:
            state = key.data
            chunk = state["sock"].recv(65536)
            if not chunk:
                raise SystemExit("the server closed a connection")
            state["data"] += chunk
            found = parse(state["data"])
            if found is None:
                continue
            answer, state["data"] = found
            if not answer.startswith(b"HTTP/1.1 200"):
                raise SystemExit(case + " was answered:\n" + answer[:400].decode("latin-1"))
            if state["sent"] < each:
                state["sock"].sendall(CASES[case])
                state["sent"] += 1
            else:
                waiting -= 1
    for sock in socks:
        selector.unregister(sock)
        sock.close()


def start(args, out):
    env = dict(os.environ)
    env["LD_PRELOAD"] = "libjemalloc.so.2"
    env["MALLOC_CONF"] = "background_thread:false,tcache_max:65536"
    command = ["taskset", "-c", str(args.cpu), "valgrind", "--tool=callgrind", "--callgrind-out-file=" + out, args.server]
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
    """Calls to each function, summed over callgrind's calls= lines by callee."""
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


def stop(process, out):
    process.send_signal(signal.SIGTERM)
    try:
        err = process.communicate(timeout=120)[1].decode()
    except subprocess.TimeoutExpired:
        process.kill()
        raise SystemExit("the server did not stop")
    collected = re.search(r"Collected : (\d+)", err)
    if collected is None:
        raise SystemExit("no count in callgrind's output:\n" + err)
    totals = calls(out)
    allocated = sum(n for name, n in totals.items() if name in ALLOCATES)
    parked = sum(n for name, n in totals.items() if name in PARKS)
    return int(collected.group(1)), allocated, parked


def run(args, case, count, out):
    process = start(args, out)
    if args.conns:
        closed_loop(args, case, count)
    else:
        send(args, case, count)
    return stop(process, out)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("server")
    parser.add_argument("--reps", type=int, default=3)
    parser.add_argument("--cases", default="get")
    parser.add_argument("--each-its-own", action="store_true")
    parser.add_argument("--settle-ms", type=float, default=0.0)
    parser.add_argument("--first", default=None)
    parser.add_argument("--first-count", type=int, default=1)
    parser.add_argument("--other", default="sdelay1")
    parser.add_argument("--other-count", type=int, default=0)
    parser.add_argument("--pause-ms", type=float, default=0.0)
    parser.add_argument("--alternate", default=None)
    parser.add_argument("--conns", type=int, default=0)
    parser.add_argument("--cpu", type=int, default=0)
    parser.add_argument("--keep", default=None)
    parser.add_argument("--label", default="")
    parser.add_argument("--gap-ms", type=float, default=0.0, help="the client waits this long after each answer")
    parser.add_argument("--few", type=int, default=240)
    parser.add_argument("--many", type=int, default=1240)
    args = parser.parse_args()
    if args.first is not None and args.each_its_own:
        raise SystemExit("--first is for a kept-alive connection")
    out = f"/tmp/count-{args.cpu}.callgrind"
    if args.conns:
        first = args.first_count if args.first is not None else 0
        few, many = first + max(1, 240 // args.conns), first + max(1, 240 // args.conns) + -(-1000 // args.conns)
        between = (many - few) * args.conns
    else:
        few, many, between = args.few, args.many, args.many - args.few
    print(f"{'case':<14}{'median':>10}{'least':>10}{'most':>10}  runs | allocations a request: median, runs | parks a request: runs", flush=True)
    for case in args.cases.split(","):
        each, allocs, parks = [], [], []
        for rep in range(args.reps):
            a = run(args, case, few, out + ".few")
            b = run(args, case, many, out + ".many")
            each.append((b[0] - a[0]) / between)
            allocs.append((b[1] - a[1]) / between)
            parks.append((b[2] - a[2]) / between)
            if args.keep and rep == args.reps - 1:
                os.makedirs(args.keep, exist_ok=True)
                shutil.copy(out + ".few", os.path.join(args.keep, f"{args.label}{case}.few"))
                shutil.copy(out + ".many", os.path.join(args.keep, f"{args.label}{case}.many"))
        ordered = sorted(each)
        median = ordered[len(ordered) // 2]
        runs = " ".join(f"{one:.0f}" for one in each)
        amedian = sorted(allocs)[len(allocs) // 2]
        print(f"{case:<14}{median:>10.0f}{ordered[0]:>10.0f}{ordered[-1]:>10.0f}  {runs} | {amedian:.3f}, {' '.join(f'{one:.3f}' for one in allocs)} | {' '.join(f'{one:.3f}' for one in parks)}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
