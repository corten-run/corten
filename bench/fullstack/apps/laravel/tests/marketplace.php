<?php

// Native HTTP-kernel tests, also runnable without development dependencies.
require __DIR__.'/../vendor/autoload.php';

use App\Support\MarketplaceFormat;
use App\Support\MarketplaceSource;
use App\Support\MarketplaceAlerts;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;

$app = require __DIR__.'/../bootstrap/app.php';
$kernel = $app->make(Kernel::class);
$kernel->bootstrap();
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

function nodes(string $html, string $xpath): DOMNodeList
{
    $document = new DOMDocument;
    @$document->loadHTML('<?xml encoding="utf-8" ?>'.$html);

    return (new DOMXPath($document))->query($xpath);
}

$records = json_decode(file_get_contents(__DIR__.'/marketplace_fixture.json'), true, flags: JSON_THROW_ON_ERROR);
$path = tempnam(sys_get_temp_dir(), 'marketplace');
file_put_contents($path, json_encode($records, JSON_THROW_ON_ERROR));
config(['marketplace.source' => 'fixture', 'marketplace.fixture_path' => $path, 'session.driver' => 'file']);
$source = new MarketplaceSource;
unlink($path);
check($source->get('item_1') === $records['item_1'], 'Startup fixture read');
check($source->get('missing') === null, 'Unknown fixture item');
$app->instance(MarketplaceSource::class, $source);

$cookies = [];
$send = function (string $path, string $method = 'GET', array $params = [], array $headers = []) use ($kernel, &$cookies) {
    $request = Request::create($path, $method, $params, $cookies, [], $headers);
    $response = $kernel->handle($request);
    $kernel->terminate($request, $response);
    foreach ($response->headers->getCookies() as $cookie) {
        $cookies[$cookie->getName()] = $cookie->getValue();
    }

    return $response;
};

check(json_decode($send('/api/alerts')->getContent(), true) === [], 'Fresh session is empty');
$expectedAlerts = [];

$expected = [
    'en-US' => ['$0.00', '$0.01', '$0.10', '$1.25', '$1,234.50', '$1,234,567.89', '-$1,234.50'],
    'fr-FR' => ['0,00 $US', '0,01 $US', '0,10 $US', '1,25 $US', '1 234,50 $US', '1 234 567,89 $US', '-1 234,50 $US'],
    'de-DE' => ['0,00 $', '0,01 $', '0,10 $', '1,25 $', '1.234,50 $', '1.234.567,89 $', '-1.234,50 $'],
];
foreach (MarketplaceFormat::LOCALES as $locale) {
    $format = new MarketplaceFormat($locale);
    $normalize = fn (string $s) => str_replace(["\u{00a0}", "\u{202f}"], ' ', $s);
    check(array_map(fn ($n) => $normalize($format->money($n)), [0, 1, 10, 125, 123450, 123456789, -123450]) === $expected[$locale], 'Currency '.$locale);
    check(array_map($format->rating(...), [0, 400, 425, 475, 499]) === ($locale === 'en-US' ? ['0', '4', '4.3', '4.8', '5'] : ['0', '4', '4,3', '4,8', '5']), 'Ratings '.$locale);
    foreach ([0, 1, 2, 1000, 1000000] as $n) {
        $category = $locale === 'fr-FR' && $n === 1000000 ? 'many' : ($n === 1 || ($locale === 'fr-FR' && $n === 0) ? 'one' : 'other');
        check(str_ends_with($format->count($n), ' '.$format->labels['listing_'.$category]), 'Plural '.$locale.' '.$n);
    }
    $route = '/marketplace/'.$locale.'/item_1';
    $response = $send($route);
    check($response->getStatusCode() === 200, 'Page status '.$locale);
    $html = $response->getContent();
    foreach (['<html lang="'.$locale.'">', '&lt;script&gt;&quot;Dragon&quot;&lt;/script&gt;', '/marketplace.css'] as $text) {
        check(str_contains($html, $text), 'Escaped page content '.$text);
    }
    check(nodes($html, '//main/article[@class="marketplace"]')->length === 1, 'One article');
    check(nodes($html, '//*[@data-offer-id]')->length === 5, 'Only five offers');
    check(nodes($html, '//*[@class="marketplace__image"]')->length === 2, 'All images');
    check(nodes($html, '//*[@class="marketplace__contents"]//a[@href="/marketplace/'.$locale.'/item_2"]')->length === 1, 'Localized relative navigation');
    $csrf = nodes($html, '//input[@name="_token"]')->item(0)->getAttribute('value');
    $target = $locale === 'en-US' ? '12.50' : '12,50';
    check($format->alertResult('a@b', $locale === 'en-US' ? '0.105' : '0,105', 'Title')[1] === 11, 'Parsed target converted with half-up rounding');
    foreach ([['<a>@b', $target, null], ['invalid', $target, 'invalid_email'], ['a@b', '0', 'invalid_price'], ['a@b', '12bad', 'invalid_price'], ['a@b', 'NaN', 'invalid_price']] as [$email, $price, $key]) {
        $response = $send($route, 'POST', ['_token' => $csrf, 'email' => $email, 'target_price' => $price]);
        check($response->getStatusCode() === 200, 'POST status '.$locale.' '.$response->getStatusCode());
        $text = nodes($response->getContent(), '//*[@class="marketplace__message"]')->item(0)->textContent;
        check($text === ($key ? $format->labels[$key] : $format->alert($email, $price, $records['item_1']['title'])), 'POST message '.$locale);
        check(nodes($response->getContent(), '//article//script')->length === 0, 'Alert data escaped');
        if ($key === null) {
            $expectedAlerts[] = ['item_id' => 'item_1', 'email' => $email, 'target_minor' => 1250];
        }
        check(json_decode($send('/api/alerts')->getContent(), true) === $expectedAlerts, 'Independent ordered readback, including rejected writes');
    }
    check($send($route, 'POST', ['email' => 'a@b', 'target_price' => $target])->getStatusCode() === 419, 'CSRF remains enabled');
    check($send($route, 'POST', ['_token' => $csrf, 'email' => 'a@b', 'target_price' => $target], ['HTTP_ORIGIN' => 'https://other.test'])->getStatusCode() === 403, 'Cross-origin write rejected');
    check($send($route, 'POST', ['_token' => $csrf, 'email' => 'a@b', 'target_price' => $target], ['HTTP_SEC_FETCH_SITE' => 'cross-site'])->getStatusCode() === 403, 'Cross-site write rejected');
}

check(json_decode($send('/api/alerts?email=fake&target_minor=999')->getContent(), true) === $expectedAlerts, 'GET neither resets nor fabricates state');
$firstCookies = $cookies;
$cookies = [];
check(json_decode($send('/api/alerts')->getContent(), true) === [], 'Independent client sees no alerts');
$cookies = $firstCookies;
check(json_decode($send('/api/alerts')->getContent(), true) === $expectedAlerts, 'Original client retains alerts');

$html = $send('/marketplace/fr-FR/item_1?sort=desc&offers=all')->getContent();
$ids = array_map(fn ($node) => $node->getAttribute('data-listing-id'), iterator_to_array(nodes($html, '//*[@data-listing-id]')));
check($ids === ['listing_5', 'listing_4', 'listing_3', 'listing_8', 'listing_2', 'listing_1', 'listing_0', 'listing_6', 'listing_7'], 'Stable numeric descending sort, null last');
check(nodes($html, '//*[@data-offer-id]')->length === 7, 'All offers');
$html = $send('/marketplace/en-US/item_1?seller=%20Alice')->getContent();
check(nodes($html, '//*[@data-listing-id="listing_8"]')->length === 1 && nodes($html, '//*[@data-listing-id]')->length === 1, 'Prefix not trimmed');
check(str_contains($html, 'seller=%20Alice') || str_contains($html, 'seller=+Alice'), 'More link retains prefix');
check(nodes($send('/marketplace/en-US/item_1?seller=alice')->getContent(), '//*[@data-listing-id]')->length === 0, 'Case-sensitive filter');
$html = $send('/marketplace/de-DE/item_2')->getContent();
check(nodes($html, '//*[@class="marketplace__subtitle"]')->length === 0, 'Null subtitle');
check(str_contains($html, 'Noch keine Angebote'), 'Missing summary');
foreach ($records as $id => $record) {
    check(json_decode($send('/api/marketplace/'.$id)->getContent(), true, flags: JSON_THROW_ON_ERROR) === $record, 'Numeric JSON '.$id);
}
check($send('/marketplace/es-ES/item_1')->getStatusCode() === 400, 'Unsupported locale');
foreach (['/marketplace/en-US/missing', '/api/marketplace/missing'] as $route) {
    check($send($route)->getStatusCode() === 404, 'Not found');
}

config(['marketplace.source' => 'api', 'marketplace.api_base' => 'http://example.test/base']);
$calls = [];
$responses = [$records['item_1'], $records['item_2']];
Http::fake(function ($request) use (&$calls, &$responses) {
    $calls[] = $request->url();

    return Http::response(array_shift($responses));
});
$source = new MarketplaceSource;
$app->instance(MarketplaceSource::class, $source);
check($send('/marketplace/en-US/item_1')->getStatusCode() === 200, 'HTTP page');
check(json_decode($send('/api/marketplace/item_1')->getContent(), true, flags: JSON_THROW_ON_ERROR) === $records['item_2'], 'HTTP response not cached');
check($calls === array_fill(0, 2, 'http://example.test/base/marketplace/records/item_1'), 'Exactly one upstream request per route');
Http::swap(new Illuminate\Http\Client\Factory);
Http::fake(function ($request) use (&$calls) { $calls[] = $request->url(); return Http::response('', 404); });
check($source->get('a/b ?') === null, 'Upstream 404');
check(end($calls) === 'http://example.test/base/marketplace/records/a%2Fb%20%3F', 'URL-encoded ID');
Http::swap(new Illuminate\Http\Client\Factory);
Http::fake(fn () => Http::response('', 503));
check($send('/marketplace/en-US/item_1')->getStatusCode() >= 500, 'Upstream failure stays 5xx');
Http::swap(new Illuminate\Http\Client\Factory);
Http::fake(fn () => Http::response('', 302, ['Location' => 'http://example.test/elsewhere']));
check($send('/marketplace/en-US/item_1')->getStatusCode() >= 500, 'Upstream redirect is not followed');

echo "Marketplace checks passed: all locales, signed currency, half-away ratings, million plurals, native page/JSON, literal filtering, stable sorting, offers, localized links, CSRF POSTs, fixture startup, uncached HTTP and errors.\n";
