<?php

namespace App\Support;

use Illuminate\Support\Facades\Http;

final class MarketplaceSource
{
    private ?array $fixture = null;

    public function __construct()
    {
        if (config('marketplace.source') === 'fixture') {
            $this->fixture = json_decode(file_get_contents(config('marketplace.fixture_path')), true, flags: JSON_THROW_ON_ERROR);
        }
    }

    public function get(string $id): ?array
    {
        if ($this->fixture !== null) {
            return $this->fixture[$id] ?? null;
        }
        $response = Http::withoutRedirecting()->timeout(10)->get(rtrim(config('marketplace.api_base'), '/').'/marketplace/records/'.rawurlencode($id));
        if ($response->status() === 404) {
            return null;
        }
        $response->throw();
        if (! $response->successful()) {
            throw new \RuntimeException('Marketplace API returned '.$response->status());
        }

        return json_decode($response->body(), true, flags: JSON_THROW_ON_ERROR);
    }
}
