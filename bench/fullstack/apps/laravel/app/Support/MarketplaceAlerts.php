<?php

namespace App\Support;

use Illuminate\Contracts\Session\Session;
use Illuminate\Support\Facades\Cache;

final class MarketplaceAlerts
{
    public function append(Session $session, array $alert): void
    {
        $store = Cache::store('file');
        $key = 'marketplace-alerts:'.$session->getId();
        $store->lock($key, 10)->block(10, function () use ($store, $key, $alert): void {
            $alerts = $store->get($key, []);
            $alerts[] = $alert;
            if (! $store->put($key, $alerts, config('session.lifetime') * 60)) {
                throw new \RuntimeException('Alert persistence failed');
            }
        });
    }

    public function list(Session $session): array
    {
        return Cache::store('file')->get('marketplace-alerts:'.$session->getId(), []);
    }
}
