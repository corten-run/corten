<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <meta name="reverb-key" content="{{ config('broadcasting.connections.reverb.key') }}">
    <title>Native Laravel Livewire and Reverb</title>
    @livewireStyles
</head>
<body>
    <livewire:native-screen />
    @livewireScriptConfig
    <script type="module" src="/client.js"></script>
</body>
</html>
