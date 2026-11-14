<main id="native-screen">
    <h1>Native Laravel Livewire and Reverb</h1>
    <noscript>This live screen requires JavaScript and native Livewire/Reverb connections.</noscript>
    <output id="effects" data-through="{{ $through }}">{{ $count }}</output>
    <table>
        <thead><tr><th>Version</th><th>Price</th><th>Quantity</th></tr></thead>
        <tbody id="rows">
            @foreach ($rows as $row)
                <tr id="{{ $row['id'] }}" wire:key="{{ $row['id'] }}"><td>{{ $row['version'] }}</td><td>{{ $row['priceCents'] }}</td><td>{{ $row['quantity'] }}</td></tr>
            @endforeach
        </tbody>
    </table>
</main>
