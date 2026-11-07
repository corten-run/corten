from django.urls import path

from . import catalog_views, live, views

urlpatterns = [
    path("", views.home),
    path("items/<str:item_id>", views.item),
    path("api/items/<str:item_id>", views.item_json),
    path("catalog/<str:record_id>", catalog_views.show, name="catalog"),
    path("api/catalog/<str:record_id>", catalog_views.record_json, name="catalog_json"),
    path("live/prices", live.prices),
    path("live/publish", live.publish),
]
