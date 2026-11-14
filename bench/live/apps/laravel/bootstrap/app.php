<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(web: __DIR__.'/../routes/web.php')
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->validateCsrfTokens(except: ['parity/*']);
        $middleware->appendToGroup('web', App\Http\SameSiteWrites::class);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->render(function (InvalidArgumentException $error, Illuminate\Http\Request $request) {
            if ($request->is('parity/*')) {
                return response()->json(['error' => $error->getMessage()], 400);
            }
        });
    })->create();
