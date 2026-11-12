"""The FastAPI app's own tests (python -m unittest, with requirements.txt installed): formatting,
the page's rows and links, the cross-site post check, and both sources, each read per request.
Run them with the profile off, or with HOSTS=testserver under PROFILE=matched (its host list
refuses the test client's host)."""
import asyncio
from copy import deepcopy
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

from . import main
from .marketplace import LABELS, MarketplaceFormat, MarketplaceRecord, MarketplaceSource

RECORD = {
    "id": "item_1", "title": '<script>&"{price}', "subtitle": "", "description": "<b>Data</b>",
    "categories": [{"name": "Cards", "slug": "cards"}], "badges": ["Rare"], "tags": ["foil"],
    "images": ["/one.webp", "/two.webp"], "fields": [{"name": "Set", "value": "Ember"}],
    "summary": {"lowest_minor": -123450, "count": 1000000, "quantity": 1234},
    "listings": [
        {"id": "a", "seller": "Alice", "rating_hundredths": 425, "reviews": 1234, "condition": "NM", "ships_from": "US", "quantity": 2, "price_minor": 100},
        {"id": "b", "seller": "Alice B", "rating_hundredths": 499, "reviews": 0, "condition": "NM", "ships_from": "DE", "quantity": 1000, "price_minor": 100},
        {"id": "c", "seller": "bob", "rating_hundredths": None, "reviews": 1, "condition": "", "ships_from": "FR", "quantity": 0, "price_minor": None},
        {"id": "d", "seller": "Alice", "rating_hundredths": 0, "reviews": 2, "condition": "NM", "ships_from": "US", "quantity": 1, "price_minor": -1},
    ],
    "offers": [{"id": f"offer_{i}", "buyer": "Buyer", "condition": "NM", "quantity": 1000, "price_minor": None if i == 0 else i} for i in range(7)],
    "contents": [{"id": "line_1", "item_id": "item/2", "title": "Other", "quantity": 1000}],
    "included_in": [{"id": "line_2", "item_id": "item_3", "title": "Bundle", "quantity": 2}],
}


def spaces(text):
    return text.replace("\u00a0", " ").replace("\u202f", " ")


class FormattingTests(unittest.TestCase):
    def test_money_ratings_counts_and_alerts(self):
        prices = [0, 1, 10, 125, 123450, 123456789, -123450]
        expected = {
            "en-US": ["$0.00", "$0.01", "$0.10", "$1.25", "$1,234.50", "$1,234,567.89", "-$1,234.50"],
            "fr-FR": ["0,00 $US", "0,01 $US", "0,10 $US", "1,25 $US", "1 234,50 $US", "1 234 567,89 $US", "-1 234,50 $US"],
            "de-DE": ["0,00 $", "0,01 $", "0,10 $", "1,25 $", "1.234,50 $", "1.234.567,89 $", "-1.234,50 $"],
        }
        for locale in LABELS:
            fmt = MarketplaceFormat(locale)
            self.assertEqual([spaces(fmt.money(n)) for n in prices], expected[locale])
            self.assertEqual([fmt.rating(n) for n in [0, 400, 425, 475, 499]],
                ["0", "4", "4.3", "4.8", "5"] if locale == "en-US" else ["0", "4", "4,3", "4,8", "5"])
            for n in [0, 1, 2, 1000, 1000000]:
                key = "listing_many" if locale == "fr-FR" and n == 1000000 else "listing_one" if n == 1 or (locale == "fr-FR" and n == 0) else "listing_other"
                self.assertEqual(fmt.count(n), f"{fmt.number(n)} {LABELS[locale][key]}")
            target = "1234.50" if locale == "en-US" else "1234,50"
            message = fmt.alert("a@example.test", target, "{email} $&")
            self.assertIn("{email} $&", message)
            self.assertIn(fmt.money(123450), message)
            self.assertEqual(fmt.alert("bad", target, "T"), LABELS[locale]["invalid_email"])
            for bad in ["", "0", "-1", "NaN", "Infinity", "1e3", "12wrong"]:
                self.assertEqual(fmt.alert("a@b", bad, "T"), LABELS[locale]["invalid_price"], bad)


class PageTests(unittest.TestCase):
    def setUp(self):
        self.records = {"item_1": deepcopy(RECORD)}
        patcher = patch.object(main, "marketplace_source", AsyncMock())
        self.source = patcher.start()
        self.addCleanup(patcher.stop)
        self.source.get.side_effect = lambda record_id: None if record_id not in self.records else MarketplaceRecord.model_validate(self.records[record_id])
        self.client = TestClient(main.app)

    def test_pages_are_escaped_localized_and_complete(self):
        for locale in LABELS:
            html = self.client.get(f"/marketplace/{locale}/item_1").text
            self.assertIn(f'<html lang="{locale}">', html)
            self.assertIn("&lt;script&gt;&amp;&#34;{price}", html)
            self.assertNotIn("<script>&", html)
            self.assertEqual(html.count("data-offer-id="), 5)
            self.assertIn(f'href="/marketplace/{locale}/item%2F2">Other</a> × ', html)
            self.assertIn("offers=all", html)
            all_offers = self.client.get(f"/marketplace/{locale}/item_1", params={"offers": "all"}).text
            self.assertEqual(all_offers.count("data-offer-id="), 7)
            self.assertNotIn('class="marketplace__more"', all_offers)
        self.records["item_1"]["summary"]["lowest_minor"] = 1
        self.assertIn("$0.01", self.client.get("/marketplace/en-US/item_1").text)
        self.assertEqual(self.client.get("/api/marketplace/item_1").json(), self.records["item_1"])

    def test_sort_filter_and_statuses(self):
        def rows(**params):
            html = self.client.get("/marketplace/en-US/item_1", params=params).text
            return [part.split('"')[0] for part in html.split('data-listing-id="')[1:]]
        self.assertEqual(rows(), ["d", "a", "b", "c"])
        self.assertEqual(rows(sort="desc"), ["a", "b", "d", "c"])
        self.assertEqual(rows(seller="Alice B"), ["b"])
        self.assertEqual(rows(seller="alice"), [])
        self.assertEqual(self.client.get("/marketplace/es-ES/item_1").status_code, 400)
        for path in ["/marketplace/en-US/missing", "/api/marketplace/missing"]:
            self.assertEqual(self.client.get(path).status_code, 404)

    def test_a_cross_site_post_is_refused(self):
        form = {"email": "<a>@b", "target_price": "12.50"}
        path = "/marketplace/en-US/item_1"
        posted = self.client.post(path, data=form, headers={"origin": "http://testserver"})
        self.assertEqual(posted.status_code, 200)
        self.assertIn("&lt;a&gt;@b", posted.text)
        self.assertEqual(self.client.post(path, data=form).status_code, 200)
        calls = self.source.get.call_count
        for headers in [{"origin": "http://attacker.test"}, {"sec-fetch-site": "cross-site"}]:
            self.assertEqual(self.client.post(path, data=form, headers=headers).status_code, 403)
        self.assertEqual(self.source.get.call_count, calls)

    def test_each_route_reads_the_upstream_once_and_serializes_its_own_json(self):
        reads = []

        def answer(request):
            reads.append(request.url.raw_path.decode())
            # Spaced out, so an answer passed through as it came would not equal FastAPI's own.
            return httpx.Response(200, content=json.dumps({**RECORD, "title": str(len(reads))}, indent=2), headers={"content-type": "application/json"})

        source = MarketplaceSource()
        source.fixture = None
        source.client = httpx.AsyncClient(base_url="http://upstream.test", transport=httpx.MockTransport(answer), follow_redirects=False)
        with patch.object(main, "marketplace_source", source):
            self.assertIn("<h1>1</h1>", self.client.get("/marketplace/en-US/item_1").text)
            self.assertIn("<h1>2</h1>", self.client.get("/marketplace/de-DE/item_1").text)
            first = self.client.get("/api/marketplace/item_1")
            self.assertEqual(first.json()["title"], "3")
            self.assertNotIn(b"\n", first.content)
            self.assertEqual(self.client.get("/api/marketplace/item_1").json()["title"], "4")
        self.assertEqual(reads, ["/marketplace/records/item_1"] * 4)
        asyncio.run(source.client.aclose())

    def test_an_upstream_failure_is_a_502(self):
        self.source.get.side_effect = httpx.ConnectError("refused")
        for path in ["/marketplace/en-US/item_1", "/api/marketplace/item_1"]:
            self.assertEqual(self.client.get(path).status_code, 502)

    def test_a_record_that_is_not_one_is_a_502(self):
        bad = [{**RECORD, "extra": 1}, {k: v for k, v in RECORD.items() if k != "offers"}, {**RECORD, "summary": {**RECORD["summary"], "count": "1"}},
            {**RECORD, "listings": [{**RECORD["listings"][0], "rating_hundredths": 501}]}]
        for record in bad:
            source = MarketplaceSource()
            source.fixture = None
            source.client = httpx.AsyncClient(base_url="http://upstream.test", transport=httpx.MockTransport(lambda request: httpx.Response(200, json=record)))
            with patch.object(main, "marketplace_source", source):
                for path in ["/marketplace/en-US/item_1", "/api/marketplace/item_1"]:
                    self.assertEqual(self.client.get(path).status_code, 502, (path, record.keys()))
            asyncio.run(source.client.aclose())


class SourceTests(unittest.IsolatedAsyncioTestCase):
    async def test_fixture_is_read_once_at_startup(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "marketplace.json"
            path.write_text(json.dumps({"item_1": RECORD}))
            with patch.dict(os.environ, MARKETPLACE_SOURCE="fixture", MARKETPLACE_FIXTURE_PATH=str(path)):
                source = MarketplaceSource()
            path.unlink()
            self.assertEqual((await source.get("item_1")).model_dump(), RECORD)
            self.assertIsNone(await source.get("missing"))

    async def test_api_is_fetched_per_request_without_redirects(self):
        requests = []
        status = {"code": 200}

        def answer(request):
            requests.append(request.url.raw_path.decode())
            if status["code"] == 302:
                return httpx.Response(302, headers={"location": "/marketplace/records/target"})
            return httpx.Response(status["code"], json={**RECORD, "title": str(len(requests))})

        with patch.dict(os.environ, {"API_BASE": "http://upstream.test"}):
            os.environ.pop("MARKETPLACE_SOURCE", None)
            source = MarketplaceSource()
        source.client = httpx.AsyncClient(base_url="http://upstream.test", transport=httpx.MockTransport(answer), follow_redirects=False)
        self.assertEqual((await source.get("item/1")).title, "1")
        self.assertEqual((await source.get("item/1")).title, "2")
        self.assertEqual(requests, ["/marketplace/records/item%2F1"] * 2)
        status["code"] = 404
        self.assertIsNone(await source.get("item_1"))
        for code in [302, 503]:
            status["code"] = code
            requests.clear()
            with self.assertRaises(httpx.HTTPStatusError):
                await source.get("item_1")
            self.assertEqual(requests, ["/marketplace/records/item_1"])


if __name__ == "__main__":
    unittest.main()
