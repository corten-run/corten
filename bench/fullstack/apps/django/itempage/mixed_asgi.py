"""Django's ASGI handler plus one outbound connection pool per worker lifespan."""
import os

import httpx
from django.core.asgi import get_asgi_application

from .upstream import UPSTREAM_IDLE


if os.environ.setdefault("DJANGO_SETTINGS_MODULE", "itempage.mixed_asgi_settings") != "itempage.mixed_asgi_settings":
    raise RuntimeError("The Mixed ASGI entry point requires itempage.mixed_asgi_settings")
django = get_asgi_application()


async def application(scope, receive, send):
    if scope["type"] != "lifespan":
        await django(scope, receive, send)
        return

    await receive()  # lifespan.startup
    async with httpx.AsyncClient(
        timeout=10,
        follow_redirects=False,
        limits=httpx.Limits(max_connections=None, max_keepalive_connections=10, keepalive_expiry=UPSTREAM_IDLE),
    ) as client:
        scope["state"]["marketplace_client"] = client
        await send({"type": "lifespan.startup.complete"})
        await receive()  # lifespan.shutdown
    await send({"type": "lifespan.shutdown.complete"})
