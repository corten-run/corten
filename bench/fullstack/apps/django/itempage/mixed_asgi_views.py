"""Mixed marketplace views with the outbound read owned by Django's ASGI request."""
import asyncio
from urllib.parse import quote, urlencode

from asgiref.sync import sync_to_async
from django.http import Http404, HttpResponse, HttpResponseBadRequest, HttpResponseForbidden, JsonResponse
from django.shortcuts import render
from django.urls import reverse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
import httpx

from .marketplace import LABELS, MarketplaceFormat, source, validate_record
from .models import Alert


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
    if request.method == "POST" and request.headers.get("Sec-Fetch-Site") == "cross-site":
        return HttpResponseForbidden("Forbidden")
    if locale not in LABELS:
        return HttpResponseBadRequest("Unsupported locale")
    try:
        record = await read_record(request, record_id)
    except (TimeoutError, httpx.TimeoutException):
        return HttpResponse("Record source timed out", status=504, content_type="text/plain",
            headers={"Cache-Control": "private, no-store"})
    return await sync_to_async(page_response)(request, locale, record_id, record)


def page_response(request, locale, record_id, record):
    # Keep the existing WSGI view inlined; the socket test compares the two page bodies.
    if record is None:
        raise Http404
    fmt = MarketplaceFormat(locale)
    prefix = request.GET.get("seller", "")
    order = "desc" if request.GET.get("sort") == "desc" else "asc"
    show_all = request.GET.get("offers") == "all"
    listings = [row for row in record["listings"] if row["seller"].startswith(prefix)]
    listings.sort(key=lambda row: (row["price_minor"] is None, (row["price_minor"] or 0) * (-1 if order == "desc" else 1)))
    path = reverse("marketplace", args=[locale, record_id])
    summary = record["summary"]
    email, target = request.POST.get("email", ""), request.POST.get("target_price", "")
    message, minor = fmt.validate_alert(email, target, record["title"]) if request.method == "POST" else ("", None)
    response = render(request, "marketplace.html", {
        "locale": locale, "record": record, "labels": fmt.labels, "prefix": prefix, "order": order,
        "show_all": show_all, "path": path,
        "more": path + "?" + urlencode({"seller": prefix, "sort": order, "offers": "all"}),
        "summary": None if summary is None else {
            "lowest": fmt.money(summary["lowest_minor"]), "count": fmt.count(summary["count"]), "quantity": fmt.number(summary["quantity"])},
        "listings": [{**row, "rating": None if row["rating_hundredths"] is None else fmt.rating(row["rating_hundredths"]),
            "quantity_text": fmt.number(row["quantity"]), "price": fmt.money(row["price_minor"]), "reviews_text": fmt.number(row["reviews"])} for row in listings],
        "offers": [{**row, "quantity_text": fmt.number(row["quantity"]), "price": fmt.money(row["price_minor"])}
            for row in (record["offers"] if show_all else record["offers"][:5])],
        "contents": [{**row, "quantity_text": fmt.number(row["quantity"])} for row in record["contents"]],
        "included": [{**row, "quantity_text": fmt.number(row["quantity"])} for row in record["included_in"]],
        "email": email, "target": target, "message": message,
    })
    if request.method == "POST":
        response["Cache-Control"] = "private, no-store"
    if minor is not None:
        if not request.session.get("marketplace"):
            request.session["marketplace"] = True
            request.session.create()
        Alert.objects.create(session_id=request.session.session_key, item_id=record_id, email=email, target_minor=minor)
    return response


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
