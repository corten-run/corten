<?php

namespace App\Providers;

use App\Support\CatalogSource;
use App\Support\ItemSource;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(ItemSource::class);
        $this->app->singleton(CatalogSource::class);
    }

    public function boot(): void
    {
        // Load the fixture when a server worker boots, not on its first request (and not in the
        // artisan process that starts the workers). It is read one item at a time (ItemSource), so
        // it fits PHP's default memory_limit (128M), which the app keeps.
        if (! $this->app->runningInConsole()) {
            $this->app->make(ItemSource::class);
            $this->app->make(CatalogSource::class);
        }
    }
}
