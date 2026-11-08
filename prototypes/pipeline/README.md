# Prototype: the request pipeline without axum

An experiment, not part of the workspace: Corten's request pipeline rebuilt from the raw
`http::Request` and `http::Response` up, on hyper, http and matchit alone, to find out what the
floor is and whether one way of configuring it can reach from a raw response to every default.

## The design

Three traits, and everything is one of them:

1. `Endpoint<Cx>` answers a request: the raw `Request`, and a typed context `Cx` (what the stages
   around it gave), in; the raw `Response` out. A handler function is one (`handler(f)`), a
   `Router` is one, and so is a struct that writes its answer by hand. This is the lowest level.
2. `Stage<Cx>` is one feature around an endpoint: the host check, the signal, the deadline, the
   security headers, error pages. It can answer the request itself, change it, change the answer,
   and give the endpoint inside something new (`type Out = (Signal, Cx)`).
3. `Stages` is the only way to put stages around an endpoint, read outside in. The app's defaults
   are a `Stages` value (`Stages::api()`), a route's own stages are one, and the app's middleware is
   a stage like any other (`Stages::api().with(RateLimit)`).

```rust
let api = Stages::api().with(Share(db));
let app = Router::new()
    .route("/ping", get(Pong))                               // nothing around it
    .route("/echo", post(|req: Request| async { .. }))       // the raw request in, a raw answer out
    .route("/items/{id}", get(api.serve(handler(item))));    // every default, and the app's state
pipeline::server::serve(listener, app).await
```

Or the whole app inside the defaults, with a raw route in it that still gets their headers:
`Stages::api().serve(Router::new().route(..))`.

Handlers are a layer on top. An argument reads the request's head and the context (`FromParts`),
the last one may take the body (`FromRequest`: `Json<T>`, `Bytes`, the raw `Request`), and the
answer is anything `Respond` (the raw `Response`, text, a status, `Json<T>`, a `Failure`, a
`Result` of two).

What a handler reads is checked against what its stages give when the app compiles. A handler that
takes a `Signal` on a route with no `Cancel` stage, or `State<Db>` with no `Share(db)`, does not
compile, and neither does a `Deadline` placed outside the `Cancel` whose signal it aborts. The
message is the framework's:

```text
error[E0277]: nothing around this endpoint gives it a `pipeline::stages::Signal`
    = note: add the stage that gives a `pipeline::stages::Signal` outside it, in its
      `Stages::new().with(..)`; stages are read outside in, so it goes before the stage or route that reads it
```

These are the `compile_fail` doctests in [src/lib.rs](src/lib.rs). The context is a list of
values passed down the stack (`(Params, (Signal, (State<Db>, ())))`), not request extensions, and
the compiler works out where each one is, so nothing names its type.

A failure is a value, not a page: a `Failure` is an answer whose body says it failed, with its
status. A stage that describes failures (`Errors::json()`, `Errors::with(page)`) turns it into
problem+json or the app's page. Without one, the client gets the bare status. So the router's 404,
a stage's refusal and a handler's `Err` all reach the same description, and a route with no stages
pays nothing for it.

Two rules came out of measuring it:

1. A stage's future is a combinator (`map`, `Either`, a hand-written `Future`), never an `async`
   block around its inner future. Written as `async` blocks, each layer stored its inner future
   twice, so the future doubled per stage: in round 1, the eight defaults made a 13,632-byte
   future, 53,056 bytes around a handler, and the defaults on a route cost 103,526 instructions a
   request, 91% of them `memcpy`. As combinators the same stacks are 216 and 832 bytes
   (`cost sizes 1`, round 4), and the defaults on a route cost 9,360 instructions. Round 1's code
   (the `async` blocks) is not in the commit; its counts are in `results/round1.tsv`, and its
   sizes were printed by the same `sizes` variant then.
2. The pipeline itself boxes once per request, at the router (the route's erased endpoint): stages
   around the router, stages on a route and the handler are one concrete future inside it. Two
   more boxes happen only when they are needed: the deadline's timer, made the first time the
   endpoint waits (one allocation and about 1,000 instructions, measured below), and a streamed
   answer's body. What a handler's own readers allocate is theirs.

## What it costs

Callgrind, release build: `examples/cost.rs` sends `GET /api/items/7` and checks the answer
(`200`, the item's JSON), one request at a time. One request is the run of 1,200 requests less
the run of 200, over 1,000 (CONTRIBUTING.md, Pull requests, 2.1). Five repeats, variants
alternating (`cost.sh`), user instructions only. Every variant's handler does the same work: it
reads the id from the path, writes the item with serde_json and answers `application/json`.
Medians, with the range where the repeats differed. Allocations and bytes are from dhat
(`dhat.sh`, one run of each count, the same difference over 1,000). No times were measured, so
the allocation counts say what is allocated, not what it costs in time (CONTRIBUTING.md, Pull
requests, 2.2).

[results/](results/) has every round: `round1.tsv` with the stages written as `async` blocks,
`round2.tsv` after rewriting them as combinators, `round3.tsv` before the review's fixes, and
`round4.tsv`, `round4-socket.tsv` and `round4-dhat.tsv` on the code as committed. Corten is
measured at `f4d340c3`, the commit this branch is on, with `default-features = false`.

In process, the request built and the answer read by the harness, no socket:

| Pipeline | Instructions a request | Allocations | Bytes allocated |
|---|---|---|---|
| A hand-written endpoint, no router (the floor, with the harness's own work) | 3,736 | 7 | 1,592 |
| Router and handler, no stages | 5,393 | 8 | 2,352 |
| Router and handler with every default (`Stages::api()`) | 9,493 | 11 | 3,728 |
| The same, the handler's header map sized for the defaults' headers | 8,765 | | |
| The defaults on the route, the router outside them | 9,360 | 11 | 3,792 |
| axum 0.8.9 alone, the same handler | 8,508 | 19 | 2,566 |
| Corten today, the same route under `App::api` | 17,336 (17,135-17,376) | 28 | 9,113 |

Over a socket: one keep-alive connection on loopback, the client in the same process
(`socket-*` variants). Each count is the whole request: hyper reading and writing it, the
pipeline, the handler and the client, whose work is the same for every variant. The kernel's side
of each read and write is not counted, so these are not a share of a request's time.

| Pipeline | Instructions a request | Allocations | Bytes allocated |
|---|---|---|---|
| A hand-written endpoint on `server::serve` | 10,647 (10,646-10,655) | | |
| Router and handler on `server::serve` | 12,485 (12,483-12,491) | 7 | 9,800 |
| Every default, on `server::serve` | 17,132 (17,131-17,136) | 10 | 11,176 |
| axum 0.8.9 on `axum::serve` | 15,904 (15,902-15,908) | 18 | 10,030 |
| Corten's router (`App::api`) on `axum::serve` | 25,889 (25,838-25,920) | 28 | 16,584 |

Corten's own `serve_on` loop adds its connection limits and timeouts, which this does not count.

Each default alone, over the router and handler (`Stages::new().with(stage)`), in process:

| Stage | Instructions |
|---|---|
| Security headers (`Secure::api()`) | 2,326 |
| Host check (`Host`) | 532 |
| The deadline, with the signal it needs | 450 |
| The request's signal (`Cancel`) alone | 425 |
| `Cache-Control` (`Cache`) | 380 |
| Failures described (`Errors`, on a success) | 158 |
| Same-origin check on writes (`SameOrigin`) | 103 |
| Panic catch (`CatchPanic`) | 89 |
| All of them (`Stages::api()`) | 4,100 |

How far these resolve: within one build every prototype variant counted the same in all five
repeats, or within 7. Between builds the same code moves: `api` is 9,493 in `round4.tsv` and
9,408 in `round4-socket.tsv`, whose binary only adds the socket variants, and `router` 5,393
against 5,396. So a row under about 100 says the stage is small, not what it costs, and a
difference under about 100 between two builds is not a change. The stages alone add 4,038 and
together 4,100.

A handler that waits once (`tokio::task::yield_now`, as a handler that reads a database does)
makes the deadline build its timer:

| Pipeline, the handler waiting once | Instructions | Over the row above |
|---|---|---|
| Router and handler | 6,534 | |
| With the signal (`Cancel`) | 6,966 | 432 |
| With the signal and the deadline | 7,990 | 1,024 |
| Every default | 11,685 | 5,151 over the router |

The deadline costs 25 over the signal when the answer is ready at once, and 1,024 when the
endpoint waits: one allocation (`api` 11 against 12 a request, 96 bytes) and the timer's entry in
tokio's wheel. In the other tables no variant's handler waits, Corten's and axum's included;
what Corten's deadline costs when its handler waits is not measured here.

A value given to the handler through the typed context against through request extensions, as
axum and Corten do: the signal in the context costs 380 over the router, and the same signal in
the extensions 1,128, 748 more, and 12 allocations to 9. Two things make that figure an upper
bound for a second value: the map was empty, so its 748 include allocating it (a request that
already carries an extension pays only the insert and the lookup), and the two stages do unequal
work: `Cancel` also keeps a guard for a client that leaves and checks for a streamed body, which
the extensions stage does not, so the context's 380 is the larger job.

So:

1. Through a router, the floor for this request is 5,393 in process, 37% under axum alone, and
   12,485 over a socket, 21% under it.
2. With every default on, the prototype is 9,493 in process, about axum alone plus 1,000, and 45%
   under Corten today (17,336). Over a socket it is 17,132 to Corten's 25,889, 34% under. Both
   are measured; the kernel's work, which is the same for both, would make the share smaller.
3. Opting out of all eight defaults saves 4,100 a request in process and 4,647 over a socket,
   where hyper also writes the headers. Most of it is the security headers (2,326, nearly all of
   it `HeaderMap` growth and hashing), and sizing the answer's header map for them saves 728.
4. Between the router alone and Corten today the defaults account for about 4,100. Corten's
   7,843 over the prototype with every default comes from the rest. Profiling both, Corten's
   request makes 28 allocations to the prototype's 11, and spends about 1,960 instructions in
   `memcpy` (the prototype 1,135) and about 4,050 in malloc and free (1,465), measured in round
   3. That says where the rest goes, but it is not a function-by-function account.

The 45% and 34% are upper bounds on what Corten would gain. On this path Corten also:

1. reads the request's mode and its credentials, and tracks whether a caller was read
2. finds the request's area or API by prefix, with its own deadline, CSP and middleware
3. answers a CORS preflight and checks the allowed origin for an API
4. checks that a path under an API's prefix is the API's own (the matched path axum puts in the
   extensions, and the API's 404 in place of another route's)
5. records the request's deadline on its connection for a graceful shutdown
6. tells a deadline spent waiting for the body (408) from the server's (503)
7. supports layout reads
8. has `Cache::settle`'s full rules
9. parses typed `Params<ItemJson>`
10. boxes the route's future (`Wrapped`) besides axum's own box

None of these is costed here.

## Against Corten's choices

The prototype was built to answer what an app could configure, not to keep Corten's current
rules, and several of them it does not keep. Taking it into Corten reopens these
(docs/design.md):

1. [Choice 25](../../docs/design.md#choice-axum-router), routing and dispatch stay axum's. It
   reopens. The Choice says no prototype router was measured and that only a measured share well
   past about 5% would outweigh the risk of writing routing again. This router is 37% under axum
   in process and 21% over a socket on the same request, though the Choice's share is of a
   rendered page, where the router is a smaller part. The risk side stands: the prototype has
   `HEAD`, `405` with `Allow` and percent-decoding with tests, but no nesting, fallbacks or
   matched path, so the correctness argument is not answered yet.
2. [Choice 21](../../docs/design.md#choice-own-extractors), an app's extractors are axum's
   `FromRequestParts`. It follows Choice 25: with dispatch Corten's, the orphan rule no longer
   stands in the way. The Choice asks Corten's own traits to keep axum's names and the
   `from_request_parts(parts, state)` signature; the prototype's `FromParts::from_parts(parts,
   cx)` does not yet, and would be renamed before it is adopted.
3. [Choice 27](../../docs/design.md#choice-caller-types), every route reaches the app through
   `Routes` or `Methods`, which check its caller, cache and failure types. A raw `Endpoint`
   given to the router is the way around those checks the Choice's Revisit-when names. To keep
   it, a raw route would still be declared in `#[corten::routes]`, saying so in the route (as
   `no_store` does), so that a module's `caller = T` cannot be skipped by writing an endpoint
   instead of a handler.
4. [Choice 28](../../docs/design.md#choice-fixed-stages) and
   [Limit 12](../../docs/design.md#limit-fixed-stages), fixed stages in one order and no step for
   one route. Both are what the prototype changes: the order is the app's (`Stages::new()`), a
   route can have its own stages or none, and the raw request is the first thing any stage sees,
   so the tower layer the Limit names is not needed. What the Choice protects is partly kept: a
   stage that needs another's value (the deadline and the signal, a handler and its state) does
   not compile outside it. Order between independent stages is not checked: an app that builds
   its own order can put the security headers inside the error description, or the host check
   after its own middleware.
5. Value 7, `corten::serve(App::new(routes))` is production-ready. The prototype's `Router::new()`
   serves a route with nothing around it unless it is put inside `Stages::api()`, the opposite
   default. In Corten the defaults would stay on for every route, and having fewer would be the
   route's explicit choice, read where the route is declared.
6. Value 5, one way to do each thing. The prototype has more than one way in three places. Stages
   go around the router or on a route, which mean different things (whether the router's 404 and
   405 are described and get the headers) and cost differently (133 fewer on the route). A raw
   answer is an `Endpoint` written by hand or a handler that takes the `Request` and returns a
   `Response`; the handler is built on the trait, so they are layers of one design, but an app
   would be told to use the handler. And a value reaches a handler through the context or through
   extensions, which `experiment` keeps only for the measurement.
7. Value 4, mistakes fail at compile time. What a handler reads from its stages is checked at
   compile time, and a duplicate `Cancel` does not compile, though with rustc's generic "type
   annotations needed" (E0283), not the framework's message. Path parameters are not typed: a
   handler reads them by name (`params.parse("id")`), and a name the route does not have answers
   404 on every request rather than failing to compile. Corten's `#[derive(Route)]` structs would
   be filled from the same positions.

## What it does not have

Compression, the `ETag` and `304`, page CSPs with a nonce, `Permissions-Policy` and the document
headers, `Caller` and the private answer it makes, layout reads, an error page that takes
extractors, CORS, the API prefix's ownership of its paths, route groups (a nested router would box
twice), `#[corten::routes]` and typed routes, connection limits, timeouts and graceful shutdown
(`server::serve` is a bare accept loop), `Upgrade` and server-sent events. A body over the
reading limit is refused with 413 and the rest is left unread, which Choice 21 says can make a
client still sending miss the answer; Corten's `bytes_up_to` reads past it, and would replace
`read_body`. Percent-decoding of path parameters is minimal. Any of these may change the
numbers above, and each would be measured as it is added.

The prototype is under `prototypes/`, outside the workspace, and nothing in CI builds it. The
layout in docs/architecture.md does not list it, since it is an experiment, not a crate.

## Running it

From this directory, in the Linux build container, then valgrind in an image that has it:

```sh
cargo test
cargo build --release --example cost
REPEATS=5 BIN=target/release/examples/cost sh cost.sh > results/round.tsv
BIN=target/release/examples/cost sh dhat.sh > results/dhat.tsv
```

`cost sizes 1` prints the size of one request's future through each stack.
