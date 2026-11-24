#!/usr/bin/env python3
"""Instructions a request costs card-market, counted by callgrind over keep-alive HTTP/1.1.

    python3 count.py <server binary> --port 4101 --cpu 1 [--reps 3] [--cases item,json]
    python3 count.py <server binary> --port 4101 --cpu 1 --dump <file>

A count is two runs of the server under callgrind, one answering 240 requests and one 1,240, on
one connection, each request sent after the answer before it: the difference over 1,000 leaves
out startup. The requests have the head curl sends, as the training script's do. `--dump` writes
what each case was answered with (status, coding, type and the least and most bytes of three
answers) to compare builds.
"""

import argparse
import os
import re
import signal
import socket
import subprocess
import time

ZSTD, BR = b"gzip, deflate, br, zstd", b"gzip, deflate, br"
# Each case's path, the Accept-Encoding it sends and the coding the answer must have.
CASES = {
    "item": (b"/items/item_5", None, None),
    "item-zstd": (b"/items/item_5", ZSTD, b"zstd"),
    "item-br": (b"/items/item_5", BR, b"br"),
    "home": (b"/", None, None),
    "home-zstd": (b"/", ZSTD, b"zstd"),
    "home-br": (b"/", BR, b"br"),
    "json": (b"/api/items/item_5", None, None),
}


def request(case, port):
    path, accepts, _ = CASES[case]
    head = b"GET " + path + b" HTTP/1.1\r\nHost: 127.0.0.1:" + str(port).encode() + b"\r\n"
    head += b"User-Agent: curl/8.14.1\r\nAccept: */*\r\n"
    if accepts:
        head += b"Accept-Encoding: " + accepts + b"\r\n"
    return head + b"\r\n"


def read_answer(sock, buffered):
    """One response off the socket: its head, its body, and what was read past it."""
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
    return head, rest[:length], rest[length:]


def header(head, name):
    found = re.search(rb"(?im)^" + name + rb":\s*([^\r]*)", head)
    return found.group(1) if found else None


def send(case, port, count):
    """`count` requests on one connection, each after the answer to the one before it. Every
    answer is a 200 in the case's coding; gives the first head and the least and most bytes."""
    sock = socket.create_connection(("127.0.0.1", port))
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    wanted = CASES[case][2]
    buffered, first, sizes = b"", None, []
    for _ in range(count):
        sock.sendall(request(case, port))
        head, body, buffered = read_answer(sock, buffered)
        if not head.startswith(b"HTTP/1.1 200"):
            raise SystemExit(case + " was answered:\n" + head[:400].decode("latin-1"))
        if header(head, b"content-encoding") != wanted:
            raise SystemExit(case + ": answered in another coding:\n" + head.decode("latin-1"))
        first = first or head
        sizes.append(len(body))
    sock.close()
    return first, min(sizes), max(sizes)


def start(server, port, cpu, out):
    env = dict(os.environ)
    env["PORT"] = str(port)
    env.pop("HOST", None)
    # The starter image's allocator and thread cache, without the background thread.
    env["LD_PRELOAD"] = "libjemalloc.so.2"
    env["MALLOC_CONF"] = "background_thread:false,tcache_max:524288"
    command = ["taskset", "-c", str(cpu), "valgrind", "--tool=callgrind", "--callgrind-out-file=" + out, server]
    process = subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(600):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            return process
        except OSError:
            if process.poll() is not None:
                raise SystemExit("the server stopped:\n" + process.stderr.read().decode())
            time.sleep(0.1)
    process.kill()
    raise SystemExit("the server did not listen")


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
    return int(collected.group(1))


def run(server, port, cpu, case, count):
    process = start(server, port, cpu, f"/tmp/count-{port}.callgrind")
    # The probe that waited for the listener is the same connection in both runs.
    send(case, port, count)
    return stop(process)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("server")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--cpu", type=int, required=True)
    parser.add_argument("--reps", type=int, default=3)
    parser.add_argument("--cases", default=",".join(CASES))
    parser.add_argument("--dump")
    args = parser.parse_args()
    cases = args.cases.split(",")
    if args.dump:
        process = start(args.server, args.port, args.cpu, f"/tmp/dump-{args.port}.callgrind")
        with open(args.dump, "w") as out:
            for case in cases:
                head, least, most = send(case, args.port, 3)
                coding = (header(head, b"content-encoding") or b"none").decode()
                kind = (header(head, b"content-type") or b"none").decode()
                out.write(f"{case}: 200, coding {coding}, {kind}, body {least} to {most} bytes\n")
        stop(process)
        return
    print(f"{'case':<12}{'median':>10}{'least':>10}{'most':>10}  runs", flush=True)
    for case in cases:
        each = []
        for _ in range(args.reps):
            few = run(args.server, args.port, args.cpu, case, 240)
            many = run(args.server, args.port, args.cpu, case, 1240)
            each.append((many - few) / 1000)
        ordered = sorted(each)
        runs = " ".join(f"{one:.0f}" for one in each)
        print(f"{case:<12}{ordered[len(ordered) // 2]:>10.0f}{ordered[0]:>10.0f}{ordered[-1]:>10.0f}  {runs}", flush=True)


if __name__ == "__main__":
    main()
