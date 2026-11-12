# Native alert sessions

Accepted marketplace form POSTs create one `Alert` ORM row, related to Django's
database session. `GET /api/alerts` uses `JsonResponse` to return only the current
session's rows as `[{item_id,email,target_minor}]`, ordered by insertion ID.
CSRF middleware, templates, forms and scripts remain native. Rejected validation,
missing records, missing CSRF tokens and cross-site requests do not write alerts.
Validation returns the localized message and half-up rounded minor units from one
parse; amounts beyond signed 64-bit minor units are rejected safely.

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

## Unreleased

- Add native database-session alert persistence and ordered, independent JSON
  readback while retaining Django security middleware and existing JS behavior.
