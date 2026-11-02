<?php

namespace App\Support;

use Illuminate\Support\Facades\Http;

class ItemSource
{
    /** @var array<string, array>|null */
    private ?array $fixture = null;

    public function __construct()
    {
        if (config('items.source') === 'fixture') {
            $raw = json_decode(file_get_contents(config('items.fixture_path')), true);
            $this->fixture = array_map(ItemView::fromApi(...), $raw);
        }
    }

    /** The items the home page lists: the first 50 by id with items in memory, none from the item API. */
    public function shelf(): array
    {
        if ($this->fixture === null) {
            return [];
        }

        return array_values(array_filter(array_map(fn (int $n) => $this->fixture["item_$n"] ?? null, range(1, 50))));
    }

    public function get(string $id): ?array
    {
        if ($this->fixture !== null) {
            return $this->fixture[$id] ?? null;
        }
        $res = Http::get(config('items.api_base').'/api/discovery/items/'.rawurlencode($id));
        if ($res->status() === 404) {
            return null;
        }
        $res->throw();

        return ItemView::fromApi($res->json());
    }
}
