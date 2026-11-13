<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;

class NativeDelivery implements ShouldBroadcastNow
{
    public function __construct(private string $client, public array $packet) {}

    public function broadcastOn(): Channel
    {
        return new Channel('live.'.$this->client);
    }

    public function broadcastAs(): string
    {
        return 'delivery';
    }
}
