# Native alert sessions

Accepted marketplace form POSTs create one `Alert` ORM row, related to Django's
database session. `GET /api/alerts` uses `JsonResponse` to return only the current
session's rows as `[{item_id,email,target_minor}]`, ordered by insertion ID.
CSRF middleware, templates, forms and scripts remain native. Rejected validation,
missing records, missing CSRF tokens and cross-site requests do not write alerts.
Validation returns the localized message and half-up rounded minor units from one
parse; amounts beyond signed 64-bit minor units are rejected safely.
Before a POST renders or persists, its complete source record is checked for required
keys, nested row shapes, primitive types, nullability, requested ID and unique IDs
within each row list. Numeric checks follow `bench/marketplace/records.mjs`:
counts 0..1e9, signed minor units -1e9..1e9, and ratings 0..500. Validation uses
the already fetched native dictionary, without another source read or JSON parse. An incomplete or
wrong-shaped upstream record produces the native 500 without adding alerts or
creating a session. GET page and record-JSON behavior is unchanged.

SQLite and Django migrations are built in, so no package is added. Row inserts,
rather than read/modify/write of a session list, preserve concurrent appends across
the default three Gunicorn workers and matched-profile threads. Startup migrates
before serving. Local non-container startup requires `python -m django migrate`.
`alerts.sqlite3` belongs to this app instance and must not be shared between runs.
There is no new common store or service. Database session cookies use Django's
unguessable keys, HttpOnly and SameSite=Lax defaults, and expire after 30 minutes.
Set `SESSION_COOKIE_SECURE=1` on HTTPS deployments. `python -m django clearsessions`
removes expired sessions and their related alerts; a read never clears a live list.
Removing the container removes this synthetic data unless explicitly persisted.

Read-only pages and record JSON do not create sessions. The session middleware is
lazy and does no database access until the alert handlers use it. Alert readbacks
and form responses are private/no-store. GET readbacks never renew a session.

Run `python -m django test itempage` in both profiles (matched: `PROFILE=matched`,
`HOSTS=testserver`). Native tests cover validation, CSRF, session expiry, cookie
fixation, readback and isolation. The real HTTP/concurrent and JS/no-JS browser
checks are documented in `../fastapi/README.md`; they exercise the ordinary app
image with its native workers, not Django's in-process test client.
`itempage.test_marketplace_record` also uses Django's real live HTTP server and a
real upstream HTTP server to check malformed-record writes and recovery with the
same cookie jar, in both profiles. Include localhost in matched `HOSTS` for it.
`../fastapi/alert-contract.test.mjs` additionally exercises both ordinary production
images over real HTTP with the complete contract failure matrix; its setup is
documented in that app's README.

## Unreleased

- Return a generic native 504 for the existing marketplace page Requests timeout,
  without mutating alerts. The WSGI disconnect limitation below remains unresolved.

- Add native database-session alert persistence and ordered, independent JSON
  readback while retaining Django security middleware and existing JS behavior.
- Reject incomplete source records before alert writes, including fields silently
  tolerated by Django templates.
- Enforce the record contract's numeric bounds, requested ID and per-list unique
  row IDs before writes, retaining read-only page and JSON behavior.

## Page Request Lifetime Limit

Both production representatives remain WSGI: default Gunicorn sync workers and
matched Granian's WSGI interface. Their synchronous marketplace view uses Requests.
There is no ASGI `http.disconnect` event in this view, and moving the blocking read
to a thread does not make that upstream I/O cancellable when the client leaves.
The native page still fails the mixed workload's 500 ms client-abort cleanup gate.
No runtime/worker/loop switch or heartbeat response is used to hide that failure.

The existing ten-second Requests inactivity timeout closes the upstream socket
on a held-header timeout. The page now answers a generic native 504 in that case,
instead of an unhandled 500; it does not append an alert. This is not an overall
operation deadline: a continuously trickling response can exceed it. Record-JSON
error handling remains unchanged. See [Requests' timeout semantics](https://requests.readthedocs.io/en/latest/user/quickstart/#timeouts).

[Django's native async support](https://docs.djangoproject.com/en/6.1/topics/async/)
provides disconnect cancellation for async views under ASGI. Taking that route
would require an ASGI deployment, an async view and cancellable async outbound I/O,
not merely wrapping Requests with `sync_to_async`. It would be an explicitly
different configuration, not a demonstrated fix to these WSGI representatives.
No such alternate contender or new HTTP dependency is introduced here.

The real-socket probe in `../fastapi/page-lifetime.test.mjs` exercises all three
locales in both production profiles and reports the remaining abort failures as
failed tests, not skips. Setup is documented in that app's README.
