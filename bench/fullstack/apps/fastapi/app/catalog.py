"""Strings-only catalog records, independent of the marketplace view model."""
import json
import os
from urllib.parse import quote

import httpx
from pydantic import BaseModel, ConfigDict, StrictStr


class CatalogField(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: StrictStr
    value: StrictStr


class RelatedRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: StrictStr
    title: StrictStr


class CatalogRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: StrictStr
    title: StrictStr
    subtitle: StrictStr
    description: StrictStr
    tags: list[StrictStr]
    fields: list[CatalogField]
    related: list[RelatedRecord]


class CatalogSource:
    def __init__(self):
        limits = httpx.Limits(max_connections=None, max_keepalive_connections=None)
        self.client = httpx.AsyncClient(base_url=os.environ.get("API_BASE", "http://localhost:8080").rstrip("/"), timeout=10, limits=limits)
        self.fixture = None
        if os.environ.get("CATALOG_SOURCE") == "fixture":
            with open(os.environ.get("CATALOG_FIXTURE_PATH", "/fixtures/catalog.json"), encoding="utf-8") as file:
                self.fixture = {key: CatalogRecord.model_validate(value) for key, value in json.load(file).items()}

    async def get(self, record_id: str) -> CatalogRecord | None:
        if self.fixture is not None:
            return self.fixture.get(record_id)
        response = await self.client.get(f"/catalog/records/{quote(record_id, safe='')}")
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return CatalogRecord.model_validate(response.json())


source = CatalogSource()
