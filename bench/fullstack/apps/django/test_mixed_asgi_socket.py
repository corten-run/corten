"""Small loopback fixture for both native Granian interfaces; no Docker or browser."""
from contextlib import contextmanager
import gzip
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import select
from shutil import copytree
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Event, Thread
from time import monotonic, sleep
import unittest

import requests

from start_matched import command


APP = Path(__file__).resolve().parent
FIXTURE = APP / "itempage" / "marketplace_test_fixture.json"
RECORD = json.loads(FIXTURE.read_text(encoding="utf-8"))["item_1"]
LOCALES = ("en-US", "fr-FR", "de-DE")
TRACE = "00-00000000000000000000000000000001-0000000000000001-01"


class HeldRead:
    def __init__(self, body=False, drip=False):
        self.body = body
        self.drip = drip
        self.started = Event()
        self.closed = Event()
        self.release = Event()


class Upstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def handle(self):
        try:
            super().handle()
        except ConnectionResetError:
            # The worker may close an idle pooled connection during teardown.
            pass

    def log_message(self, *args):
        pass

    def do_GET(self):
        record_id = self.path.removeprefix("/marketplace/records/")
        self.server.reads.append((self.path, self.headers.get("traceparent")))
        if record_id == "malformed":
            payload = b'{"arbitrary":1}'
        else:
            payload = json.dumps({**RECORD, "id": record_id}).encode()
        held = self.server.held.get(record_id)
        offset = 0
        if held and held.body:
            self.write_headers(payload)
            self.wfile.write(payload[:1])
            offset = 1
        if held:
            held.started.set()
            next_byte = monotonic() + 1
            while not held.release.is_set():
                if select.select([self.connection], [], [], 0.025)[0]:
                    try:
                        if self.connection.recv(1):
                            raise AssertionError("unexpected bytes on held upstream request")
                    except ConnectionResetError:
                        pass
                    held.closed.set()
                    self.close_connection = True
                    return
                if held.drip and monotonic() >= next_byte and offset < len(payload) - 1:
                    try:
                        self.wfile.write(payload[offset:offset + 1])
                    except (BrokenPipeError, ConnectionResetError):
                        held.closed.set()
                        self.close_connection = True
                        return
                    offset += 1
                    next_byte = monotonic() + 1
        if not (held and held.body):
            self.write_headers(payload)
        self.wfile.write(payload[offset:])

    def write_headers(self, payload):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()


@contextmanager
def native_app(asgi, upstream_port, *, fixture=False):
    (APP / "work").mkdir(exist_ok=True)
    with TemporaryDirectory(prefix="mixed-asgi-socket-", dir=APP / "work") as directory:
        app = Path(directory)
        for name in ("itempage", "templates", "static"):
            copytree(APP / name, app / name)
        # The image adds pinned htmx at build time. This probe does not run JS.
        (app / "static" / "htmx.min.js").touch()
        env = {**os.environ, "PROFILE": "matched", "HOSTS": "127.0.0.1",
               "API_BASE": f"http://127.0.0.1:{upstream_port}", "MAX_CONNECTIONS": "1000",
               "DJANGO_SETTINGS_MODULE": "itempage.mixed_asgi_settings" if asgi else "itempage.settings",
               "MARKETPLACE_SOURCE": "fixture" if fixture else "api", "MARKETPLACE_FIXTURE_PATH": str(FIXTURE),
               "CATALOG_SOURCE": "api", "PYTHONDONTWRITEBYTECODE": "1"}
        for setup in ("migrate", "collectstatic"):
            subprocess.run([sys.executable, "-m", "django", setup, "--noinput", "-v", "0"],
                           cwd=app, env=env, check=True, timeout=20)
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]
        argv = command(env, asgi=asgi)
        argv[argv.index("--port") + 1] = str(port)
        argv[argv.index("--host") + 1] = "127.0.0.1"
        base = f"http://127.0.0.1:{port}"
        with (app / "server.log").open("w+b") as log:
            child = subprocess.Popen([sys.executable, "-m", *argv], cwd=app, env=env,
                                     stdout=log, stderr=subprocess.STDOUT)
            try:
                until = monotonic() + 10
                while child.poll() is None and monotonic() < until:
                    try:
                        with requests.get(base + "/health/live", timeout=0.25) as ready:
                            if ready.status_code == 200:
                                break
                    except requests.RequestException:
                        pass
                    sleep(0.025)
                else:
                    log.seek(0)
                    raise AssertionError(f"Granian did not become ready: {log.read().decode(errors='replace')}")
                yield base, port
            finally:
                if child.poll() is None:
                    if os.name == "nt":
                        subprocess.run(["taskkill", "/T", "/F", "/PID", str(child.pid)],
                                       capture_output=True, check=True, timeout=5)
                    else:
                        child.terminate()
                child.wait(timeout=10)


class MixedAsgiSocketTests(unittest.TestCase):
    def setUp(self):
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        self.upstream.held = {}
        self.upstream.reads = []
        thread = Thread(target=self.upstream.serve_forever, daemon=True)
        self.addCleanup(self.upstream.server_close)
        self.addCleanup(self.upstream.shutdown)
        thread.start()

    def test_abort_closes_real_upstream_only_under_asgi(self):
        wsgi_pages = {}
        for asgi in (False, True):
            with self.subTest(asgi=asgi), native_app(asgi, self.upstream.server_port) as (base, port):
                cases = list(zip(LOCALES, ("request_1", "request_4", "request_40")))
                cases.append(("en-US", "held_body"))
                for locale, record_id in cases:
                    with self.subTest(locale=locale, record_id=record_id):
                        held = self.upstream.held[record_id] = HeldRead(body=record_id == "held_body")
                        path = f"/marketplace/{locale}/{record_id}"
                        try:
                            with socket.create_connection(("127.0.0.1", port), timeout=2) as client:
                                client.sendall(f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\ntraceparent: {TRACE}\r\n\r\n".encode())
                                self.assertTrue(held.started.wait(2), "upstream request did not start")
                                self.assertFalse(select.select([client], [], [], 0.05)[0], "early response before abort")
                                client.shutdown(socket.SHUT_RDWR)
                            self.assertEqual(held.closed.wait(0.5), asgi)
                        finally:
                            held.release.set()
                    recovered = requests.get(base + "/api/marketplace/item_1", timeout=2)
                    self.assertEqual(recovered.json(), RECORD)
                self.assertEqual(self.upstream.reads, [
                    row for _, record_id in cases
                    for row in ((f"/marketplace/records/{record_id}", TRACE), ("/marketplace/records/item_1", None))
                ])
                self.upstream.reads.clear()
                for locale in LOCALES:
                    page = requests.get(base + f"/marketplace/{locale}/item_1?sort=desc&offers=all",
                                        headers={"Accept-Encoding": "identity"}, timeout=3)
                    self.assertEqual(page.status_code, 200)
                    body, count = re.subn(rb'name="csrfmiddlewaretoken" value="[a-zA-Z0-9]{64}"',
                                          b'name="csrfmiddlewaretoken" value="MASKED"', page.content)
                    self.assertEqual(count, 1)
                    if asgi:
                        self.assertEqual(body, wsgi_pages[locale])
                    else:
                        wsgi_pages[locale] = body
                self.assertEqual(self.upstream.reads, [("/marketplace/records/item_1", None)] * len(LOCALES))
                self.upstream.reads.clear()

    def test_asgi_deadline_security_and_durable_alert(self):
        with native_app(True, self.upstream.server_port) as (base, _), requests.Session() as client:
            path = base + "/marketplace/fr-FR/item_1"
            with client.get(path, headers={"Accept-Encoding": "gzip"}, timeout=3, stream=True) as page:
                self.assertEqual(page.status_code, 200)
                self.assertIn("default-src 'self'", page.headers["Content-Security-Policy"])
                self.assertEqual(page.headers["X-Frame-Options"], "DENY")
                self.assertIn("no-store", page.headers["Cache-Control"])
                self.assertEqual(page.headers["Content-Encoding"], "gzip")
                self.assertIn(b'<html lang="fr-FR">', gzip.decompress(page.raw.read()))
            csrf = client.cookies["csrftoken"]
            payload = {"email": "a@b", "target_price": "1,25", "csrfmiddlewaretoken": csrf}
            self.assertEqual(client.post(path, data={"email": "a@b", "target_price": "1,25"}, timeout=3).status_code, 403)
            self.assertEqual(client.post(path, data=payload, headers={"Sec-Fetch-Site": "cross-site"}, timeout=3).status_code, 403)
            self.assertEqual(client.post(path, data=payload, timeout=3).status_code, 200)
            alerts = client.get(base + "/api/alerts", timeout=3)
            self.assertEqual(alerts.json(), [{"item_id": "item_1", "email": "a@b", "target_minor": 125}])
            self.assertEqual(requests.get(base + "/api/alerts", timeout=3).json(), [])
            self.assertEqual(self.upstream.reads, [("/marketplace/records/item_1", None)] * 2)
            malformed = client.get(base + "/api/marketplace/malformed", timeout=3)
            self.assertEqual((malformed.status_code, malformed.json()), (500, {"error": "Internal Server Error"}))
            # A body byte every second defeats an inactivity-only timeout.
            held = self.upstream.held["deadline"] = HeldRead(body=True, drip=True)
            try:
                response = client.post(base + "/marketplace/fr-FR/deadline", data=payload, timeout=13)
                self.assertTrue(held.started.is_set())
                self.assertTrue(held.closed.wait(0.5), "deadline did not close the held upstream")
                self.assertEqual((response.status_code, response.text), (504, "Record source timed out"))
                self.assertEqual(client.get(base + "/api/alerts", timeout=3).json(), alerts.json())
                self.assertEqual(self.upstream.reads[-2:], [("/marketplace/records/malformed", None), ("/marketplace/records/deadline", None)])
            finally:
                held.release.set()

    def test_asgi_fixture_reads_do_not_fetch(self):
        with native_app(True, self.upstream.server_port, fixture=True) as (base, _):
            for locale in LOCALES:
                page = requests.get(base + f"/marketplace/{locale}/item_1", timeout=3)
                self.assertEqual(page.status_code, 200)
                self.assertIn(f'<html lang="{locale}">', page.text)
            stylesheet = re.search(r'href="(/static/marketplace[.][^"]+)"', page.text)
            self.assertIsNotNone(stylesheet)
            css = requests.get(base + stylesheet[1], timeout=3)
            self.assertEqual(css.status_code, 200)
            self.assertIn("text/css", css.headers["Content-Type"])
            self.assertIn("immutable", css.headers["Cache-Control"])
            self.assertEqual(requests.get(base + "/api/marketplace/item_1", timeout=3).json(), RECORD)
            self.assertEqual(self.upstream.reads, [])


if __name__ == "__main__":
    unittest.main()
