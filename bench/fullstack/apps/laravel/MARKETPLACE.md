# Native marketplace

Marketplace page/JSON reads retain their Laravel controller, Blade and native
JSON serializer. The alert is an installed Livewire component with locked item and
locale state, `wire:model` inputs and a real `save` action. That action reads the
authoritative item and applies the same localized validation as the ordinary
HTML POST. The form's action, method and CSRF input also work without JavaScript.

An accepted submission appends exactly one `{item_id,email,target_minor}` record.
`GET /api/alerts` returns the current session's array in insertion order with
`private, no-store`. It does not derive records from query parameters, clear them,
or use a confirmation message as proof. Native file-cache storage is keyed by the
native session's unguessable ID. Laravel's native cache lock serializes concurrent
appends across Octane workers; its file driver performs locked reads and writes.
The store expires after `session.lifetime` minutes since the last accepted write.
Use the same session cookie jar for submission and readback. The example uses
file sessions, with the native encrypted HttpOnly, SameSite=Lax cookie; HTTPS
deployments set `SESSION_SECURE_COOKIE=true` and retain a private `APP_KEY`.

Normal CSRF protection remains active on ordinary POSTs and Livewire updates.
Origin/Fetch Metadata checks also reject cross-site writes with valid CSRF tokens.
Neither rejected input nor missing items mutate the alert store. There is no reset
endpoint or browser test bypass.

Focused native checks and browser smoke (Playwright from the repository root):

```sh
php tests/marketplace.php
php tests/alerts.php
node bench/fullstack/apps/rails/test/native-alerts.mjs laravel http://localhost:8080
```

The smoke uses real HTTP readbacks with each browser's cookie jar, all three
locales and both JS modes, and observes the real Livewire component `save` request.
It also checks rejection, order, concurrent same-session POSTs and two-client
isolation. These are bounded functional checks, not throughput measurements.
