<?php

use Illuminate\Contracts\Console\Kernel;
use Laravel\Reverb\Application;
use Laravel\Reverb\Contracts\Connection;
use Laravel\Reverb\Protocols\Pusher\Contracts\ChannelManager;
use Laravel\Reverb\Protocols\Pusher\Server;

require __DIR__.'/../vendor/autoload.php';
$app = require __DIR__.'/../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
set_exception_handler(function (Throwable $error): never {
    fwrite(STDERR, get_class($error).': '.$error->getMessage()."\n");
    exit(1);
});
Laravel\Reverb\Servers\Reverb\Factory::makePusherRouter('');
$application = new Application('unit-broker', 'public-unit-key', 'unit-only', 60, 30, ['localhost'], 10000);
// Only the low-level socket is a unit double; the native server, event handler,
// channel manager and allocation path are the installed production classes.
$socket = new class($application) extends Connection
{
    public array $sent = [];
    public function __construct(Application $application) { $this->application = $application; }
    public function id(): string { return 'unit-socket'; }
    public function identifier(): string { return 'unit-socket'; }
    public function send(string $message): void { $this->sent[] = json_decode($message, true, flags: JSON_THROW_ON_ERROR); }
    public function control(string $type = '9'): void {}
    public function terminate(): void {}
};
$server = app(Server::class);
$channels = app(ChannelManager::class)->for($application);
for ($n = 0; $n < 17; $n++) {
    $server->message($socket, json_encode(['event' => 'pusher:subscribe',
        'data' => ['channel' => 'live.'.str_pad(dechex($n), 64, '0', STR_PAD_LEFT)]]));
}
if (count($channels->all()) !== 16) {
    throw new RuntimeException('Native broker allocated '.count($channels->all()).' channels; expected cap 16');
}
$server->message($socket, json_encode(['event' => 'pusher:subscribe', 'data' => ['channel' => 'untracked']]));
if (count($channels->all()) !== 16 || $socket->sent[array_key_last($socket->sent)]['event'] !== 'pusher:error') {
    throw new RuntimeException('Invalid channel allocated before rejection');
}
$server->close($socket);
if ($channels->all() !== []) {
    throw new RuntimeException('Native broker close retained channel allocations');
}
echo "Laravel native broker: actual allocation cap/name validation/native close: passed\n";
