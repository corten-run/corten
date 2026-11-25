"""Mixed marketplace views with the outbound read owned by Django's ASGI request."""
import asyncio
from urllib.parse import quote

from asgiref.sync import sync_to_async
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
import httpx

from .marketplace import source, validate_record
from .marketplace_views import page_request_error, page_response, page_timeout


async def read_record(request, record_id):
    if source.fixture is not None:
        return source.fixture.get(record_id)
    traceparent = request.headers.get("traceparent")
    headers = None if traceparent is None else {"traceparent": traceparent.encode("latin-1")}
    client = request.scope["state"]["marketplace_client"]
    # Bound the entire read, including a trickling body. Django cancels this
    # await on http.disconnect; do not catch or detach that cancellation.
    async with asyncio.timeout(10):
        response = await client.get(f"{source.base}/marketplace/records/{quote(record_id, safe='')}", headers=headers)
    if response.status_code == 404:
        return None
    response.raise_for_status()
    record = response.json()
    validate_record(record, record_id)
    return record


@require_http_methods(["GET", "POST"])
async def show(request, locale, record_id):
    rejected = page_request_error(request, locale)
    if rejected is not None:
        return rejected
    try:
        record = await read_record(request, record_id)
    except (TimeoutError, httpx.TimeoutException):
        return page_timeout()
    return await sync_to_async(page_response)(request, locale, record_id, record)


@csrf_exempt
async def record_json(request, record_id):
    if request.method not in ("GET", "HEAD"):
        return JsonResponse({"error": "Method Not Allowed"}, status=405, headers={"Allow": "GET, HEAD"})
    try:
        record = await read_record(request, record_id)
        if record is None:
            return JsonResponse({"error": "Not Found"}, status=404)
        return JsonResponse(record)
    except (TimeoutError, httpx.HTTPError, TypeError, ValueError):
        return JsonResponse({"error": "Internal Server Error"}, status=500)
