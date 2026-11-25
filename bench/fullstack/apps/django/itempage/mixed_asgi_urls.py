from . import mixed_asgi_views
from .urls import routes


urlpatterns = routes(mixed_asgi_views.show, mixed_asgi_views.record_json)
