<?php

namespace App\Http\Controllers;

use App\Support\MarketplaceFormat;
use App\Support\MarketplaceSource;
use App\Support\MarketplaceAlerts;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

class MarketplaceController extends Controller
{
    public function show(Request $request, string $locale, string $id, MarketplaceSource $source): View
    {
        abort_unless(in_array($locale, MarketplaceFormat::LOCALES, true), 400);
        $record = $source->get($id) ?? abort(404);
        $prefix = $request->query('seller', '');
        abort_unless(is_string($prefix), 400);
        $order = $request->query('sort') === 'desc' ? 'desc' : 'asc';
        $showAll = $request->query('offers') === 'all';
        $listings = array_values(array_filter($record['listings'], fn (array $row) => str_starts_with($row['seller'], $prefix)));
        // PHP's native sort is stable, including in descending order.
        usort($listings, function (array $a, array $b) use ($order): int {
            $nulls = ($a['price_minor'] === null) <=> ($b['price_minor'] === null);

            return $nulls ?: (($a['price_minor'] <=> $b['price_minor']) * ($order === 'desc' ? -1 : 1));
        });
        $format = new MarketplaceFormat($locale);
        $email = $request->input('email', '');
        $target = $request->input('target_price', '');
        abort_unless(is_string($email) && is_string($target), 400);
        $message = '';
        if ($request->isMethod('post')) {
            [$message, $minor] = $format->alertResult($email, $target, $record['title']);
            if ($minor !== null) {
                app(MarketplaceAlerts::class)->append($request->session(), ['item_id' => $record['id'], 'email' => $email, 'target_minor' => $minor]);
            }
        }

        return view('marketplace', [
            'record' => $record, 'locale' => $locale, 'format' => $format, 'labels' => $format->labels,
            'prefix' => $prefix, 'order' => $order, 'showAll' => $showAll, 'listings' => $listings,
            'offers' => $showAll ? $record['offers'] : array_slice($record['offers'], 0, 5),
            'email' => $email, 'target' => $target,
            'message' => $message,
        ]);
    }

    public function json(string $id, MarketplaceSource $source): JsonResponse
    {
        return response()->json($source->get($id) ?? abort(404));
    }

    public function alerts(Request $request, MarketplaceAlerts $alerts): JsonResponse
    {
        return response()->json($alerts->list($request->session()))->header('Cache-Control', 'private, no-store');
    }
}
