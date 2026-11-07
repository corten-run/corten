<?php

namespace App\Support;

use Illuminate\Support\Facades\Http;

final class CatalogSource
{
    /** @var array<string, CatalogRecord>|null */
    private ?array $fixture = null;

    public function __construct()
    {
        if (config('catalog.source') === 'fixture') {
            $raw = json_decode(file_get_contents(config('catalog.fixture_path')), true, flags: JSON_THROW_ON_ERROR);
            $this->fixture = array_map(CatalogRecord::fromArray(...), $raw);
        }
    }

    public function get(string $id): ?CatalogRecord
    {
        if ($this->fixture !== null) {
            return $this->fixture[$id] ?? null;
        }
        $response = Http::get(rtrim(config('catalog.api_base'), '/').'/catalog/records/'.rawurlencode($id));
        if ($response->status() === 404) {
            return null;
        }
        $response->throw();
        if (! $response->successful()) {
            throw new \RuntimeException('Catalog API returned '.$response->status());
        }

        return CatalogRecord::fromArray(json_decode($response->body(), true, flags: JSON_THROW_ON_ERROR));
    }
}
