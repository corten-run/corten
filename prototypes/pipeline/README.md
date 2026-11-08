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
   twice, so the future doubled per stage. The eight defaults made a 13,632-byte future,
   53,056 bytes around a handler, and 103,526 instructions a request, 91% of them `memcpy`.
   As combinators the same stack is 208 bytes (824 around a handler), and the request is 9,262.
2. One box per request, at the router (the route's erased endpoint). Stages around the router,
   stages on a route and the handler are all one concrete future inside it.

## What it costs

Callgrind, release build, in process: `examples/cost.rs` sends `GET /api/items/7` and checks the
answer (`200`, the item's JSON), one request at a time. One request is the run of 1,200 requests
less the run of 200, over 1,000 (CONTRIBUTING.md, Pull requests, 2.1). Five repeats, variants
alternating (`cost.sh`), user instructions only. [results/](results/) has three rounds: `round1.tsv` with the stages written as `async` blocks, `round2.tsv` after rewriting them as combinators, and `round3.tsv` on the code as committed. Every prototype variant counted the same in all five repeats of rounds 2 and 3. Every variant's
handler does the same work: it reads the id from the path, writes the item with serde_json and
answers `application/json`. Medians, with the range where the repeats differed.

| Pipeline | Instructions a request | Allocations | Bytes allocated |
|---|---|---|---|
| A hand-written endpoint, no router (the floor, with the harness's own work) | 3,737 | 7 | 1,592 |
| Router and handler, no stages | 5,393 | 8 | 2,352 |
| Router and handler with every default (`Stages::api()`) | 9,438 | 11 | 3,728 |
| The same, the handler's header map sized for the defaults' headers | 8,710 | | |
| The defaults on the route, the router outside them | 9,262 | 11 | 3,784 |
| axum 0.8.9 alone, the same handler | 8,508 | 19 | 2,566 |
| Corten today, the same route under `App::api` | 17,306 (17,065-17,345) | 28 | 9,113 |

Allocations and bytes are from dhat, one run of each count, the same difference over 1,000.

Each default alone, over the router and handler (`Stages::new().with(stage)`):

| Stage | Instructions | Corten's ablation, card-market JSON |
|---|---|---|
| Security headers (`Secure::api()`) | 2,326 | 2,343 |
| Host check (`Host`) | 492 | 634, with the same-origin check |
| Same-origin check on writes (`SameOrigin`) | 103 | |
| The request's signal (`Cancel`) | 425 | |
| The deadline, with the signal it needs | 456 | 54, with the panic catch |
| Panic catch (`CatchPanic`) | 54 | |
| `Cache-Control` (`Cache`) | 380 | 808 |
| Failures described (`Errors`, on a success) | 156 | 188 |
| All of them (`Stages::api()`) | 4,045 | |

The right column is from [bench/fullstack's ablation](../../bench/fullstack/README.md#what-each-production-default-costs-callgrind-2026-11-07):
a different request (card-market's item JSON over a socket), so it says only that the same feature
costs about the same in both. The eight stages alone add 3,967. Together they cost 4,045.

Giving a handler a value through the typed context against through request extensions, as axum
and Corten do: the signal in the context costs 380 over the router, and the same signal in the
extensions costs 1,128. That is 748 more for one value, and three allocations more (9 against
12 a request).

So:

1. The floor for this request through a router is 5,393, 37% under axum alone. With every
   default on, the prototype is 9,438, about axum alone plus 900, and 45% under Corten today
   (17,306).
2. Opting out of all eight defaults saves 4,045 a request. Most of that is the security headers
   (2,326, nearly all of it `HeaderMap` growth and hashing), and sizing the answer's header map
   for them saves 728 of it.
3. Between the router alone and Corten today, the defaults account for about 4,000. Corten's
   7,868 over the prototype with every default comes from the rest. Profiling both, Corten's
   request makes 28 allocations to the prototype's 11, and spends about 1,960 instructions in
   `memcpy` (1,135) and about 4,050 in malloc and free (1,465). That says where the rest goes,
   but it is not a function-by-function account.

That 45% is an upper bound on the gain. Corten does more on this path than the prototype does:
1. reads the request's mode and credentials and tracks whether a caller was read
2. checks the API prefix's own routes
3. tells a deadline spent waiting for the body (408) from the server's (503)
4. supports layout reads and area deadlines
5. has `Cache::settle`'s full rules
6. parses typed `Params<ItemJson>`

None of these is costed here.

## What it does not have

Compression, the `ETag` and `304`, page CSPs with a nonce, `Permissions-Policy` and the document
headers, `Caller` and the private answer it makes, layout reads, an error page that takes
extractors, CORS, the API prefix's ownership of its paths, a stream's signal beyond reading the
code (`Cancel` follows a streamed body, untested), route groups (a nested router would box twice),
`#[corten::routes]` and typed routes, connection limits, timeouts and graceful shutdown
(`server::serve` is a bare accept loop), `Upgrade` and server-sent events. Percent-decoding of
path parameters is minimal. Any of these may change the numbers above, and each would be measured
as it is added.

## Running it

From this directory, in the Linux build container, then valgrind in an image that has it:

```sh
cargo test
cargo build --release --example cost
REPEATS=5 BIN=target/release/examples/cost sh cost.sh > results/round.tsv
```

`cost sizes 1` prints the size of one request's future through each stack.
