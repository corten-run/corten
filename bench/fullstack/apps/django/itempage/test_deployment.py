from django.test import SimpleTestCase

from start_matched import command


class DeploymentTests(SimpleTestCase):
    def test_native_production_arguments(self):
        args = command({"MAX_CONNECTIONS": "1000"})
        self.assertEqual(args[0], "granian")
        self.assertEqual(args[-1], "itempage.wsgi:application")
        for flag, value in {
            "--interface": "wsgi", "--workers": "1", "--blocking-threads": "3",
            "--runtime-threads": "1", "--runtime-blocking-threads": "1",
            "--backpressure": "1000", "--http1-header-read-timeout": "30000",
            "--http1-buffer-size": "8192",
        }.items():
            self.assertEqual(args[args.index(flag) + 1], value)
        args = command({"MAX_CONNECTIONS": "1200"})
        self.assertEqual(args[args.index("--backpressure") + 1], "1200")

    def test_invalid_connection_settings_fail_instead_of_silently_disabling(self):
        for value in ["0", "-1", "", "unlimited", "1.5"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                command({"MAX_CONNECTIONS": value})
