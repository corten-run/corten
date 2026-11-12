from django.http import JsonResponse
from django.utils.cache import add_never_cache_headers
from django.views.decorators.http import require_safe


class ProductionHeadersMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        response.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        add_never_cache_headers(response)
        return response


@require_safe
def health_live(request):
    return JsonResponse({"status": "ok"})
