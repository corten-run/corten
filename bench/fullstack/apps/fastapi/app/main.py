import asyncio
import os
from urllib.parse import quote, urlencode

import httpx
from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import HTMLResponse, PlainTextResponse, Response
from fastapi.sse import EventSourceResponse, ServerSentEvent
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import ValidationError
from starlette.middleware.body_limit import RequestBodyLimitMiddleware

from .catalog import CatalogRecord, source as catalog_source
from .alerts import Alert, COOKIE, LIFETIME, store as alerts
from .items import ItemView, alert_message, fetch_item, shelf
from .marketplace import LABELS, MarketplaceFormat, MarketplaceRecord, source as marketplace_source
from .record_json import RecordJsonRoute, read_record

# The matched tier's production profile (bench/fullstack/README.md, "The matched tier"), from
# FastAPI's, Starlette's and uvicorn's own middleware and settings (the end of this file and the
# Dockerfile); without it the app is as FastAPI starts it.
PROFILE = os.environ.get("PROFILE") == "matched"
# The JSON routes: in the profile GET and HEAD, as Corten's get routes (FastAPI answers HEAD only
# where a route lists it).
GET = ["GET", "HEAD"] if PROFILE else ["GET"]

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
record_routes = APIRouter(route_class=RecordJsonRoute)
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
templates.env.filters["intcomma"] = lambda n: f"{n:,}"


@app.exception_handler(httpx.HTTPError)
@app.exception_handler(ValidationError)
async def upstream_failed(request: Request, exc: Exception):
    # An upstream that failed, redirected or sent a record that is not one is a 502. Handled here
    # rather than left to the server: uvicorn answers an unhandled error's 500 and then closes the
    # connection without saying so, which a client that kept it alive sees as a reset.
    return PlainTextResponse("Bad Gateway", status_code=502)


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    # Corten's home page: cards for the first 50 items with items in memory, links by id from the
    # item API (which cannot list items).
    return templates.TemplateResponse(request, "home.html", {"items": shelf(), "numbers": range(1, 51)})


@app.api_route("/items/{item_id}", methods=["GET", "POST"], response_class=HTMLResponse)
async def item(request: Request, item_id: str):
    view = await fetch_item(item_id)
    if view is None:
        return templates.TemplateResponse(request, "not_found.html", {}, status_code=404)
    message = ""
    if request.method == "POST":
        form = await request.form()
        message = alert_message(str(form.get("title", "")), str(form.get("email", "")), str(form.get("target_price", "")))
        # htmx swaps only the message; without JavaScript the whole page comes back.
        if request.headers.get("HX-Request"):
            return templates.TemplateResponse(request, "alert_message.html", {"message": message})
    all_offers = request.query_params.get("offers") == "all"
    return templates.TemplateResponse(request, "item.html", {
        "item": view,
        "listings": sorted(view.listings, key=lambda l: l.price_value),
        "offers": view.offers if all_offers else view.offers[:5],
        "more_offers": len(view.offers) > 5 and not all_offers,
        "message": message,
    })


@app.api_route("/api/items/{item_id}", methods=GET)
async def item_json(item_id: str) -> ItemView:
    view = await fetch_item(item_id)
    if view is None:
        raise HTTPException(status_code=404)
    return view


def cross_site(request: Request) -> bool:
    # FastAPI has no CSRF protection of its own, so, as the Gin and Drogon apps do, a post another
    # site sends is refused: the browser says so in Sec-Fetch-Site, or its Origin is another host.
    origin = request.headers.get("origin")
    return request.headers.get("sec-fetch-site") == "cross-site" or (
        origin is not None and origin != f"{request.url.scheme}://{request.headers.get('host')}")


def marketplace_path(locale: str, record_id: str) -> str:
    return f"/marketplace/{quote(locale, safe='')}/{quote(record_id, safe='')}"


@app.api_route("/marketplace/{locale}/{record_id}", methods=["GET", "POST"], response_class=HTMLResponse)
async def marketplace(request: Request, locale: str, record_id: str):
    if locale not in LABELS:
        return PlainTextResponse("Unsupported locale", status_code=400)
    if request.method == "POST" and cross_site(request):
        return PlainTextResponse("Forbidden", status_code=403)
    record = await marketplace_source.get(record_id)
    if record is None:
        raise HTTPException(status_code=404)
    if request.method == "POST":
        try:
            record.validate_for_write(record_id)
        except ValueError:
            return PlainTextResponse("Bad Gateway", status_code=502)
    fmt = MarketplaceFormat(locale)
    query = request.query_params
    prefix = query.get("seller", "")
    order = "desc" if query.get("sort") == "desc" else "asc"
    show_all = query.get("offers") == "all"
    listings = [row for row in record.listings if row.seller.startswith(prefix)]
    listings.sort(key=lambda row: (row.price_minor is None, (row.price_minor or 0) * (-1 if order == "desc" else 1)))
    path = marketplace_path(locale, record_id)
    summary = record.summary
    form = await request.form() if request.method == "POST" else {}
    email, target = str(form.get("email", "")), str(form.get("target_price", ""))
    message, minor = fmt.validate_alert(email, target, record.title) if request.method == "POST" else ("", None)
    response = templates.TemplateResponse(request, "marketplace.html", {
        "locale": locale, "record": record, "labels": fmt.labels, "prefix": prefix, "order": order,
        "show_all": show_all, "path": path, "item_path": lambda item_id: marketplace_path(locale, item_id),
        "more": path + "?" + urlencode({"seller": prefix, "sort": order, "offers": "all"}),
        "summary": None if summary is None else {
            "lowest": fmt.money(summary.lowest_minor), "count": fmt.count(summary.count), "quantity": fmt.number(summary.quantity)},
        "listings": [{**dict(row), "rating": None if row.rating_hundredths is None else fmt.rating(row.rating_hundredths),
            "quantity_text": fmt.number(row.quantity), "price": fmt.money(row.price_minor), "reviews_text": fmt.number(row.reviews)} for row in listings],
        "offers": [{**dict(row), "quantity_text": fmt.number(row.quantity), "price": fmt.money(row.price_minor)}
            for row in (record.offers if show_all else record.offers[:5])],
        "contents": [{**dict(row), "quantity_text": fmt.number(row.quantity)} for row in record.contents],
        "included": [{**dict(row), "quantity_text": fmt.number(row.quantity)} for row in record.included_in],
        "email": email, "target": target,
        "message": message,
    })
    if request.method == "POST":
        response.headers["Cache-Control"] = "private, no-store"
    if minor is not None:
        token, created = alerts.append(request.cookies.get(COOKIE), Alert(item_id=record_id, email=email, target_minor=minor))
        if created:
            response.set_cookie(COOKIE, token, max_age=LIFETIME, httponly=True, samesite="lax", secure=request.url.scheme == "https")
    return response


@app.get("/api/alerts")
async def alert_list(request: Request, response: Response) -> list[Alert]:
    response.headers["Cache-Control"] = "private, no-store"
    return alerts.read(request.cookies.get(COOKIE))


@record_routes.api_route("/api/marketplace/{record_id}", methods=GET)
async def marketplace_json(request: Request, record_id: str) -> MarketplaceRecord:
    return await read_record(request, marketplace_source, record_id)


@app.get("/catalog/{record_id}", response_class=HTMLResponse)
async def catalog(request: Request, record_id: str):
    record = await catalog_source.get(record_id)
    if record is None:
        raise HTTPException(status_code=404)
    prefix = request.query_params.get("field", "")
    return templates.TemplateResponse(request, "catalog.html", {
        "record": record,
        "prefix": prefix,
        "fields": [field for field in record.fields if field.name.startswith(prefix)],
        "catalog_path": lambda record_id: f"/catalog/{quote(record_id, safe='')}",
    })


@record_routes.api_route("/api/catalog/{record_id}", methods=GET)
async def catalog_json(request: Request, record_id: str) -> CatalogRecord:
    return await read_record(request, catalog_source, record_id)


app.include_router(record_routes)


# The live benchmark (bench/live): GET /live/prices is FastAPI's server-sent event stream
# (EventSourceResponse) and every POST /live/publish body goes to each open stream as it came.
# One process holds every stream, so the publisher reaches them all.
_clients: set[asyncio.Queue] = set()


@app.get("/live/prices", response_class=EventSourceResponse)
async def prices():
    queue: asyncio.Queue = asyncio.Queue()
    _clients.add(queue)
    try:
        yield ServerSentEvent(comment="open")
        while True:
            yield ServerSentEvent(raw_data=await queue.get())
    finally:
        # FastAPI cancels the generator when the response ends: for a client that left, at the
        # next write that fails, which its keepalive comment (every 15 s) bounds.
        _clients.discard(queue)


@app.post("/live/publish", status_code=204)
async def publish(request: Request):
    data = (await request.body()).decode()
    for queue in _clients:
        queue.put_nowait(data)
    return Response(status_code=204)


if PROFILE:
    # The last added runs first: the host list, compression, the headers, then the body limit,
    # nearest the routes. Request bodies of at most 2 MiB, as Corten's forms take.
    app.add_middleware(RequestBodyLimitMiddleware, max_body_size=2 * 1024 * 1024)

    @app.middleware("http")
    async def profile_headers(request: Request, call_next):
        # axum-maud's security headers on every answer the routes make, set as FastAPI's middleware
        # tutorial sets a header, and a private cache policy on the pages and the JSON (the static
        # files are left as StaticFiles serves them).
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; "
            "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Permissions-Policy"] = (
            "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), "
            "payment=(), usb=()")
        if not request.url.path.startswith("/static/"):
            response.headers.setdefault("Cache-Control", "private, no-cache")
        return response

    # gzip when asked, at Starlette's defaults (it leaves event streams as they are).
    app.add_middleware(GZipMiddleware)
    # Names it answers to: localhost, the loopback addresses and the deploy's HOSTS (comma separated,
    # ".example.com" for the domain and every subdomain); others get the host middleware's 400.
    _hosts = [h.strip() for h in os.environ.get("HOSTS", "").split(",") if h.strip()]
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=[
        "localhost", "*.localhost", "127.0.0.1", "[::1]",
        *(name for h in _hosts for name in ([h[1:], "*" + h] if h.startswith(".") else [h]))])
