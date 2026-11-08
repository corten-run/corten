"""Numeric marketplace records and request-local CLDR presentation."""
from decimal import Decimal, ROUND_HALF_UP
import json
import os
from pathlib import Path
import re
from typing import Annotated
from urllib.parse import quote

from babel import Locale
from babel.numbers import format_currency, format_decimal, get_decimal_symbol, get_group_symbol, parse_decimal, NumberFormatError
import httpx
from pydantic import BaseModel, ConfigDict, Field


LABELS = json.loads((Path(__file__).resolve().parent / "marketplace_labels.json").read_text(encoding="utf-8"))
LOCALES = {name: Locale.parse(name, sep="-") for name in LABELS}


Count = Annotated[int, Field(ge=0)]


class Record(BaseModel):
    """A part of a record: exactly its keys, each of its JSON type, as the Express adapter checks."""
    model_config = ConfigDict(extra="forbid", strict=True)


class Category(Record):
    name: str
    slug: str


class Detail(Record):
    name: str
    value: str


class Summary(Record):
    lowest_minor: int | None
    count: Count
    quantity: Count


class Listing(Record):
    id: str
    seller: str
    rating_hundredths: Annotated[int, Field(ge=0, le=500)] | None
    reviews: Count
    condition: str
    ships_from: str
    quantity: Count
    price_minor: int | None


class Offer(Record):
    id: str
    buyer: str
    condition: str
    quantity: Count
    price_minor: int | None


class Line(Record):
    id: str
    item_id: str
    title: str
    quantity: Count


class MarketplaceRecord(Record):
    id: str
    title: str
    subtitle: str | None
    description: str
    categories: list[Category]
    badges: list[str]
    tags: list[str]
    images: list[str]
    fields: list[Detail]
    summary: Summary | None
    listings: list[Listing]
    offers: list[Offer]
    contents: list[Line]
    included_in: list[Line]


class MarketplaceSource:
    def __init__(self):
        base = os.environ.get("API_BASE", "http://localhost:8080").rstrip("/")
        # No cap on connections to the item API, as every app's client (bench/fullstack/README.md).
        limits = httpx.Limits(max_connections=None, max_keepalive_connections=None)
        self.client = httpx.AsyncClient(base_url=base, timeout=10, follow_redirects=False, limits=limits)
        self.fixture = None
        if os.environ.get("MARKETPLACE_SOURCE") == "fixture":
            with open(os.environ.get("MARKETPLACE_FIXTURE_PATH", "/fixtures/marketplace.json"), encoding="utf-8") as file:
                self.fixture = {key: MarketplaceRecord.model_validate(value) for key, value in json.load(file).items()}

    async def get(self, record_id):
        if self.fixture is not None:
            return self.fixture.get(record_id)
        response = await self.client.get(f"/marketplace/records/{quote(record_id, safe='')}")
        if response.status_code == 404:
            return None
        if not response.is_success:
            raise httpx.HTTPStatusError("Marketplace API returned a non-success status", request=response.request, response=response)
        return MarketplaceRecord.model_validate_json(response.content)


class MarketplaceFormat:
    def __init__(self, locale):
        self.locale = LOCALES[locale]
        self.labels = LABELS[locale]
        # A target is digits and this locale's marks only: Babel's parser also takes an exponent.
        marks = re.escape(get_decimal_symbol(self.locale) + get_group_symbol(self.locale))
        self.target = re.compile(rf"[0-9{marks}]+")

    def money(self, minor):
        return "\u2014" if minor is None else self.amount(Decimal(minor) / 100)

    def amount(self, amount):
        return format_currency(amount.quantize(Decimal(".01"), rounding=ROUND_HALF_UP), "USD", locale=self.locale)

    def number(self, value):
        return format_decimal(value, format="#,##0", locale=self.locale)

    def rating(self, hundredths):
        value = (Decimal(hundredths) / 100).quantize(Decimal(".1"), rounding=ROUND_HALF_UP)
        return format_decimal(value, format="#,##0.#", locale=self.locale)

    def count(self, value):
        return f"{self.number(value)} {self.labels['listing_' + self.locale.plural_form(value)]}"

    def alert(self, email, target, title):
        if "@" not in email:
            return self.labels["invalid_email"]
        try:
            if not self.target.fullmatch(target):
                raise ValueError("not a decimal in this locale")
            amount = parse_decimal(target, locale=self.locale, strict=True)
            if not amount.is_finite() or amount <= 0:
                raise ValueError("non-positive target")
        except (NumberFormatError, ValueError):
            return self.labels["invalid_price"]
        values = {"{email}": email, "{title}": title, "{price}": self.amount(amount)}
        return re.sub(r"\{email\}|\{title\}|\{price\}", lambda match: values[match.group()], self.labels["alert_set"])


source = MarketplaceSource()
