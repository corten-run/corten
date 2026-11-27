from datetime import timedelta
from urllib.parse import urlsplit
from unittest.mock import patch

from django.conf import settings
from django.contrib.sessions.models import Session
from django.core.exceptions import ImproperlyConfigured
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from .marketplace_csrf import parse_public_origin
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

    def test_invalid_public_origins_are_rejected(self):
        for invalid in ("", "ftp://localhost:8080", "https://user@localhost:8080",
                        "https://localhost:8080/", "https://localhost:8080?", "https://localhost:8080#fragment",
                        "https://localhost:65536", "https://localhost:443"):
            with self.subTest(invalid=invalid), self.assertRaises(ImproperlyConfigured):
                parse_public_origin(invalid)

    @override_settings(
        MARKETPLACE_PUBLIC_ORIGIN=parse_public_origin("https://localhost:8080"),
        ALLOWED_HOSTS=["localhost", "127.0.0.1"],
        MIDDLEWARE=[
            ("itempage.marketplace_csrf.MarketplaceCsrfViewMiddleware"
             if name == "django.middleware.csrf.CsrfViewMiddleware" else name)
            for name in settings.MIDDLEWARE
        ],
    )
    def test_public_origin_keeps_direct_forms_and_native_csrf(self):
        path = "/marketplace/en-US/item_1"
        edge, direct = "https://localhost:8080", "http://127.0.0.1:8080"
        for host, origin in (("localhost:8080", edge), ("127.0.0.1:8080", direct)):
            with self.subTest(host=host):
                client = Client(enforce_csrf_checks=True)
                self.assertEqual(client.get(path, HTTP_HOST=host).status_code, 200)
                form = {"email": "a@b", "target_price": "12.50",
                        "csrfmiddlewaretoken": client.cookies["csrftoken"].value}
                headers = {"HTTP_HOST": host, "HTTP_ORIGIN": origin, "HTTP_SEC_FETCH_SITE": "same-origin"}
                self.assertEqual(client.post(path, form, **headers).status_code, 200)
                other_origins = ("http://localhost:8080", "https://localhost:8081", "https://wrong.test:8080") if origin == edge else (edge,)
                for other in other_origins:
                    url = urlsplit(other)
                    self.assertEqual(client.post(path, form, **(headers | {
                        "HTTP_ORIGIN": other, "HTTP_FORWARDED": f'proto={url.scheme};host="{url.netloc}"',
                        "HTTP_X_FORWARDED_PROTO": url.scheme, "HTTP_X_FORWARDED_HOST": url.netloc,
                    })).status_code, 403)
                if origin == edge:
                    self.assertEqual(client.post(path, form, **(headers | {"HTTP_SEC_FETCH_SITE": "cross-site"})).status_code, 403)
                    self.assertEqual(client.post(path, form, HTTP_HOST=host).status_code, 403)
                    self.assertEqual(client.post(path, form | {"csrfmiddlewaretoken": ""}, **headers).status_code, 403)
                    self.assertEqual(client.post("/items/item_1", form, **headers).status_code, 403)
                    with override_settings(ALLOWED_HOSTS=["127.0.0.1"]):
                        self.assertEqual(client.post(path, form, **headers).status_code, 400)
                self.assertEqual(len(client.get("/api/alerts", HTTP_HOST=host).json()), 1)
        self.assertEqual(Alert.objects.count(), 2)

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
