#!/usr/bin/env python3
"""Instructions a request costs the server, counted by callgrind over keep-alive HTTP/1.1.

Run in a Linux container with valgrind, python3 and (for the default allocator setting)
libjemalloc2:

    python3 measure/count.py <server binary> [--reps 3] [--cases get,post,...] [--depth 16]
    python3 measure/count.py <server binary> --profile get --out /tmp/get.callgrind
    python3 measure/count.py <server binary> --dump /tmp/answers

A count is two runs of the server under callgrind, one answering 240 requests and one 1,240, on
one connection, each request sent after the answer before it (or `--depth` at a time, pipelined):
the difference over 1,000 leaves out startup. `--profile` records one run's 1,000 requests after
240 uncounted ones, for `by_source.py`. `--dump` writes each case's answer, as sent, to a file,
with its `Date` and `ETag` masked, to compare two builds' bytes.
"""

import argparse
import os
import re
import signal
import socket
import subprocess
import sys
import time

BROWSER = (
    b"User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0\r\n"
    b"Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\n"
    b"Accept-Language: en-US,en;q=0.5\r\n"
    b"Accept-Encoding: gzip, deflate, br, zstd\r\n"
    b"Sec-Fetch-Dest: document\r\n"
    b"Sec-Fetch-Mode: navigate\r\n"
    b"Sec-Fetch-Site: none\r\n"
)
API, PAGES = 8080, 8082


def get(port, path, more=b""):
    return port, b"GET " + path + b" HTTP/1.1\r\nHost: localhost:" + str(port).encode() + b"\r\n" + more + b"\r\n"


POST = (
    b"POST /baseline11?a=1&b=2 HTTP/1.1\r\nHost: localhost:8080\r\n"
    b"Content-Type: text/plain\r\nContent-Length: 2\r\n\r\n20"
)

# Each case's port and request.
CASES = {
    # The staged route, in an API: typed query parameters in, a short String out.
    "get": get(API, b"/baseline11?a=1&b=2"),
    "post": (API, POST),
    # The same GET from a route that says `unstaged`, and the HttpArena entry's unstaged route.
    "unstaged": get(API, b"/unstaged11?a=1&b=2"),
    "pipeline": get(API, b"/pipeline"),
    # In an app without an API: a short text answer, and a page of about 12 KB.
    "text": get(PAGES, b"/text"),
    "page": get(PAGES, b"/page"),
    # The same with the headers a browser sends: the page is compressed, the short ones are not.
    "get-browser": get(API, b"/baseline11?a=1&b=2", BROWSER),
    "text-browser": get(PAGES, b"/text", BROWSER),
    "page-browser": get(PAGES, b"/page", BROWSER),
}


def read_answer(sock, buffered):
    """One response off the socket: its bytes, and what was read past it."""
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


def send(case, count, first=None, depth=1):
    """`count` requests on one connection, `depth` at a time, each batch after the answers to the
    one before it."""
    port, request = CASES[case]
    sock = socket.create_connection(("127.0.0.1", port))
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    buffered = b""
    answer = None
    for _ in range(count // depth):
        sock.sendall(request * depth)
        for _ in range(depth):
            got, buffered = read_answer(sock, buffered)
            if not got.startswith(b"HTTP/1.1 200"):
                raise SystemExit(case + " was answered:\n" + got[:400].decode("latin-1"))
            # The date changes, and a tag is made with a key of the process's own.
            masked = re.sub(rb"(?im)^(date|etag): [^\r]*", lambda found: found.group(1) + b": " + b"-" * 8, got)
            # A compressed body may differ between answers; an answer's length does not.
            if answer is None:
                answer = masked
            elif len(masked) != len(answer):
                raise SystemExit(case + ": an answer of another length than the first")
    sock.close()
    if first is not None:
        with open(first, "wb") as out:
            out.write(answer)
    return answer


def start(server, out, extra, allocator):
    env = dict(os.environ)
    if allocator == "jemalloc":
        env["LD_PRELOAD"] = "libjemalloc.so.2"
        env["MALLOC_CONF"] = "background_thread:false,tcache_max:65536"
    command = ["taskset", "-c", "0", "valgrind", "--tool=callgrind", "--callgrind-out-file=" + out] + extra + [server]
    process = subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(600):
        try:
            socket.create_connection(("127.0.0.1", PAGES), timeout=0.2).close()
            socket.create_connection(("127.0.0.1", API), timeout=0.2).close()
            return process
        except OSError:
            if process.poll() is not None:
                raise SystemExit("the server stopped:\n" + process.stderr.read().decode())
            time.sleep(0.1)
    process.kill()
    raise SystemExit("the server did not listen on 8080 and 8082")


def stop(process):
    process.send_signal(signal.SIGTERM)
    try:
        err = process.communicate(timeout=60)[1].decode()
    except subprocess.TimeoutExpired:
        process.kill()
        raise SystemExit("the server did not stop")
    collected = re.search(r"Collected : (\d+)", err)
    if collected is None:
        raise SystemExit("no count in callgrind's output:\n" + err)
    return int(collected.group(1))


def run(server, case, count, allocator, depth, out="/tmp/count.callgrind"):
    process = start(server, out, [], allocator)
    # The probes that waited for the listeners are the same connections in both runs.
    send(case, count, depth=depth)
    return stop(process)


def profile(server, case, out, allocator, depth):
    process = start(server, out, ["--instr-atstart=no", "--compress-strings=no", "--compress-pos=no"], allocator)
    send(case, 240, depth=depth)
    subprocess.run(["callgrind_control", "-i", "on", str(process.pid)], check=True, stdout=subprocess.DEVNULL)
    send(case, 1000, depth=depth)
    subprocess.run(["callgrind_control", "-i", "off", str(process.pid)], check=True, stdout=subprocess.DEVNULL)
    return stop(process)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("server")
    parser.add_argument("--reps", type=int, default=3)
    parser.add_argument("--cases", default=",".join(CASES))
    parser.add_argument("--allocator", default="jemalloc", choices=["jemalloc", "system"])
    parser.add_argument("--depth", type=int, default=1, help="requests sent at a time; a divisor of 1,000 and 240")
    parser.add_argument("--profile")
    parser.add_argument("--out", default="/tmp/profile.callgrind")
    parser.add_argument("--dump")
    args = parser.parse_args()
    if args.profile:
        total = profile(args.server, args.profile, args.out, args.allocator, args.depth)
        print(f"{args.profile}: {total / 1000:.0f} instructions a request over 1,000, in {args.out}")
        return
    cases = args.cases.split(",")
    if args.dump:
        os.makedirs(args.dump, exist_ok=True)
        process = start(args.server, "/tmp/dump.callgrind", [], args.allocator)
        for case in cases:
            send(case, 3, os.path.join(args.dump, case + ".http"))
        stop(process)
        return
    print(f"{'case':<14}{'median':>10}{'least':>10}{'most':>10}  runs")
    for case in cases:
        each = []
        for _ in range(args.reps):
            few = run(args.server, case, 240, args.allocator, args.depth)
            many = run(args.server, case, 1240, args.allocator, args.depth)
            each.append((many - few) / 1000)
        ordered = sorted(each)
        median = ordered[len(ordered) // 2]
        runs = " ".join(f"{one:.0f}" for one in each)
        print(f"{case:<14}{median:>10.0f}{ordered[0]:>10.0f}{ordered[-1]:>10.0f}  {runs}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
