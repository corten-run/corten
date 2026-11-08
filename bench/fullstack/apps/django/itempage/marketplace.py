"""Numeric marketplace records and request-local CLDR presentation."""
from decimal import Decimal, ROUND_HALF_UP
import json
import os
from pathlib import Path
import re

from babel import Locale
from babel.numbers import format_currency, format_decimal, parse_decimal, NumberFormatError
import requests


LABELS = json.loads((Path(__file__).resolve().parent / "marketplace_labels.json").read_text(encoding="utf-8"))
LOCALES = {name: Locale.parse(name, sep="-") for name in LABELS}


class MarketplaceSource:
    def __init__(self):
        self.base = os.environ.get("API_BASE", "http://localhost:8080").rstrip("/")
        self.session = requests.Session()
        self.fixture = None
        if os.environ.get("MARKETPLACE_SOURCE") == "fixture":
            with open(os.environ.get("MARKETPLACE_FIXTURE_PATH", "/fixtures/marketplace.json"), encoding="utf-8") as file:
                self.fixture = json.load(file)

    def get(self, record_id):
        if self.fixture is not None:
            return self.fixture.get(record_id)
        response = self.session.get(f"{self.base}/marketplace/records/{requests.utils.quote(record_id, safe='')}", allow_redirects=False, timeout=10)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        if not 200 <= response.status_code < 300:
            raise requests.HTTPError("Marketplace API returned a non-success status")
        return response.json()


class MarketplaceFormat:
    def __init__(self, locale):
        self.locale = LOCALES[locale]
        self.labels = LABELS[locale]

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
            amount = parse_decimal(target, locale=self.locale, strict=True)
            if not amount.is_finite() or amount <= 0:
                raise ValueError("non-positive target")
        except (NumberFormatError, ValueError):
            return self.labels["invalid_price"]
        values = {"{email}": email, "{title}": title, "{price}": self.amount(amount)}
        return re.sub(r"\{email\}|\{title\}|\{price\}", lambda match: values[match.group()], self.labels["alert_set"])


source = MarketplaceSource()
