from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from unittest.mock import Mock, patch

from django.contrib.sessions.models import Session
from django.test import Client, LiveServerTestCase, SimpleTestCase, TestCase, override_settings
import requests

from .marketplace import MarketplaceSource, validate_record
from .models import Alert
from .test_marketplace import RECORDS


def malformed_records():
    record = deepcopy(RECORDS["item_1"])
    record["included_in"] = [{"id": "bundle_1", "item_id": "item_2", "title": "Bundle", "quantity": 1}]
    for key in record:
        bad = deepcopy(record)
        del bad[key]
        yield f"missing {key}", bad
    for key, value in [("description", {}), ("categories", {}), ("images", "not an array"),
            ("categories", [None]), ("categories", [{"name": "Cards"}]),
            ("categories", [{"name": 1, "slug": "cards"}]), ("images", [None]),
            ("fields", [None]), ("fields", [{"name": "Set"}]),
            ("fields", [{"name": "Set", "value": []}]), ("badges", [1]),
            ("tags", {}), ("summary", {}), ("summary", {"lowest_minor": 1, "count": True, "quantity": 1}),
            ("listings", [None]), ("offers", [{"id": "o"}]),
            ("contents", [{"id": "c", "item_id": "item_2", "title": None, "quantity": 1}]),
            ("included_in", [None])]:
        yield f"wrong shape {key}: {value!r}", {**deepcopy(record), key: value}
    yield "wrong requested ID", {**deepcopy(record), "id": "item_2"}
    for key in ("listings", "offers", "contents", "included_in"):
        bad = deepcopy(record)
        bad[key].append(deepcopy(bad[key][0]))
        yield f"duplicate {key} ID", bad
    for path in [("summary", "count"), ("summary", "quantity"), ("summary", "lowest_minor"),
            ("listings", 0, "reviews"), ("listings", 0, "quantity"), ("listings", 0, "rating_hundredths"),
            ("listings", 0, "price_minor"), ("offers", 0, "quantity"), ("offers", 0, "price_minor"),
            ("contents", 0, "quantity"), ("included_in", 0, "quantity")]:
        key = path[-1]
        minimum = -10**9 if key.endswith("minor") else 0
        maximum = 500 if key == "rating_hundredths" else 10**9
        for value in (minimum - 1, maximum + 1):
            bad = deepcopy(record)
            parent = bad
            for part in path[:-1]:
                parent = parent[part]
            parent[key] = value
            yield f"numeric {path}: {value}", bad


def api_source(record):
    with patch.dict(os.environ, API_BASE="http://example.test/base", MARKETPLACE_SOURCE="api"):
        source = MarketplaceSource()
    response = requests.Response()
    response.status_code = 200
    response.headers["Content-Type"] = "application/json"
    response._content = json.dumps(record).encode()
    source.session.get = Mock(return_value=response)
    return source, response


class MarketplaceSourceTests(SimpleTestCase):
    def test_api_rejects_arbitrary_object_and_every_malformed_record(self):
        source, response = api_source({"arbitrary": 1})
        self.addCleanup(source.session.close)
        for label, record in [("arbitrary object", {"arbitrary": 1}), ("null", None),
                ("array", []), ("boolean", False), *malformed_records()]:
            with self.subTest(record=label):
                response._content = json.dumps(record).encode()
                with self.assertRaises(ValueError):
                    source.get("item_1")

    def test_fixture_rejects_arbitrary_object_at_startup(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "marketplace.json"
            path.write_text(json.dumps({"item_1": {"arbitrary": 1}}))
            with patch.dict(os.environ, MARKETPLACE_SOURCE="fixture", MARKETPLACE_FIXTURE_PATH=str(path)):
                with self.assertRaises(ValueError):
                    MarketplaceSource()

    def test_fixture_rejects_invalid_roots_and_every_malformed_record(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "marketplace.json"
            for label, records in [("null root", None), ("array root", []),
                    *((label, {**RECORDS, "item_1": record}) for label, record in malformed_records())]:
                with self.subTest(record=label):
                    path.write_text(json.dumps(records))
                    with patch.dict(os.environ, MARKETPLACE_SOURCE="fixture", MARKETPLACE_FIXTURE_PATH=str(path)):
                        with self.assertRaises(ValueError):
                            MarketplaceSource()

    def test_fixture_validates_once_at_startup_without_fetching_on_reads(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "marketplace.json"
            path.write_text(json.dumps(RECORDS))
            with patch.dict(os.environ, MARKETPLACE_SOURCE="fixture", MARKETPLACE_FIXTURE_PATH=str(path)), \
                    patch("itempage.marketplace.validate_record", wraps=validate_record) as validate:
                source = MarketplaceSource()
                self.addCleanup(source.session.close)
                self.assertEqual(validate.call_count, len(RECORDS))
                path.unlink()
                source.session.get = Mock(side_effect=AssertionError("fixture read fetched upstream"))
                for record_id in RECORDS:
                    self.assertTrue(source.get(record_id) == RECORDS[record_id])
                    self.assertTrue(source.get(record_id, "request trace") == RECORDS[record_id])
                self.assertIsNone(source.get("missing"))
                self.assertEqual(validate.call_count, len(RECORDS))
                source.session.get.assert_not_called()


@override_settings(STORAGES={"staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"}})
class MarketplaceRecordTests(TestCase):
    def test_api_validates_once_per_json_page_and_post_read(self):
        source, _ = api_source(RECORDS["item_1"])
        self.addCleanup(source.session.close)
        client = Client(enforce_csrf_checks=True)
        with patch("itempage.marketplace_views.source", source), \
                patch("itempage.marketplace.validate_record", wraps=validate_record) as validate:
            self.assertEqual(client.get("/marketplace/en-US/item_1").status_code, 200)
            self.assertEqual(validate.call_count, 1)
            self.assertTrue(client.get("/api/marketplace/item_1").json() == RECORDS["item_1"])
            self.assertEqual(validate.call_count, 2)
            self.assertEqual(client.head("/api/marketplace/item_1").status_code, 200)
            self.assertEqual(validate.call_count, 3)
            form = {"email": "validated@example.test", "target_price": "12.50",
                "csrfmiddlewaretoken": client.cookies["csrftoken"].value}
            self.assertEqual(client.post("/marketplace/en-US/item_1", form).status_code, 200)
            self.assertEqual(validate.call_count, 4)
            self.assertEqual(client.post("/marketplace/en-US/item_1", {**form, "email": "invalid"}).status_code, 200)
            self.assertEqual(validate.call_count, 5)
        self.assertEqual(source.session.get.call_count, 5)
        self.assertEqual(Session.objects.count(), 1)
        self.assertEqual(Alert.objects.count(), 1)

    def test_arbitrary_api_object_is_json_500_for_get_and_head(self):
        source, _ = api_source({"arbitrary": 1})
        self.addCleanup(source.session.close)
        with patch("itempage.marketplace_views.source", source):
            for method in ("get", "head"):
                with self.subTest(method=method):
                    response = getattr(self.client, method)("/api/marketplace/item_1")
                    self.assertEqual(response.status_code, 500)
                    self.assertEqual(response["Content-Type"], "application/json")
                    self.assertEqual(response.content, b'' if method == "head" else b'{"error": "Internal Server Error"}')
        self.assertEqual(source.session.get.call_count, 2)
        self.assertEqual(Session.objects.count(), 0)
        self.assertEqual(Alert.objects.count(), 0)

    def test_malformed_api_records_fail_json_and_page_reads_without_writes(self):
        source, upstream = api_source(RECORDS["item_1"])
        self.addCleanup(source.session.close)
        client = Client(raise_request_exception=False)
        with patch("itempage.marketplace_views.source", source):
            for label, record in malformed_records():
                with self.subTest(record=label):
                    upstream._content = json.dumps(record).encode()
                    for method, path in [("get", "/api/marketplace/item_1"),
                            ("head", "/api/marketplace/item_1"), ("get", "/marketplace/en-US/item_1")]:
                        response = getattr(client, method)(path)
                        self.assertEqual(response.status_code, 500)
                    self.assertEqual(Session.objects.count(), 0)
                    self.assertEqual(Alert.objects.count(), 0)

    def test_page_head_remains_405_without_fetching(self):
        source, _ = api_source(RECORDS["item_1"])
        self.addCleanup(source.session.close)
        with patch("itempage.marketplace_views.source", source):
            self.assertEqual(self.client.head("/marketplace/en-US/item_1").status_code, 405)
        source.session.get.assert_not_called()

    def test_transport_timeout_is_504_without_a_write_or_private_details(self):
        client = Client(enforce_csrf_checks=True)
        with patch("itempage.marketplace_views.source") as source:
            source.get.return_value = RECORDS["item_1"]
            client.get("/marketplace/en-US/item_1")
            form = {"email": "timeout@example.test", "target_price": "12.50",
                "csrfmiddlewaretoken": client.cookies["csrftoken"].value}
            self.assertEqual(client.post("/marketplace/en-US/item_1", form).status_code, 200)
            before = client.get("/api/alerts").json()
            source.get.side_effect = requests.ReadTimeout("private upstream details")
            for response in (client.get("/marketplace/en-US/item_1"), client.post("/marketplace/en-US/item_1", form)):
                self.assertEqual(response.status_code, 504)
                self.assertNotIn(b"private upstream", response.content)
                self.assertIn("no-store", response["Cache-Control"])
                self.assertEqual(client.get("/api/alerts").json(), before)
            self.assertEqual(Session.objects.count(), 1)
            self.assertEqual(Alert.objects.count(), 1)

    def test_incomplete_records_never_commit_and_valid_record_recovers(self):
        client = Client(enforce_csrf_checks=True, raise_request_exception=False)
        source, upstream = api_source(RECORDS["item_1"])
        self.addCleanup(source.session.close)
        with patch("itempage.marketplace_views.source", source):
            client.get("/marketplace/en-US/item_1")
            token = client.cookies["csrftoken"].value
            form = {"email": "complete@example.test", "target_price": "12.50", "csrfmiddlewaretoken": token}
            self.assertEqual(client.post("/marketplace/en-US/item_1", form).status_code, 200)
            before = client.get("/api/alerts").json()
            fresh = Client(enforce_csrf_checks=True, raise_request_exception=False)
            fresh.get("/marketplace/en-US/item_1")
            fresh_form = {**form, "csrfmiddlewaretoken": fresh.cookies["csrftoken"].value}
            for label, record in malformed_records():
                with self.subTest(record=label):
                    upstream._content = json.dumps(record).encode()
                    self.assertEqual(client.post("/marketplace/en-US/item_1", form).status_code, 500)
                    self.assertEqual(client.get("/api/alerts").json(), before)
                    self.assertEqual(fresh.post("/marketplace/en-US/item_1", fresh_form).status_code, 500)
                    self.assertEqual(fresh.get("/api/alerts").json(), [])
                    self.assertEqual(Session.objects.count(), 1)
                    self.assertEqual(Alert.objects.count(), 1)
            upstream._content = json.dumps(RECORDS["item_1"]).encode()
            self.assertEqual(client.post("/marketplace/en-US/item_1", form).status_code, 200)
            self.assertEqual(client.get("/api/alerts").json(), before + before)


class MarketplaceRecordHttpTests(LiveServerTestCase):
    def test_real_upstream_and_cookie_jar_reject_incomplete_records(self):
        current = {"record": RECORDS["item_1"]}

        class Upstream(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(current["record"]).encode())

            def log_message(self, *args):
                pass

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        thread = Thread(target=upstream.serve_forever)
        thread.start()
        try:
            with patch.dict(os.environ, API_BASE=f"http://127.0.0.1:{upstream.server_port}", MARKETPLACE_SOURCE="api"):
                source = MarketplaceSource()
            with patch("itempage.marketplace_views.source", source), requests.Session() as client, requests.Session() as fresh:
                page = self.live_server_url + "/marketplace/en-US/item_1"
                readback = self.live_server_url + "/api/alerts"
                self.assertEqual(client.get(page, timeout=10).status_code, 200)
                form = {"email": "http@example.test", "target_price": "12.50", "csrfmiddlewaretoken": client.cookies["csrftoken"]}
                self.assertEqual(client.post(page, data=form, timeout=10).status_code, 200)
                before = client.get(readback, timeout=10).json()
                self.assertEqual(len(before), 1)
                self.assertEqual(fresh.get(page, timeout=10).status_code, 200)
                fresh_form = {**form, "csrfmiddlewaretoken": fresh.cookies["csrftoken"]}
                for label, record in malformed_records():
                    with self.subTest(record=label):
                        current["record"] = record
                        self.assertEqual(client.post(page, data=form, timeout=10).status_code, 500)
                        self.assertEqual(client.get(readback, timeout=10).json(), before)
                        self.assertEqual(fresh.post(page, data=fresh_form, timeout=10).status_code, 500)
                        self.assertEqual(fresh.get(readback, timeout=10).json(), [])
                        self.assertNotIn("sessionid", fresh.cookies)
                current["record"] = RECORDS["item_1"]
                self.assertEqual(client.post(page, data=form, timeout=10).status_code, 200)
                self.assertEqual(client.get(readback, timeout=10).json(), before + before)
            source.session.close()
        finally:
            upstream.shutdown()
            upstream.server_close()
            thread.join()
