"""Real native HTTP requests retain their own transparent W3C traceparent."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import socket
from threading import Event, Thread
import time
import unittest
from unittest.mock import patch

import httpx
import uvicorn

from . import main
from .marketplace import MarketplaceSource
from .test_marketplace import RECORD


FIRST = "00-11111111111111111111111111111111-1111111111111111-00"
SECOND = "00-22222222222222222222222222222222-2222222222222222-01"


class TraceContextTests(unittest.TestCase):
    def test_native_json_pages_and_accepted_posts_capture_before_delayed_fetch(self):
        observations = []
        entered, release = Event(), Event()
        body_entered, body_release = Event(), Event()
        hold_body = Event()

        class Upstream(BaseHTTPRequestHandler):
            def do_GET(self):
                observations.append((self.path, self.headers.get("traceparent")))
                body = json.dumps(RECORD).encode()
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
            async def get(self, record_id, traceparent=None):
                self.loop = asyncio.get_running_loop()
                if traceparent == FIRST and not hold_body.is_set():
                    entered.set()
                    while not release.is_set():
                        await asyncio.sleep(0.005)
                # Delay before the native client constructs the outbound request.
                return await super().get(record_id, traceparent)

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        upstream_thread = Thread(target=upstream.serve_forever)
        upstream_thread.start()
        with patch.dict(os.environ, API_BASE=f"http://127.0.0.1:{upstream.server_port}", MARKETPLACE_SOURCE="api"):
            source = DelayedSource()
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        base = f"http://127.0.0.1:{sock.getsockname()[1]}"
        server = uvicorn.Server(uvicorn.Config(main.app, log_level="error"))
        thread = Thread(target=server.run, kwargs={"sockets": [sock]})
        try:
            with patch.object(main, "marketplace_source", source), httpx.Client(base_url=base, timeout=10) as client:
                thread.start()
                deadline = time.monotonic() + 10
                while not server.started:
                    self.assertTrue(thread.is_alive())
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.01)

                def send(path, trace=None, post=False):
                    headers = {} if trace is None else {"traceparent": trace}
                    if post:
                        target = "12.50" if "/en-US/" in path else "12,50"
                        return client.post(path, headers=headers, data={"email": "trace@example.test", "target_price": target})
                    return client.get(path, headers=headers)

                cases = [("/api/marketplace/item_1", False)]
                self.assertEqual(send("/marketplace/en-US/item_1", post=True).status_code, 200)
                cases += [(f"/marketplace/{locale}/item_1", post)
                          for locale in ("en-US", "fr-FR", "de-DE") for post in (False, True)]
                for path, post in cases:
                    with self.subTest(path=path, post=post), ThreadPoolExecutor(max_workers=1) as pool:
                        entered.clear()
                        release.clear()
                        start = len(observations)
                        old = pool.submit(send, path, FIRST, post)
                        try:
                            self.assertTrue(entered.wait(5), "request captured trace before delayed source read")
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

                # Headers already sent upstream, but the old native body read is still pending.
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
                readback = client.get("/api/alerts").json()
                self.assertEqual(len(readback), 16)
                self.assertTrue(all(row["email"] == "trace@example.test" and row["target_minor"] == 1250 for row in readback))
        finally:
            release.set()
            body_release.set()
            if hasattr(source, "loop") and source.loop.is_running():
                asyncio.run_coroutine_threadsafe(source.client.aclose(), source.loop).result(timeout=5)
            server.should_exit = True
            if thread.ident is not None:
                thread.join(10)
                self.assertFalse(thread.is_alive())
            sock.close()
            upstream.shutdown()
            upstream.server_close()
            upstream_thread.join()

    def test_fixture_does_not_use_http_with_a_trace(self):
        from pathlib import Path
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "records.json"
            fixture.write_text(json.dumps({"item_1": RECORD}), encoding="utf-8")
            with patch.dict(os.environ, MARKETPLACE_SOURCE="fixture", MARKETPLACE_FIXTURE_PATH=str(fixture)):
                source = MarketplaceSource()

            async def check():
                try:
                    with patch.object(source.client, "get", side_effect=AssertionError("fixture must not fetch")):
                        self.assertEqual((await source.get("item_1", FIRST)).id, "item_1")
                        self.assertIsNone(await source.get("missing", SECOND))
                finally:
                    await source.client.aclose()

            asyncio.run(check())
