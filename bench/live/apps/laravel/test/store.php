<?php

use App\Events\NativeDelivery;
use App\Support\NativeStore as Store;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\Event;

require __DIR__.'/../vendor/autoload.php';
$app = require __DIR__.'/../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
set_exception_handler(function (Throwable $error): never {
    fwrite(STDERR, get_class($error).': '.$error->getMessage()."\n");
    exit(1);
});
Event::fake([NativeDelivery::class]);

function check(bool $condition, string $message): void
{
    if (! $condition) {
        throw new RuntimeException($message);
    }
}
function rejects(callable $operation): void
{
    try {
        $operation();
    } catch (InvalidArgumentException) {
        return;
    }
    throw new RuntimeException('Invalid native operation accepted');
}
function row(int $version = 0): array
{
    return ['id' => 'a', 'version' => $version, 'priceCents' => 100, 'quantity' => 1];
}
function event(int $seq): array
{
    return ['seq' => $seq, 'effectId' => 'effect-'.$seq, 'key' => 'a', 'op' => 'upsert', 'row' => row($seq)];
}
function observed(int $through, int $count, int $rows = 1): array
{
    return ['through' => $through, 'effectCount' => $count, 'rowCount' => $rows];
}
function attach(string $id = 'browser'): void
{
    Store::connection($id);
    Store::nativeSubscription($id, $id);
    Store::subscribe($id, 0, true, observed(0, 0, 0));
    Store::snapshot($id, observed(0, 0, 0));
    Store::acknowledge($id, observed(0, 0));
}
function packet(): array
{
    return Event::dispatched(NativeDelivery::class)->last()[0]->packet;
}
function publish(int $seq): array
{
    return Store::publish(['event' => event($seq)]);
}
function configure(): void
{
    Store::configure(['initial' => [row()], 'queueLimit' => 2, 'historyLimit' => 4]);
}

$tests = [
    'prevalidation and independent authoritative reads' => function (): void {
        rejects(fn () => publish(2));
        rejects(fn () => Store::publish(['events' => [event(1), event(3)]]));
        rejects(fn () => Store::publish(['event' => event(1), 'events' => [event(1)]]));
        check(Store::snapshot()['through'] === 0, 'rejected input mutated source');
        publish(1);
        check(Store::snapshot()['rows'] === [row(1)], 'source rows incorrect');
        check(Store::snapshot()['rows'] === [row(1)], 'GET reset source');
    },
    'real bounded overflow retains an applied effect only after browser evidence' => function (): void {
        attach();
        publish(1);
        $delivery = packet();
        $value = Store::consume('browser', $delivery);
        check($value['state']['count'] === 1, 'event was not staged');
        Store::publish(['events' => [event(2), event(3), event(4)]]);
        $overflow = packet();
        check($overflow['kind'] === 'overflow' && $overflow['resources']['queueEvents'] === 2, 'no actual queue saturation');
        $reads = Store::resources()['inventory']['snapshotReads'];
        rejects(fn () => Store::snapshot('browser', observed(1, 99)));
        rejects(fn () => Store::snapshot('browser', observed(4, 4)));
        rejects(fn () => Store::snapshot('browser', observed(1, 1, 2)));
        check(Store::resources()['inventory']['snapshotReads'] === $reads, 'rejected observation performed snapshot work');
        $value = Store::snapshot('browser', observed(1, 1));
        check($value['snapshot']['through'] === 4 && $value['state']['count'] === 1, 'lost ACK erased applied effect');
        Store::acknowledge('browser', observed(4, 1));
        Store::control(['action' => 'duplicate']);
        $value = Store::consume('browser', packet());
        check($value['packet']['disposition'] === 'duplicate' && $value['state']['count'] === 1, 'duplicate applied twice');
        Store::acknowledge('browser', observed(4, 1));
        publish(5);
        check(Store::consume('browser', packet())['state']['count'] === 2, 'no progress after snapshot');
    },
    'duplicate acknowledgement cannot release an unconsumed delivery' => function (): void {
        attach();
        publish(1);
        Store::consume('browser', packet());
        Store::acknowledge('browser', observed(1, 1));
        publish(2);
        $second = packet();
        publish(3);
        $sent = Event::dispatched(NativeDelivery::class)->count();
        Store::acknowledge('browser', observed(1, 1));
        check(Event::dispatched(NativeDelivery::class)->count() === $sent, 'duplicate ACK released unconsumed credit');
        check(Store::consume('browser', $second)['state']['through'] === 2, 'duplicate ACK discarded delivery');
        Store::acknowledge('browser', observed(2, 2));
        check(packet()['event']['seq'] === 3, 'valid ACK did not grant credit');
    },
    'unobserved delivery contributes no snapshot effect' => function (): void {
        attach();
        publish(1);
        Store::publish(['events' => [event(2), event(3), event(4)]]);
        $value = Store::snapshot('browser', observed(0, 0));
        check($value['state']['count'] === 0 && $value['snapshot']['through'] === 4, 'unobserved effect counted');
    },
    'lost native morph response cannot contribute an unobserved effect' => function (): void {
        attach();
        publish(1);
        $delivery = packet();
        rejects(fn () => Store::consume('browser', $delivery + ['forged' => true]));
        $forged = $delivery;
        $forged['event']['row']['quantity'] = 999;
        rejects(fn () => Store::consume('browser', $forged));
        $forged['event']['row']['quantity'] = true;
        rejects(fn () => Store::consume('browser', $forged));
        Store::consume('browser', $delivery);
        Store::consume('browser', $delivery);
        check(Store::resources()['inventory']['stagedClientRows'] === 1, 'repeated delivery grew staged state');
        $value = Store::snapshot('browser', observed(0, 0));
        check($value['state']['count'] === 0 && $value['snapshot']['through'] === 1, 'unobserved native morph counted');
    },
    'lost ACK reconnect reconciles staged state and bounded replay' => function (): void {
        attach();
        publish(1);
        Store::consume('browser', packet());
        Store::disconnection('browser');
        Store::connection('browser');
        Store::nativeSubscription('browser', 'browser');
        $ready = Store::subscribe('browser', 1, false, observed(1, 1));
        check($ready['state']['count'] === 1 && $ready['status'] === 'accepted', 'reconnect lost staged effect');
        $sent = Event::dispatched(NativeDelivery::class)->count();
        Store::resume('browser');
        check(Event::dispatched(NativeDelivery::class)->count() === $sent, 'observed cursor replayed before missed work');
        publish(2);
        check(packet()['event']['seq'] === 2, 'missed native delivery blocked by an already observed event');
        $value = Store::consume('browser', packet());
        check($value['packet']['disposition'] === 'applied' && $value['state']['count'] === 2, 'replay lost the next effect');
        Store::acknowledge('browser', observed(2, 2));
        Store::control(['action' => 'duplicate']);
        $value = Store::consume('browser', packet());
        check($value['packet']['disposition'] === 'duplicate' && $value['state']['count'] === 2, 'native duplicate applied twice after reconnect');
    },
    'superseded reader delivery cannot mutate a newly resumed reader' => function (): void {
        attach();
        publish(1);
        $old = packet();
        $ready = Store::subscribe('browser', 0, false, observed(0, 0));
        check($ready['readerId'] !== $old['readerId'], 'reader identity reused');
        Store::resume('browser');
        $current = packet();
        rejects(fn () => Store::consume('browser', $old));
        check(Store::consume('browser', $current)['state']['count'] === 1, 'current native replay rejected');
    },
    'expiry and gap use source snapshots without additional effects' => function (): void {
        attach();
        publish(1);
        Store::consume('browser', packet());
        Store::acknowledge('browser', observed(1, 1));
        Store::disconnection('browser');
        for ($n = 2; $n <= 6; $n++) {
            publish($n);
        }
        Store::connection('browser');
        Store::nativeSubscription('browser', 'browser');
        check(Store::subscribe('browser', 1, false, observed(1, 1))['status'] === 'expired', 'expiry not detected');
        Store::snapshot('browser', observed(1, 1));
        Store::acknowledge('browser', observed(6, 1));
        Store::control(['action' => 'drop', 'seq' => 7]);
        publish(7);
        publish(8);
        check(Store::consume('browser', packet())['packet']['disposition'] === 'gap', 'gap not detected');
        check(Store::resources()['historyEvents'] === 4, 'history unbounded');
    },
    'independent consumers and native per-consumer teardown' => function (): void {
        attach('browser');
        attach('peer');
        rejects(fn () => configure());
        publish(1);
        $deliveries = Event::dispatched(NativeDelivery::class)->take(-2)->values();
        foreach (['browser', 'peer'] as $index => $client) {
            check(Store::consume($client, $deliveries[$index][0]->packet)['state']['count'] === 1, 'consumer missed delivery');
            Store::acknowledge($client, observed(1, 1));
        }
        Store::finish('browser');
        Store::disconnection('browser');
        $inventory = (array) Store::resources()['inventory']['consumers'];
        check(! isset($inventory['browser']) && $inventory['peer']['subscriptions'] === 1, 'teardown affected peer');
        check(Store::resources()['inventory']['nativeSocketBufferBytes'] === null, 'unknown socket buffering fabricated');
    },
    'native connection, channel and retained-client caps are enforced' => function (): void {
        try {
            for ($n = 0; $n < 16; $n++) {
                attach('limit-'.$n);
            }
            rejects(fn () => Store::connection('seventeenth'));
            rejects(fn () => Store::nativeSubscription('seventeenth', 'limit-0'));
            check(Store::resources()['connections'] === 16, 'native connection cap exceeded');
            check(Store::resources()['inventory']['retainedClients'] === 16, 'native client cap exceeded');
        } finally {
            for ($n = 0; $n < 16; $n++) {
                Store::finish('limit-'.$n);
                Store::disconnection('limit-'.$n);
            }
        }
    },
];
foreach ($tests as $name => $test) {
    foreach (['browser', 'peer'] as $id) {
        Store::disconnection($id);
    }
    configure();
    $test();
    echo "Laravel native store: $name: passed\n";
}
foreach (['browser', 'peer'] as $id) {
    Store::finish($id);
    Store::disconnection($id);
}
echo count($tests)." native store cases passed\n";
