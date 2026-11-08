<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // Catalog and marketplace prefixes are literal text, including whitespace and "".
        $catalog = fn (Request $request) => $request->is('catalog/*', 'marketplace/*');
        $middleware->trimStrings(except: [$catalog]);
        $middleware->convertEmptyStringsToNull(except: [$catalog]);
        // The live benchmark's publisher is another service, not a browser form.
        $middleware->validateCsrfTokens(except: ['live/publish']);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
    })->create();
