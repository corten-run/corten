from django.conf import settings
from django.urls import path

from . import catalog_views, live, marketplace_views, views

urlpatterns = [
    path("marketplace/<str:locale>/<str:record_id>", marketplace_views.show, name="marketplace"),
    path("api/marketplace/<str:record_id>", marketplace_views.record_json),
    path("", views.home),
    path("items/<str:item_id>", views.item),
    path("api/items/<str:item_id>", views.item_json),
    path("catalog/<str:record_id>", catalog_views.show, name="catalog"),
    path("api/catalog/<str:record_id>", catalog_views.record_json, name="catalog_json"),
    path("live/prices", live.prices),
    path("live/publish", live.publish),
]

if "itempage.production.ProductionHeadersMiddleware" in settings.MIDDLEWARE:
    from .production import health_live

    urlpatterns.append(path("health/live", health_live))
