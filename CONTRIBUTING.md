# Contributing to Corten

Thanks for helping. Open an issue to discuss a change before a large pull request; a small fix
can go straight to a pull request. Every change follows the [values](README.md#values), and
when two conflict, the order given there decides. A change that adds a dependency or a new
concept needs a reason a smaller change cannot meet. The checks below prove a change builds and
its tests pass; the [review](#review) decides whether it should land.

## Layout

```text
crates/
  corten/            The framework on hyper: App, Req, html!, components, the runtime (js/corten.js)
  corten-macros/     html!, #[component], #[event], script!, messages!, tokens!, derives (Fields, Route), on proc_macro alone (no syn)
  corten-cli/        The corten command, standard library only
  corten-feed/       Live feeds: rows, numbered patches, replay, resume
  corten-protocol/   Wire types and Replica (the client side), no web or async dependencies
  corten-cluster/    One feed across instances: Postgres outbox, NATS JetStream relay
  corten-ui/         Optional headless components: number field, combobox, tabs, menu button
examples/watchlist/  A stock watchlist: live prices, news, alerts; scripts/smoke.mjs tests the runtime against it
examples/card-market/ A trading-card store (home, categories, item pages) with every production module on; smoke.mjs tests it
examples/seller-desk/ A seller's inventory desk: a client-heavy screen built with handlers
examples/listings-feed/ A seller's listings kept live by a feed on corten-cluster, served by several instances, and the failover benchmark; smoke.mjs tests the page
examples/ui-gallery/ corten-ui and every UI kit component; smoke.mjs tests them in a browser
docs/              Guides (docs/guide), design decisions and limits, surfaces (architecture.md)
skills/corten/     The agent skill for building apps on Corten
bench/fullstack/     Historical marketplace implementations and diagnostic scripts; localization work differs
bench/marketplace/   Equivalent-localization marketplace v2, the nightly workload from official r17
bench/catalog/       Optional locale-neutral record detail and JSON diagnostic, with a separate baseline
bench/live/          One price feed pushed to many clients in the same frameworks
```

Dependencies of `corten`: `hyper` and `hyper-util` (connections, including ones that switch
protocols, HTTP/1.1 only), `http` (the HTTP types apps name as `corten::http`), `http-body`
(the body trait hyper and its clients share), `bytes` (bodies and multipart pieces),
`matchit` (the router's path matching) and `percent-encoding` (its parameters), `tokio`
(sockets, signals, timers), `futures-util`, `pin-project-lite` (bodies and streams without
`unsafe`), `tower-layer` and `tower-service` (at the edges: `App::layer`, and `corten::Router` as a `Service`), `getrandom`
(CSP nonces), `zmij` (float digits), `memchr` (searching a multipart body for its boundary),
`form_urlencoded` (forms and query strings), `serde`, `tracing` and `corten-macros` (no
dependencies). No web framework: [design Choice 25](docs/design.md#choice-axum-router).
Optional: `serde`'s derive, `serde_json` and `serde_path_to_error` (`json`), `zstd`,
`brotli`, `flate2` (`compress`), `jiff` (`zones`), `corten-feed` (`feed`). Apps need no JavaScript dependencies; `package.json` here is tooling for
the framework itself.

## Tooling

- Rust (stable). On Windows the tests run in Docker, because the host cannot link `windows-sys`.
- Node 22 or later, for the runtime's type check, its minified build and the browser smoke
  tests: `npm install`, then `npx playwright install chromium firefox webkit` (the core and
  `corten-ui` smoke tests run in all three).
- Docker, for the example images the smoke tests run against.
- For measuring (Pull requests, item 2): valgrind, on Linux or in the `rust:1-bookworm`
  container after `apt-get update && apt-get install -y valgrind`, and for `count.mjs` a Linux
  host with `perf`, root and cgroup v2.

## Checks

All of these must pass before a pull request is ready. Run each command separately (shown for
PowerShell from the repository root; in another shell use `$PWD` for `${PWD}` and
`checkout=$(basename "$PWD")` for the first line).

Each checkout builds into its own volumes, named after its folder (`corten-target-<folder>`,
`corten-msrv-target-<folder>`), so two checkouts or worktrees never share one: every checkout is
mounted at `/src`, and cargo could take one checkout's build for another's and stop with an error
the code does not have. The folder name must be one Docker accepts in a volume name (letters,
digits, `_`, `.` and `-`). The registry volume, `corten-cargo`, holds only downloaded crates and
is shared. When you remove a checkout, remove its two volumes too.

```powershell
$checkout = Split-Path -Leaf $PWD
docker run --rm -v "${PWD}:/src" -v corten-cargo:/usr/local/cargo/registry -v "corten-target-${checkout}:/target" -e CARGO_TARGET_DIR=/target -w /src rust:1-bookworm sh -c "rustup component add clippy rustfmt >/dev/null 2>&1; cargo fmt --all --check && cargo run -q -p corten-cli -- fmt --check crates examples bench && cargo clippy --workspace --all-features --all-targets -- -D warnings && cargo test --workspace --all-features && cargo test --release --workspace --all-features"
docker run --rm -v "${PWD}:/src" -v corten-cargo:/usr/local/cargo/registry --tmpfs /usr/local/cargo/registry/src:exec -v "corten-target-${checkout}:/target" -e CARGO_TARGET_DIR=/target -w /src rust:1-bookworm sh -c "rustup component add clippy rustfmt >/dev/null 2>&1; cargo test -p corten-run --no-default-features && cargo build -q -p corten-cli && /target/debug/corten new /tmp/app --corten-path /src/crates/corten && cd /tmp/app && /target/debug/corten check --no-script-types && /target/debug/corten ui init && /target/debug/corten ui add --all && /target/debug/corten check --no-script-types && cd /src && CARGO_TARGET_DIR=/tmp/publish cargo publish --workspace --dry-run --locked --allow-dirty"
docker run --rm -v "${PWD}:/src" -v corten-cargo:/usr/local/cargo/registry -v "corten-msrv-target-${checkout}:/target" -e CARGO_TARGET_DIR=/target -w /src rust:1.88-bookworm cargo check --locked --workspace --all-features --all-targets
npm run check
docker build -f examples/watchlist/Dockerfile -t corten-watchlist .
docker run -d --name corten-watchlist -p 18480:8080 -e SMOKE_TRUSTED_TYPES=1 corten-watchlist
npm run smoke -- http://localhost:18480
docker rm -f corten-watchlist
docker run -d --name corten-watchlist-dev -p 18483:8080 -e CORTEN_DEV=1 corten-watchlist
node scripts/smoke-dev.mjs http://localhost:18483 corten-watchlist-dev
docker rm -f corten-watchlist-dev
docker build -f examples/card-market/Dockerfile -t corten-card-market .
docker run -d --name corten-card-market -p 18481:8080 -e ITEM_SOURCE=fixture -e FIXTURE_PATH=/fixtures/smoke.json -e AGENT_ORIGINS=http://127.0.0.1:18481 -e EMBED_ORIGINS=http://127.0.0.1:18481 -e PROXIES=172.16.0.0/12,192.168.0.0/16 -e API_KEYS=dev=dev-key -e AGENT_TOKENS=dev-token -v "${PWD}/examples/card-market/fixtures:/fixtures:ro" corten-card-market
node examples/card-market/smoke.mjs http://localhost:18481
docker rm -f corten-card-market
docker build -f examples/ui-gallery/Dockerfile -t corten-ui-gallery .
docker run -d --name corten-ui-gallery -p 18482:8080 corten-ui-gallery
node examples/ui-gallery/smoke.mjs http://localhost:18482
docker rm -f corten-ui-gallery
docker build -f examples/seller-desk/Dockerfile -t corten-seller-desk .
docker run -d --name corten-seller-desk -p 18484:8080 corten-seller-desk
node examples/seller-desk/smoke.mjs http://localhost:18484
docker rm -f corten-seller-desk
docker build -f examples/deck-builder/Dockerfile -t corten-deck-builder .
docker run -d --name corten-deck-builder -p 18487:8080 corten-deck-builder
node examples/deck-builder/smoke.mjs http://localhost:18487
node examples/deck-builder/preview-smoke.mjs http://localhost:18487
docker rm -f corten-deck-builder
docker build -f examples/auction-room/Dockerfile -t corten-auction-room .
docker run -d --name corten-auction-room -p 18486:8080 -e HOUSE_KEY=smoke-house corten-auction-room
node examples/auction-room/smoke.mjs http://localhost:18486 smoke-house
docker rm -f corten-auction-room
docker network create feeds
docker run -d --name feeds-pg --network feeds -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=feeds postgres:16-alpine
docker run -d --name feeds-nats --network feeds nats:2-alpine -js
docker build -f examples/listings-feed/Dockerfile -t corten-listings-feed .
docker run -d --name corten-listings-feed --network feeds -p 18485:8080 -e DATABASE_URL=postgres://postgres:postgres@feeds-pg/feeds -e NATS_URL=nats://feeds-nats:4222 corten-listings-feed
node examples/listings-feed/smoke.mjs http://localhost:18485
docker rm -f corten-listings-feed feeds-pg feeds-nats
docker network rm feeds
```

The first command also compiles every `rust` code block in `README.md` and `docs/guide/` as a
doctest. Mark a fragment that cannot compile on its own `rust,ignore`, and a complete program
that serves forever `rust,no_run`. The second's `corten check` runs `--no-script-types`, since
the Rust image has no Node; CI's `rust` job installs TypeScript and type-checks the new app's
scripts. The second ends by packaging every published crate and
building each from its `.crate` file, as crates.io will (`cargo publish --dry-run`). It unpacks
sources into a throwaway `--tmpfs` over the registry's `src`: the dry run unpacks Corten's own
crates there too, and since their version never changes, a shared copy would be the first one
any checkout unpacked. It builds them in a target directory of its own for the same reason:
cargo treats a registry crate as unchanged as long as its version stays the same, so the
checkout's target volume would hand the dry run an earlier run's build of `corten`. The third
builds on the oldest supported Rust, `rust-version` in the root `Cargo.toml`. The `CI` workflow
(`.github/workflows/ci.yml`) runs the same checks on every pull request and push to `main`.
A browser smoke that goes five minutes without finishing a check stops itself (`scripts/stall.mjs`),
printing the last check it finished and, for the runtime's smoke, the requests still loading; give a
new smoke script's `check` the same watchdog. Each smoke launches its browser through `steady` (`scripts/steady.mjs`), which
retries a page's `goto` or `reload` once on `net::ERR_NETWORK_CHANGED` alone: Chromium aborts a
navigation when Docker changes the machine's network interfaces, which says nothing about the app.
A resource the page loads can be aborted the same way, and the page's console listeners are not
told of the error Chromium logs for it (the exact text
`Failed to load resource: net::ERR_NETWORK_CHANGED`); a check that needed the resource still fails
on its own, and what the runtime logs for a loss it recovers from is still seen.

Playwright's Firefox (1.64.1) sometimes acknowledges a click tens of seconds late on a heavily
loaded Windows machine, with no Corten on the page: a static form reproduces it, with or without
form validation
([#712 ui-gallery smoke: on a loaded Windows machine a page stops making progress for 30 s about one full run in three, with the server answering in under 210 ms](https://github.com/corten-run/corten/issues/712)).
In a Linux container on the same machine, under the same load, 12 rounds of 200 clicks had none
over 10 s, which suggests but does not prove that the stall is specific to Windows. In ui-gallery
it has shown at the "List for sale" step. A Firefox-only click timeout there, with nothing still
loading, is that stall: rerun the smoke in Firefox alone
(`node examples/ui-gallery/smoke.mjs <url> firefox`) once the machine is quiet, and treat a
failure on the rerun, or the same step failing in Chromium or WebKit, as real. Nothing retries
the step or waits longer for it.

## Cluster integration tests

`corten-cluster`'s tests run against real Postgres and NATS JetStream when two variables are
set, and are skipped otherwise (`$checkout` as in [Checks](#checks)):

```powershell
$checkout = Split-Path -Leaf $PWD
docker network create corten-test
docker run -d --name corten-test-pg --network corten-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=feeds postgres:16-alpine
docker run -d --name corten-test-nats --network corten-test nats:2-alpine -js
docker run --rm --network corten-test -v "${PWD}:/src" -v corten-cargo:/usr/local/cargo/registry -v "corten-target-${checkout}:/target" -e CARGO_TARGET_DIR=/target -e CORTEN_TEST_DATABASE_URL=postgres://postgres:postgres@corten-test-pg/feeds -e CORTEN_TEST_NATS_URL=nats://corten-test-nats:4222 -w /src rust:1-bookworm cargo test -p corten-cluster -- --test-threads=1
docker rm -f corten-test-pg corten-test-nats
docker network rm corten-test
```

The failover benchmark is `node examples/listings-feed/bench/run.mjs`; see its header.

## Pull requests

For nightly performance evidence, use the [marketplace v2 procedure](bench/marketplace/nightly.md).
Official `rN` rounds start at r17; `wN` stays for development. Require all twenty apps, both
sources and every conformance profile before load. The nightly suite measures CPU, memory,
load and cold start only, with three short-window passes (`--duration 15 --warmup 10 --rate 150`)
on a dedicated c-8, app CPU 1, upstream CPUs 2-3 and load CPUs 4-7. Time pages in all three
locales (`en-US`, `fr-FR`, `de-DE`) and locale-neutral JSON once per source per pass.
Report medians, ranges and headroom limits, not a guaranteed finish by 7 am. Compare only
compatible v2 rounds, with no r16 or catalog c1 delta; catalog is not a duplicate nightly run.
Historical build, browser, byte and instruction evidence remains under its original workload
labels. The tools below still serve focused measurements not yet covered by the v2 nightly.
Keep framework feature claims separate from speed; unequal historical localization does not
establish a general ranking.

1. One change per pull request, with a test for each behavior: a Rust test, a `compile_fail`
   doctest for a compile-time guarantee, an `@ts-expect-error` line in
   `scripts/typecheck-fixture.js` for a typing guarantee, and a browser smoke check for anything
   the runtime does.
2. A change to rendering, the runtime or the request path is measured before and after, with
   the number that can see the change:
   1. Work done in process (rendering, routing, serialization, middleware, a handler's own
      code): instructions per request under callgrind (`valgrind --tool=callgrind`). Count a
      test that sends 1,200 requests through the router in process with `oneshot` and one that
      sends 200: the difference over 1,000 leaves out startup and setup. Over a real socket,
      `bench/fullstack/count.mjs` counts with `perf stat`. A count barely moves with other load
      on the machine, so it shows a difference of a few percent that times on a laptop or
      Docker Desktop hide. Reading JSON: `read_cost` in `examples/card-market` reads the
      fixture's 500 item API responses once each, and its doc comment gives the command.
   2. Memory (allocation, buffer sizes, copies, data layout): the count and times, because a
      count does not see cache misses or memory stalls, and the same count can take longer.
      For the item page, `render_cost` in `examples/card-market` prints the times of building,
      rendering and serving it, and the bytes:
      `CORTEN_FIXTURE=/abs/path/items.json cargo test --release -p card-market -- --ignored render_cost --nocapture`
      in the Linux container, with the fixture `bench/fullstack/fixtures/fetch.mjs` writes from
      the item API on `:18400`.
   3. Waiting and concurrency (I/O, locks, channels, timers, feeds, streaming, startup): time,
      because a count does not see waiting or how well work overlaps. `bench/fullstack/ab.mjs`
      runs the two builds' images on one CPU for latency and throughput under load, and
      `bench/fullstack/cold-start.mjs` times cold start. Take these on a quiet Linux host: on
      Docker Desktop one image's throughput moved by up to 25% between rounds.
   4. What the client receives: bytes shipped (the document, patches, the minified runtime,
      assets), raw and compressed. `render_cost` gives the page's per encoding, and
      `bench/fullstack/bytes.mjs` every script and stylesheet a page loads.

   Measure release builds and alternate runs of the two. Give the tool, the number of runs and
   their median and range; when one build's runs vary more than the two builds differ, say so
   instead of reporting a difference.
3. Update the guide in `docs/guide/` that describes the behavior, and add a line to
   `CHANGELOG.md` under Unreleased.
4. Commit messages say what changed and why, in plain sentences.
5. The description says what changed and why, the checks run and their results, and the
   measurements from 2. It merges after its [review](#review).

## Review

Every pull request is reviewed against the [values](README.md#values) before it merges, by
someone who did not write it: another person, or, when an agent wrote the change, a new agent
that starts from the diff and these documents rather than from the author's reasoning. The
reviewer reads the change as an adversary and looks for the way it breaks a value; where values
conflict, the order in the README decides. What to look for:

- Correctness and reliability: an input, failure, cancellation, retry or concurrent request it
   gets wrong; a behavior with no test, or a test that would still pass if the behavior broke.
- Performance at the user's end: a cost added to every request, render or page (instructions,
   allocation, bytes shipped, a round trip) with no before-and-after number, or a number taken
   with a measurement that cannot see the change.
- Compile-time safety and one way to do things: a mistake left to startup or to a request that
   the compiler could catch, a guarantee with no `compile_fail` doctest or `@ts-expect-error`
   line, a string at a seam (a URL, a ref, a class, a message key), or a second way to do
   something that already has one ([design rules](docs/design.md#rules)).
- Standards: a header, wire format or file format of Corten's own where a standard exists,
   with no Choice in `docs/design.md` saying why ([design rule 10](docs/design.md#rule-standard-formats)),
   or something the browser or HTTP already provides built again.
- Premises: a change that makes a Choice's "Revisit when" condition true, or takes away a
   premise it stands on, and leaves the Choice as it was; a change that measures or probes a
   Choice's evidence again and leaves its "Last checked" date, or moves the date without doing so;
   a new or rewritten Choice without the three, or with a premise its evidence does not meet
   (measured with no number, or with no word on how often it was taken; an untested assumption
   called reasoned) ([design, Choices](docs/design.md#choices)).
- The other values: a dependency or concept a smaller change would avoid, a page that stops
   working without JavaScript, a default that is not production-ready, a guide or changelog
   that no longer matches.

Findings come first, the most severe first, each with its file and line and the value it
breaks. The author fixes each one or answers on the pull request why it stands. The pull
request merges when every finding is resolved and the checks pass. A review that finds nothing
says so, and names what it could not check.

## Releasing

Every published crate (all of `crates/`) shares the version in `[workspace.package]` and is
released together; the examples have `publish = false`. Pushing a tag `vX.Y.Z` runs the
`Release` workflow (`.github/workflows/release.yml`): the checks, a `corten` binary for each
platform, `cargo publish --workspace` (each crate after the ones it depends on), then a GitHub
release with the binaries and the version's `CHANGELOG.md` section as its notes. It stops before
publishing when the tag, the workspace version and the changelog disagree.

1. Check that every crate in `crates/` is on crates.io. For one that is not, follow
   [Before a release that adds a crate](#before-a-release-that-adds-a-crate) first.
2. In one pull request, set `version` in `[workspace.package]` and the same version on every
   `corten*` line of `[workspace.dependencies]`, then rename `## Unreleased` in `CHANGELOG.md`
   to `## X.Y.Z (YYYY-MM-DD)` and start a new empty `## Unreleased` above it. A release before
   1.0 that changes the API bumps the minor version.
3. Merge it, then tag that commit on `main` and push the tag:
   `git tag -a vX.Y.Z -m "Corten X.Y.Z"` and `git push origin vX.Y.Z`.
4. Approve the `release` environment when the workflow asks.

A crate whose trusted publisher was added before the repository moved to `corten-run` still
names the old owner's repository, and crates.io refuses the workflow until it is edited: before
the next release, check each published crate's Settings on crates.io and point its publisher at
`corten-run/corten`.

The framework's package is `corten-run` and its library `corten` (`[lib] name` in
`crates/corten/Cargo.toml`), so apps and the paths `corten-macros` generates still name it
`corten`: `corten` on crates.io is an empty 2022 placeholder of someone else's, and crates.io does
not transfer a crate without its owner
([#835 The main crate cannot be published: corten on crates.io is an empty 2022 placeholder, so choose its package name (corten-run) or wait for crates.io](https://github.com/corten-run/corten/issues/835)).
If crates.io frees the name, take it only so no one else can, and keep publishing `corten-run`:
moving back would be a second rename for every app. The `corten` command still reads an app's pin
under the old name (`PACKAGES` in `crates/corten-cli/src/pin.rs`).

A published version cannot be replaced, only yanked (`cargo yank --version X.Y.Z <crate>`), so
a fix is a new patch release.

### Before a release that adds a crate

crates.io only lets a workflow publish (trusted publishing) for a crate that already exists, so a
release that publishes a crate for the first time uses an API token once. Without the token the
workflow would publish the crates before the new one and stop there, and a published version
cannot be taken back. When this was written, `corten-run`, `corten-ui` and `corten-cluster`
were not on crates.io, while the other four were at 0.1.0.

1. Sign in to crates.io with the GitHub account that will own the crates (an admin of
   `corten-run/corten`).
2. In the repository settings, create the environment `release` with yourself as a required
   reviewer, and add a secret `CARGO_REGISTRY_TOKEN` to it: a crates.io token with the
   `publish-new` and `publish-update` scopes, expiring in a few days.
3. Release as above. Then, for each crate that did not have one, open its Settings on crates.io,
   add a trusted publisher (GitHub, repository `corten-run/corten`, workflow `release.yml`,
   environment `release`), delete the secret and revoke the token. Later releases authenticate
   through `rust-lang/crates-io-auth-action` with no stored token.
