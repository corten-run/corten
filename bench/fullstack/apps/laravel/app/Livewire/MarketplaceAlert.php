<?php

namespace App\Livewire;

use App\Support\MarketplaceAlerts;
use App\Support\MarketplaceFormat;
use App\Support\MarketplaceSource;
use Livewire\Attributes\Locked;
use Livewire\Component;

class MarketplaceAlert extends Component
{
    #[Locked]
    public string $itemId;

    #[Locked]
    public string $locale;

    public string $email = '';

    public string $target = '';

    public string $message = '';

    public function save(MarketplaceSource $source, MarketplaceAlerts $alerts): void
    {
        abort_unless(in_array($this->locale, MarketplaceFormat::LOCALES, true), 400);
        $record = $source->get($this->itemId) ?? abort(404);
        [$this->message, $minor] = (new MarketplaceFormat($this->locale))->alertResult($this->email, $this->target, $record['title']);
        if ($minor !== null) {
            $alerts->append(request()->session(), ['item_id' => $record['id'], 'email' => $this->email, 'target_minor' => $minor]);
        }
    }

    public function render()
    {
        return view('livewire.marketplace-alert', ['labels' => (new MarketplaceFormat($this->locale))->labels]);
    }
}
