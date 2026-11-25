# Native production profile

`PROFILE=matched` enables Django's CSP and gzip middleware, host validation from
`HOSTS` (comma-separated), and a 2 MiB in-memory form-data limit. Security and
clickjacking middleware and page/form CSRF protection remain enabled. Dynamic
responses use Django's private/no-store cache headers and a Permissions-Policy;
WhiteNoise retains its native static caching. `/health/live` has no upstream
dependency. The default profile's middleware, hosts and limits are unchanged.

## Deployment

The default build retains the original three synchronous Gunicorn workers and
does not install Granian. `docker build --build-arg PROFILE=matched` selects a
separate production stage with `granian==2.8.8`; its default command executes
`start_matched.py`, which replaces itself with Granian's native WSGI CLI. The
application, templates, source fetch/parse and CSRF remain Django's normal WSGI
path, with no ASGI adaptation or shared proxy/renderer/application-level cap.

Reason: sync workers ignore `worker_connections`. In installed Gunicorn 26.2.0,
gthread's initial-data wait occupies request threads, partial headers lack a
deadline, and the native ASGI worker does not enforce its connection count.
Uvicorn's immediate overload 503 is not the qualifier's queued admission behavior.
Granian supplies native accept-loop backpressure and a header-read timeout.
See [pinned Gunicorn source](https://github.com/benoitc/gunicorn/tree/26.2.0/gunicorn/workers)
and [Granian's native settings](https://github.com/emmett-framework/granian/blob/v2.8.8/README.md).

The matched command explicitly selects one worker, one Rust runtime thread,
one runtime I/O blocking thread, and at most three Python blocking request threads.
The supervisor, worker and every native thread are charged to the same application
container (1 CPU, 1 GiB); this is not three CPUs or a claim of equal runtime cost.
Three request threads preserve the baseline's nominal concurrent-handler count,
not its process topology or GIL behavior. Actual processes/thread counts are saved
before/after qualification; native housekeeping threads can also exist.

`MAX_CONNECTIONS` (default 1000) becomes Granian's `--backpressure`. The cap is
per worker, so exactly one worker is intentional. The native semaphore gates
acceptance and is held for the connection lifetime; excess connections wait in
the kernel backlog, which is not itself the accepted-connection cap. HTTP/1 uses
an 8192-byte buffer and a 30000 ms header-read timeout, not a fabricated application
timer. These are header limits, not a universal request/body/write deadline.
The source's existing requests timeout remains 10 seconds (not an absolute total
deadline against a trickling upstream).

## Limits And Verification

Django's upload setting limits parsed form data, not every raw request body or
uploaded file; it is not a blanket transport-level body limit. Neither a native
read timeout nor a worker timeout is a universal absolute request deadline.
Conditional GET and dependency readiness are not claimed by this qualification.

Build and run the bounded marketplace qualifier and complete browser gate on
the fresh matched image:

```sh
npm ci
docker build --build-arg PROFILE=matched -t cb-marketplace-django-granian:local bench/fullstack/apps/django
node bench/fullstack/apps/django/qualify-production.mjs bench/fullstack/apps/django/work/granian cb-marketplace-django-granian:local
```

The helper mounts fixtures only, not application source. It runs fixture and API
modes, records raw qualification in `*-bounded-qualification.json`, the actual PID 1 command, image identity,
deployment/process/thread inventory, complete browser results and server logs,
then removes its containers and network. Run the commands from the repository
root: before creating results or starting Docker, the helper checks the checker's
resolved `@playwright/test`, `playwright`, and `playwright-core` versions against the
root lockfile and loads the checker's Playwright entry without launching a browser.
It then uses the matching Noble image. This is capability and
functional-parity evidence, not load/performance evidence. A missing feature
leaves `eligible: false`; failures are retained and the helper exits nonzero.
Connection-flood resistance: not measured.
The baseline image must never be relabeled as the production image, or vice versa.

## Mixed ASGI Candidate

The app-local candidate for [#1304 Benchmark parity: Django in approved workload groups](https://github.com/corten-run/corten/issues/1304)
is built with `--build-arg PROFILE=matched-asgi`. It inherits the matched image's
settings (`PROFILE=matched`, including host checks, CSRF, CSP, gzip, WhiteNoise,
and private/no-store dynamic responses). Its command migrates the same SQLite
schema and runs `start_mixed_asgi.py`. Granian retains the one worker, native
HTTP/1 limits, backpressure and runtime-thread settings, but selects ASGI, with
WebSocket handling disabled and one Granian blocking thread rather than the
WSGI-only pool of three. Django's sync middleware, rendering and ORM may still
use Python threads; record actual thread/process counts on the pinned image.
Default Gunicorn, matched Granian WSGI and the live Uvicorn entry point keep
their existing commands, settings and routes.

Only the marketplace page/form and marketplace record JSON callbacks differ in
this URL configuration. An async view awaits one HTTPX read for API mode (none
for a fixture), forwarding that request's traceparent and validating the
complete record before use. A worker owns its pool for the ASGI lifespan;
connections idle for four seconds are not reused. Django handles
`http.disconnect` and cancels the awaited read, including a held body. There
are no redirects, retries, early responses, or synthetic request headers. The
ten-second bound covers the entire HTTP read; a page/form deadline returns a
native 504 and cannot append an alert. The JSON route retains native JSON
serialization and its generic 500 for read/parse failures. The page uses the
same Django rendering, alert writes and session readback as WSGI. A write
already in the synchronous ORM is not a rollback-on-disconnect promise.

From this app directory, with the three requirements files installed, run
`python -m unittest -v test_mixed_asgi_socket`. It runs both Granian CLI
interfaces with temporary databases and actual caller and upstream sockets:
three locale cases holding upstream headers, a held-body case, WSGI still
pending at 500 ms, and ASGI closed at 500 ms. It also probes the ASGI deadline,
gzip/security, CSRF, alert readback, JSON validation, fixture bypass, and
matching localized HTML apart from the generated CSRF token. It does not run
a browser or qualify the pinned Linux image.

Official selection is not wired. A later Mixed-only integration must:

1. Add one fixed, explicitly selected Django deployment for both sources and
   every stage/pass. In `bench/mixed-production/run.mjs`, pass
   `PROFILE=matched-asgi` only to the selected Django **build**, from the existing
   immutable Git archive; keep the runtime feature profile `matched` in both
   the runner and `measure.mjs`. Do not select it through an unbound image tag.
2. Bind the deployment ID and build argument separately from the feature
   profile in the image metadata, `sourceAuditIdentity`/`verifySourceAudit`,
   and the retained capture and measurement receipts. Extend `verify.mjs` and
   `execution-evidence.mjs` replay to require the matching image ID, context
   hash, startup command/settings and deployment for both sources. Bind the
   selector in the isolated campaign options and its exact-argv replay
   (`bench/workloads/isolated/campaign-contract.mjs`, `contract.mjs` and
   `adapters/mixed-production.mjs`), preserving verification of old receipts.
   Obtain a fresh independent native audit against the candidate's exact
   committed input manifest and archive.
3. Give `bench/workloads/deployments.mjs` a separate Mixed-only candidate, for
   example `django-granian-asgi`, with the Docker build argument, migration and
   launcher, worker/loop configuration, checked-in settings and dependency
   sources. Do not rename the existing WSGI representative or the Uvicorn live
   option. On the pinned Linux image, verify the three original API cancel
   cells with one request, zero completed, one cancelled and zero pending
   within the unchanged bound. Then run the full Mixed native/production
   qualification before timing. The loopback fixture is not that evidence.
