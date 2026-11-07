<?php

namespace App\Http\Controllers;

use App\Support\CatalogSource;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

class CatalogController extends Controller
{
    public function show(Request $request, string $id, CatalogSource $source): View
    {
        $record = $source->get($id) ?? abort(404);
        $prefix = $request->query('field', '');
        abort_unless(is_string($prefix), 400);

        return view('catalog', [
            'record' => $record,
            'prefix' => $prefix,
            'fields' => array_values(array_filter($record->fields, fn (array $field) => str_starts_with($field['name'], $prefix))),
        ]);
    }

    public function json(string $id, CatalogSource $source): JsonResponse
    {
        return response()->json($source->get($id) ?? abort(404));
    }
}
