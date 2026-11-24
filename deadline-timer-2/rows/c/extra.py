#!/usr/bin/env python3
"""Row 7, allocations and idle bytes, with count2.py's server, client and cases.

    ARENA_MODE=default python3 extra.py row7 <server binary> [--reps 3]
    ARENA_MODE=default python3 extra.py allocs <server binary> [--reps 3]
    ARENA_MODE=default python3 extra.py idle <server binary> [--reps 3]

row7: instructions under callgrind for a request that does not wait (`get`) on a kept-alive
connection whose first request waited (`sdelay1`): the difference of 1,240 and 240 such requests
over 1,000, as count2.py counts the others.

allocs: heap blocks and bytes DHAT counts (no jemalloc preload: valgrind's own malloc), the same
difference over 1,000, for rows 1, 2, 5, 6 and 7.

idle: bytes and blocks live at DHAT's global maximum with 600 connections open and idle less
the same with 100, over 500: each connection has been answered one request (`get`, `sdelay1`,
or `sdelay1` and then `get`) and is then left open until all are.
"""

import argparse
import os
import re
import signal
import socket
import subprocess
import sys
import time

import count2

PORT = count2.PORT


def connect():
    sock = socket.create_connection(("127.0.0.1", PORT))
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    return sock


def ask(sock, case):
    sock.sendall(count2.CASES[case])
    got, _ = count2.read_answer(sock, b"")
    if not got.startswith(b"HTTP/1.1 200"):
        raise SystemExit(case + " was answered:\n" + got[:400].decode("latin-1"))


def send(case, count, first=None, each_its_own=False):
    """`count` requests, each after the answer before it, on one connection (after one `first`
    request where given) or each on its own."""
    sock = None
    if first is not None:
        sock = connect()
        ask(sock, first)
    for _ in range(count):
        if sock is None:
            sock = connect()
        ask(sock, case)
        if each_its_own:
            sock.close()
            sock = None
    if sock is not None:
        sock.close()


def hold(cases, count):
    """`count` connections, each answered `cases` in turn and then left open until all are."""
    socks = []
    for _ in range(count):
        sock = connect()
        for case in cases:
            ask(sock, case)
        socks.append(sock)
    time.sleep(0.5)
    for sock in socks:
        sock.close()
    time.sleep(0.5)


def start_dhat(server):
    env = dict(os.environ)
    command = ["taskset", "-c", "0", "valgrind", "--tool=dhat", "--dhat-out-file=/tmp/extra.dhat", server]
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


def number(text):
    return int(text.replace(",", ""))


def stop_dhat(process):
    process.send_signal(signal.SIGTERM)
    try:
        err = process.communicate(timeout=300)[1].decode()
    except subprocess.TimeoutExpired:
        process.kill()
        raise SystemExit("the server did not stop")
    total = re.search(r"Total:\s+([\d,]+) bytes in ([\d,]+) blocks", err)
    most = re.search(r"At t-gmax:\s+([\d,]+) bytes in ([\d,]+) blocks", err)
    if total is None or most is None:
        raise SystemExit("no totals in dhat's output:\n" + err)
    return (number(total.group(1)), number(total.group(2)), number(most.group(1)), number(most.group(2)))


ROWS = {
    "1": ("get", None, False),
    "2": ("sdelay1", None, False),
    "5": ("get", None, True),
    "6": ("sdelay1", None, True),
    "7": ("get", "sdelay1", False),
}

IDLE = {
    "after-get": ["get"],
    "after-sdelay1": ["sdelay1"],
    "after-sdelay1-get": ["sdelay1", "get"],
}


def median(values):
    return sorted(values)[len(values) // 2]


def row7(server, reps):
    print(f"{'case':<14}{'median':>10}{'least':>10}{'most':>10}  runs", flush=True)
    each = []
    for _ in range(reps):
        counts = []
        for count in (240, 1240):
            process = count2.start(server, "/tmp/extra.callgrind")
            send("get", count, first="sdelay1")
            counts.append(count2.stop(process))
        each.append((counts[1] - counts[0]) / 1000)
    ordered = sorted(each)
    runs = " ".join(f"{one:.0f}" for one in each)
    print(f"{'row7':<14}{median(each):>10.0f}{ordered[0]:>10.0f}{ordered[-1]:>10.0f}  {runs}", flush=True)


def allocs(server, reps, rows):
    print(f"{'row':<6}{'blocks':>10}{'bytes':>12}  runs (blocks/bytes)", flush=True)
    for row in rows:
        case, first, each_its_own = ROWS[row]
        blocks, sizes = [], []
        for _ in range(reps):
            totals = []
            for count in (240, 1240):
                process = start_dhat(server)
                send(case, count, first=first, each_its_own=each_its_own)
                totals.append(stop_dhat(process))
            sizes.append((totals[1][0] - totals[0][0]) / 1000)
            blocks.append((totals[1][1] - totals[0][1]) / 1000)
        runs = " ".join(f"{b:.3f}/{s:.1f}" for b, s in zip(blocks, sizes))
        print(f"{row:<6}{median(blocks):>10.3f}{median(sizes):>12.1f}  {runs}", flush=True)


def idle(server, reps):
    print(f"{'state':<20}{'bytes':>10}{'blocks':>10}  runs (bytes/blocks)", flush=True)
    for name, cases in IDLE.items():
        sizes, blocks, took = [], [], 0.0
        for _ in range(reps):
            most = []
            for count in (100, 600):
                process = start_dhat(server)
                began = time.time()
                hold(cases, count)
                took = max(took, time.time() - began)
                most.append(stop_dhat(process))
            sizes.append((most[1][2] - most[0][2]) / 500)
            blocks.append((most[1][3] - most[0][3]) / 500)
        runs = " ".join(f"{s:.1f}/{b:.3f}" for s, b in zip(sizes, blocks))
        print(f"{name:<20}{median(sizes):>10.1f}{median(blocks):>10.3f}  {runs}  (longest hold {took:.1f} s)", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("what", choices=["row7", "allocs", "idle"])
    parser.add_argument("server")
    parser.add_argument("--reps", type=int, default=3)
    parser.add_argument("--rows", default="1,2,5,6,7")
    args = parser.parse_args()
    if args.what == "row7":
        row7(args.server, args.reps)
    elif args.what == "allocs":
        allocs(args.server, args.reps, args.rows.split(","))
    else:
        idle(args.server, args.reps)


if __name__ == "__main__":
    sys.exit(main())
