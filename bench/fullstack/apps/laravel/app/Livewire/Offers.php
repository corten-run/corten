<?php

namespace App\Livewire;

use App\Support\ItemSource;
use Livewire\Component;

class Offers extends Component
{
    public string $itemId = '';

    public bool $all = false;

    /** "Show all" without JavaScript loads the page with ?offers=all. */
    public function mount(): void
    {
        $this->all = request()->query('offers') === 'all';
    }

    public function showAll(): void
    {
        $this->all = true;
    }

    public function render()
    {
        $offers = app(ItemSource::class)->get($this->itemId)['offers'] ?? [];

        return view('livewire.offers', ['offers' => $this->all ? $offers : array_slice($offers, 0, 5), 'total' => count($offers)]);
    }
}
