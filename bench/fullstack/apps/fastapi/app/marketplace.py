"""Numeric marketplace records and request-local CLDR presentation."""
from decimal import Decimal, ROUND_HALF_UP
import json
import os
from pathlib import Path
import re
from urllib.parse import quote

from babel import Locale
from babel.numbers import format_currency, format_decimal, get_decimal_symbol, get_group_symbol, parse_decimal, NumberFormatError
import httpx


LABELS = json.loads((Path(__file__).resolve().parent / "marketplace_labels.json").read_text(encoding="utf-8"))
LOCALES = {name: Locale.parse(name, sep="-") for name in LABELS}


class MarketplaceSource:
    def __init__(self):
        base = os.environ.get("API_BASE", "http://localhost:8080").rstrip("/")
        self.client = httpx.AsyncClient(base_url=base, timeout=10, follow_redirects=False)
        self.fixture = None
        if os.environ.get("MARKETPLACE_SOURCE") == "fixture":
            with open(os.environ.get("MARKETPLACE_FIXTURE_PATH", "/fixtures/marketplace.json"), encoding="utf-8") as file:
                self.fixture = json.load(file)

    async def get(self, record_id):
        if self.fixture is not None:
            return self.fixture.get(record_id)
        response = await self.client.get(f"/marketplace/records/{quote(record_id, safe='')}")
        if response.status_code == 404:
            return None
        if not response.is_success:
            raise httpx.HTTPStatusError("Marketplace API returned a non-success status", request=response.request, response=response)
        return response.json()


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
