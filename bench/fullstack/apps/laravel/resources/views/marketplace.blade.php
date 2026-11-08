<x-layout :title="$record['title']" :lang="$locale">
<x-slot:head><link rel="stylesheet" href="{{ asset('marketplace.css') }}"></x-slot:head>
<article class="marketplace">
<nav class="marketplace__categories">@foreach ($record['categories'] as $category)<a href="{{ route('marketplace.show', ['locale' => $locale, 'id' => 'item_1']) }}">{{ $category['name'] }}</a>@endforeach</nav>
<h1>{{ $record['title'] }}</h1>
@if ($record['subtitle'] !== null)<p class="marketplace__subtitle">{{ $record['subtitle'] }}</p>@endif
<ul class="marketplace__badges">@foreach ($record['badges'] as $badge)<li>{{ $badge }}</li>@endforeach</ul>
<div class="marketplace__images">@foreach ($record['images'] as $image)<div class="marketplace__image" role="img" aria-label="{{ $record['title'] }} {{ $loop->iteration }}" data-src="{{ $image }}"></div>@endforeach</div>
<section class="marketplace__summary">@if ($record['summary'] !== null)<span><strong>{{ $format->money($record['summary']['lowest_minor']) }}</strong> {{ $labels['lowest'] }}</span><span>{{ $format->count($record['summary']['count']) }}</span><span>{{ $format->number($record['summary']['quantity']) }} {{ $labels['available'] }}</span>@else<span>{{ $labels['no_listings'] }}</span>@endif</section>
<section class="marketplace__listings"><h2>{{ $labels['listings'] }}</h2>
<form method="get" action="{{ route('marketplace.show', ['locale' => $locale, 'id' => $record['id']]) }}">
<label>{{ $labels['filter'] }}<input type="text" name="seller" value="{{ $prefix }}"></label>
<label>{{ $labels['sort'] }}<select name="sort"><option value="asc" @selected($order === 'asc')>{{ $labels['asc'] }}</option><option value="desc" @selected($order === 'desc')>{{ $labels['desc'] }}</option></select></label>
@if ($showAll)<input type="hidden" name="offers" value="all">@endif<button type="submit">{{ $labels['apply'] }}</button></form>
<table><thead><tr>@foreach (['seller', 'condition', 'ships_from', 'qty', 'price', 'reviews'] as $key)<th>{{ $labels[$key] }}</th>@endforeach</tr></thead><tbody>@foreach ($listings as $row)<tr data-listing-id="{{ $row['id'] }}"><td>{{ $row['seller'] }}@if ($row['rating_hundredths'] !== null) · {{ $format->rating($row['rating_hundredths']) }} ★@endif</td><td>{{ $row['condition'] }}</td><td>{{ $row['ships_from'] }}</td><td>{{ $format->number($row['quantity']) }}</td><td>{{ $format->money($row['price_minor']) }}</td><td>{{ $format->number($row['reviews']) }}</td></tr>@endforeach</tbody></table></section>
<section class="marketplace__offers"><h2>{{ $labels['offers'] }}</h2>
<table><thead><tr>@foreach (['buyer', 'condition', 'qty', 'price'] as $key)<th>{{ $labels[$key] }}</th>@endforeach</tr></thead><tbody>@foreach ($offers as $row)<tr data-offer-id="{{ $row['id'] }}"><td>{{ $row['buyer'] }}</td><td>{{ $row['condition'] }}</td><td>{{ $format->number($row['quantity']) }}</td><td>{{ $format->money($row['price_minor']) }}</td></tr>@endforeach</tbody></table>
@if (! $showAll && count($record['offers']) > 5)<a class="marketplace__more" href="{{ route('marketplace.show', ['locale' => $locale, 'id' => $record['id'], 'seller' => $prefix, 'sort' => $order, 'offers' => 'all']) }}">{{ $labels['show_all'] }}</a>@endif</section>
<section class="marketplace__alert"><h2>{{ $labels['alert'] }}</h2>
<form method="post" action="{{ route('marketplace.show', ['locale' => $locale, 'id' => $record['id']]) }}">@csrf<label>{{ $labels['email'] }}<input type="email" name="email" value="{{ $email }}"></label><label>{{ $labels['target'] }}<input type="text" inputmode="decimal" name="target_price" value="{{ $target }}"></label><button type="submit">{{ $labels['submit'] }}</button></form><p class="marketplace__message">{{ $message }}</p></section>
<section class="marketplace__details"><h2>{{ $labels['details'] }}</h2><p>{{ $record['description'] }}</p><dl>@foreach ($record['fields'] as $field)<dt>{{ $field['name'] }}</dt><dd>{{ $field['value'] }}</dd>@endforeach</dl><ul>@foreach ($record['tags'] as $tag)<li>{{ $tag }}</li>@endforeach</ul></section>
@foreach (['contents' => 'contents', 'included_in' => 'included'] as $key => $section)<section class="marketplace__{{ $section }}"><h2>{{ $labels[$section] }}</h2><ul>@foreach ($record[$key] as $row)<li><a href="{{ route('marketplace.show', ['locale' => $locale, 'id' => $row['item_id']], false) }}">{{ $row['title'] }}</a> × {{ $format->number($row['quantity']) }}</li>@endforeach</ul></section>@endforeach
</article>
</x-layout>
