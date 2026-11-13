# FastAPI record JSON checks

The native `/api/catalog/{record_id}` and `/api/marketplace/{record_id}` routes return complete
Pydantic records using FastAPI serialization. Missing records, failed or malformed upstream
reads and expired deadlines return native JSON HTTP errors. FastAPI's native method handling
keeps its JSON 405 and Allow header: default remains GET-only, matched remains GET/HEAD.
A route class on these two endpoints catches Pydantic serialization failures after the
handler returns and raises the same generic native JSON 502. Successful records still use
FastAPI's response model and Pydantic serializer, without a replacement renderer.

These JSON reads own a ten-second whole-operation deadline and a disconnect watcher that
cancels the HTTPX read, including an in-flight body. HTTPX's existing inactivity timeouts remain.
Their implementation and error semantics are unchanged by the marketplace page lifetime fix below.

## Marketplace page request lifetime

Marketplace GET/POST source reads now also belong to the native ASGI request.
`app/page_read.py` waits for the source and `Request.receive()`'s `http.disconnect`,
cancels the losing task, and joins both tasks before returning. Cancelling HTTPX's
awaited read closes the actual upstream connection, including an unfinished body.
POST finishes its native form read before starting the receive listener, so it does
not race the form parser or discard fields. Templates, localized validation, session
stores, scripts, workers, loops and production commands are unchanged.

The existing marketplace client's ten-second budget now bounds the entire source
read, not only socket inactivity. Transport timeouts and whole-read expiry return
native generic 504 errors rather than 502. This covers a held header and a body that
keeps trickling without completing. It is a source-read deadline, not a new deadline
for form uploads or CPU-bound template rendering. JSON endpoints, catalog/legacy
pages, and their existing policies are not changed.

`python -m unittest app.test_page_read` checks task cleanup on disconnect, expiry
and outer cancellation. `page-lifetime.test.mjs` uses a real upstream and client
socket, all three locales, and the ordinary default/matched production commands:

```sh
PAGE_FRAMEWORK=fastapi PAGE_IMAGE=record-fastapi node --test page-lifetime.test.mjs
```

It observes the upstream before aborting the real client 50 ms later, requires
actual upstream cancellation within 500 ms, and checks deadline statuses and
upstream counters independently. The body probe trickles bytes to distinguish an
operation deadline from an inactivity timeout. Failed-probe cleanup happens only
after counters are captured. Per-operation source IDs prevent late cleanup-induced
retries from being attributed to a later probe. Its twelve-second client guard is
a test bound, not a native deadline, and cannot qualify a timed-out request.

The same probe accepts `PAGE_FRAMEWORK=django|spring` and the respective `PAGE_IMAGE`.
Django also requires `PAGE_MATCHED_IMAGE` built with `--build-arg PROFILE=matched`.
Spring uses the same native MVC configuration for both environment values. The
probe fails rather than skipping remaining WSGI/MVC cancellation limitations;
see those apps' scoped docs. This is functional evidence, not mixed/load qualification.

With `requirements.txt` installed, run `python -m unittest app.test_marketplace` from this directory.
From the repository root:

```sh
docker build -t record-fastapi bench/fullstack/apps/fastapi
node bench/fullstack/apps/fastapi/check-native.mjs record-fastapi
```

The wrapper uses the Express adapter's HTTP test driver only, never its implementation or JSON.
It binds this adapter's current sources read-only onto the dependency image and runs this app's
normal startup command. Both profiles, both payloads and fixture/API sources are checked,
including shared `checkJsonApp` sweeps, JSON errors/methods, whole-read deadlines, real caller
disconnects, upstream socket closure and recovery. Raw responses, identities, source hashes and
summaries stay in ignored `tests/results/`; labeled containers are removed. `--quick` omits only
deadline/disconnect probes. No positive audit receipt or load readiness is manufactured.
`--regressions-only` runs just the invalid-Unicode serialization probes. Test containers have
a one-CPU, 1 GiB budget; Linux hosts receive an explicit host-gateway mapping.

The native source audit is still pending. Existing models do not enforce requested-record
identity, all workload numeric bounds or duplicate row IDs. The retained independent review
run `tests/results/review-1794510811983/` passed 81/82 tests: one healthy `record_62` request
returned JSON 502; an isolated 500-record retry passed. The original logs remain unchanged,
and the cause is unknown. A subsequent passing run does not explain that failure or qualify
the adapter for load.
The repair rerun `tests/results/after-1794512074118/` passed 85/86 checks: a healthy `item_310`
returned JSON 502 in the matched/API marketplace gate, with no upstream finish event for
that request. Its raw observations are retained too; the cause remains unknown. Both
serialization regressions passed, but the full rerun is not green.
The independent repair review `tests/results/review-repair-1794512746980/` passed 61/62
quick checks. Its default/API marketplace sweep first reported `item_131`; the raw
responses also contain healthy-read 502s for `item_125`, `item_128`, `item_129`,
`item_130`, `item_132` and `item_134`. None has an upstream finish event in that run.
The default-profile observation means matched-only middleware is not necessary for
the symptom. It does not establish the source exception or exclude the disconnect
watcher, HTTPX or a transport failure. These original logs remain unchanged.

## Local source tracing

For a bounded diagnostic pass using the same native driver and gates:

```sh
node bench/fullstack/apps/fastapi/check-trace.mjs record-fastapi before
```

`RECORD_JSON_TRACE=1` opts into request-correlated source exception chains, HTTPX's
transport trace hook, read completion and caller-disconnect events. Successful
events are buffered only for that request and emitted only on failure or cancellation.
The native route wrapper owns the context through response serialization and resets
it on every exit. A native Pydantic serialization failure flushes the source events
and complete exception chain under the same request ID before cleanup. Tracing is
disabled by default, including exception formatting. HTTPX's `upstream_path` is
separate from the correlated native route `path`. Tracing does not change the native serializer, production
profile, source parsing, retry policy or ten-second bound.
The diagnostic wrapper also observes the driver's real upstream sockets and responses,
retains Docker stderr separately, and bounds log capture independently of HTTP deadlines.
It cleans up its containers and servers even when the shared driver fails to stop.
Ignored `cause-*` folders identify their associated native `trace-*` gate evidence and
the exact source hashes before and after the pass. Tracebacks can include upstream
values; keep this opt-in evidence local. A passing traced sweep is not a root cause
or evidence that any earlier healthy 502 was fixed.
The retained `cause-before-1794513790972/` and `cause-before-1794514253740/`
diagnostic passes each completed 62/62 quick checks, including all eight shared
gates. Only deliberate upstream error/parse probes produced source exception
traces. The second pass suppressed successful-request trace output to reduce
observer overhead. Neither reproduced a healthy failure; the root cause remains
unproven. An earlier diagnostic attempt, `cause-before-1794513537397/`, stopped
at Docker log capture's original 1 MiB buffer limit, not at a healthy JSON failure.
Its evidence is retained separately; the diagnostic wrapper now uses a bounded
16 MiB log capture and failure cleanup without increasing any HTTP timeout.

The trace unit tests run with `python -m unittest app.test_record_json`; the existing
`app.test_marketplace` suite remains separate. Both can run in default and matched
profiles without changing those production profiles.
`node bench/fullstack/apps/fastapi/check-trace.mjs record-fastapi after --regressions-only`
runs just the native invalid-Unicode probes and healthy recovery, and asserts the
catalog serialization exception trace, correlation and cleanup in both profiles.
## Native alert sessions

An accepted marketplace form POST appends one alert; `GET /api/alerts` independently
serializes that session's alerts as `[{item_id,email,target_minor}]`, in insertion
order. The native FastAPI request/form APIs, Pydantic response serialization,
Jinja templates and existing scripts remain in use. The localized validation
returns both its message and rounded minor units from one parse. Targets beyond
signed 64-bit minor units are rejected rather than failing during persistence.

The single-process deployment keeps alerts in memory behind a lock. A new accepted
write issues a 256-bit random session token, never adopting an unknown caller token.
Cookies are HttpOnly, SameSite=Lax, path `/`, Secure on HTTPS, and expire after
30 minutes. Expired tokens cannot read or append to their old lists. A restart loses
sessions; this is synthetic benchmark state, not a durable notification service.
The existing cross-site write check remains; reads and form answers are no-store.
Ordinary read-only page and record-JSON routes do not establish sessions.

Before rendering a POST, the already parsed native Pydantic record also checks
the requested ID, unique IDs within each row list, and the integer bounds from
`bench/marketplace/records.mjs`: counts 0..1e9, signed minor units -1e9..1e9,
and ratings 0..500. Required types, exact keys and nullability remain Pydantic's
checks. A bad source returns 502 without creating a session or appending an alert.
No extra source read or JSON parse is performed. GET page/JSON parsing is unchanged.

`python -m unittest app.test_marketplace app.test_record_json app.test_alerts`
runs native tests. Run in both default and matched profiles (`HOSTS=testserver`
for matched). `native-alerts.test.mjs` also checks each of FastAPI, Django and Spring
over real HTTP and Chromium, using the same cookie jar for POST and readback.
It checks accepted/rejected/missing/cross-site writes, ordering, isolated clients,
eight concurrent writes, JS/no-JS marketplace forms and the unchanged legacy htmx
form. It requires the repository's Playwright installation, `ALERT_BASE_URL` and
`ALERT_FRAMEWORK=fastapi|django|spring`; run with `node --test native-alerts.test.mjs`.
Start the app with `MARKETPLACE_SOURCE=fixture` pointing `MARKETPLACE_FIXTURE_PATH`
at Django's `itempage/marketplace_test_fixture.json`, and `ITEM_SOURCE=fixture`
pointing `FIXTURE_PATH` at this directory's `alert-items-fixture.json`.
These checks are functional evidence only, not throughput qualification.

`alert-contract.test.mjs` starts ordinary native images and a real mutable HTTP
upstream. Set `ALERT_FRAMEWORK=fastapi|django|spring` and `ALERT_CONTRACT_IMAGE`
to the corresponding locally built image, then run `node --test alert-contract.test.mjs`.
It tests both profiles; Django additionally requires `ALERT_CONTRACT_MATCHED_IMAGE`
built with `--build-arg PROFILE=matched`, so its matched run uses native Granian.
Spring has no separate matched configuration; both environment values use its
unchanged production command. Each malformed record is checked against the existing
record contract, POSTed with existing and fresh cookie jars, and followed by an
independent GET readback. The test checks one upstream fetch per POST, no session
on failures, recovery and valid boundary values. It does not run the JSON matrix
or change its readiness gates.

### Unreleased

- Own marketplace page source reads with native ASGI disconnect cancellation and
  the existing ten-second budget, including trickling bodies; return native 504 on
  source timeout without changing JSON reads or production runtime settings.

- Persist native session-isolated marketplace alerts and expose independent JSON
  readback without changing the unresolved FastAPI load behavior or server settings.
- Reject mismatched record IDs, duplicate row IDs and out-of-contract integers
  before marketplace alert writes, with both-profile real HTTP regressions.
