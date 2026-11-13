<?php

namespace App\Support;

use App\Events\NativeDelivery;
use Illuminate\Support\Facades\Cache;
use InvalidArgumentException;
use RuntimeException;

class NativeStore
{
    private static function fresh(): array
    {
        return ['rows' => [], 'through' => 0, 'history' => [], 'historyLimit' => 4,
            'historyPeak' => 0, 'queueLimit' => 2, 'queuePeak' => 0, 'clients' => [],
            'readers' => [], 'connections' => [], 'channels' => [], 'reads' => 0,
            'held' => false, 'drop' => null];
    }

    private static function change(callable $operation): mixed
    {
        $outbox = [];
        $cache = Cache::store('file');
        $result = $cache->lock('native-live-state-lock', 30)->block(10, function () use ($cache, $operation, &$outbox) {
            $state = $cache->get('native-live-state') ?? self::fresh();
            $result = $operation($state, $outbox);
            if (! $cache->forever('native-live-state', $state)) {
                throw new RuntimeException('Native cache write failed');
            }

            return $result;
        });
        // Never hold the cross-process state lock across a native broker request.
        foreach ($outbox as [$client, $packet]) {
            broadcast(new NativeDelivery($client, $packet));
        }

        return $result;
    }

    public static function validRow(mixed $row): bool
    {
        return is_array($row) && is_string($row['id'] ?? null)
            && preg_match('/^[a-zA-Z0-9_-]{1,100}$/D', $row['id'])
            && is_int($row['version'] ?? null) && is_int($row['priceCents'] ?? null) && is_int($row['quantity'] ?? null);
    }

    private static function validEvent(mixed $event, int $expected): bool
    {
        return is_array($event) && is_int($event['seq'] ?? null) && $event['seq'] === $expected
            && is_string($event['effectId'] ?? null) && is_string($event['key'] ?? null)
            && preg_match('/^[a-zA-Z0-9_-]{1,100}$/D', $event['key'])
            && (($event['op'] ?? null) === 'remove' || (($event['op'] ?? null) === 'upsert'
                && self::validRow($event['row'] ?? null) && $event['row']['id'] === $event['key']));
    }

    public static function configure(array $data): void
    {
        $rows = $data['initial'] ?? null;
        $bounds = [$data['queueLimit'] ?? null, $data['historyLimit'] ?? null];
        if (! is_array($rows) || ! array_is_list($rows) || count($rows) > 1000
            || ! in_array($bounds, [[2, 4], [1024, 1025]], true)
            || count(array_filter($rows, self::validRow(...))) !== count($rows)
            || count(array_unique(array_column($rows, 'id'))) !== count($rows)) {
            throw new InvalidArgumentException('Invalid configuration');
        }
        self::change(function (array &$s) use ($rows, $bounds): void {
            if ($s['connections'] || $s['readers']) {
                throw new InvalidArgumentException('Active native readers');
            }
            $s = self::fresh();
            $s['rows'] = array_column($rows, null, 'id');
            [$s['queueLimit'], $s['historyLimit']] = $bounds;
        });
    }

    public static function connection(string $socket): void
    {
        self::change(function (array &$s) use ($socket): void {
            if (! isset($s['connections'][$socket]) && count($s['connections']) >= 16) {
                throw new InvalidArgumentException('Native connection limit reached');
            }
            $s['connections'][$socket] = true;
        });
    }

    public static function disconnection(string $socket): void
    {
        self::change(function (array &$s) use ($socket): void {
            unset($s['connections'][$socket]);
            foreach ($s['channels'] as $client => $id) {
                if ($id === $socket) {
                    unset($s['channels'][$client], $s['readers'][$client]);
                }
            }
        });
    }

    public static function nativeSubscription(string $client, string $socket): void
    {
        self::change(function (array &$s) use ($client, $socket): void {
            if (! isset($s['connections'][$socket]) || (! isset($s['channels'][$client]) && count($s['channels']) >= 16)) {
                throw new InvalidArgumentException('Native channel limit reached');
            }
            $s['channels'][$client] = $socket;
        });
    }

    private static function observedState(array $state, array $observed): bool
    {
        return is_int($observed['through'] ?? null) && is_int($observed['effectCount'] ?? null)
            && is_int($observed['rowCount'] ?? null) && $observed['through'] === $state['through']
            && $observed['effectCount'] === $state['count'] && $observed['rowCount'] === count($state['rows']);
    }

    private static function reconcile(array $state, array $observed): array
    {
        if (self::observedState($state, $observed)) {
            $state['pending'] = null;

            return $state;
        }
        if ($state['pending'] !== null && self::observedState($state['pending'], $observed)) {
            return $state['pending'];
        }
        throw new InvalidArgumentException('Browser state is not acknowledged or pending');
    }

    public static function subscribe(string $client, int $from, bool $initial, array $observed): array
    {
        return self::change(function (array &$s) use ($client, $from, $initial, $observed) {
            if (! isset($s['channels'][$client], $s['connections'][$s['channels'][$client]])
                || $from < 0 || $from > $s['through'] || (! isset($s['readers'][$client]) && count($s['readers']) >= 16)
                || (! isset($s['clients'][$client]) && count($s['clients']) >= 16)) {
                throw new InvalidArgumentException('Invalid native reader or cursor');
            }
            $expired = $from < $s['through'] && (! $s['history'] || $from < $s['history'][0]['seq'] - 1);
            $replay = $initial || $expired ? [] : array_values(array_filter($s['history'], fn ($e) => $e['seq'] > $from));
            $s['readers'][$client] = ['id' => bin2hex(random_bytes(16)), 'queue' => [], 'replay' => $replay, 'inflight' => null, 'overflowed' => false];
            $s['clients'][$client] ??= ['through' => 0, 'rows' => [], 'count' => 0, 'initialized' => false, 'pending' => null];
            if (! $initial) {
                if (($observed['through'] ?? null) !== $from) {
                    throw new InvalidArgumentException('Browser cursor differs');
                }
                $s['clients'][$client] = self::reconcile($s['clients'][$client], $observed);
            }

            return ['consumer' => $client, 'readerId' => $s['readers'][$client]['id'], 'from' => $from, 'status' => $expired ? 'expired' : 'accepted',
                'needs_snapshot' => ! $s['clients'][$client]['initialized'], 'resources' => self::resourceState($s),
                'state' => $s['clients'][$client]];
        });
    }

    public static function snapshot(?string $client = null, array $observed = []): array
    {
        return self::change(function (array &$s) use ($client, $observed) {
            if ($client !== null) {
                self::requireReader($s, $client);
                $s['clients'][$client] = self::reconcile($s['clients'][$client], $observed);
            }
            $s['reads']++;
            $snapshot = ['through' => $s['through'], 'rows' => array_values($s['rows']),
                'work' => ['reads' => 1, 'rows' => count($s['rows'])]];
            if ($client === null) {
                return $snapshot;
            }
            self::requireReader($s, $client);
            $state = $s['clients'][$client];
            $state['rows'] = $s['rows'];
            $state['through'] = $s['through'];
            $state['initialized'] = true;
            $s['clients'][$client]['pending'] = $state;
            $s['readers'][$client] = ['id' => $s['readers'][$client]['id'], 'queue' => [], 'replay' => [],
                'inflight' => ['kind' => 'snapshot'], 'overflowed' => false];

            return ['snapshot' => $snapshot, 'state' => $state];
        });
    }

    public static function publish(array $data): array
    {
        return Cache::store('file')->lock('native-live-publication-lock', 30)->block(10,
            fn () => self::publishLocked($data));
    }

    private static function publishLocked(array $data): array
    {
        return self::change(function (array &$s, array &$outbox) use ($data) {
            if (array_key_exists('event', $data) === array_key_exists('events', $data)) {
                throw new InvalidArgumentException('Supply event or events');
            }
            $events = array_key_exists('event', $data) ? [$data['event']] : $data['events'];
            if (! is_array($events) || ! array_is_list($events) || count($events) < 1 || count($events) > 1044) {
                throw new InvalidArgumentException('Invalid events');
            }
            foreach ($events as $index => $event) {
                if (! self::validEvent($event, $s['through'] + $index + 1)) {
                    throw new InvalidArgumentException('Invalid or nonconsecutive event');
                }
            }
            $acks = [];
            foreach ($events as $event) {
                self::write($s, $outbox, $event);
                $acks[] = ['seq' => $event['seq'], 'resources' => self::resourceState($s)];
            }

            return array_key_exists('event', $data) ? $acks[0] : ['acks' => $acks];
        });
    }

    private static function write(array &$s, array &$outbox, array $event): void
    {
        $s['through'] = $event['seq'];
        if ($event['op'] === 'remove') {
            unset($s['rows'][$event['key']]);
        } else {
            $s['rows'][$event['key']] = $event['row'];
        }
        if (count($s['history']) === $s['historyLimit']) {
            array_shift($s['history']);
        }
        $s['history'][] = $event;
        $s['historyPeak'] = max($s['historyPeak'], count($s['history']));
        if ($event['seq'] !== $s['drop']) {
            self::enqueue($s, $outbox, $event);
        }
    }

    private static function enqueue(array &$s, array &$outbox, array $event): void
    {
        foreach (array_keys($s['readers']) as $client) {
            if ($s['readers'][$client]['overflowed']) {
                continue;
            }
            if (count($s['readers'][$client]['queue']) === $s['queueLimit']) {
                $resources = self::resourceState($s);
                $s['readers'][$client]['queue'] = $s['readers'][$client]['replay'] = [];
                $s['readers'][$client]['overflowed'] = true;
                $s['held'] = false;
                $outbox[] = [$client, ['kind' => 'overflow', 'readerId' => $s['readers'][$client]['id'],
                    'outcome' => 'resnapshot', 'resources' => $resources]];
            } else {
                $s['readers'][$client]['queue'][] = $event;
                $s['queuePeak'] = max($s['queuePeak'], count($s['readers'][$client]['queue']));
            }
        }
        foreach (array_keys($s['readers']) as $client) {
            self::pump($s, $outbox, $client);
        }
    }

    private static function send(array &$s, array &$outbox, string $client, array $packet): void
    {
        $packet['deliveryId'] = bin2hex(random_bytes(16));
        $packet['readerId'] = $s['readers'][$client]['id'];
        $s['readers'][$client]['inflight'] = $packet;
        $outbox[] = [$client, $packet];
    }

    private static function pump(array &$s, array &$outbox, string $client): void
    {
        if (! isset($s['readers'][$client]) || $s['held'] || $s['readers'][$client]['inflight'] !== null
            || $s['readers'][$client]['overflowed']) {
            return;
        }
        $reader = &$s['readers'][$client];
        $event = array_shift($reader['replay']) ?? array_shift($reader['queue']);
        if ($event !== null) {
            self::send($s, $outbox, $client, ['kind' => 'event', 'event' => $event]);
        }
    }

    public static function consume(string $client, array $packet): array
    {
        return self::change(function (array &$s) use ($client, $packet) {
            self::requireReader($s, $client);
            $pending = $s['readers'][$client]['inflight'];
            if (! is_array($pending) || ! is_string($packet['deliveryId'] ?? null)
                || ! hash_equals($pending['deliveryId'] ?? '', $packet['deliveryId']) || $pending !== $packet) {
                throw new InvalidArgumentException('Not the pending native delivery');
            }
            $state = $s['clients'][$client];
            $state['pending'] = null;
            if ($packet['kind'] === 'event') {
                $event = $packet['event'];
                if ($event['seq'] <= $state['through']) {
                    $packet['disposition'] = 'duplicate';
                } elseif ($event['seq'] !== $state['through'] + 1) {
                    $packet['disposition'] = 'gap';
                } else {
                    $packet['disposition'] = 'applied';
                    if ($event['op'] === 'remove') {
                        unset($state['rows'][$event['key']]);
                    } else {
                        $state['rows'][$event['key']] = $event['row'];
                    }
                    $state['through'] = $event['seq'];
                    $state['count']++;
                }
            }

            $s['clients'][$client]['pending'] = $state;

            return ['packet' => $packet, 'state' => $state];
        });
    }

    public static function resume(string $client): void
    {
        self::change(function (array &$s, array &$outbox) use ($client): void {
            self::requireReader($s, $client);
            self::pump($s, $outbox, $client);
        });
    }

    public static function acknowledge(string $client, array $observed): void
    {
        self::change(function (array &$s, array &$outbox) use ($client, $observed): void {
            self::requireReader($s, $client);
            $candidate = $s['clients'][$client]['pending'] ?? $s['clients'][$client];
            if (! self::observedState($candidate, $observed)) {
                throw new InvalidArgumentException('Browser acknowledgement differs');
            }
            if ($s['clients'][$client]['pending'] === null) {
                return;
            }
            $s['clients'][$client] = $candidate;
            $s['readers'][$client]['inflight'] = null;
            self::pump($s, $outbox, $client);
        });
    }

    public static function finish(string $client): void
    {
        self::change(function (array &$s) use ($client): void { unset($s['readers'][$client], $s['clients'][$client]); });
    }

    public static function control(array $data): void
    {
        self::change(function (array &$s, array &$outbox) use ($data): void {
            switch ($data['action'] ?? null) {
                case 'hold': $s['held'] = true; break;
                case 'drop':
                    if (! is_int($data['seq'] ?? null) || $data['seq'] <= 0) {
                        throw new InvalidArgumentException('Invalid drop sequence');
                    }
                    $s['drop'] = $data['seq'];
                    break;
                case 'duplicate':
                    if (! $s['history']) {
                        throw new InvalidArgumentException('No event');
                    }
                    self::enqueue($s, $outbox, $s['history'][array_key_last($s['history'])]);
                    break;
                default: throw new InvalidArgumentException('Unknown control');
            }
        });
    }

    private static function requireReader(array $s, string $client): void
    {
        if (! isset($s['readers'][$client], $s['clients'][$client])) {
            throw new InvalidArgumentException('No native reader');
        }
    }

    public static function resources(): array
    {
        return self::change(fn (array &$s) => self::resourceState($s));
    }

    private static function resourceState(array $s): array
    {
        $readers = array_values($s['readers']);
        $consumers = [];
        foreach (array_unique([...array_keys($s['clients']), ...array_keys($s['channels'])]) as $client) {
            $reader = $s['readers'][$client] ?? null;
            $consumers[$client] = ['subscriptions' => $reader === null ? 0 : 1,
                'connections' => isset($s['channels'][$client]) ? 1 : 0,
                'pendingTasks' => $reader === null ? 0 : 1, 'queueEvents' => count($reader['queue'] ?? [])];
        }

        return ['subscriptions' => count($readers), 'connections' => count($s['connections']), 'pendingTasks' => count($readers),
            'queueLimit' => $s['queueLimit'], 'queueEvents' => array_sum(array_map(fn ($r) => count($r['queue']), $readers)),
            'queuePeak' => $s['queuePeak'], 'historyLimit' => $s['historyLimit'], 'historyEvents' => count($s['history']), 'historyPeak' => $s['historyPeak'],
            'process' => ['pid' => getmypid(), 'php' => PHP_VERSION, 'memoryBytes' => memory_get_usage(true), 'rusage' => getrusage()],
            'inventory' => ['consumers' => (object) $consumers, 'processes' => self::processes(), 'inflightEvents' => count(array_filter($readers, fn ($r) => $r['inflight'] !== null)),
                'inflightLimitPerReader' => 1, 'overflowSlotsLimit' => 1,
                'replayCopyEvents' => array_sum(array_map(fn ($r) => count($r['replay']), $readers)), 'replayCopyLimitEvents' => $s['historyLimit'],
                'retainedClients' => count($s['clients']), 'retainedClientLimit' => 16,
                'retainedClientRows' => array_sum(array_map(fn ($c) => count($c['rows']), $s['clients'])),
                'stagedClientRows' => array_sum(array_map(fn ($c) => count($c['pending']['rows'] ?? []), $s['clients'])),
                'stagedStatesLimitPerClient' => 1,
                'sourceRows' => count($s['rows']), 'snapshotReads' => $s['reads'],
                'nativeSocketBufferBytes' => null]];
    }

    private static function processes(): array
    {
        $processes = [];
        foreach (glob('/proc/[0-9]*/comm') ?: [] as $file) {
            $name = @file_get_contents($file);
            if ($name !== false) {
                $processes[] = ['pid' => (int) basename(dirname($file)), 'name' => trim($name)];
            }
        }

        return $processes;
    }
}
