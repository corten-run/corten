<?php

use App\Events\PriceTick;
use App\Http\Controllers\CatalogController;
use App\Support\ItemSource;
use App\Support\ItemView;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

// Corten's home page: cards for the first 50 items with items in memory, links by id from the item
// API (which cannot list items).
Route::get('/', fn (ItemSource $items) => view('home', ['shelf' => $items->shelf()]));

Route::get('/items/{id}', function (string $id, ItemSource $items) {
    $item = $items->get($id) ?? abort(404);

    return view('item', ['item' => $item, 'listings' => ItemView::sortedListings($item)]);
});

Route::get('/catalog/{id}', [CatalogController::class, 'show'])->name('catalog.show');

// The live benchmark (bench/live): one price update, broadcast now (no queue) to Reverb.
Route::post('/live/publish', function (Request $request) {
    broadcast(new PriceTick((int) $request->input('seq'), (float) $request->input('sent'), (string) $request->input('price')));

    return response()->noContent();
});
