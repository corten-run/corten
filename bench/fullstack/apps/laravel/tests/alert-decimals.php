<?php

require __DIR__.'/../vendor/autoload.php';

use App\Support\MarketplaceFormat;
use Illuminate\Contracts\Console\Kernel;

$app = require __DIR__.'/../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
set_exception_handler(function (Throwable $error): never {
    fwrite(STDERR, $error::class.': '.$error->getMessage()."\n");
    exit(1);
});

$cases = [
    ['0.0049', 0], ['0.005', 1], ['0.105', 11], ['1.005', 101],
    ['1.004999999999999999', 100], ['1.005000000000000001', 101], ['2.675', 268],
    ['90071992547409.935', 9007199254740994],
    ['92233720368547758.065', PHP_INT_MAX],
];
$large = [
    'en-US' => ['$90,071,992,547,409.94', '$92,233,720,368,547,758.07'],
    'fr-FR' => ['90 071 992 547 409,94 $US', '92 233 720 368 547 758,07 $US'],
    'de-DE' => ['90.071.992.547.409,94 $', '92.233.720.368.547.758,07 $'],
];
foreach (MarketplaceFormat::LOCALES as $locale) {
    $format = new MarketplaceFormat($locale);
    foreach ($cases as [$decimal, $expected]) {
        $target = $locale === 'en-US' ? $decimal : str_replace('.', ',', $decimal);
        [$message, $minor] = $format->alertResult('boundary@example.test', $target, 'Title');
        if ($minor !== $expected) {
            throw new RuntimeException("$locale $target: expected $expected minor units, got ".var_export($minor, true));
        }
        $normalize = fn ($text) => str_replace(["\u{00a0}", "\u{202f}"], ' ', $text);
        $price = $expected === PHP_INT_MAX ? $large[$locale][1]
            : ($expected === 9007199254740994 ? $large[$locale][0] : $normalize($format->money($expected)));
        if (! str_contains($normalize($message), $price)) {
            throw new RuntimeException("$locale $target: confirmation must contain exact $price");
        }
    }
    foreach (['0', '-1', 'NaN', '12bad', '92233720368547758.075'] as $decimal) {
        $target = $locale === 'en-US' ? $decimal : str_replace('.', ',', $decimal);
        if ($format->alertResult('boundary@example.test', $target, 'Title') !== [$format->labels['invalid_price'], null]) {
            throw new RuntimeException("$locale $target: invalid or overflowing target accepted");
        }
    }
    echo "$locale: exact decimal ties, adjacent values, large integers, confirmation and overflow passed\n";
}
