<x-layout :title="$record->title">
  <x-slot:head><link rel="stylesheet" href="{{ asset('catalog.css') }}"></x-slot:head>
  <article aria-label="Catalog record">
    <h1>{{ $record->title }}</h1>
    <p>{{ $record->subtitle }}</p>
    <p>{{ $record->description }}</p>
    <ul aria-label="Tags">@foreach ($record->tags as $tag)<li>{{ $tag }}</li>@endforeach</ul>
    <form method="get" action="{{ route('catalog.show', ['id' => $record->id], false) }}">
      <label>Field name <input name="field" value="{{ $prefix }}"></label>
      <button type="submit">Filter</button>
    </form>
    <table>
      <caption>Record fields</caption>
      <thead><tr><th scope="col">Name</th><th scope="col">Value</th></tr></thead>
      <tbody>@foreach ($fields as $field)<tr><th scope="row">{{ $field['name'] }}</th><td>{{ $field['value'] }}</td></tr>@endforeach</tbody>
    </table>
    <nav aria-label="Related records"><ul>@foreach ($record->related as $row)<li><a href="{{ route('catalog.show', ['id' => $row['id']], false) }}">{{ $row['title'] }}</a></li>@endforeach</ul></nav>
  </article>
</x-layout>
