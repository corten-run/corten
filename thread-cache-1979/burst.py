"""Slow readers of the item pages. Usage: python3 burst.py <host> <port> <connections> <floods>
<hold seconds> <item>...
Each flood opens the connections with a 4 KiB receive buffer, asks on each for one of the items'
pages (in turn) with Accept-Encoding: identity and reads nothing, so the app holds what the
socket does not take. A second before a hold ends it prints the app's memory.current; when the
hold ends it counts the connections whose answer began "HTTP/1.1 200" and closes them all. 35 s
after the last flood it prints memory.current again. Sizes are MiB."""
import socket
import subprocess
import sys
import time

host, port, count, floods, hold = sys.argv[1], *(int(a) for a in sys.argv[2:6])
items = sys.argv[6:]


def mem():
    out = subprocess.run(["docker", "exec", "mem-app", "cat", "/sys/fs/cgroup/memory.current"],
                         capture_output=True, text=True).stdout
    return int(out) / 1048576


row = [f"before {mem():.1f}"]
highest, answered, refused = [], 0, 0
for flood in range(floods):
    socks = []
    for n in range(count):
        s = socket.socket()
        s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
        try:
            s.connect((host, port))
            s.sendall(f"GET /items/{items[n % len(items)]} HTTP/1.1\r\nHost: {host}:{port}\r\n"
                      "Accept-Encoding: identity\r\n\r\n".encode())
            socks.append(s)
        except OSError:
            refused += 1
            s.close()
    time.sleep(hold - 1)
    highest.append(mem())
    time.sleep(1)
    for s in socks:
        s.setblocking(False)
        try:
            answered += s.recv(12, socket.MSG_PEEK) == b"HTTP/1.1 200"
        except OSError:
            pass
        s.close()
    time.sleep(2)
row.append("held a second before each hold ended " + " ".join(f"{m:.1f}" for m in highest))
row.append(f"as the last flood closed {mem():.1f}")
time.sleep(35)
row.append(f"35 s after {mem():.1f}")
row.append(f"answered 200 {answered} of {count * floods}, refused {refused}")
print(" | ".join(row))
