<x-layout title="Popular items | Card Market">
<h1>Popular items</h1>
@if (count($shelf))<ul class="item-list__list">@foreach ($shelf as $item)<li><a class="item-card__card" href="/items/{{ $item['id'] }}" wire:navigate><strong>{{ $item['title'] }}</strong>@if ($item['subtitle'])<span class="item-card__set">{{ $item['subtitle'] }}</span>@endif @if ($s = $item['summary'])<span class="item-card__from">From {{ $s['lowest'] ?? '—' }}</span>@else<span class="item-card__from">No listings yet</span>@endif</a></li>@endforeach</ul>
@else<ul class="item-list__list item-list__ids">@foreach (range(1, 50) as $n)<li><a href="/items/item_{{ $n }}" wire:navigate>Item {{ $n }}</a></li>@endforeach</ul>@endif
</x-layout>
