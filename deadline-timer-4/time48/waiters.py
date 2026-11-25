#!/usr/bin/env python3
"""N kept-alive connections to 127.0.0.1:8080, each sending one request a second, their phases spread
evenly over the second. Runs until SIGTERM, then prints what was sent and answered.
Usage: waiters.py <connections> <path>"""
import selectors
import signal
import socket
import sys
import time

count = int(sys.argv[1])
request = b"GET " + sys.argv[2].encode() + b" HTTP/1.1\r\nHost: localhost\r\n\r\n"
stop = []
signal.signal(signal.SIGTERM, lambda *_: stop.append(1))
selector = selectors.DefaultSelector()
conns = []
start = time.monotonic() + 0.05
for j in range(count):
    sock = socket.create_connection(("127.0.0.1", 8080))
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    sock.setblocking(False)
    conn = {"sock": sock, "next": start + j / count, "sent": 0, "answered": 0, "bad": 0, "late": 0, "closed": 0, "buf": b""}
    selector.register(sock, selectors.EVENT_READ, conn)
    conns.append(conn)


def take(conn):
    """Counts the whole answers in the connection's buffer."""
    while True:
        end = conn["buf"].find(b"\r\n\r\n")
        if end < 0:
            return
        head = conn["buf"][:end].decode("latin-1")
        length = 0
        for line in head.split("\r\n")[1:]:
            name, _, value = line.partition(":")
            if name.strip().lower() == "content-length":
                length = int(value)
        if len(conn["buf"]) < end + 4 + length:
            return
        conn["buf"] = conn["buf"][end + 4 + length:]
        if head.startswith("HTTP/1.1 200"):
            conn["answered"] += 1
        else:
            conn["bad"] += 1


while not stop:
    now = time.monotonic()
    for conn in conns:
        if conn["closed"] or now < conn["next"]:
            continue
        conn["next"] += 1.0
        if conn["sent"] > conn["answered"] + conn["bad"]:
            conn["late"] += 1
            continue
        try:
            conn["sock"].send(request)
            conn["sent"] += 1
        except OSError:
            conn["closed"] = 1
    wake = min(conn["next"] for conn in conns)
    for key, _ in selector.select(timeout=max(0.0, min(wake - time.monotonic(), 0.05))):
        conn = key.data
        try:
            data = conn["sock"].recv(65536)
        except BlockingIOError:
            continue
        except OSError:
            data = b""
        if not data:
            conn["closed"] = 1
            selector.unregister(conn["sock"])
            continue
        conn["buf"] += data
        take(conn)

total = lambda key: sum(conn[key] for conn in conns)
print(f"waiters conns={count} sent={total('sent')} answered={total('answered')} bad={total('bad')} "
      f"late={total('late')} closed={total('closed')} least={min(conn['answered'] for conn in conns)}")
