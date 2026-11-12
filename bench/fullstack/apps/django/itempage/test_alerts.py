from datetime import timedelta
from unittest.mock import patch

from django.contrib.sessions.models import Session
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from .models import Alert
from .test_marketplace import RECORDS


@override_settings(STORAGES={"staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"}})
class AlertTests(TestCase):
    def setUp(self):
        patcher = patch("itempage.marketplace_views.source")
        source = patcher.start()
        source.get.side_effect = RECORDS.get
        self.addCleanup(patcher.stop)
        self.client = Client(enforce_csrf_checks=True)
        self.client.get("/marketplace/en-US/item_1")
        self.token = self.client.cookies["csrftoken"].value

    def post(self, locale="en-US", **data):
        return self.client.post(f"/marketplace/{locale}/item_1", {"email": "a@b", "target_price": "12.50", "csrfmiddlewaretoken": self.token, **data})

    def test_native_rows_readback_order_and_rejections(self):
        self.assertEqual(self.client.get("/api/alerts").json(), [])
        self.assertEqual(Session.objects.count(), 0)
        for locale, target, minor in [("en-US", "12.505", 1251), ("fr-FR", "1,25", 125), ("de-DE", "2,50", 250)]:
            self.assertEqual(self.post(locale, target_price=target).status_code, 200)
            self.assertEqual(self.client.get("/api/alerts").json()[-1], {"item_id": "item_1", "email": "a@b", "target_minor": minor})
        expected = self.client.get("/api/alerts").json()
        self.assertEqual(len(expected), 3)
        for data in [{"email": "bad"}, {"target_price": "NaN"}, {"target_price": "0"}, {"target_price": "1e100"}, {"target_price": ""}]:
            self.assertEqual(self.post(**data).status_code, 200)
        self.assertEqual(self.client.post("/marketplace/en-US/missing", {"csrfmiddlewaretoken": self.token}).status_code, 404)
        self.assertEqual(self.client.post("/marketplace/en-US/item_1", {"email": "a@b", "target_price": "2"}).status_code, 403)
        for headers in [{"HTTP_ORIGIN": "http://evil.test"}, {"HTTP_SEC_FETCH_SITE": "cross-site"}]:
            self.assertEqual(self.client.post("/marketplace/en-US/item_1", {"csrfmiddlewaretoken": self.token, "email": "a@b", "target_price": "2"}, **headers).status_code, 403)
        for _ in range(2):
            response = self.client.get("/api/alerts")
            self.assertEqual(response.json(), expected)
            self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual(Alert.objects.count(), 3)
        other = Client()
        self.assertEqual(other.get("/api/alerts").json(), [])
        other.post("/marketplace/en-US/item_1", {"email": "other@b", "target_price": "2"})
        self.assertEqual(len(other.get("/api/alerts").json()), 1)
        self.assertEqual(self.client.get("/api/alerts").json(), expected)

    def test_forged_and_expired_sessions_cannot_read_or_reuse_alerts(self):
        self.client.cookies["sessionid"] = "x" * 32
        response = self.post()
        self.assertNotEqual(self.client.cookies["sessionid"].value, "x" * 32)
        self.assertTrue(response.cookies["sessionid"]["httponly"])
        self.assertEqual(response.cookies["sessionid"]["samesite"], "Lax")
        Session.objects.update(expire_date=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.client.get("/api/alerts").json(), [])
        self.assertEqual(Alert.objects.count(), 1)
        self.post()
        self.assertEqual(len(self.client.get("/api/alerts").json()), 1)
        self.assertEqual(Alert.objects.count(), 2)
