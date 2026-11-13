"""Native WSGI HTTP propagation, including a fetch delayed by another request."""
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Thread
from unittest.mock import patch

from django.test import LiveServerTestCase, SimpleTestCase, override_settings
import requests

from .marketplace import MarketplaceSource
from .test_marketplace import RECORDS


FIRST = "00-11111111111111111111111111111111-1111111111111111-00"
SECOND = "00-22222222222222222222222222222222-2222222222222222-01"


@override_settings(STORAGES={"staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"}})
class TraceContextHttpTests(LiveServerTestCase):
    def test_json_pages_and_accepted_posts_capture_before_delayed_fetch(self):
        observations = []
        entered, release = Event(), Event()
        body_entered, body_release, hold_body = Event(), Event(), Event()

        class Upstream(BaseHTTPRequestHandler):
            def do_GET(self):
                observations.append((self.path, self.headers.get("traceparent")))
                body = json.dumps(RECORDS["item_1"]).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if hold_body.is_set() and self.headers.get("traceparent") == FIRST:
                    body_entered.set()
                    body_release.wait(10)
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        class DelayedSource(MarketplaceSource):
            def get(self, record_id, traceparent=None):
                if traceparent == FIRST and not hold_body.is_set():
                    entered.set()
                    if not release.wait(10):
                        raise AssertionError("delayed source was not released")
                return super().get(record_id, traceparent)

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        thread = Thread(target=upstream.serve_forever)
        thread.start()
        with patch.dict(os.environ, API_BASE=f"http://127.0.0.1:{upstream.server_port}", MARKETPLACE_SOURCE="api"):
            source = DelayedSource()
        try:
            with patch("itempage.marketplace_views.source", source), requests.Session() as client:
                page = "/marketplace/en-US/item_1"
                self.assertEqual(client.get(self.live_server_url + page, timeout=10).status_code, 200)
                token = client.cookies["csrftoken"]
                observations.clear()

                def send(path, trace=None, post=False):
                    headers = {} if trace is None else {"traceparent": trace}
                    if post:
                        target = "12.50" if "/en-US/" in path else "12,50"
                        return client.post(self.live_server_url + path, headers=headers, timeout=10,
                            data={"email": "trace@example.test", "target_price": target, "csrfmiddlewaretoken": token})
                    return client.get(self.live_server_url + path, headers=headers, timeout=10)

                cases = [("/api/marketplace/item_1", False)]
                self.assertEqual(send(page, post=True).status_code, 200)
                cases += [(f"/marketplace/{locale}/item_1", post)
                          for locale in ("en-US", "fr-FR", "de-DE") for post in (False, True)]
                for path, post in cases:
                    with self.subTest(path=path, post=post), ThreadPoolExecutor(max_workers=1) as pool:
                        entered.clear()
                        release.clear()
                        start = len(observations)
                        old = pool.submit(send, path, FIRST, post)
                        try:
                            self.assertTrue(entered.wait(5))
                            self.assertEqual(send(path, SECOND, post).status_code, 200)
                            self.assertFalse(old.done())
                            self.assertEqual(send(path, None, post).status_code, 200)
                        finally:
                            release.set()
                        self.assertEqual(old.result(timeout=10).status_code, 200)
                        self.assertEqual(send(path, "not-a-valid-traceparent", post).status_code, 200)
                        self.assertEqual(send(path, None, post).status_code, 200)
                        self.assertEqual(observations[start:], [("/marketplace/records/item_1", trace)
                            for trace in (SECOND, None, FIRST, "not-a-valid-traceparent", None)])

                hold_body.set()
                start = len(observations)
                with ThreadPoolExecutor(max_workers=1) as pool:
                    old = pool.submit(send, "/api/marketplace/item_1", FIRST)
                    try:
                        self.assertTrue(body_entered.wait(5))
                        self.assertEqual(send("/api/marketplace/item_1", SECOND).status_code, 200)
                        self.assertFalse(old.done())
                    finally:
                        body_release.set()
                    self.assertEqual(old.result(timeout=10).status_code, 200)
                self.assertEqual(send("/api/marketplace/item_1").status_code, 200)
                self.assertEqual([trace for _, trace in observations[start:]], [FIRST, SECOND, None])
                rows = client.get(self.live_server_url + "/api/alerts", timeout=10).json()
                self.assertEqual(len(rows), 16)
                self.assertTrue(all(row["email"] == "trace@example.test" and row["target_minor"] == 1250 for row in rows))
        finally:
            release.set()
            body_release.set()
            source.session.close()
            upstream.shutdown()
            upstream.server_close()
            thread.join()


class TraceFixtureTests(SimpleTestCase):
    def test_native_requests_preserve_wsgi_obs_text_header_bytes(self):
        observed = []

        class Upstream(BaseHTTPRequestHandler):
            def do_GET(self):
                observed.append(self.headers.get("traceparent"))
                body = json.dumps(RECORDS["item_1"]).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        thread = Thread(target=upstream.serve_forever)
        thread.start()
        with patch.dict(os.environ, MARKETPLACE_SOURCE="api", API_BASE=f"http://127.0.0.1:{upstream.server_port}"):
            source = MarketplaceSource()
        try:
            for trace in ("\xa0", "\x85", "\xe9", FIRST, None):
                with self.subTest(trace=trace):
                    self.assertEqual(source.get("item_1", trace), RECORDS["item_1"])
            self.assertEqual(observed, ["\xa0", "\x85", "\xe9", FIRST, None])
            self.assertNotIn("traceparent", source.session.headers)
        finally:
            source.session.close()
            upstream.shutdown()
            upstream.server_close()
            thread.join()

    def test_fixture_never_fetches_even_with_trace_context(self):
        with TemporaryDirectory() as directory:
            fixture = Path(directory) / "records.json"
            fixture.write_text(json.dumps(RECORDS), encoding="utf-8")
            with patch.dict(os.environ, MARKETPLACE_SOURCE="fixture", MARKETPLACE_FIXTURE_PATH=str(fixture)):
                source = MarketplaceSource()
            try:
                with patch.object(source.session, "get", side_effect=AssertionError("fixture must not fetch")):
                    self.assertEqual(source.get("item_1", FIRST), RECORDS["item_1"])
                    self.assertIsNone(source.get("missing", SECOND))
            finally:
                source.session.close()
