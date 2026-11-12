# Native marketplace

The marketplace keeps Rails controllers, ERB, native JSON serialization, CSRF
protection, and ordinary HTML forms. Turbo Drive handles navigation and GET forms;
the alert form updates a Turbo Frame. Without JavaScript the same POST renders the
whole page, with the same localized validation and persistence.

Each accepted POST appends one `{item_id,email,target_minor}` record. The target is
parsed once and converted to USD minor units with half-up rounding. Rejected,
missing-item, CSRF-invalid and cross-site requests do not append. `GET /api/alerts`
returns this session's array in insertion order, with `private, no-store`; reads
never clear or populate it. Keep the native cookie jar for the form and readback.

A cryptographically random identifier lives in Rails' authenticated/encrypted
session cookie. A Ruby mutex protects the process-local synthetic alert store,
including concurrent requests. State lasts for this server process, not a durable
production database or multiple Puma processes. Set `SECRET_KEY_BASE` for stable
deployment keys; standalone runs generate a fresh key at startup. TLS deployments
must enable Rails' normal HTTPS/secure-cookie settings.

Focused checks (with bundle dependencies installed):

```sh
bundle exec ruby test/marketplace_test.rb
```

From the repository root with Playwright installed and a native image running
with `MARKETPLACE_SOURCE=fixture`, pointing `MARKETPLACE_FIXTURE_PATH` at this
app's `test/marketplace_fixture.json` (also copied in Laravel's tests):

```sh
node bench/fullstack/apps/rails/test/native-alerts.mjs rails http://localhost:8080
```

`native-alerts.mjs` also accepts `laravel` and `phoenix` to exercise the same
independent HTTP contract against those native apps. It checks all locales, JS and
no-JS browser contexts, native transport, CSRF/cross-site rejection, missing fields
and items, sequential order, eight concurrent POSTs, and separate cookie jars. It
does not time throughput or make comparative performance claims.
