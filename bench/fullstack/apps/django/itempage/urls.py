from django.conf import settings
from django.urls import path
from django.views.decorators.cache import cache_control

from . import catalog_views, live, marketplace_views, views

# Under the matched tier's profile (settings.PROFILE) the pages and the JSON are marked
# `private, no-cache` with Django's cache_control (never_cache adds no-store, for which
# ConditionalGetMiddleware writes no ETag); the static files keep WhiteNoise's own headers.
private = cache_control(private=True, no_cache=True) if settings.PROFILE else (lambda view: view)

urlpatterns = [
    path("marketplace/<str:locale>/<str:record_id>", private(marketplace_views.show), name="marketplace"),
    path("api/marketplace/<str:record_id>", private(marketplace_views.record_json)),
    path("", private(views.home)),
    path("items/<str:item_id>", private(views.item)),
    path("api/items/<str:item_id>", private(views.item_json)),
    path("catalog/<str:record_id>", private(catalog_views.show), name="catalog"),
    path("api/catalog/<str:record_id>", private(catalog_views.record_json), name="catalog_json"),
    path("live/prices", live.prices),
    path("live/publish", live.publish),
]
