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
        parent::open($connection);
        NativeStore::connection($connection->id());
    }

    public function close(Connection $connection): void
    {
        try {
            parent::close($connection);
        } finally {
            NativeStore::disconnection($connection->id());
        }
    }
}
