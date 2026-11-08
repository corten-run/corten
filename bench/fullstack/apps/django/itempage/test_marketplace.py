from copy import deepcopy
from decimal import Decimal
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

from django.test import Client, SimpleTestCase, override_settings
import requests

from .marketplace import LABELS, MarketplaceFormat, MarketplaceSource


RECORDS = json.loads(Path(__file__).with_name("marketplace_test_fixture.json").read_text())


@override_settings(STORAGES={"staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"}})
class MarketplaceTests(SimpleTestCase):
    def setUp(self):
        self.records = deepcopy(RECORDS)
        self.source = Mock()
        self.source.get.side_effect = self.records.get
        self.patcher = patch("itempage.marketplace_views.source", self.source)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def test_localized_pages_and_numeric_json(self):
        for locale in LABELS:
            response = self.client.get(f"/marketplace/{locale}/item_1")
            self.assertEqual(response.status_code, 200)
            self.assertContains(response, f'<html lang="{locale}">')
            self.assertContains(response, '&lt;script&gt;&quot;Dragon&quot;&lt;/script&gt;')
            self.assertContains(response, f'/marketplace/{locale}/item_2')
            self.assertContains(response, 'class="marketplace__image"', count=2)
            self.assertContains(response, 'data-offer-id=', count=5)
            self.assertContains(response, 'class="marketplace__included"')
            self.assertContains(response, 'name="csrfmiddlewaretoken"')
            self.assertEqual(self.client.get('/api/marketplace/item_1').json(), RECORDS['item_1'])
        self.records['item_1']['summary']['lowest_minor'] = 1
        self.assertContains(self.client.get('/marketplace/en-US/item_1'), '$0.01')

    def test_order_filter_and_offers(self):
        response = self.client.get('/marketplace/fr-FR/item_1', {'sort': 'desc', 'offers': 'all'})
        self.assertEqual([row['id'] for row in response.context['listings']],
            ['listing_5', 'listing_4', 'listing_3', 'listing_8', 'listing_2', 'listing_1', 'listing_0', 'listing_6', 'listing_7'])
        self.assertContains(response, 'data-offer-id=', count=7)
        response = self.client.get('/marketplace/en-US/item_1', {'seller': ' Alice'})
        self.assertEqual([row['id'] for row in response.context['listings']], ['listing_8'])
        self.assertContains(response, 'seller=+Alice&amp;sort=asc&amp;offers=all')
        self.assertContains(self.client.get('/marketplace/en-US/item_1', {'seller': 'alice'}), 'data-listing-id=', count=0)

    def test_empty_statuses_and_csrf(self):
        response = self.client.get('/marketplace/de-DE/item_2')
        self.assertContains(response, LABELS['de-DE']['no_listings'])
        self.assertNotContains(response, 'marketplace__subtitle')
        self.assertContains(response, '<ul class="marketplace__badges"></ul>')
        self.assertEqual(self.client.get('/marketplace/es-ES/item_1').status_code, 400)
        for path in ['/marketplace/en-US/missing', '/api/marketplace/missing']:
            self.assertEqual(self.client.get(path).status_code, 404)
        client = Client(enforce_csrf_checks=True)
        path = '/marketplace/en-US/item_1'
        self.assertEqual(client.post(path, {'email': 'a@b', 'target_price': '12.50'}).status_code, 403)
        client.get(path)
        response = client.post(path, {'email': 'a@b', 'target_price': '12.50', 'csrfmiddlewaretoken': client.cookies['csrftoken'].value})
        self.assertContains(response, 'Alert set:')

    def test_formatting_boundaries_and_alerts(self):
        prices = [0, 1, 10, 125, 123450, 123456789, -123450]
        expected = {
            'en-US': ['$0.00', '$0.01', '$0.10', '$1.25', '$1,234.50', '$1,234,567.89', '-$1,234.50'],
            'fr-FR': ['0,00 $US', '0,01 $US', '0,10 $US', '1,25 $US', '1 234,50 $US', '1 234 567,89 $US', '-1 234,50 $US'],
            'de-DE': ['0,00 $', '0,01 $', '0,10 $', '1,25 $', '1.234,50 $', '1.234.567,89 $', '-1.234,50 $'],
        }
        for locale in LABELS:
            fmt = MarketplaceFormat(locale)
            normalize = lambda s: s.replace('\u00a0', ' ').replace('\u202f', ' ')
            self.assertEqual([normalize(fmt.money(n)) for n in prices], expected[locale])
            self.assertEqual([fmt.rating(n) for n in [0, 400, 425, 475, 499]],
                ['0', '4', '4.3', '4.8', '5'] if locale == 'en-US' else ['0', '4', '4,3', '4,8', '5'])
            for n in [0, 1, 2, 1000, 1000000]:
                word = LABELS[locale]['listing_many' if locale == 'fr-FR' and n == 1000000 else 'listing_one' if n == 1 or (locale == 'fr-FR' and n == 0) else 'listing_other']
                self.assertTrue(fmt.count(n).endswith(' ' + word))
            path = f'/marketplace/{locale}/item_1'
            target = '12.50' if locale == 'en-US' else '12,50'
            response = self.client.post(path, {'email': '<a>@b', 'target_price': target})
            self.assertEqual(response.status_code, 200)
            self.assertContains(response, '&lt;a&gt;@b')
            self.assertIn(fmt.amount(Decimal('12.50')), response.context['message'])
            for email, price, key in [('invalid', target, 'invalid_email'), ('a@b', '0', 'invalid_price'), ('a@b', '12bad', 'invalid_price'), ('a@b', 'NaN', 'invalid_price')]:
                self.assertEqual(self.client.post(path, {'email': email, 'target_price': price}).context['message'], LABELS[locale][key])

    def test_fixture_once_and_uncached_http(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'marketplace.json'
            path.write_text(json.dumps(RECORDS))
            with patch.dict(os.environ, MARKETPLACE_SOURCE='fixture', MARKETPLACE_FIXTURE_PATH=str(path)):
                source = MarketplaceSource()
            path.unlink()
            self.assertEqual(source.get('item_1'), RECORDS['item_1'])
            self.assertIsNone(source.get('missing'))
        with patch.dict(os.environ, MARKETPLACE_SOURCE='api', API_BASE='http://example.test/base'):
            source = MarketplaceSource()
        response = Mock(status_code=200)
        response.json.side_effect = [RECORDS['item_1'], RECORDS['item_2']]
        source.session.get = Mock(return_value=response)
        self.assertEqual(source.get('a/b ?')['id'], 'item_1')
        self.assertEqual(source.get('a/b ?')['id'], 'item_2')
        self.assertEqual(source.session.get.call_count, 2)
        source.session.get.assert_called_with('http://example.test/base/marketplace/records/a%2Fb%20%3F', allow_redirects=False, timeout=10)
        response.status_code = 302
        with self.assertRaises(requests.HTTPError):
            source.get('item_1')
        response.status_code = 404
        self.assertIsNone(source.get('missing'))
        response.status_code = 503
        response.raise_for_status.side_effect = requests.HTTPError('failed')
        with self.assertRaises(requests.HTTPError):
            source.get('item_1')
