<?php

namespace App\Livewire;

use App\Support\NativeStore;
use Livewire\Attributes\Locked;
use Livewire\Component;

class NativeScreen extends Component
{
    #[Locked] public string $client;
    #[Locked] public array $rows = [];
    #[Locked] public int $through = 0;
    #[Locked] public int $count = 0;

    public function mount(): void
    {
        $this->client = bin2hex(random_bytes(32));
    }

    public function start(int $from, bool $initial, array $observed): void
    {
        $ready = NativeStore::subscribe($this->client, $from, $initial, $observed);
        $state = $ready['state'];
        unset($ready['state']);
        $this->notify(['kind' => 'ready'] + $ready, $state);
        if ($initial || $ready['needs_snapshot']) {
            $this->snapshot($observed);
        } elseif ($ready['status'] !== 'expired') {
            $this->replace($state);
            $this->notify(['kind' => 'restore'], $state);
            NativeStore::resume($this->client);
        }
    }

    public function snapshot(array $observed): void
    {
        $value = NativeStore::snapshot($this->client, $observed);
        $this->replace($value['state']);
        $this->notify(['kind' => 'snapshot', 'snapshot' => $value['snapshot']], $value['state']);
    }

    public function receive(array $payload): void
    {
        $value = NativeStore::consume($this->client, $payload['packet']);
        $this->replace($value['state']);
        $this->notify($value['packet'], $value['state']);
    }

    public function acknowledge(array $observed): void
    {
        NativeStore::acknowledge($this->client, $observed);
        $this->skipRender();
    }

    public function finish(): void
    {
        NativeStore::finish($this->client);
        $this->dispatch('parity', packet: ['kind' => 'finished']);
        $this->skipRender();
    }

    private function replace(array $state): void
    {
        $this->rows = array_values($state['rows']);
        $this->through = $state['through'];
        $this->count = $state['count'];
    }

    private function notify(array $packet, array $state): void
    {
        $this->dispatch('parity', packet: $packet + ['nativeThrough' => $state['through'],
            'nativeCount' => $state['count'], 'nativeRows' => count($state['rows'])]);
    }

    public function render()
    {
        return view('livewire.native-screen');
    }
}
