<?php

// Runs in the production benchmark image, without installing development dependencies.
require __DIR__.'/../vendor/autoload.php';

use App\Support\CatalogRecord;
use App\Support\CatalogSource;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;

$app = require __DIR__.'/../bootstrap/app.php';
$kernel = $app->make(Kernel::class);
$kernel->bootstrap();
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

function raises(callable $call, string $class): void
{
    try {
        $call();
    } catch (Throwable $error) {
        check($error instanceof $class, 'Unexpected error: '.$error::class);

        return;
    }
    throw new RuntimeException('Expected '.$class);
}

$record = [
    'id' => 'record_1', 'title' => '<script>"title"</script>', 'subtitle' => 'A & B', 'description' => '001.50',
    'tags' => ['<tag>', 'second'],
    'fields' => [['name' => 'Access', 'value' => '<north>'], ['name' => 'access', 'value' => 'south']],
    'related' => [['id' => 'record_2', 'title' => '<Related>']],
];
$empty = [...$record, 'id' => 'record_2', 'tags' => [], 'fields' => [], 'related' => []];

$path = tempnam(sys_get_temp_dir(), 'catalog');
file_put_contents($path, json_encode(['record_1' => $record, 'record_2' => $empty], JSON_THROW_ON_ERROR));
config(['catalog.source' => 'fixture', 'catalog.fixture_path' => $path]);
$source = new CatalogSource;
unlink($path);
check($source->get('record_1')->jsonSerialize() === $record, 'Fixture is parsed once');
check($source->get('missing') === null, 'Unknown fixture record');
$app->instance(CatalogSource::class, $source);

$get = function (string $path) use ($kernel) {
    $request = Request::create($path);
    $response = $kernel->handle($request);
    $kernel->terminate($request, $response);

    return $response;
};

$response = $get('/catalog/record_1?field=A');
check($response->getStatusCode() === 200, 'Catalog page status');
$html = $response->getContent();
foreach (['&lt;script&gt;&quot;title&quot;&lt;/script&gt;', '&lt;north&gt;', 'name="field" value="A"', 'action="/catalog/record_1"', 'href="/catalog/record_2"', '/catalog.css'] as $text) {
    check(str_contains($html, $text), 'Missing escaped page content: '.$text);
}
check(! str_contains($html, 'south'), 'Case-sensitive prefix filter');
check(str_contains($get('/catalog/record_1')->getContent(), 'south'), 'Unfiltered fields');
$html = $get('/catalog/record_1?field='.rawurlencode(' <"'))->getContent();
check(str_contains($html, 'value=" &lt;&quot;"'), 'Literal prefix retained');
check(! str_contains($html, '<th scope="row">'), 'Prefix must not be trimmed');

foreach ([$record, $empty] as $value) {
    $response = $get('/api/catalog/'.$value['id']);
    check($response->getStatusCode() === 200, 'JSON status');
    check(json_decode($response->getContent(), true, flags: JSON_THROW_ON_ERROR) === $value, 'JSON schema');
}
$html = $get('/catalog/record_2')->getContent();
foreach (['<ul aria-label="Tags"></ul>', '<tbody></tbody>', '<nav aria-label="Related records"><ul></ul></nav>'] as $text) {
    check(str_contains($html, $text), 'Empty list container: '.$text);
}
foreach (['/catalog/missing', '/api/catalog/missing'] as $path) {
    check($get($path)->getStatusCode() === 404, 'Actual 404');
}

config(['catalog.source' => 'api', 'catalog.api_base' => 'http://example.test/base']);
$calls = [];
$responses = [$record, [...$record, 'title' => 'changed']];
Http::fake(function ($request) use (&$calls, &$responses) {
    $calls[] = $request->url();

    return Http::response(array_shift($responses));
});
$source = new CatalogSource;
check($source->get('record_1')->title === $record['title'], 'First API record');
check($source->get('record_1')->title === 'changed', 'No API record cache');
check($calls === array_fill(0, 2, 'http://example.test/base/catalog/records/record_1'), 'One fetch per call');
Http::swap(new Illuminate\Http\Client\Factory);
Http::fake(fn () => Http::response('', 404));
check($source->get('missing') === null, 'Upstream 404');
Http::swap(new Illuminate\Http\Client\Factory);
Http::fake(fn () => Http::response('', 503));
raises(fn () => $source->get('record_1'), Illuminate\Http\Client\RequestException::class);
Http::swap(new Illuminate\Http\Client\Factory);
Http::fake(fn () => Http::response('invalid json'));
raises(fn () => $source->get('record_1'), JsonException::class);

foreach ([[...$record, 'subtitle' => 123], [...$record, 'tags' => null], [...$record, 'fields' => [['name' => 'a', 'value' => 1]]]] as $value) {
    raises(fn () => CatalogRecord::fromArray($value), InvalidArgumentException::class);
}

echo "Catalog checks passed: fixture warmup, native page, escaping, prefix filtering, JSON, empty lists, 404, uncached API, upstream errors, schema validation.\n";
