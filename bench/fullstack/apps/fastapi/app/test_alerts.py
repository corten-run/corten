from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from . import main, test_marketplace
from .alerts import Alert, AlertStore, COOKIE, LIFETIME
from .marketplace import MarketplaceFormat


class AlertPageTests(unittest.TestCase):
    def setUp(self):
        test_marketplace.PageTests.setUp(self)

    def test_store_readback_rejections_and_isolation(self):
        self.assertEqual(self.client.get("/api/alerts").json(), [])
        for locale, target, minor in [("en-US", "12.505", 1251), ("fr-FR", "1,25", 125), ("de-DE", "2,50", 250)]:
            response = self.client.post(f"/marketplace/{locale}/item_1", data={"email": "a@example.test", "target_price": target})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(self.client.get("/api/alerts").json()[-1], {"item_id": "item_1", "email": "a@example.test", "target_minor": minor})
        expected = self.client.get("/api/alerts").json()
        self.assertEqual(len(expected), 3)
        for data in [{}, {"email": "bad", "target_price": "2"}, {"email": "a@b", "target_price": "NaN"}, {"email": "a@b", "target_price": "1" + "0" * 100}]:
            self.assertEqual(self.client.post("/marketplace/en-US/item_1", data=data).status_code, 200)
        self.assertEqual(self.client.post("/marketplace/en-US/missing", data={"email": "a@b", "target_price": "2"}).status_code, 404)
        self.assertEqual(self.client.post("/marketplace/en-US/item_1", data={"email": "a@b", "target_price": "2"}, headers={"Origin": "http://evil.test"}).status_code, 403)
        for _ in range(2):
            response = self.client.get("/api/alerts")
            self.assertEqual(response.json(), expected)
            self.assertIn("no-store", response.headers["cache-control"])
        with TestClient(main.app) as fresh:
            self.assertEqual(fresh.get("/api/alerts").json(), [])
            fresh.cookies.set(COOKIE, "attacker-chosen")
            response = fresh.post("/marketplace/en-US/item_1", data={"email": "b@c", "target_price": "3"})
            self.assertIn("HttpOnly", response.headers["set-cookie"])
            self.assertIn("SameSite=lax", response.headers["set-cookie"])
            self.assertNotIn("attacker-chosen", response.headers["set-cookie"])
            self.assertEqual(len(fresh.get("/api/alerts").json()), 1)
        self.assertEqual(self.client.get("/api/alerts").json(), expected)

    def test_https_cookie_is_secure(self):
        with TestClient(main.app, base_url="https://testserver") as client:
            result = client.post("/marketplace/en-US/item_1", data={"email": "a@b", "target_price": "1"})
            self.assertIn("Secure", result.headers["set-cookie"])

    def test_source_contract_failure_does_not_append(self):
        form = {"email": "contract@example.test", "target_price": "12.50"}
        path = "/marketplace/en-US/item_1"
        self.assertEqual(self.client.post(path, data=form).status_code, 200)
        before = self.client.get("/api/alerts").json()
        mutations = [{**deepcopy(test_marketplace.RECORD), "id": "item_2"}]
        for key in ("listings", "offers", "contents", "included_in"):
            record = deepcopy(test_marketplace.RECORD)
            record[key].append(deepcopy(record[key][0]))
            mutations.append(record)
        record = deepcopy(test_marketplace.RECORD)
        record["summary"]["count"] = 10**9 + 1
        mutations.append(record)
        for record in mutations:
            with self.subTest(record=record):
                self.records["item_1"] = record
                self.assertEqual(self.client.post(path, data=form).status_code, 502)
                self.assertEqual(self.client.get("/api/alerts").json(), before)
        self.records["item_1"] = deepcopy(test_marketplace.RECORD)
        self.assertEqual(self.client.post(path, data=form).status_code, 200)
        self.assertEqual(self.client.get("/api/alerts").json(), before + before)


class StoreTests(unittest.TestCase):
    def test_concurrent_append_and_snapshot(self):
        store = AlertStore()
        token, created = store.append(None, Alert(item_id="first", email="a@b", target_minor=1))
        self.assertTrue(created)
        snapshot = store.read(token)
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda i: store.append(token, Alert(item_id=str(i), email="a@b", target_minor=i)), range(32)))
        rows = store.read(token)
        self.assertEqual(len(rows), 33)
        self.assertEqual(rows[0], snapshot[0])
        self.assertEqual({row.item_id for row in rows[1:]}, {str(i) for i in range(32)})
        snapshot[0].email = "changed"
        self.assertEqual(store.read(token)[0].email, "a@b")
        self.assertEqual(store.read("unknown"), [])

    def test_expired_token_is_not_reused(self):
        store = AlertStore()
        alert = Alert(item_id="first", email="a@b", target_minor=1)
        with patch("app.alerts.monotonic", return_value=0):
            token, _ = store.append(None, alert)
        with patch("app.alerts.monotonic", return_value=LIFETIME + 1):
            self.assertEqual(store.read(token), [])
            new, created = store.append(token, alert)
        self.assertTrue(created)
        self.assertNotEqual(new, token)

    def test_rounding_and_bounds(self):
        fmt = MarketplaceFormat("en-US")
        self.assertEqual(fmt.validate_alert("a@b", "12.505", "T")[1], 1251)
        self.assertIsNone(fmt.validate_alert("a@b", "92233720368547758.08", "T")[1])
