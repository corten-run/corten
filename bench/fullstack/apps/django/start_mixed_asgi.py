"""Select the standalone matched ASGI deployment, not the live override."""
import os

from start_matched import command


if __name__ == "__main__":
    argv = command(os.environ, asgi=True)
    os.execvp(argv[0], argv)
