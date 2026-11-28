from urllib.parse import urlsplit

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured, ValidationError
from django.core.validators import URLValidator
from django.middleware.csrf import CsrfViewMiddleware


def parse_public_origin(value):
    try:
        URLValidator(schemes=["http", "https"])(value)
        url = urlsplit(value)
        host, port = url.hostname, url.port
        if ":" in host:
            host = f"[{host}]"
        authority = host if port in (None, {"http": 80, "https": 443}[url.scheme]) else f"{host}:{port}"
        if value.isascii() and port != 0 and value == f"{url.scheme}://{authority}":
            return url
    except (ValidationError, ValueError):
        pass
    raise ImproperlyConfigured("MARKETPLACE_PUBLIC_ORIGIN must be one serialized HTTP(S) origin.")


class MarketplaceCsrfViewMiddleware(CsrfViewMiddleware):
    def _uses_public_origin(self, request):
        return (
            request.method == "POST" and request.resolver_match.url_name == "marketplace"
            and request.get_host().lower() == settings.MARKETPLACE_PUBLIC_ORIGIN.netloc
        )

    def process_view(self, request, callback, callback_args, callback_kwargs):
        if "HTTP_ORIGIN" not in request.META and self._uses_public_origin(request):
            return self._reject(request, "The marketplace public origin is required.")
        return super().process_view(request, callback, callback_args, callback_kwargs)

    def _origin_verified(self, request):
        # Override only the expected origin; Django still checks its native cookie and form token.
        if self._uses_public_origin(request):
            return request.META["HTTP_ORIGIN"] == settings.MARKETPLACE_PUBLIC_ORIGIN.geturl()
        return super()._origin_verified(request)
