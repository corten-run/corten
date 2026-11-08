"""Strings-only catalog records, independent of the marketplace view model."""
from dataclasses import asdict, dataclass
import json
import os

import requests


@dataclass(frozen=True)
class CatalogField:
    name: str
    value: str


@dataclass(frozen=True)
class RelatedRecord:
    id: str
    title: str


def _strings(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError("Invalid catalog object")
    if any(not isinstance(value[key], str) for key in keys):
        raise ValueError("Catalog text must be strings")
    return value


@dataclass(frozen=True)
class CatalogRecord:
    id: str
    title: str
    subtitle: str
    description: str
    tags: list[str]
    fields: list[CatalogField]
    related: list[RelatedRecord]

    @classmethod
    def from_dict(cls, value):
        text_keys = ("id", "title", "subtitle", "description")
        if not isinstance(value, dict) or set(value) != {*text_keys, "tags", "fields", "related"}:
            raise ValueError("Invalid catalog record")
        text = _strings({key: value[key] for key in text_keys}, text_keys)
        if any(not isinstance(value[key], list) for key in ("tags", "fields", "related")):
            raise ValueError("Catalog lists must be arrays")
        if any(not isinstance(tag, str) for tag in value["tags"]):
            raise ValueError("Catalog tags must be strings")
        return cls(
            **text,
            tags=value["tags"],
            fields=[CatalogField(**_strings(field, ("name", "value"))) for field in value["fields"]],
            related=[RelatedRecord(**_strings(row, ("id", "title"))) for row in value["related"]],
        )

    def to_dict(self):
        return asdict(self)


class CatalogSource:
    def __init__(self):
        self.base = os.environ.get("API_BASE", "http://localhost:8080").rstrip("/")
        self.session = requests.Session()
        self.fixture = None
        if os.environ.get("CATALOG_SOURCE") == "fixture":
            with open(os.environ.get("CATALOG_FIXTURE_PATH", "/fixtures/catalog.json"), encoding="utf-8") as file:
                self.fixture = {key: CatalogRecord.from_dict(value) for key, value in json.load(file).items()}

    def get(self, record_id: str) -> CatalogRecord | None:
        if self.fixture is not None:
            return self.fixture.get(record_id)
        response = self.session.get(f"{self.base}/catalog/records/{requests.utils.quote(record_id, safe='')}")
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return CatalogRecord.from_dict(response.json())


source = CatalogSource()
