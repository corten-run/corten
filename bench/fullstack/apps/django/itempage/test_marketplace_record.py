from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from threading import Thread
from unittest.mock import patch

from django.contrib.sessions.models import Session
from django.test import Client, LiveServerTestCase, TestCase, override_settings
import requests

from .marketplace import MarketplaceSource
from .models import Alert
from .test_marketplace import RECORDS


def malformed_records():
    record = RECORDS["item_1"]
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


@override_settings(STORAGES={"staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"}})
class MarketplaceRecordTests(TestCase):
    def test_incomplete_records_never_commit_and_valid_record_recovers(self):
        client = Client(enforce_csrf_checks=True, raise_request_exception=False)
        with patch("itempage.marketplace_views.source") as source:
            source.get.return_value = RECORDS["item_1"]
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
                    source.get.return_value = record
                    self.assertEqual(client.post("/marketplace/en-US/item_1", form).status_code, 500)
                    self.assertEqual(client.get("/api/alerts").json(), before)
                    self.assertEqual(fresh.post("/marketplace/en-US/item_1", fresh_form).status_code, 500)
                    self.assertEqual(fresh.get("/api/alerts").json(), [])
                    self.assertEqual(Session.objects.count(), 1)
                    self.assertEqual(Alert.objects.count(), 1)
            source.get.return_value = RECORDS["item_1"]
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
