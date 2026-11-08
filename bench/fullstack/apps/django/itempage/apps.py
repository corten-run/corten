from django.apps import AppConfig


class CatalogConfig(AppConfig):
    name = "itempage"

    def ready(self):
        # Warm fixtures during both WSGI and ASGI startup, before requests are served.
        from . import catalog  # noqa: F401
        from . import marketplace  # noqa: F401
