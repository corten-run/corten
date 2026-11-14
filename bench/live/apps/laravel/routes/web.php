<?php

use App\Support\NativeStore;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

Route::get('/', fn () => view('home'));
Route::prefix('parity')->group(function (): void {
    Route::post('/configure', function (Request $request) {
        NativeStore::configure($request->json()->all());

        return response()->json(['configured' => true, 'framework' => 'laravel', 'version' => app()->version()]);
    });
    Route::get('/snapshot', fn () => response()->json(NativeStore::snapshot())->header('Cache-Control', 'no-store'));
    Route::get('/resources', fn () => response()->json(NativeStore::resources())->header('Cache-Control', 'no-store'));
    Route::post('/publish', fn (Request $request) => response()->json(NativeStore::publish($request->json()->all())));
    Route::post('/control', function (Request $request) {
        NativeStore::control($request->json()->all());

        return response()->json(['resources' => NativeStore::resources()]);
    });
});
