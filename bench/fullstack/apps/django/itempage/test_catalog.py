import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

from django.test import SimpleTestCase
import requests

from .catalog import CatalogRecord, CatalogSource


RECORD = {
    "id": "record_1", "title": '<script>"title"</script>', "subtitle": "A & B", "description": "001.50",
    "tags": ["<tag>", "second"],
    "fields": [{"name": "Access", "value": "<north>"}, {"name": "access", "value": "south"}],
    "related": [{"id": "record_2", "title": "<Related>"}],
}
EMPTY = {**RECORD, "id": "record_2", "tags": [], "fields": [], "related": []}


class CatalogTests(SimpleTestCase):
    def setUp(self):
        self.source = Mock()
        self.source.get.side_effect = lambda key: {"record_1": CatalogRecord.from_dict(RECORD), "record_2": CatalogRecord.from_dict(EMPTY)}.get(key)
        self.mock_source = patch("itempage.catalog_views.source", self.source)
        self.mock_source.start()
        self.addCleanup(self.mock_source.stop)

    def test_page_filter_and_escaping(self):
        response = self.client.get("/catalog/record_1", {"field": "A"})
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "&lt;script&gt;&quot;title&quot;&lt;/script&gt;")
        self.assertContains(response, "&lt;north&gt;")
        self.assertNotContains(response, "south")
        self.assertContains(response, 'name="field" value="A"')
        self.assertContains(response, 'action="/catalog/record_1"')
        self.assertContains(response, 'href="/catalog/record_2"')
        self.assertContains(response, "catalog.")
        self.source.get.assert_called_once_with("record_1")

    def test_unfiltered_and_literal_prefix(self):
        self.assertContains(self.client.get("/catalog/record_1"), "south")
        response = self.client.get("/catalog/record_1", {"field": ' <"'})
        self.assertContains(response, 'value=" &lt;&quot;"')
        self.assertNotContains(response, "<th scope=\"row\">")

    def test_json_empty_lists_and_missing_records(self):
        self.assertEqual(self.client.get("/api/catalog/record_1").json(), RECORD)
        response = self.client.get("/catalog/record_2")
        self.assertContains(response, '<ul aria-label="Tags"></ul>')
        self.assertContains(response, "<tbody></tbody>")
        self.assertContains(response, '<nav aria-label="Related records"><ul></ul></nav>')
        self.assertEqual(self.client.get("/api/catalog/record_2").json(), EMPTY)
        for path in ("/catalog/missing", "/api/catalog/missing"):
            self.assertEqual(self.client.get(path).status_code, 404)

    def test_fixture_is_read_once(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.json"
            path.write_text(json.dumps({"record_1": RECORD}), encoding="utf-8")
            with patch.dict(os.environ, CATALOG_SOURCE="fixture", CATALOG_FIXTURE_PATH=str(path)):
                source = CatalogSource()
            path.unlink()
            self.assertEqual(source.get("record_1").to_dict(), RECORD)
            self.assertIsNone(source.get("missing"))

    def test_api_fetches_and_parses_on_each_call(self):
        with patch.dict(os.environ, CATALOG_SOURCE="api", API_BASE="http://example.test/base"):
            source = CatalogSource()
        response = Mock(status_code=200)
        response.json.side_effect = [RECORD, {**RECORD, "title": "changed"}]
        source.session.get = Mock(return_value=response)
        self.assertEqual(source.get("record_1").title, RECORD["title"])
        self.assertEqual(source.get("record_1").title, "changed")
        self.assertEqual(response.json.call_count, 2)
        self.assertEqual(source.session.get.call_count, 2)
        source.session.get.assert_called_with("http://example.test/base/catalog/records/record_1")
        response.status_code = 404
        self.assertIsNone(source.get("missing"))
        response.status_code = 503
        response.raise_for_status.side_effect = requests.HTTPError("upstream failed")
        with self.assertRaises(requests.HTTPError):
            source.get("record_1")

    def test_invalid_records_fail_instead_of_coercing(self):
        for value in ({**RECORD, "subtitle": 123}, {**RECORD, "tags": None}, {**RECORD, "fields": [{"name": "a", "value": 1}]}):
            with self.assertRaises(ValueError):
                CatalogRecord.from_dict(value)
