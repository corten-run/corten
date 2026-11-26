"""c60.py <cpu> <rounds> <binary>...: instructions a request of each scratch server (c60/), under
callgrind, over one persistent socket from a client outside callgrind that checks every status
and body: the run of 1,200 requests less the run of 200, over 1,000. The rounds alternate over the
binaries, every second round in reverse order. Prints each round's count, then median and range.
"""
import os
import re
import signal
import socket
import statistics
import subprocess
import sys
import time

cpu, rounds, binaries = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
PORT = 18651
ASK = b"GET / HTTP/1.1\r\nhost: localhost\r\n\r\n"


KEEP = int(os.environ.get("C60_CONNECTIONS", "1"))


def count(binary, requests):
    return many(binary, requests) if KEEP > 1 else one(binary, requests)


def many(binary, requests):
    """As one(), over KEEP persistent sockets asked in turn, all opened before the first request."""
    env = dict(os.environ, HOST="127.0.0.1", PORT=str(PORT))
    if os.environ.get("C60_JEMALLOC") == "1":
        env["LD_PRELOAD"] = "libjemalloc.so.2"
    command = ["taskset", "-c", cpu, "valgrind", "--tool=callgrind", "--callgrind-out-file=/dev/null", binary]
    server = subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    try:
        until = time.time() + 90
        socks = []
        while len(socks) < KEEP:
            try:
                sock = socket.create_connection(("127.0.0.1", PORT))
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                socks.append(sock)
            except OSError:
                if time.time() > until or server.poll() is not None:
                    sys.exit(f"c60.py: {binary} did not listen: {server.stderr.read()[-800:]}")
                time.sleep(0.1)
        for at in range(requests):
            sock = socks[at % KEEP]
            sock.sendall(ASK)
            held = b""
            while True:
                end = held.find(b"\r\n\r\n")
                if end >= 0:
                    head = held[:end]
                    length = int(re.search(rb"(?i)\r\ncontent-length: (\d+)", head).group(1))
                    if len(held) >= end + 4 + length:
                        break
                piece = sock.recv(65536)
                if not piece:
                    sys.exit(f"c60.py: {binary} closed the connection after {held[-200:]!r}")
                held += piece
            if not head.startswith(b"HTTP/1.1 200") or held[end + 4:] != b"served":
                sys.exit(f"c60.py: {binary} answered {held[:300]!r}")
        for sock in socks:
            sock.close()
        time.sleep(0.5)
    finally:
        server.send_signal(signal.SIGTERM)
    err = server.communicate(timeout=180)[1]
    found = re.search(r"Collected : (\d+)", err)
    if not found:
        sys.exit(f"c60.py: no count from {binary}: {err[-800:]}")
    return int(found.group(1))


def one(binary, requests):
    env = dict(os.environ, HOST="127.0.0.1", PORT=str(PORT))
    if os.environ.get("C60_JEMALLOC") == "1":
        env["LD_PRELOAD"] = "libjemalloc.so.2"
    command = ["taskset", "-c", cpu, "valgrind", "--tool=callgrind", "--callgrind-out-file=/dev/null", binary]
    server = subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    try:
        until = time.time() + 90
        while True:
            try:
                sock = socket.create_connection(("127.0.0.1", PORT))
                break
            except OSError:
                if time.time() > until or server.poll() is not None:
                    sys.exit(f"c60.py: {binary} did not listen: {server.stderr.read()[-800:]}")
                time.sleep(0.1)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        held = b""
        for _ in range(requests):
            sock.sendall(ASK)
            while True:
                end = held.find(b"\r\n\r\n")
                if end >= 0:
                    head = held[:end]
                    length = int(re.search(rb"(?i)\r\ncontent-length: (\d+)", head).group(1))
                    if len(held) >= end + 4 + length:
                        break
                piece = sock.recv(65536)
                if not piece:
                    sys.exit(f"c60.py: {binary} closed the connection after {held[-200:]!r}")
                held += piece
            body = held[end + 4:end + 4 + length]
            if not head.startswith(b"HTTP/1.1 200") or body != b"served":
                sys.exit(f"c60.py: {binary} answered {head[:200]!r} {body[:80]!r}")
            held = held[end + 4 + length:]
        sock.close()
        time.sleep(0.5)
    finally:
        server.send_signal(signal.SIGTERM)
    err = server.communicate(timeout=180)[1]
    found = re.search(r"Collected : (\d+)", err)
    if not found:
        sys.exit(f"c60.py: no count from {binary}: {err[-800:]}")
    return int(found.group(1))


counts = {binary: [] for binary in binaries}
for turn in range(rounds):
    order = binaries if turn % 2 == 0 else binaries[::-1]
    for binary in order:
        low = count(binary, 200)
        high = count(binary, 1200)
        counts[binary].append((high - low) / 1000)
        print(f"round {turn + 1} {os.path.basename(binary)}: {counts[binary][-1]:.3f} ({low} {high})", flush=True)
for binary in binaries:
    got = counts[binary]
    print(f"{os.path.basename(binary)}: median {statistics.median(got):.3f}, range {min(got):.3f}-{max(got):.3f}", flush=True)
print("C60-DONE")
