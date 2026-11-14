"""Exercise Gunicorn's HTTP parser, not Django's in-process test client."""
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest


class GunicornRefreshTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.listener = socket.socket()
        cls.listener.bind(("127.0.0.1", 0))
        cls.listener.listen()
        cls.port = cls.listener.getsockname()[1]
        cls.log = tempfile.TemporaryFile()
        cls.addClassCleanup(cls.log.close)
        cls.addClassCleanup(cls.listener.close)
        cls.server = subprocess.Popen(
            [sys.executable, "-m", "gunicorn", "itempage.wsgi:application",
             "--bind", f"fd://{cls.listener.fileno()}", "--workers", "1", "--preload"],
            cwd=Path(__file__).resolve().parent.parent,
            env={**os.environ, "PROFILE": "defaults"},
            pass_fds=(cls.listener.fileno(),), stdout=cls.log, stderr=cls.log,
        )
        cls.addClassCleanup(cls.stop_server)
        until = time.monotonic() + 30
        while time.monotonic() < until and cls.server.poll() is None:
            try:
                if cls.request(b"").startswith(b"HTTP/1.1 200 "):
                    return
            except (OSError, TimeoutError):
                pass
            time.sleep(0.05)
        cls.log.seek(0)
        raise AssertionError(f"Gunicorn did not start: {cls.log.read().decode()}")

    @classmethod
    def stop_server(cls):
        cls.server.terminate()
        try:
            cls.server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.server.kill()
            cls.server.wait(timeout=5)

    @classmethod
    def request(cls, headers, body=b"", method=b"GET"):
        with socket.create_connection(("127.0.0.1", cls.port), timeout=2) as client:
            client.sendall(method + b" /api/alerts HTTP/1.1\r\nHost: localhost\r\n"
                           + b"Connection: close\r\n" + headers + b"\r\n" + body)
            response = b""
            while chunk := client.recv(65536):
                response += chunk
            return response

    def test_normal_get_head_and_chunked_request_remain_valid(self):
        response = self.request(b"")
        self.assertTrue(response.startswith(b"HTTP/1.1 200 "), response)
        self.assertEqual(response.split(b"\r\n\r\n", 1)[1], b"[]")
        response = self.request(b"", method=b"HEAD")
        self.assertTrue(response.startswith(b"HTTP/1.1 200 "), response)
        self.assertEqual(response.split(b"\r\n\r\n", 1)[1], b"")
        response = self.request(b"Transfer-Encoding: chunked\r\n", b"0\r\n\r\n")
        self.assertTrue(response.startswith(b"HTTP/1.1 200 "), response)

    def test_ambiguous_framing_is_rejected_before_django(self):
        for headers in [
            b"Transfer-Encoding: identity\r\n",
            b"Transfer-Encoding: gzip\r\nContent-Length: 0\r\n",
            b"Content-Length: +0\r\n",
            b"Content-Length : 0\r\n",
        ]:
            with self.subTest(headers=headers):
                response = self.request(headers)
                self.assertTrue(response.startswith(b"HTTP/1.1 400 "), response)
        self.assertTrue(self.request(b"").startswith(b"HTTP/1.1 200 "))
