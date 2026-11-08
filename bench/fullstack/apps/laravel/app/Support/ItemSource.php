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
            $this->fixture = [];
            try {
                self::eachItem(file_get_contents(config('items.fixture_path')), function (string $id, string $json) {
                    $this->fixture[$id] = ItemView::fromApi(json_decode($json, true, 512, JSON_THROW_ON_ERROR));
                });
            } catch (\JsonException $error) {
                // Octane drops an exception thrown while a worker boots, so say why it stopped.
                file_put_contents('php://stderr', 'items fixture '.config('items.fixture_path').': '.$error->getMessage()."\n");

                throw $error;
            }
        }
    }

    /**
     * Each item of `{"item_1": <API response>, ...}` with its JSON, one at a time, as the Rust apps
     * read it: decoding the whole 27.7 MB file at once takes more than PHP's default 128 MB
     * memory_limit, which the app keeps (README, caveat 7). Only the converted items are kept.
     * json_validate checks the whole file first without building it, so a cut-off or malformed
     * fixture fails at boot instead of loading the items before the damage.
     *
     * @param  callable(string, string): void  $item
     */
    private static function eachItem(string $json, callable $item): void
    {
        $i = strspn($json, " \t\r\n");
        if (! json_validate($json) || ($json[$i] ?? '') !== '{') {
            throw new \JsonException('the fixture is not a JSON object');
        }
        $i++;
        while (true) {
            $i += strspn($json, " \t\r\n,", $i);
            if (($json[$i] ?? '}') === '}') {
                return;
            }
            $keyEnd = self::stringEnd($json, $i);
            $id = json_decode(substr($json, $i, $keyEnd - $i + 1), false, 512, JSON_THROW_ON_ERROR);
            $i = strpos($json, ':', $keyEnd) + 1;
            $i += strspn($json, " \t\r\n", $i);
            // The value is an object: to the brace that closes it, past every string inside it.
            $start = $i;
            $depth = 0;
            do {
                $i += strcspn($json, '"{}[]', $i);
                $c = $json[$i] ?? throw new \JsonException("the fixture ends inside {$id}");
                if ($c === '"') {
                    $i = self::stringEnd($json, $i) + 1;

                    continue;
                }
                $depth += ($c === '{' || $c === '[') ? 1 : -1;
                $i++;
            } while ($depth > 0);
            $item($id, substr($json, $start, $i - $start));
        }
    }

    /** Where the JSON string opened at `$open` closes. */
    private static function stringEnd(string $json, int $open): int
    {
        $i = $open + 1;
        while (true) {
            $i += strcspn($json, '"\\', $i);
            $c = $json[$i] ?? throw new \JsonException('the fixture ends inside a string');
            if ($c === '\\') {
                $i += 2;

                continue;
            }

            return $i;
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
