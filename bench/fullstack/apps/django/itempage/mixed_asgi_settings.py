import os

from django.core.exceptions import ImproperlyConfigured

from .settings import *  # noqa: F403


if os.environ.get("PROFILE") != "matched":
    raise ImproperlyConfigured("The Mixed ASGI deployment requires PROFILE=matched")

ROOT_URLCONF = "itempage.mixed_asgi_urls"
