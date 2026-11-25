"""Loopback checks for both Granian interfaces and the running candidate image."""
from contextlib import contextmanager
import gzip
from http.client import HTTPResponse
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
from unittest.mock import patch
from urllib.parse import urlsplit

import requests

from start_matched import command


APP = Path(__file__).resolve().parent
FIXTURE = APP / "itempage" / "marketplace_test_fixture.json"
RECORD = json.loads(FIXTURE.read_text(encoding="utf-8"))["item_1"]
LOCALES = ("en-US", "fr-FR", "de-DE")
TRACE = "00-00000000000000000000000000000001-0000000000000001-01"
CLEANUP_SECONDS = 0.5
DEADLINE_LOW, DEADLINE_HIGH = 9.75, 10.75


class HeldRead:
    def __init__(self, body=False, drip=False):
        self.body = body
        self.drip = drip
        self.started = Event()
        self.closed = Event()
        self.release = Event()
        self.started_at = None
        self.closed_at = None
        self.body_writes = []


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
        if held:
            held.started_at = monotonic()
        if held and held.body:
            self.write_headers(payload)
            self.wfile.write(payload[:1])
            held.body_writes.append(monotonic())
            offset = 1
        if held:
            held.started.set()
            next_byte = monotonic() + 1
            dripping = held.drip
            while not held.release.is_set():
                if select.select([self.connection], [], [], 0.025)[0]:
                    try:
                        data = self.connection.recv(1)
                    except ConnectionResetError:
                        data = b""
                    observed_at = monotonic()
                    if data:
                        raise AssertionError("unexpected bytes on held upstream request")
                    held.closed_at = observed_at
                    held.closed.set()
                    self.close_connection = True
                    return
                if dripping and monotonic() >= next_byte and offset < len(payload) - 1:
                    try:
                        self.wfile.write(payload[offset:offset + 1])
                    except (BrokenPipeError, ConnectionResetError):
                        # Stop writing, but record the first EOF/reset from recv above.
                        dripping = False
                    else:
                        held.body_writes.append(monotonic())
                        offset += 1
                        next_byte = held.body_writes[-1] + 1
        if not (held and held.body):
            self.write_headers(payload)
        self.wfile.write(payload[offset:])

    def write_headers(self, payload):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()


def wait_until_ready(base, alive=lambda: True):
    until = monotonic() + 10
    while alive() and monotonic() < until:
        try:
            with requests.get(base + "/health/live", timeout=0.25) as ready:
                if ready.status_code == 200:
                    return True
        except requests.RequestException:
            pass
        sleep(0.025)
    return False


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
                if not wait_until_ready(base, lambda: child.poll() is None):
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


class SocketFixture(unittest.TestCase):
    def start_upstream(self, port=0):
        self.upstream = ThreadingHTTPServer(("127.0.0.1", port), Upstream)
        self.upstream.held = {}
        self.upstream.reads = []
        thread = Thread(target=self.upstream.serve_forever, daemon=True)
        self.addCleanup(self.upstream.server_close)
        self.addCleanup(self.upstream.shutdown)
        thread.start()

    def close_elapsed(self, held, abort_at):
        held.closed.wait(max(0, abort_at + CLEANUP_SECONDS - monotonic()))
        observed_at = held.closed_at
        if observed_at is None:
            return None
        elapsed = observed_at - abort_at
        self.assertGreaterEqual(elapsed, 0, "upstream closed before the caller aborted")
        return elapsed

    @contextmanager
    def held_request(self, port, locale, record_id, *, body):
        held = self.upstream.held[record_id] = HeldRead(body=body)
        path = f"/marketplace/{locale}/{record_id}"
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=2) as client:
                client.sendall(f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\ntraceparent: {TRACE}\r\n\r\n".encode())
                self.assertTrue(held.started.wait(2), "upstream request did not start")
                self.assertFalse(select.select([client], [], [], 0.05)[0], "early response during the hold")
                yield client, held, path
        finally:
            held.release.set()

    def assert_abort(self, port, locale, record_id, *, body=False, expect_closed=True):
        with self.held_request(port, locale, record_id, body=body) as (client, held, path):
            abort_at = monotonic()  # Before the shutdown syscall, not after a possible pause.
            client.shutdown(socket.SHUT_RDWR)
            client.close()
            elapsed = self.close_elapsed(held, abort_at)
            observed = "not observed by the cutoff" if elapsed is None else f"{elapsed:.3f} s after abort"
            print(f"{path}: upstream EOF/reset {observed} (expect within 0.500 s: {expect_closed})", flush=True)
            self.assertEqual(elapsed is not None and elapsed <= CLEANUP_SECONDS, expect_closed,
                             f"{path}: upstream EOF/reset at {elapsed!r} s after abort")

    def assert_connected(self, port, locale, record_id, *, body=False):
        with self.held_request(port, locale, record_id, body=body) as (client, held, _):
            # Start at the point where the other probe aborts, then hold through its entire cleanup window.
            release_at = monotonic() + CLEANUP_SECONDS
            while (remaining := release_at - monotonic()) > 0:
                self.assertFalse(select.select([client], [], [], remaining)[0],
                                 "connected caller received data or EOF before upstream release")
            self.assertIsNone(held.closed_at, "upstream closed while the caller stayed connected")
            held.release.set()
            with HTTPResponse(client) as response:
                response.begin()
                self.assertEqual(response.status, 200)
                self.assertTrue(response.getheader("Content-Type", "").startswith("text/html"))
                page = response.read()
            self.assertIn(f'<html lang="{locale}">'.encode(), page)
            self.assertTrue(page.rstrip().endswith(b"</html>"), "incomplete marketplace HTML")

    def assert_whole_read_deadline(self, held, response_elapsed):
        self.assertTrue(held.closed.wait(CLEANUP_SECONDS), "deadline did not close the held upstream")
        self.assertIsNotNone(held.started_at)
        self.assertIsNotNone(held.closed_at)
        for name, elapsed in (("client response", response_elapsed),
                              ("upstream close", held.closed_at - held.started_at)):
            self.assertTrue(DEADLINE_LOW <= elapsed <= DEADLINE_HIGH,
                            f"{name} at {elapsed:.3f} s, expected the ten-second whole-read deadline")
        self.assertGreaterEqual(len(held.body_writes), 9, "too few successful trickle writes")
        points = [*held.body_writes, held.closed_at]
        for earlier, later in zip(points, points[1:]):
            self.assertTrue(0 <= later - earlier <= 2, "trickle stalled before the upstream close")


class MixedAsgiSocketTests(SocketFixture):
    def setUp(self):
        self.start_upstream()

    def test_abort_closes_real_upstream_only_under_asgi(self):
        wsgi_pages = {}
        for asgi in (False, True):
            with self.subTest(asgi=asgi), native_app(asgi, self.upstream.server_port) as (base, port):
                cases = list(zip(LOCALES, ("request_1", "request_4", "request_40")))
                cases.append(("en-US", "held_body"))
                expected_reads = []
                for locale, record_id in cases:
                    with self.subTest(locale=locale, record_id=record_id):
                        body = record_id == "held_body"
                        self.assert_abort(port, locale, record_id, body=body, expect_closed=asgi)
                        if asgi:
                            self.assert_connected(port, locale, record_id, body=body)
                    recovered = requests.get(base + "/api/marketplace/item_1", timeout=2)
                    self.assertEqual(recovered.json(), RECORD)
                    expected_reads.extend([(f"/marketplace/records/{record_id}", TRACE)] * (2 if asgi else 1))
                    expected_reads.append(("/marketplace/records/item_1", None))
                self.assertEqual(self.upstream.reads, expected_reads)
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
                start = monotonic()
                response = client.post(base + "/marketplace/fr-FR/deadline", data=payload, timeout=13)
                elapsed = monotonic() - start
                self.assertTrue(held.started.is_set())
                self.assert_whole_read_deadline(held, elapsed)
                print(f"Whole read: response {elapsed:.3f} s, upstream close "
                      f"{held.closed_at - held.started_at:.3f} s, {len(held.body_writes)} body writes", flush=True)
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


class ShippedAsgiSocketTests(SocketFixture):
    def test_default_container_command_serves_and_cancels(self):
        upstream = urlsplit(os.environ["API_BASE"])
        self.assertEqual((upstream.scheme, upstream.hostname, upstream.path), ("http", "127.0.0.1", ""))
        self.assertIsNotNone(upstream.port)
        self.start_upstream(upstream.port)
        base = "http://127.0.0.1:8080"
        self.assertTrue(wait_until_ready(base), "the image's default command did not start the app")
        self.assert_abort(8080, "en-US", "request_1")
        self.assert_connected(8080, "en-US", "request_1")
        self.assertEqual(self.upstream.reads, [("/marketplace/records/request_1", TRACE)] * 2)
        # A write through the running server also requires the shipped migration to have run.
        with requests.Session() as client:
            path = base + "/marketplace/en-US/item_1"
            self.assertEqual(client.get(path, timeout=3).status_code, 200)
            form = {"email": "a@b", "target_price": "1.25", "csrfmiddlewaretoken": client.cookies["csrftoken"]}
            self.assertEqual(client.post(path, data=form, timeout=3).status_code, 200)
            self.assertEqual(client.get(base + "/api/alerts", timeout=3).json(),
                             [{"item_id": "item_1", "email": "a@b", "target_minor": 125}])


class SocketTimingTests(SocketFixture):
    def test_scheduler_pause_does_not_reclassify_late_close(self):
        held = HeldRead()
        held.closed.set()
        with patch(f"{__name__}.monotonic", return_value=102):
            for observed_at, in_budget in ((100.25, True), (100.75, False)):
                with self.subTest(observed_at=observed_at):
                    held.closed_at = observed_at
                    self.assertEqual(self.close_elapsed(held, 100) <= CLEANUP_SECONDS, in_budget)
            held.closed_at = 99.75
            with self.assertRaisesRegex(AssertionError, "before the caller aborted"):
                self.close_elapsed(held, 100)

    def test_whole_read_deadline_rejects_wrong_timer_and_missing_progress(self):
        held = HeldRead(body=True, drip=True)
        held.started_at = 100
        held.closed_at = 110
        held.closed.set()
        held.body_writes = list(range(100, 110))
        self.assert_whole_read_deadline(held, 10)
        for elapsed in (9, 11):
            with self.subTest(elapsed=elapsed):
                with self.assertRaisesRegex(AssertionError, "client response"):
                    self.assert_whole_read_deadline(held, elapsed)
        held.closed_at = 111
        with self.assertRaisesRegex(AssertionError, "upstream close"):
            self.assert_whole_read_deadline(held, 10)
        held.closed_at = 110
        held.body_writes = [100]
        with self.assertRaisesRegex(AssertionError, "too few"):
            self.assert_whole_read_deadline(held, 10)
        held.body_writes = [*range(100, 108), 107.5]
        with self.assertRaisesRegex(AssertionError, "trickle stalled"):
            self.assert_whole_read_deadline(held, 10)


if __name__ == "__main__":
    unittest.main()
