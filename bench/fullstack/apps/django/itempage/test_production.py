from copy import deepcopy
import gzip
import json
import os
from pathlib import Path
from unittest import skipIf, skipUnless
from unittest.mock import Mock, patch

from django.conf import settings
from django.test import Client, SimpleTestCase, TestCase, override_settings


RECORDS = json.loads(Path(__file__).with_name("marketplace_test_fixture.json").read_text())


@skipUnless(os.environ.get("PROFILE") == "matched", "production profile only")
class ProductionTests(TestCase):
    def setUp(self):
        self.source = Mock()
        self.source.get.side_effect = deepcopy(RECORDS).get
        patcher = patch("itempage.marketplace_views.source", self.source)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_security_and_private_cache_on_pages_json_and_errors(self):
        for path in ('/marketplace/en-US/item_1', '/api/marketplace/item_1',
                '/marketplace/en-US/missing', '/api/marketplace/missing'):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertIn("script-src 'self'", response.get('Content-Security-Policy', ''))
                self.assertNotIn('unsafe-', response.get('Content-Security-Policy', ''))
                self.assertEqual(response.get('X-Content-Type-Options'), 'nosniff')
                self.assertEqual(response.get('Referrer-Policy'), 'same-origin')
                self.assertEqual(response.get('Cross-Origin-Opener-Policy'), 'same-origin')
                self.assertEqual(response.get('X-Frame-Options'), 'DENY')
                self.assertTrue(response.get('Permissions-Policy'))
                self.assertIn('private', response.get('Cache-Control', ''))
                self.assertIn('no-store', response.get('Cache-Control', ''))

    def test_gzip_is_negotiated_and_decodes_to_the_native_content(self):
        for path in ('/marketplace/en-US/item_1', '/api/marketplace/item_1'):
            response = self.client.get(path, HTTP_ACCEPT_ENCODING='br, gzip')
            self.assertEqual(response.get('Content-Encoding'), 'gzip')
            content = gzip.decompress(response.content)
            if path.startswith('/api/'):
                self.assertEqual(json.loads(content), RECORDS['item_1'])
            else:
                self.assertIn(b'&lt;script&gt;', content)
            self.assertIn('Accept-Encoding', response.get('Vary', ''))
            self.assertNotIn('Content-Encoding', self.client.get(path, HTTP_ACCEPT_ENCODING='identity'))

    def test_unknown_host_is_rejected_before_the_source(self):
        for path in ('/marketplace/en-US/item_1', '/api/marketplace/item_1', '/health/live', '/static/style.css'):
            self.assertEqual(self.client.get(path, HTTP_HOST='unrecognized.invalid').status_code, 400)
        self.source.get.assert_not_called()

    def test_static_cache_is_not_made_private(self):
        response = self.client.get('/static/style.css')
        self.assertEqual(response.status_code, 200)
        self.assertIn('public', response.get('Cache-Control', ''))
        self.assertNotIn('private', response.get('Cache-Control', ''))

    def test_liveness_is_independent_of_the_upstream(self):
        self.source.get.side_effect = RuntimeError('upstream is unavailable')
        response = self.client.get('/health/live')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'status': 'ok'})
        self.assertEqual(self.client.head('/health/live').content, b'')
        self.source.get.assert_not_called()

    def test_oversized_form_is_rejected_by_django_and_csrf_remains_on(self):
        client = Client(enforce_csrf_checks=True)
        path = '/marketplace/en-US/item_1'
        self.assertEqual(client.post(path, {'email': 'a@b', 'target_price': '1'}).status_code, 403)
        client.get(path)
        token = client.cookies['csrftoken'].value
        response = client.post(path, {'email': 'a@b', 'target_price': 'x' * (3 * 1024 * 1024), 'csrfmiddlewaretoken': token})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(client.post(path, {'email': 'a@b', 'target_price': '1', 'csrfmiddlewaretoken': token}).status_code, 200)
        self.assertEqual(client.post(path, {'csrfmiddlewaretoken': token}, HTTP_ORIGIN='https://other.invalid').status_code, 403)

    @override_settings(ALLOWED_HOSTS=['testserver'])
    def test_errors_keep_security_headers(self):
        self.source.get.side_effect = ValueError('private upstream failure')
        client = Client(raise_request_exception=False)
        for path in ('/marketplace/en-US/item_1', '/api/marketplace/item_1'):
            response = client.get(path)
            self.assertEqual(response.status_code, 500)
            self.assertIn("script-src 'self'", response.get('Content-Security-Policy', ''))
            self.assertIn('private', response.get('Cache-Control', ''))


@skipIf(os.environ.get("PROFILE") == "matched", "default profile only")
class DefaultProfileTests(SimpleTestCase):
    def test_baseline_security_and_limits_remain_with_native_sessions(self):
        from . import settings as configured

        # Django's test runner appends testserver to the runtime host list.
        self.assertEqual(configured.ALLOWED_HOSTS, ['*'])
        self.assertEqual(settings.DATA_UPLOAD_MAX_MEMORY_SIZE, 2621440)
        self.assertEqual(settings.MIDDLEWARE, [
            'django.middleware.security.SecurityMiddleware',
            'whitenoise.middleware.WhiteNoiseMiddleware',
            'django.middleware.common.CommonMiddleware',
            'django.contrib.sessions.middleware.SessionMiddleware',
            'django.middleware.csrf.CsrfViewMiddleware',
            'django.middleware.clickjacking.XFrameOptionsMiddleware',
        ])
        self.assertEqual(self.client.get('/health/live').status_code, 404)
