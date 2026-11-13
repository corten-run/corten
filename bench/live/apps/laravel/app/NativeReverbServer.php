<?php

namespace App;

use App\Support\NativeStore;
use Laravel\Reverb\Contracts\Connection;
use Laravel\Reverb\Protocols\Pusher\Server;

// Native server lifecycle extension, not a replacement protocol or WebSocket implementation.
class NativeReverbServer extends Server
{
    public function open(Connection $connection): void
    {
        try {
            NativeStore::connection($connection->id());
        } catch (\InvalidArgumentException) {
            $connection->terminate();

            return;
        }
        parent::open($connection);
    }

    public function close(Connection $connection): void
    {
        try {
            parent::close($connection);
        } finally {
            NativeStore::disconnection($connection->id());
        }
    }

    public function message(Connection $from, string $message): void
    {
        $event = json_decode($message, true);
        if (($event['event'] ?? null) === 'pusher:subscribe') {
            $data = $event['data'] ?? [];
            $data = is_string($data) ? json_decode($data, true) : $data;
            $name = $data['channel'] ?? null;
            $channels = $this->channels->for($from->app());
            if (! is_string($name) || ! preg_match('/^live\.[a-f0-9]{64}$/D', $name)
                || (! $channels->exists($name) && count($channels->all()) >= 16)) {
                $this->error($from, new \InvalidArgumentException('Native channel limit or name'));

                return;
            }
        }
        parent::message($from, $message);
    }
}
