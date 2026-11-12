<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

final class SameSiteWrites
{
    public function handle(Request $request, Closure $next)
    {
        if (! $request->isMethodSafe()) {
            abort_if($request->header('Sec-Fetch-Site') === 'cross-site', 403);
            $origin = $request->header('Origin');
            abort_if($origin !== null && $origin !== $request->getSchemeAndHttpHost(), 403);
        }

        return $next($request);
    }
}
