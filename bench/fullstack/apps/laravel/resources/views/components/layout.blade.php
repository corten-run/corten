@props(['title' => 'Card Market', 'lang' => 'en'])
<!doctype html>
<html lang="{{ $lang }}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{ $title }}</title>
<link rel="stylesheet" href="{{ asset('style.css') }}">
<link rel="stylesheet" href="{{ asset('components.css') }}">
{{ $head ?? '' }}
@livewireStyles
<script>
// The browser benchmark reads this mark: Livewire and Alpine have started.
document.addEventListener('livewire:initialized', () => { window.__hydratedAt ??= performance.now(); });
</script>
</head>
<body>
<header class="site-header__bar"><a href="/" wire:navigate>Card Market</a></header>
<main>{{ $slot }}</main>
@livewireScripts
</body>
</html>
