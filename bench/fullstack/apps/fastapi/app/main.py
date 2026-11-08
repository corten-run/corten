import asyncio
from urllib.parse import quote, urlencode

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import ValidationError

from .catalog import CatalogRecord, source as catalog_source
from .items import ItemView, alert_message, fetch_item, shelf
from .marketplace import LABELS, MarketplaceFormat, source as marketplace_source

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
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


@app.get("/api/items/{item_id}")
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
    fmt = MarketplaceFormat(locale)
    query = request.query_params
    prefix = query.get("seller", "")
    order = "desc" if query.get("sort") == "desc" else "asc"
    show_all = query.get("offers") == "all"
    listings = [row for row in record["listings"] if row["seller"].startswith(prefix)]
    listings.sort(key=lambda row: (row["price_minor"] is None, (row["price_minor"] or 0) * (-1 if order == "desc" else 1)))
    path = marketplace_path(locale, record_id)
    summary = record["summary"]
    form = await request.form() if request.method == "POST" else {}
    email, target = str(form.get("email", "")), str(form.get("target_price", ""))
    return templates.TemplateResponse(request, "marketplace.html", {
        "locale": locale, "record": record, "labels": fmt.labels, "prefix": prefix, "order": order,
        "show_all": show_all, "path": path, "item_path": lambda item_id: marketplace_path(locale, item_id),
        "more": path + "?" + urlencode({"seller": prefix, "sort": order, "offers": "all"}),
        "summary": None if summary is None else {
            "lowest": fmt.money(summary["lowest_minor"]), "count": fmt.count(summary["count"]), "quantity": fmt.number(summary["quantity"])},
        "listings": [{**row, "rating": None if row["rating_hundredths"] is None else fmt.rating(row["rating_hundredths"]),
            "quantity_text": fmt.number(row["quantity"]), "price": fmt.money(row["price_minor"]), "reviews_text": fmt.number(row["reviews"])} for row in listings],
        "offers": [{**row, "quantity_text": fmt.number(row["quantity"]), "price": fmt.money(row["price_minor"])}
            for row in (record["offers"] if show_all else record["offers"][:5])],
        "contents": [{**row, "quantity_text": fmt.number(row["quantity"])} for row in record["contents"]],
        "included": [{**row, "quantity_text": fmt.number(row["quantity"])} for row in record["included_in"]],
        "email": email, "target": target,
        "message": fmt.alert(email, target, record["title"]) if request.method == "POST" else "",
    })


@app.get("/api/marketplace/{record_id}")
async def marketplace_json(record_id: str):
    record = await marketplace_source.get(record_id)
    if record is None:
        raise HTTPException(status_code=404)
    return record


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


@app.get("/api/catalog/{record_id}")
async def catalog_json(record_id: str) -> CatalogRecord:
    record = await catalog_source.get(record_id)
    if record is None:
        raise HTTPException(status_code=404)
    return record


# The live benchmark (bench/live): GET /live/prices is a server-sent event stream and every
# POST /live/publish body goes to each open stream. One process holds every stream, so the
# publisher reaches them all.
_clients: set[asyncio.Queue] = set()


@app.get("/live/prices")
async def prices():
    queue: asyncio.Queue = asyncio.Queue()
    _clients.add(queue)

    async def events():
        try:
            yield ": open\n\n"
            while True:
                yield await queue.get()
        finally:
            # Starlette cancels the stream when the client disconnects.
            _clients.discard(queue)

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@app.post("/live/publish", status_code=204)
async def publish(request: Request):
    event = f"data: {(await request.body()).decode()}\n\n"
    for queue in _clients:
        queue.put_nowait(event)
    return Response(status_code=204)
