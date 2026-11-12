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

Build and run the unchanged marketplace qualifier and complete browser gate on
the fresh matched image:

```sh
docker build --build-arg PROFILE=matched -t cb-marketplace-django-granian:local bench/fullstack/apps/django
node bench/fullstack/apps/django/qualify-production.mjs bench/fullstack/apps/django/work/granian cb-marketplace-django-granian:local
```

The helper mounts fixtures only, not application source. It runs fixture and API
modes, records raw qualification, the actual PID 1 command, image identity,
deployment/process/thread inventory, complete browser results and server logs,
then removes its containers and network. Browser work uses the repository's
existing Playwright image and checker without changes. This is capability and
functional-parity evidence, not load/performance evidence. A missing feature
leaves `eligible: false`; failures are retained and the helper exits nonzero.
The baseline image must never be relabeled as the production image, or vice versa.
