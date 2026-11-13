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


def _object(value, fields):
    if not isinstance(value, dict) or value.keys() != fields.keys():
        raise ValueError("Invalid marketplace object")
    if any(type(value[key]) not in types for key, types in fields.items()):
        raise ValueError("Invalid marketplace field type")


def validate_record(record, requested_id):
    """Validate a write's complete source record, not what the template happens to use."""
    text, number = (str,), (int,)
    nullable_text, nullable_number = (str, type(None)), (int, type(None))
    arrays = ("categories", "badges", "tags", "images", "fields", "listings", "offers", "contents", "included_in")
    _object(record, {
        "id": text, "title": text, "subtitle": nullable_text, "description": text,
        "summary": (dict, type(None)), **{key: (list,) for key in arrays},
    })
    if record["id"] != requested_id:
        raise ValueError("Marketplace record ID mismatch")
    for key in ("badges", "tags", "images"):
        if any(not isinstance(value, str) for value in record[key]):
            raise ValueError("Invalid marketplace text array")
    schemas = {
        "categories": {"name": text, "slug": text},
        "fields": {"name": text, "value": text},
        "listings": {"id": text, "seller": text, "rating_hundredths": nullable_number,
            "reviews": number, "condition": text, "ships_from": text, "quantity": number, "price_minor": nullable_number},
        "offers": {"id": text, "buyer": text, "condition": text, "quantity": number, "price_minor": nullable_number},
        "contents": {"id": text, "item_id": text, "title": text, "quantity": number},
        "included_in": {"id": text, "item_id": text, "title": text, "quantity": number},
    }
    for key, schema in schemas.items():
        for row in record[key]:
            _object(row, schema)
            for field in ("quantity", "reviews", "price_minor", "rating_hundredths"):
                if field in row:
                    _integer(row[field], -10**9 if field == "price_minor" else 0,
                        500 if field == "rating_hundredths" else 10**9)
        if key in ("listings", "offers", "contents", "included_in"):
            if len({row["id"] for row in record[key]}) != len(record[key]):
                raise ValueError("Duplicate marketplace row ID")
    summary = record["summary"]
    if summary is not None:
        _object(summary, {"lowest_minor": nullable_number, "count": number, "quantity": number})
        _integer(summary["lowest_minor"], -10**9)
        _integer(summary["count"])
        _integer(summary["quantity"])


def _integer(value, minimum=0, maximum=10**9):
    if value is not None and not minimum <= value <= maximum:
        raise ValueError("Marketplace integer outside record contract")


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
        return self.validate_alert(email, target, title)[0]

    def validate_alert(self, email, target, title):
        if "@" not in email:
            return self.labels["invalid_email"], None
        try:
            amount = parse_decimal(target, locale=self.locale, strict=True)
            if not amount.is_finite() or amount <= 0 or amount > Decimal("92233720368547758.07"):
                raise ValueError("non-positive target")
        except (NumberFormatError, ValueError):
            return self.labels["invalid_price"], None
        values = {"{email}": email, "{title}": title, "{price}": self.amount(amount)}
        message = re.sub(r"\{email\}|\{title\}|\{price\}", lambda match: values[match.group()], self.labels["alert_set"])
        return message, int(amount.quantize(Decimal(".01"), rounding=ROUND_HALF_UP) * 100)


source = MarketplaceSource()
