"""Launch the matched image using native Granian limits, not application caps."""
import os


def command(environ):
    connections = int(environ.get("MAX_CONNECTIONS", "1000"))
    if connections < 1:
        raise ValueError("MAX_CONNECTIONS must be positive")
    return [
        "granian", "--interface", "wsgi", "--workers", "1",
        "--host", "0.0.0.0", "--port", "8080",
        "--backpressure", str(connections),
        "--runtime-threads", "1", "--runtime-blocking-threads", "1",
        "--blocking-threads", "3", "--http", "1",
        "--http1-header-read-timeout", "30000", "--http1-buffer-size", "8192",
        "itempage.wsgi:application",
    ]


if __name__ == "__main__":
    argv = command(os.environ)
    os.execvp(argv[0], argv)
