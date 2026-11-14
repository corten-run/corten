<?php

require __DIR__.'/../vendor/autoload.php';

use App\Support\MarketplaceAlerts;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Filesystem\Filesystem;
use Illuminate\Session\FileSessionHandler;
use Illuminate\Session\Store;
use Illuminate\Support\Str;

$app = require __DIR__.'/../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
$directory = sys_get_temp_dir().'/marketplace-alerts-'.bin2hex(random_bytes(16));
$files = new Filesystem;
$files->makeDirectory($directory.'/sessions', 0700, true);
config(['cache.stores.file.path' => $directory.'/data', 'cache.stores.file.lock_path' => $directory.'/locks']);
$app->make('cache')->purge('file');

function verify(bool $condition, string $message): void
{
    if (! $condition) {
        throw new RuntimeException($message);
    }
}

try {
    $session = new Store('alerts-test', new FileSessionHandler($files, $directory.'/sessions', 120));
    $session->setId(Str::random(40));
    $alerts = new MarketplaceAlerts;
    verify($alerts->list($session) === [], 'Fresh native session');
    $first = ['item_id' => 'item_1', 'email' => 'first@test', 'target_minor' => 1250];
    $second = ['item_id' => 'item_2', 'email' => 'second@test', 'target_minor' => 11];
    $alerts->append($session, $first);
    $alerts->append($session, $second);
    verify($alerts->list($session) === [$first, $second], 'Insertion order and independent read');
    $children = [];
    for ($worker = 0; $worker < 8; $worker++) {
        $pid = pcntl_fork();
        verify($pid !== -1, 'Native process fork');
        if ($pid === 0) {
            for ($index = 0; $index < 10; $index++) {
                $alerts->append($session, ['item_id' => 'item_1', 'email' => "$worker-$index@test", 'target_minor' => $index]);
            }
            exit(0);
        }
        $children[] = $pid;
    }
    foreach ($children as $pid) {
        pcntl_waitpid($pid, $status);
        verify(pcntl_wifexited($status) && pcntl_wexitstatus($status) === 0, 'Concurrent worker completed');
    }
    $stored = $alerts->list($session);
    verify(count($stored) === 82 && count(array_unique(array_column($stored, 'email'))) === 82, 'No concurrent append is lost or duplicated');
    verify(array_slice($stored, 0, 2) === [$first, $second], 'Earlier insertion order retained');
    $session->setId(Str::random(40));
    verify($alerts->list($session) === [], 'Different native session isolated');
    echo "Alert store checks passed: native ordered reads, 80 concurrent multi-process appends, no loss/duplicates, independent session.\n";
} finally {
    $files->deleteDirectory($directory);
}
