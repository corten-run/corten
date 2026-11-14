<?php

namespace App\Providers;

use App\NativeReverbServer;
use App\Support\NativeStore;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\ServiceProvider;
use Laravel\Reverb\Events\MessageSent;
use Laravel\Reverb\Protocols\Pusher\Server;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->bind(Server::class, NativeReverbServer::class);
    }

    public function boot(): void
    {
        // Reverb's native post-subscription acknowledgement proves a real channel binding.
        Event::listen(MessageSent::class, function (MessageSent $event): void {
            $message = json_decode($event->message, true, flags: JSON_THROW_ON_ERROR);
            if (($message['event'] ?? null) === 'pusher_internal:subscription_succeeded'
                && preg_match('/^live\.([a-f0-9]{64})$/D', $message['channel'] ?? '', $match)) {
                NativeStore::nativeSubscription($match[1], $event->connection->id());
            }
        });
        config(['reverb.apps.apps.0.allowed_origins' => ['127.0.0.1', 'localhost']]);
    }
}
