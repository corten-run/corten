<?php

// Runs in the production benchmark image, without installing development dependencies:
// docker run --rm cb-laravel php tests/items.php
require __DIR__.'/../vendor/autoload.php';

use App\Support\ItemSource;
use Illuminate\Contracts\Http\Kernel;

$app = require __DIR__.'/../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
// Laravel installs its own exception handler during bootstrap.
set_exception_handler(function (Throwable $error): never {
    fwrite(STDERR, $error::class.': '.$error->getMessage()."\n".$error->getTraceAsString()."\n");
    exit(1);
});

function check(bool $condition, string $message): void
{
    if (! $condition) {
        throw new RuntimeException($message);
    }
}

$eachItem = new ReflectionMethod(ItemSource::class, 'eachItem');
$scan = function (string $json) use ($eachItem): array {
    $items = [];
    $eachItem->invoke(null, $json, function (string $id, string $item) use (&$items) {
        $items[$id] = json_decode($item, true, 512, JSON_THROW_ON_ERROR);
    });

    return $items;
};

// Each item comes out as decoding the whole file gives it, past strings that hold brackets,
// quotes and escapes; a repeated key keeps its last value, as json_decode does.
$files = [
    '{}',
    " \r\n{ \"a\" : {\"x\": \"}{][\\\"\\\\\", \"y\": [1, {\"z\": []}, \"\\u0022\\u005c\"]} ,\n\"b\\\"q\": {\"k\": {}}}\n",
    json_encode([
        'item_1' => ['s' => "a\"b\\", 'o' => [['p' => '{'], ['p' => ']']], 'u' => "\u{1F600} \u{e9}"],
        'item_2' => ['n' => 1.5, 't' => true, 'e' => null, 'l' => [[], [[]]]],
    ], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
    '{"a": {"v": 1}, "a": {"v": 2}}',
];
foreach ($files as $json) {
    check($scan($json) === json_decode($json, true, 512, JSON_THROW_ON_ERROR), 'Scanned items differ: '.$json);
}

// A damaged file fails as a whole instead of loading the items before the damage.
$damaged = [
    '', '   ', '{"a": {"x": 1}', '{"a": {"x": 1},', '{"a"', '{"a": {"x": "1}', '{"a": {"x": 1}} trailing',
    '{"a": {"x": 1},, "b": {}}', '{, "a": {}}', '{"a": {},}', "\u{FEFF}{}", 'x{"a": {}}',
    '[{"a": {"b": 1}}, {"c": {}}]', '"{}"', '5', '0', 'null', '[]',
];
foreach ($damaged as $json) {
    try {
        $scan($json);
    } catch (JsonException) {
        continue;
    }
    throw new RuntimeException('Damaged fixture loaded: '.json_encode($json));
}

// The app itself refuses a cut-off fixture at boot.
$path = tempnam(sys_get_temp_dir(), 'items');
file_put_contents($path, '{"item_1": {"id": "item_1"},');
config(['items.source' => 'fixture', 'items.fixture_path' => $path]);
try {
    new ItemSource;
    throw new RuntimeException('Cut-off fixture loaded');
} catch (JsonException) {
} finally {
    unlink($path);
}

echo "Item fixture checks passed: items as a full decode, strings with brackets and escapes, repeated keys, damaged files refused.\n";
