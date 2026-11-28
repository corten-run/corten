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
                     Put new crate-level tests in the area's file under crates/corten/src/tests/.
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
examples/corten-site/ Corten's own site, a page that demonstrates itself, with the files that deploy it; smoke.mjs tests it
docs/              Guides (docs/guide), design decisions and limits, surfaces (architecture.md)
skills/corten/     The agent skill for building apps on Corten
bench/fullstack/     Historical marketplace implementations and diagnostic scripts; localization work differs
bench/marketplace/   Equivalent-localization marketplace v2, the nightly workload from official r17
bench/catalog/       Optional locale-neutral record detail and JSON diagnostic, with a separate baseline
bench/live/          One price feed pushed to many clients in the same frameworks
bench/nodelay/       A burst of small live events through nginx, with and without TCP_NODELAY
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
Optional: `serde`'s derive, `serde_json` and `serde_path_to_error` (`json`), `typeid` (`types`), `zstd`,
`brotli`, `flate2` (`compress`), `jiff` (`zones`), `corten-feed` (`feed`). Apps need no JavaScript dependencies; `package.json` here is tooling for
the framework itself.

## Tooling

Corten apps require TypeScript 6.0 or later. Framework CI pins the root `typescript` to 7.0.2,
npm's `latest` verified on 2026-11-20, and also type-checks `jsconfig.json` with TypeScript
6.0.3 installed outside the repository. `corten check` finds the compiler as it does for any
app: `node_modules/.bin/tsc`, then the PATH, with the minimum checked. The parser checks use
7.0.2's unstable native API ([Choice 5](docs/design.md#choice-handlers-checked-where-called)).
The benchmark harness's classic compiler API consumers (`bench/fullstack-browser` and
`bench/workloads`) use TypeScript 6.0.3 from `bench/package.json`, loaded only through
`bench/typescript.mjs`: run `npm --prefix bench ci` before `npm run check:workloads`,
`check:catalog`, `check:json-api` and the `check:groups` suites, which otherwise stop at import
naming that command.

After `npm ci` and the benchmark's normal build has generated `out/_gen/view/views.d.ts`,
type-check the browser benchmark's view apps with the repository's pinned
compiler: `npx tsc -p bench/browser/jsconfig.json`.

- Rust (stable; the supported floor is 1.89), with the `clippy`, `rustfmt` and `llvm-tools` components (`rustup component add llvm-tools`: the `corten` command's tests run a profile-guided build, which merges its profile with the toolchain's `llvm-profdata`). On Windows the tests run in Docker, because the host cannot link `windows-sys`.
- Node (use the framework CI version in [`.node-version`](.node-version)), for the runtime's
  type check, its minified build and the browser smoke tests: `npm ci`, then
  `npx playwright install chromium firefox webkit` (the core and `corten-ui` smoke tests run
  in all three).
- Docker, for the example images the smoke tests run against.
- For measuring (Pull requests, item 2): valgrind, on Linux or in the `rust:1-trixie`
  container after `apt-get update && apt-get install -y valgrind`, and for `count.mjs` a Linux
  host with `perf`, root and cgroup v2.

Use Cargo 1.100 or later when changing Rust dependencies. The checkout's `.cargo/config.toml`
asks Cargo to pass over registry versions published less than three days ago when resolving
dependencies. This gives a bad release time to be noticed and yanked, not a guarantee that old
versions are safe. It does not reject versions already in `Cargo.lock`, cover versions without a
registry publish time, or apply to an install from the registry (`cargo install corten-cli`);
`cargo install --path` and an app inside the checkout do read it. A new resolution fails when no
version old enough meets a requirement. For an urgent fix, set
`CARGO_RESOLVER_INCOMPATIBLE_PUBLISH_AGE=allow` for that resolution only, and review the lockfile
diff. Cargo 1.89 ignores the setting; Cargo 1.99.1 ignores it with a warning.

A workspace `Cargo.lock` refresh also moves the standalone Corten benchmark locks
(`bench/catalog/corten`, `bench/marketplace/corten`, `bench/live/apps/corten` and `bench/nodelay/app`),
so each uses the workspace's locked version of a registry crate their trees share where the app's
own requirements allow it:
`cargo update --manifest-path <app>/Cargo.toml -p <crate>@<locked version> --precise <version>`,
then `cargo check --locked --manifest-path <app>/Cargo.toml`. A crate a benchmark manifest pins
exactly (`=`) keeps its pin, and any other divergence is named in the pull request rather than
forced. The HTTP/2 probe's lock stays with its recorded results.

Fix Cargo's unused dependency warnings from the stable, all-feature, all-target check below.
Cargo 1.100's `unused_dependencies` lint does not cover dev-dependencies. These Cargo lints
remain warnings: setting them to `deny` in the manifests would introduce warnings on the
supported Rust floor, and `-D warnings` here applies to rustc and Clippy, not Cargo.
Revisit `deny` when the Rust floor reaches 1.100.

## Checks

Grouped benchmark replay and observer controls also run in the separate
`Benchmark Evidence` workflow: `npm run check:groups:evidence:core`,
`npm run check:groups:evidence:contracts` and `npm run check:groups:evidence:browser`.
On pull requests and pushes to `main`, its scope job starts the suites only when the
benchmark, tooling, workflow or committed source-custody inputs change. These inputs
include `docs/`, `crates/`, and the Cargo manifests and locks for the portable suites.
The native Linux job scopes separately to benchmark, scripts, tooling and workflow inputs.
A push with no usable base commit runs all Evidence jobs.
Evidence is not a publication gate; Release calls CI only.
They need Node 24 or later, the installed pinned Playwright Chromium, current Git,
the full repository history and the integrity-checked npm cache used by `npm ci` and
`npm --prefix bench ci`.
The portable jobs use the existing Git-capable Playwright image and serial test files;
they do not mount a Docker socket or qualify native framework images. A separate
required native Linux job runs disposable kernel fixtures on the runner host, not
an official campaign or framework performance test.

The portable core selection excludes only `host-lifetime-linux.test.mjs` and
`host-participant-linux.test.mjs` under `bench/workloads/isolated/`. The native job
uses `scripts/benchmark-kernel-ci.sh` with fresh delegated systemd test units and
one owned, digest-pinned Docker fixture. It exercises real process accounting and
cancellation, matched Docker PID/cgroup observations and a private-PID-namespace
negative. Any skipped or cancelled native control fails the job. Before the driver,
the hosted job adds Google's Docker Hub cache to the runner daemon's registry mirrors
(`scripts/ci-docker-hub-mirror.sh`), after any it already lists, and reloads Docker without
restarting it. The daemon tries its mirrors before falling back to Docker Hub, so a pull the
cache serves does not count against Docker Hub's anonymous limit; a miss still goes to Docker
Hub. The image keeps its Hub reference and digest. If Docker does not list the cache within a
minute, the step fails the job; the runner is discarded, so nothing is rolled back. The step
refuses to run outside a GitHub-hosted runner; never run it on your own machine. The driver
never edits a Docker configuration. A static coverage
check rejects any other omitted core test file. Browser CI runs every
portable saved-verifier test, excluding only the optional historical `retained real w28`
capture test. Native production-image and Docker collector controls are also separate;
their absence cannot establish framework or host qualification.

`Catalog Contract` runs the harness and Corten parity for framework-only changes; app
changes run the harness and the affected apps, including consumers of shared drivers.
The listed fleet-controller files keep the harness, Corten's root-context build and both
JSON jobs, but do not select unrelated app builds. Benchmark Evidence selection is unchanged.
Changes to shared benchmark inputs or the workflow, and manual runs, test all 20 parity
apps and both JSON jobs. A push to `main` is scoped the same way by its push diff, and tests
everything when its base commit is unknown. This also applies to unknown app directories
and files directly in `bench/fullstack/apps/`. An `aspnet-aot` change runs the JSON jobs.
Run `node --test scripts/benchmark-scope.test.mjs` to check both selectors, including
the imports of the Catalog parity commands for each app.
Both workflows compare the pull request merge commit with its first parent, using
the full Git diff rather than GitHub's path-filter file list, and the before and after
commits on a push; a push whose before commit is unknown or not an ancestor of the new one (a
force-push) tests everything. Newer pull request runs cancel older ones; `main` runs do not
cancel one another, so each push's own diff is tested.

All of these must pass before a pull request is ready. Run each command separately (shown for
PowerShell from the repository root; in another shell use `$PWD` for `${PWD}`,
`checkout=$(basename "$PWD")` for the first line, and, for the three lines from `$env:SITE_HELD` to
`Remove-Item`, the one line
`SITE_HELD=1 node examples/corten-site/smoke.mjs http://localhost:18488 chromium`).

Each checkout builds into its own volumes, named after its folder (`corten-target-<folder>`,
`corten-msrv-target-<folder>`), so two checkouts or worktrees never share one: every checkout is
mounted at `/src`, and cargo could take one checkout's build for another's and stop with an error
the code does not have. The folder name must be one Docker accepts in a volume name (letters,
digits, `_`, `.` and `-`). The registry volume, `corten-cargo`, holds only downloaded crates and
is shared. When you remove a checkout, remove its two volumes too.

`npm run check` fails on a commit the Markdown cites that is not on the checkout's history or
under `refs/tags/evidence/` (`scripts/design-refs.mjs`), so it needs the whole history and those
tags, which keep cited commits no branch has. A plain `git clone` of corten-run/corten has both,
but a fork's clone may lack the tags, and `git fetch` brings a new one only with `--tags`; when
the check names a commit, run
`git fetch https://github.com/corten-run/corten.git "+refs/tags/evidence/*:refs/tags/evidence/*"`
(in a shallow clone, with `--unshallow`).

```powershell
$checkout = Split-Path -Leaf $PWD
docker run --rm -v "${PWD}:/src" -v corten-cargo:/usr/local/cargo/registry -v "corten-target-${checkout}:/target" -e CARGO_TARGET_DIR=/target -w /src rust:1-trixie sh -c "rustup component add clippy rustfmt llvm-tools >/dev/null 2>&1; cargo fmt --all --check && cargo run -q -p corten-cli -- fmt --check crates examples bench && cargo clippy --workspace --all-features --all-targets -- -D warnings && cargo test --workspace --all-features && cargo test --release --workspace --all-features"
docker run --rm -v "${PWD}:/src" -v corten-cargo:/usr/local/cargo/registry --tmpfs /usr/local/cargo/registry/src:exec -v "corten-target-${checkout}:/target" -e CARGO_TARGET_DIR=/target -w /src rust:1-trixie sh -c "rustup component add clippy rustfmt >/dev/null 2>&1; cargo test -p corten-run --no-default-features && cargo check -p corten-run --no-default-features --features json --all-targets && cargo check -p corten-run --no-default-features --features agent,feed && cargo build -q -p corten-cli && /target/debug/corten new /tmp/app --corten-path /src/crates/corten && cd /tmp/app && /target/debug/corten check --no-script-types && /target/debug/corten ui init && /target/debug/corten ui add --all && /target/debug/corten check --no-script-types && cd /src && CARGO_TARGET_DIR=/tmp/publish cargo publish --workspace --dry-run --locked --allow-dirty"
docker run --rm -v "${PWD}:/src" -v corten-cargo:/usr/local/cargo/registry -v "corten-msrv-target-${checkout}:/target" -e CARGO_TARGET_DIR=/target -w /src rust:1.89-trixie cargo check --locked --workspace --all-features --all-targets
npm run check
docker build -f examples/watchlist/Dockerfile -t corten-watchlist .
docker run -d --name corten-watchlist -p 18480:8080 -e SMOKE_TRUSTED_TYPES=1 corten-watchlist
npm run smoke -- http://localhost:18480
docker rm -f corten-watchlist
docker run -d --name corten-watchlist-dev -p 18483:8080 -e CORTEN_DEV=1 corten-watchlist
node scripts/smoke-dev.mjs http://localhost:18483 corten-watchlist-dev
docker rm -f corten-watchlist-dev
docker build --build-arg CARD_MARKET_SMOKE=1 -f examples/card-market/Dockerfile -t corten-card-market .
docker run -d --name corten-card-market -p 18481:8080 -e ITEM_SOURCE=fixture -e FIXTURE_PATH=/fixtures/smoke.json -e AGENT_ORIGINS=http://127.0.0.1:18481 -e EMBED_ORIGINS=http://127.0.0.1:18481 -e PROXIES=172.16.0.0/12,192.168.0.0/16 -e API_KEYS=dev=dev-key -e AGENT_TOKENS=dev-token -v "${PWD}/examples/card-market/fixtures:/fixtures:ro" corten-card-market
node examples/card-market/smoke.mjs http://localhost:18481
docker rm -f corten-card-market
docker build -f examples/ui-gallery/Dockerfile -t corten-ui-gallery .
docker run -d --name corten-ui-gallery -p 18482:8080 corten-ui-gallery
node examples/ui-gallery/smoke.mjs http://localhost:18482
docker rm -f corten-ui-gallery
docker build -f examples/corten-site/Dockerfile -t corten-site .
docker run -d --name corten-site -p 18488:8080 corten-site
node examples/corten-site/smoke.mjs http://localhost:18488
docker rm -f corten-site
docker run -d --name corten-site --cpus 1 --memory 512m -p 18488:8080 corten-site
$env:SITE_HELD = "1"
node examples/corten-site/smoke.mjs http://localhost:18488 chromium
Remove-Item Env:SITE_HELD
docker rm -f corten-site
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
docker run -d --name feeds-pg --network feeds -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=feeds postgres:19-alpine
docker run -d --name feeds-nats --network feeds nats:2-alpine -js
docker build -f examples/listings-feed/Dockerfile -t corten-listings-feed .
docker run -d --name corten-listings-feed --network feeds -p 18485:8080 -e DATABASE_URL=postgres://postgres:postgres@feeds-pg/feeds -e NATS_URL=nats://feeds-nats:4222 corten-listings-feed
node examples/listings-feed/smoke.mjs http://localhost:18485
docker rm -f -v corten-listings-feed feeds-pg feeds-nats
docker network rm feeds
```

The first command also compiles every `rust` code block in `README.md` and `docs/guide/` as a
doctest. Mark a fragment that cannot compile on its own `rust,ignore`, and a complete program
that serves forever `rust,no_run`. The second's `corten check` runs `--no-script-types`, since
the Rust image has no Node; CI's `rust-checks` job installs TypeScript and type-checks the new app's
scripts. The second ends by packaging every published crate and
building each from its `.crate` file, as crates.io will (`cargo publish --dry-run`). It unpacks
sources into a throwaway `--tmpfs` over the registry's `src`: the dry run unpacks Corten's own
crates there too, and since their version never changes, a shared copy would be the first one
any checkout unpacked. It builds them in a target directory of its own for the same reason:
cargo treats a registry crate as unchanged as long as its version stays the same, so the
checkout's target volume would hand the dry run an earlier run's build of `corten`. The third
builds on the oldest supported Rust, `rust-version` in the root `Cargo.toml`. The `CI` workflow
(`.github/workflows/ci.yml`) runs the same checks on every pull request and push to `main`,
side by side on runners of their own: the release tests apart from the other Rust checks, and the
browser smokes in three groups, one engine of the watchlist's smoke in each. The required checks
`rust` and `browser` pass only when every job under them ran and passed, and `msrv` checks the
supported Rust floor. A new smoke step names
its part in its condition and in exactly one group's `parts`, or `browser` fails.
The three example groups use the pinned Playwright image directly. A fourth group,
`benchmark-checks`, runs the `npm-check` part, the marketplace browser oracle and the native
workload group apparatus on its own runner. Only that group builds the Git-capable test-tools
image. The apparatus runs as the checkout owner with fingerprint-checked Git and immutable-source checks.

Add new watchlist runtime checks to the matching area in [`scripts/smoke/`](scripts/smoke/),
and new gallery checks to the matching widget or area in [`examples/ui-gallery/smoke/`](examples/ui-gallery/smoke/).
The entry points order the areas, including those that share pages, routes, or listeners.

A browser smoke that goes five minutes without finishing a check stops itself (`scripts/stall.mjs`),
printing the last check it finished and, for the runtime's smoke, the requests still loading; give a
new smoke script's `check` the same watchdog. Each smoke launches its browser through `steady` (`scripts/steady.mjs`), which
retries a page's `goto` or `reload` once on `net::ERR_NETWORK_CHANGED` alone: Chromium aborts a
navigation when Docker changes the machine's network interfaces, which says nothing about the app.
A resource the page loads can be aborted the same way, and the page's console listeners are not
told of the error Chromium logs for it (the exact text
`Failed to load resource: net::ERR_NETWORK_CHANGED`); a check that needed the resource still fails
on its own, and what the runtime logs for a loss it recovers from is still seen.

The watchlist and ui-gallery smokes gate the initial HTTP navigation on each new Linux WebKit
page, including new tabs in an existing context. A fast `Cross-Origin-Opener-Policy: same-origin`
response can otherwise start a process swap before WebKit handles the original process's
provisional-load start, then that late start cancels the swap
([WebKit bug 325840](https://bugs.webkit.org/show_bug.cgi?id=325840)). The one-shot request route
lets the start reach the UI process before the request goes to the server. It keeps existing
fixture routes and the real response. Playwright bypasses the HTTP cache while the route is
installed. The gate waits at most five seconds each for route setup and cleanup, without retrying
the navigation or extending its timeout. If setup or navigation already failed, cleanup cannot
replace that error; after a successful navigation, failed cleanup fails the smoke. Remove the gate
when Playwright's pinned WebKit includes the upstream fix.

A watchlist case that marks a request for its own route to read names the header `smoke-*`
(`smoke-note`, `smoke-start` and the rest). Marks are test-only request headers. They may reach
the watchlist server, which ignores them: `the_smokes_request_marks_change_no_answer` in
`examples/watchlist/src/smoke.rs` sends each kind of request the cases mark to the app's router as
it goes on the wire (the test client has no `corten: page` read and does not let a test set
`corten`). It first loads the watchlist and writes an alert in action mode, both in identity
encoding. It then checks each page a marked case reads (the alerts page at a receipt and at the
receipt's replaced address, `/alerts?saved=1&shown=1`,
whose fetches the page-refresh cases' wrapper marks, and `/smoke/written`, `/smoke/written/again`
and `/smoke/quoted`, every fetch of whose pages the write cases' wrapper marks) as a document load,
a navigation (`corten: nav`), a hover prefetch, a whole read (`corten: page`) and a part's read
(`corten: action`); the writes to `/smoke/written` and `/smoke/written/again` in action mode, with
and without `Prefer: corten-draws=whole`; each of these uncompressed, as a case's route fetches
it, and with Firefox's and WebKit's `Accept-Encoding` (`gzip, deflate, br, zstd` and
`gzip, deflate`), as a request a route lets through reaches the server; a screen's data and its
revalidation and a stylesheet under `/assets/`, in each browser's encoding. It sends each without
marks and with each set a wrapper sends, as the browser traces show them (`smoke-note` alone,
`smoke-start` alone, and `smoke-start` with `smoke-styled`), and with one the smoke does not use
(`smoke-canary`) alone, and requires the same status, headers (`Vary` and `Cache-Control` among them)
and body, and each navigation answered as one (`corten-page`) and each whole read as a page. So a case ties
its claim to its own route's answer to its own request, not to a mark not reaching the server. The
diagnostic replay of the requests still loading sends no `smoke-*` header, since a replay need not
carry them.
In Playwright 1.64.1, Firefox sometimes acknowledged a click tens of seconds late on a heavily
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

A Firefox page load that runs past its 30 s timeout on such a machine, with the stall report
saying the browser held its requests, is the same kind of stall. On a workstation with all 16
CPUs busy and 60 to 170 threads waiting for one, the server answered every request of such a load
within a millisecond, through Docker Desktop's own port forwarding as through WSL's localhost
relay; the page's own timing had its document in after 0.1 s and `DOMContentLoaded` 9 to 28 s
later. Firefox's network log of one such load had the document's whole answer in its parent
process at once, then nothing from that process's main thread for 56 s while its socket thread
went on reading, so the answer reached the page only then. Independent Firefox instances loading
pages at the same moment stalled together, whether each page had a browser context of its own or
not
([#1149 Smoke and check failures under load remain after the #1053 and #1102 fixes: a fixed 4 s wait on the formaction post, page loads past their 30 s timeout, and builds.test's touch case](https://github.com/corten-run/corten/issues/1149)).
Rerun it as above.

The watchlist's waiting-submit and submit-key cases press their buttons in the page
(`button.click()`), so each submit runs before the test changes the form's values, presses
again or releases its held answer. A loaded browser can acknowledge Playwright's click before
dispatching that submit: waiting for the answer alone does not prove that the first write used
the old values or that the second press met it still pending. A press that must meet a request
still on its way holds that request's answer until the case has made it, never for a fixed time,
and the cases count their submits, so a press meant to send nothing is seen to have been made.
The other checks that act while a request is out (a busy mark, a navigation before a write's
page, a script's `replaceState` during a read) hold it the same way. The busy mark's write check
sees each post where the page calls `fetch`, since a route hears of a request only some time
after the browser sends it: it requires the waiting button's post sent only once the held answer
is drawn, the two posts and their answers in the route's log, and the waiting post's own answer
drawn within five seconds of the release. The `replaceState` check loads the page with the
document the server draws for the write's receipt, with its status line and its head's read-again
tag put in place as the server draws them while the write has not landed, so the page comes in
waiting whether or not the store had the write by the time the test asked for that document; a
fixture that draws no page for the write fails the check rather than skipping it. The page is
loaded after a blank one, and the runtime's reads of a page are recorded from the start of that
document whatever their address. Its first read of the alerts page is held from before the load,
so the read held is the first however soon it comes, and it must be the document's first read, at
the receipt's address. The check requires the navigation reading it to be still on its way when
the script replaces the address, the replaceState to cancel that navigation, and the held read to
fail after the replaceState while it is still held (not before it, and not once it is let go); then
every later read made at its address with only `shown` changed, one of them answered with success,
`Saved.` drawn in the same document, and the page left at that address. Its write and the read of
the receipt's page are bounded to 15 seconds, and setting and removing its route to five each, a
bound that runs out ending the run with its reason. A wait for a request that
a held answer lets out starts when that answer is let go. The check of a navigation started before
a write's page comes requires the write's request, the navigation's request read whole and the
Stocks page drawn in the same document (its title and its watch form in `<main>`), five seconds
each; each press shares its five seconds with the wait for the request it sends, so a press that
stalls fails the check too. Without one it fails and does no more work on its page, and the next
check starts from the News page it left, gone back to within ten seconds. The way back starts once
the page it is on has loaded (the runtime handles navigations only then), may load the News page in
full, and ends once that page has loaded; a read of the page that fails while it loads means only
not yet. A check that stops before its first press never left the page and does not go back. Only a
page that does not get back stops the smoke, after the check's hold, listeners and the News page's
route are removed.
The check that navigating away abandons a held write requires that write to
fail while it is still held, within five seconds of the page's leaving. The check that navigating
away stops a page's part reads sets its route before it starts the page's write, then holds each
part read of the page it reaches, so the part cannot draw `Saved.` and stop by itself first: it
requires a read held within five seconds while the page still says `Saving...`, then leaves by a
link and answers each held read as one that asks again. It requires at least one such answer
received, every held read let go that way within five seconds of its release, and no part read in
the 2.2 s after (the fixture's one-second read-again delay and 1.2 s more), waited by a timer of the
smoke's own rather than a Playwright command, whose answer has no bound and could keep the case from
its cleanup. A held read counts as
answered only once the browser has finished loading that exact request (Playwright's
`requestfinished` for it) with the answer its fulfill sent, told by a mark unique to that answer
(its `smoke-held` header): a fulfill that resolves is not enough, since Playwright's Firefox
backend drops the browser's refusal of one. A held read fails it, saying which, when its fetch or
fulfill fails, when the browser fails the read or finishes it without that mark, when its release
does not settle, or when its answer is not a
patch whose top-level elements, as the page itself parses them the way the runtime parses a patch
(a template's `innerHTML`), include the `Saving...` status line and end their read-again tags
with a `ReadAgain::from` template that waits that one second and whose `data-from`, resolved
against the base URL of the page it is delivered to (the page the case left for, which the
runtime's fetch resolves it against), is the held read's own address. Without a held read it
fails. Its holds are let go in a `finally`, each release within its own five seconds and, for one
whose fulfill was already sent, ten seconds more to hear what became of it (below), and its route is
removed there too, bounded to five seconds. A
release's five seconds are measured by the monotonic clock (`performance.now()`) from the release,
and checked once its answer is fetched and again just before its fulfill is sent, so a timer that
runs late does not stretch them: a release past them before its fulfill is sent aborts its read,
and its late fetch, if it ever ends, does not answer it. Once the fulfill is sent, the read is late
only if the check heard the browser finish it (its `requestfinished`, timestamped as it is heard)
after the five seconds; reading the finished answer's mark is the check's own work, so a read
finished in time whose mark is read after them is not late. A release whose five-second timer runs
after its fulfill is sent cannot abort the read (Playwright refuses an abort once a fulfill is under
way): it waits ten seconds more for the browser's end of the read and its mark, judged as above,
and without them reports the read's outcome as unconfirmed, and the check fails. The check of a navigation
during a patch's stylesheet load holds the one stylesheet the patch links until the runtime has
read the navigation's answer, and requires that
the page did not swap while it was held and that the browser requested it once while it was
held. It runs twice: once the load succeeds, and the page swaps in with the area's rules applied,
the stylesheet requested once in all; once it fails, and the page loads in full, as a navigation
whose own stylesheet fails does, which may request the stylesheet again. Its steps before the
stylesheet is let go share 15 seconds, and each arm's steps after it 10. A step that fails, runs
out of that time or settles only after it fails the check, and no page work starts after it; a
handle a wait returns is read in a step of its own, so no read of it starts once the time is up.
Its page is closed however the check ends.
Only the failed load tells a navigation that shares the load from one that took the patch's link
for a loaded stylesheet whatever the
page's handler modules do, since those also hold the swap: with a module held past the
stylesheet, a runtime that skips the shared load still swaps in styled, but on the failed load it
swaps in unstyled instead of loading in full.
The watch form's other presses (watching and unwatching a stock, the submit the network fails
and the formaction button) are made in the page too, as a loaded Firefox's click on them can miss.
The two Firefox failures in
[#2014 Firefox smoke fails a different waiting-submit or template-copy case on two commits that touch neither the runtime nor the watchlist](https://github.com/corten-run/corten/issues/2014)
each logged only that an expected post was never sent. A loaded Firefox reproduction of those
cases showed one way that happens: Playwright's click reached the page after it had checked what
was under its point, the page's live updates had moved the button by then, and the click landed
on `<main>` or a `<div>` beside it. The CI logs do not show whether that is what happened there.
The cases still wait for their output condition, then check the busy mark sampled while the
answer was held, the exact sends and the renewed submit key. The first request is captured
before editing its fields. An error a case waits for is its form's own. The check of a submit the
network fails presses its button in the page task that starts listening for the error and its
six-second timer, so its six seconds start at the press, and its handler fails an error heard
after them even if the timer has not run yet. The other checks that wait for a form's
error (the submit that waited for a failed write, the submit keys, the template copies and the
cut connections) listen from before the press but start their six seconds once the press has
returned, or, for the held failure, once its answer is let go; a case whose error does not come
in that time fails and stops, without making its retry. Output is polled on a timer, independent
of animation frames, and output that comes only after its bound fails the check. The 205 check's
waiting submit counts by when its request was seen, so one seen after its six seconds fails the
check whichever of it and the timer is handled first. Each of these checks reads its outcome,
then removes the listeners, routes and holds it installed however it ends, a press that throws or a
wait that times out included. The cut-connection and template-copy checks set up inside that guard
too, so a setup step that fails part way is undone, and each of their removals runs even when
another fails. Neither the six-second outcome bound nor the window for detecting forbidden sends is
extended.

The watchlist's write-page checks on a page that reads itself again (`/smoke/written/again`)
find and press their buttons in one page task, and require each write to reach the stand-in
within five seconds counted from just before the page is asked to press: the press task and the
wait for the write share those five seconds, and a press task that has not returned by then, or
returns after them, fails the press. A failed press names its step in the check's details: the
press task not returning in time, failing or finding nothing to press, or what it led to not
coming in time. The link to `/smoke/quoted` these checks then follow is
pressed the same way, and that page must come in within five seconds counted from just before the
press, a budget the press task shares. It has come only once the address is `/smoke/quoted` and its
`<main>` holds an `<output id="quoted">` and no form, with neither `<main>` nor anything in it busy
(`aria-busy`): the written page draws that output too, inside its form, so neither the output nor the address alone shows that page, and an
empty or other `<main>` at that address does not count. The page that reads itself again swaps `<main>` about a
second after it loads and whenever its answer changes, so a click that found the button (or the
link) before a swap can reach nothing and send nothing
([#2035 Five more Firefox smoke cases fail intermittently under load](https://github.com/corten-run/corten/issues/2035)).
The second write of the check that a failed write stays shown after the page read itself whole is
pressed the same way, in one page task whose press and write reaching the stand-in share one
five-second budget, while the page's next read of itself after that whole read is held at the
stand-in, answer and all: that read must reach the stand-in within five seconds of the whole read's
draw being seen, and it is let go only after the press, once the failure is shown (within five
seconds) or the press has failed. So no read's answer is drawn between the press finding the
button and pressing it, nor while the write is out. A draw while the write is out replaces the
form, and the runtime then says the failure on the form's successor or the document
([#2068 A write's failure is announced on the form a page read already replaced, so the page shows no failure](https://github.com/corten-run/corten/issues/2068)),
and other cases test that. This check does not cover that order: it presses only once the whole
read before the press is drawn, which it tells from the write's own page by a mark the stand-in
puts in each whole page after the write (the page's first read of itself after the stand-in
answered the first write, asked within five seconds of that answer, and drawn as below). A write's own `<main>` they wait
for is noted the moment it is drawn with no element busy, with the time the page drew it, and must
be drawn after the press that sent the write and within five seconds of it, by the page's monotonic
clock (`performance.now()` there) on both sides: the press task records the page's time just before
it presses, since the page's next read draws the form over it a second later; where a case
also waits for the brand that write changed, the brand must show the write's value at that same
moment, so a brand drawn by a later whole read does not count.
The checks that a failure stays shown while the page reads itself again require the page's first
read of itself after the failure to be a navigation whose `<main>` is drawn, which a mark the
stand-in puts in each navigation's `<main>` shows (a request alone is not a draw), and the failure
already shown at that draw and still shown when the check looks again at least 500 ms after it,
counted from the time the page recorded as it drew it, against the page's own clock (a later look,
not a watch through those 500 ms, waited by a timer of the smoke's own, as the failure's own wait is
bounded by the smoke's clock): a poll drawn before the failure was shown is not one that kept it. In the cut-body cases
the failure shown at that later look must be the body's own (its
status), so another failure that took its place does not count. That first read is taken from the
moment the stand-in failed (or answered) the write it follows, or from a held body's release, not
from when the check sees the
failure, and must come within five seconds of that moment: the stand-in records the time of each
outcome and request, so a read asked later fails however soon the check looks. A read counts as
after that moment only if it reached the stand-in after its time, not in the same millisecond, and
not only after its place among the reads. A held body's release is a moment the page records, as it
lets the body go, so a read after it must be one the page started after that time and within five
seconds of it: a read the page started while its task to let the body go waited to run came before
the release, however late it reached the stand-in. In the check whose next read after
the whole one is held, a read that comes after the stand-in handed that held read its answer has its
five seconds counted from that moment instead, which the stand-in records: the page waits on the
held read until then, and the check's wait to see the failure has five seconds of its own. The page
records, the moment it draws each mark, the time and whether the failure was shown; the `<main>`
must be drawn within five seconds of the page starting the read that brought it, by that recorded
time, so a check that looks late neither fails a draw made in time nor passes one made after. No
wall clock is compared, and no time the page records with one the smoke records: the smoke and its
stand-in use the smoke's monotonic clock (`performance.now()`), and what the page records (a draw,
a press, a release, the start of each fetch it makes, which a wrapper added before the page loads
puts on the request, `smoke-start`) uses the page's (`performance.now()` there), each look at the
page reading its records and its time in one task until that clock passes the bound.
The whole-poll stylesheet case requires its
write, that write's page, the poll's request for the held stylesheet (within five seconds from
just before the press), the failing write and its failure in turn, then the next read after the
hold is let go asked as a navigation and its answer drawn, which a mark the stand-in puts in each
navigation's `<main>`
shows, with the failure shown at that draw, both within five seconds of the release: the read as
the stand-in heard it, by the smoke's clock against its moment before it let go, and the draw by the
page's clock against the moment the page had the released stylesheet, which it notes as that
stylesheet loads. The page must also have started that read once it had noted that load, which the
page's fetch wrapper marks on the read in the task that starts it (`smoke-styled`), so the page's own
order of events decides, not two times a coarsened clock can make equal; and drawn its answer no
earlier than that moment by the page's clock (the draw's record). A read made, or drawn, while the
stylesheet still held the poll does not pass. It does not make a press once a step before it failed, and lets go of the hold, removes
its routes and closes its page however it ends, setting and removing its route each bounded to
five seconds. The
cut-body cases take a failure as the body's only when the page's own wrapper of that write's
answer, which runs once its headers came, says it cut (or gave) the body; with a second write,
that wrapper must be asked for the first write's body within five seconds counted from just before
the press of the first write, and the second write's own `<main>` and the brand it brought must be drawn at the
same moment, with nothing in `<main>` busy (the first form, outside it, still waits for its body),
before the first write's body is let go, in a page task that does not wait for the body, bounded
to five seconds. The body cut (or given in full) and its failure must then both come within five
seconds of the body's release, by the times the page records as it lets the body go, as the body
is cut (or given) and as that failure is first shown with nothing busy. With a second write the
release time the page returned as the check let the body go bounds the first look too, so the time
the check took to hear of the release is not added to them. The check looks until a look finds the
failure or the page's clock at or past those five seconds, which is its last look, and the times
the page recorded decide, so a late look
neither passes an outcome that came after them nor fails one that came in time. The wait as a whole
has ten seconds by the smoke's own monotonic clock, from the moment the check heard of the release it
let go (without a second write, from the start of the wait): each look has what is left of them, at
most five seconds, none starts once they are over, the pause between looks ends with them, and a
failure no look saw by then is none. The page's first failure
must be the one expected, said after the wrapper cut (or gave) the body, on the form that sent the
held write: each failure the page says
is recorded with the wrapper's state at that moment and its target, compared with the form noted
as it submitted that write, so a failure said at the headers, before the body, or said on the
window or on another form, does not count as the body's.
The check that a navigation leaving a write's patch before it is drawn reads the next page whole
requires the browser to have finished loading that write with the stand-in's answer for it (its
`requestfinished`, with the answer's own `smoke-write` mark, heard within five seconds of the press
of the form's button, the press and the finish taken by the same monotonic clock and judged by the
time the finish was heard, however late the click returns), and the held
script the patch asks for to have been asked within five seconds of that finish, the page's first
request for it heard after the stand-in handed the page the write's answer (before then the page had
no patch to name it; the page can have the whole body before the check hears the finish), before the case
presses the link, which it presses only once both are confirmed; and that page to show what the write
changed: its brand, and the section the patch draws,
which every page after the write draws too, drawn by that page's own section element and not by the
patch. The patch's element alone carries a mark, and a MutationObserver set before the write is sent
records whether that element ever enters the page, however briefly; the check fails if it ever did,
so a patch drawn for a moment and then drawn over by the page does not pass. The check that the next
navigation then reads `<main>` alone requires that section still drawn after it, and the patch's
element still never in the page.
These cases, the check that a write's patch answered before a navigation is drawn by that page,
the two checks of a write's patch to the layout beside another write's own page, and each case that
holds a script or write while it follows the link to `/smoke/quoted` close their page in a
`finally` too, all but the first after letting go of the script or write they hold; one cleanup
step that fails does not skip the next, and removing a route is
bounded to five seconds, so one that never settles does not keep the page open. Setting a route,
starting a page's notes of what it draws and listening for its failures are bounded to five seconds
each too, and so is each read of the page (an `evaluate` or a locator's, one made only for a
check's details included, and the one that asks whether the browser has the Navigation API), here
and in the page part, slow part and no-JavaScript post cases below,
so a read the browser never answers does not keep a case from its `finally`. Making a case's
context or page and closing its context are bounded to 30 seconds, Playwright's own timeout for an
action, since a loaded Firefox has taken over five seconds to close one. Each case makes its context
before its page, so it holds the context to close even if making the page never settles, and
closing one of its pages closes that page alone: if the context's close is not confirmed in time,
each of its pages is closed, bounded the same, and the case fails rather than waits. A context that
comes only after its 30 seconds is closed as it comes, the same way. The page these
checks make is closed by the helper that makes it if making it, its route, its load or its mark
fails, before a case holds it. The stand-in in front of them fetches, reads and sends each answer
within five seconds a step by the smoke's clock (a hold the case controls aside), and sends none
once its case has ended, which each case marks before it lets go of what it holds: the request is
aborted then, its context closing. A write counts as answered only once its fulfill is confirmed,
and each write's answer carries a mark unique to the page and the write (its `smoke-write`
header). A script or stylesheet a case holds is let through or answered within five seconds once let
go, and aborted once the case has ended; the check that a whole poll waiting for its stylesheet does
not replace the layout requires that stylesheet's answer sent and confirmed.
That check counts only the
reads of the page it goes back to, since the page that comes can prefetch the link left under the
pointer, and goes back only once the step before it saw the write answered once with its scripts
held and the link's page read whole and come, drawn with the brand the write changed
(`Watchlist, written`) in the document the page kept: otherwise it fails saying so, naming what the
page showed, since a return that
reads `<main>` alone shows nothing of a patch never left behind. The check that a page part's
answer that asks again takes the place of the page's tag needs an answer that asks: the write lands
1.5 s after it is sent and the part's first read comes
a second after the page loads, so a loaded browser can find it landed. A first read that finds it
landed is answered as the server answers one while it lands (its status line saying so, and a tag
asking again from the same address); the check requires an answer that asked, and every later read
is the server's. The first read's answer, whatever it found, is held until the case has read the
status line, filled the form and recorded the document and its history length, so no answer draws
before the case has what it compares it with. Setting the case up and loading the page can take
longer than 1.5 s too, and a
document that says `Saved.` asks for no part at all, so the document the case loads, if it finds
the write landed, is answered the same way (its status line, its head asking to be read again and
the tag asking again from the same address, as the server writes them while the write lands).
The tag the first drawn answer that asks again puts on the page has its address
moved, the moment it is drawn, to one the server reads the same, and the read after that answer's
must be made from the moved address: the read is made from the tag on the page, which a script may
change, not from the answer's own. The read after that answer's is the one the page sent next after
that answer's own read, by the log below, so a read at another address between the two fails it.
The case keeps one log of every read of `/alerts` the page sends, whatever its query: each part
read, each read of the page itself and each hover prefetch (the runtime's fetch of a link under the
pointer, which reads nothing again: it is named in the details and counted by no check), started
before the page is loaded; the document it loads is told from them by its own request, so a read
of the page sent before that load ends counts against "read again, not the page". Each part read
takes its place among the stand-in's answers as it reaches it, and its answer's status line carries
that place, so the check that the part stops counts only once the first answer to draw `Saved.`,
noted the moment it is drawn, is one that does not ask again, read once the first check's wait for
`Saved.` has seen it within its six seconds. It then requires no read of the page at all (a hover
prefetch aside) in the log after the one whose answer drew it, as the log stands when the check
looks, once 2.2 s have passed by the smoke's monotonic clock since the check read that note, so at
least 2.2 s since the draw; no wall clock of the page's or the smoke's is compared. A read sent
after the 2.2 s that is in the log by then counts too. The check that reading the part keeps the
document, its history entry and the form counts only once one of the case's answers to a part read
was drawn, by its mark as the page noted it drawing it (the first answer that asked again, or else
the first `Saved.`): a page that drew no part answer kept them by doing nothing, and fails it. Its route is
set and removed each within five seconds, and its route, request listener and init script on the
shared page are removed, and its observer in the page disconnected, however it ends, adding and
removing the init script each bounded to five seconds; the init script then does nothing in the
document it ran in, nor, by a switch the case sets in the page's session storage as it ends and
clears once the removal is confirmed, in a later one, and the route lets each read through once the
case is over, so neither acts on later checks if its removal is not confirmed. Each answer the
stand-in routes of these cases give (the part case's, the navigations', the reached page's part,
the whole reads', the held-read case's load and the failing read's 502) is fetched, read and sent
within five seconds a step by the smoke's clock (ten for the step that sets the leave-before-read
case's waits, which parses the answer in the page up to three times), and none is sent once its
case has ended, which the stand-in reads just before each step starts and again just before the
answer itself is sent: the request is then let through as it came, bounded to five seconds, as is
each request these routes let through without answering it. A step that fails or runs out aborts
its request; a fulfill sent whose acknowledgement does not come within its five seconds cannot be
taken back, and is reported as unconfirmed, not aborted. Either fails the checks that rest on it,
saying why. The check that a
page's part reached by the runtime's navigation is read again requires a part read of the reached
page's own address, and `Saved.` drawn by an answer to one of those reads, which a route of its own
marks as it answers them: a read of an earlier receipt's address draws the same `Saved.` in the
same status line. The wait for it has six seconds by the smoke's own monotonic clock from its start,
not Playwright's timeout, which counts from when the driver receives the command, so a delayed
command cannot stretch them; the evidence is the marked answer the wait saw in that time, not a
later look at the page. That navigation, as each of the leaving cases' does, counts only
if it drew its own `Saving...` within five seconds of its start by the page's clock, noted the
moment it was drawn; asking the page to navigate and reading that note are bounded to 15 seconds
each, so a draw in time does not fail because the note came back late. Each of these navigations'
own fetch, and that of the check that a page reached by the runtime's navigation reads itself again
in place, gets the server's own answer when that says `Saving...`, changed only by the mark the
fixture puts on its status line to tell the navigation's draw (and, for the whole-page check, with
its part templates taken out, as every read there is), and the case fails unless it carries the
server's read-again tags (the head's, and for a part, the part's reading again from the page's own
address), each waiting the page's one second. A tag counts only where a browser reads it: the
fixture parses the answer in the page as the runtime does (DOMParser for a whole read's page, a
template's `innerHTML` for a navigation's answer), never with a pattern over its text, so a tag in an
HTML comment or in the text of a raw-text element (`<script>`, `<style>`, `<textarea>`, `<title>`)
is none. The head's tag is a `<noscript data-corten-read-again data-corten-head>` in the page's
`<head>`, or, in a navigation's answer, which has none, one of its top-level elements; its wait is
read from it and from each `<meta http-equiv="refresh">` in it as a browser without JavaScript
parses it. These are read first; then the fixture takes out what the runtime takes out before it
draws `<main>`, in its order: it empties every `<noscript>`, cuts a whole page to what a
navigation's answer holds, and takes out the top-level layout elements that are the page's
(`data-corten-page`), the title and every `data-corten-head` element at any depth, which the runtime
moves to the head. The part's tag is the `<template data-corten-read-again data-from>` left after
that, which the runtime reads in `<main>`: one inside a `<noscript>` or a `data-corten-head` element
is none. A fixture never supplies or repairs the server's read-again tags or waits. Only when the write has
already landed, and the server says `Saved.`, does the stand-in answer as the server does while it
lands. Only the leave-before-read case changes the server's tags: once they are found waiting one
second, it sets those waits to its own longer one, changing nothing else. It finds where each wait
is written by parsing the answer again with each quoted wait or `content` value replaced by a mark
of its own, sets only the places whose marks the found tags carry, and parses the result to confirm
the same tags each wait its time; an answer whose waits it cannot trace so is passed on as written
and fails the case. The check that a page reached by the runtime's
navigation reads itself again in place then requires `Saved.` drawn, at the navigation's address, by
the answer to one of the page's own reads of that address sent after the navigation's fetch, which
the route marks as it answers them (a `Saved.` another receipt's read drew is not this page reading
itself again), seen within six seconds by the smoke's clock as above, and the check that each read
replaces the history entry counts only once that read's answer is drawn. The check that a page at a
place (`#alert-status`) reads itself again has the page's load of its receipt answered still saving
whatever the store says by then, so a write that landed before the load cannot pass it, and
requires `Saved.` drawn at the place by the answer to a later read of that receipt within six
seconds of the load's start the same way: with the Navigation API, the runtime's read in the document the case loaded
(a full load of the receipt is not the page reading itself again in place); without it, a load of
the receipt, drawn in a document the tab made after the case's own by the count below (`Saved.` a
fetch drew in place does not pass for it). That document is told by an init script added before the load, which numbers each
document the tab makes from then on in the order they are made (a count in the page's session
storage, which a reload keeps). With the Navigation API, the document once the load returns and once
the wait ends must both be the first, so a full load at any moment after the case's own, even one
before Playwright's load returns, fails it. The init script and its count are removed however the case ends, each bounded to
five seconds. The check that a page waiting for a write stops once it no longer asks, after a full
load, marks each answer to a load or read of the receipt with its place, and answers its first load
still saving whatever the store says by then, as the place case's is, so a write that landed before
the load cannot leave the page nothing to read again. An init script added before the write is sent
notes in the page's session storage, the moment each is drawn, the first status line the page draws
(which must be that load's own `Saving...`, not a later look once the load returns) and the first
answer the page draws `Saved.` from: it requires that note, read once the wait for `Saved.` has seen
it within six seconds of the load's start, to name an answer to a read of the page after the case's
load, not the load's own: the runtime's read of the receipt or a load of it, never a prefetch, whose
answer the route marks too but which reads nothing again. All three of the case's checks require
that answer. It also requires no read of the
alerts page after that answer's own request in the log of the page's requests, as the log stands
once 2.2 s have passed by the smoke's monotonic clock since the check read the note, so a read sent
between the draw and the check's look counts against it. That the page read itself again in the
same document is told as the place case's is, by an init script added before the load that numbers
each document the tab makes: the document once the load returns and once the wait for `Saved.` ends
must both be the first, so a read again that loads the page in full, even before Playwright's load
returns, is not taken for the load's own document, and it requires the same note of `Saved.` from a
read after the load, without which a document that stayed the first says nothing. Its route and
request listener are removed however its cases end, each removal and each read of the page
bounded. Wherever a case other than the check that navigating away stops the reads (below) leaves
by the header's link and then requires no further read for a while, the press and the wait for
News are each bounded to 30 seconds by the smoke's clock, and sending the alert until it says
`Saving...` in the patch cases shares one budget of 30 seconds, checked as each of its steps starts,
so none starts once they have passed; a driver that never answers ends the run with its reason
rather than keeping the case from its cleanup. Every other driver action the cases of a page reading
itself again, of a patch's reads (its refusals included), of a write's own page and of the held slow
part make before a check or its cleanup (a click, fill, key press or load) is bounded the same way
to Playwright's own 30 seconds, every read of the page to five seconds, and each driver wait to its
own time by the smoke's clock. The check that navigating away stops the reads is the exception: its own
page operations have no bound by the smoke's clock (the whole-read route's exchange it shares and that
route's removal keep theirs), as they were before these bounds, its navigations, press
and waits under Playwright's own timeouts, its 2.2 s by Playwright's timer, and its reads of the page
(`page.evaluate()`, the write it sends among them) under no timeout, so a page that never answers one
keeps the case from its cleanup, until [#2217 The News leave smoke case ("navigating away stops the reads") needs a deterministic press and a request-identity check](https://github.com/corten-run/corten/issues/2217) reworks it. Where a check rests on a wait, that wait must come in its time,
so one whose answer comes late or never counts as one that did not come: each wait for `Saved.` (six
seconds, required by every check that waits for it), the `Saving...` a submit draws
before its `Saved.`, and a refused field's mark (five seconds), which must also still be on the
field in the sample the check reads. Three rules keep such a wait honest: what the
check relies on is observed by a listener, route or note in the page installed before the press
(or load) that leads to it, never sampled before it is installed (the page notes a `Saving...` the
moment it is drawn, armed before the key press, so a `Saved.` drawn soon after does not hide it); a
wait for what a press causes is started, or its note armed, before that press, not after the
driver's action returns; and its time is counted from just before the press or load, not from
when the action returned, so a slow driver does not stretch it. The waits for `Saved.` after a
runtime navigation start once that navigation's own draw is confirmed, which the page times by its
own clock (above). A write's own page case presses its link onward only once every step its check
rests on came in time, and the held slow part's link is pressed only once the part showed it; other
cases may go on to a later press after a check failed, to report the checks that follow, and those
rest only on what they observe after that press. The other waits in these cases only end a look, and the check
rests on what is read after them or on what the page or the route recorded: a navigation's own
`Saving...`, which the page notes by its own clock (above), a removal's `Saving...`, which the page
notes with the time it drew it by its monotonic clock (`performance.now()`, which a step of the wall
clock does not move) and which must come after, and within five seconds of, the press as the page
notes it on that clock (the first `click` on the removed alert's own Remove button, told by its
form's alert id and heard by a listener armed before the press and removed as the case ends, an
arming the page runs only after that removal doing nothing, not the time it was armed nor a click
elsewhere), however late the arming or the click returns, with the
list after the removal the list before it without that alert, in order, and the held slow part's busy, done and
failed marks, read once each wait has come or run out. The terminal-patch quiet check marks only a
successful `corten-patch` answer with `Saved.` and no read-again tag. An observer armed before the
press notes the first `Saved.` draw, which must carry the mark of a part read at the address named
by that press's POST answer. The page records the press and the draw on its own monotonic clock:
the draw must follow the press within six seconds even if the driver acknowledges it later. The
check waits 2.2 s once it has that note and counts every read logged after the marked request,
including any sent before the check read the note. The check that navigating away stops a
patch's reads holds the first part read after the write's press, taken within five seconds of the
press by the time the route heard it. The hold and the log match the same alerts part reads,
regardless of query. The held read must be first in that log from the press on, and must read the
address named by the press's own POST answer.
The route fetches and holds its answer until the page has left for News. That answer must ask
again, since a terminal one (`Saved.`, no tag) ends the reads whether or
not the page left: it is the server's own while that says `Saving...`, or, once the write has
landed, the stand-in's answer as the server's while it lands (`Saving...` and a tag asking again
from the read's own address after one second). The fixture requires a 2xx answer with
`corten-patch`; the runtime accepts same-origin `corten-patch` answers regardless of status.
The route parses the answer in the page as the runtime parses a patch, confirming that it asks again
within 15 seconds of the read reaching the route; one that does not ask again is
never sent, and fails the check. The held read must still be under way as the departure starts (the
check has heard it neither finish nor fail, and the route has sent nothing for it) and when the press
of News reaches the page: a wrapper of the page's `fetch` gives each alerts part read its own
`smoke-note` id and notes whether it has settled. The check uses only the note matching the held
request's id, never another fetch of the same address. A window listener in the capture phase
saves the notes to `sessionStorage` on the first click on the link to News, before the page acts on
it, for News to read. Which departure to expect depends on whether the case's page exposes
`window.navigation`, not on the engine's name. With it, News must be drawn in the same document.
When the route lets the answer go, the browser must finish loading that exact request with it
(its `requestfinished`, with the answer's own `smoke-held` header) within five seconds of the
release, by the time the check heard it. Without the API, News must be a new document, and
the old page must record the held fetch's own `smoke-note` as still pending at `beforeunload`.
The failure must be heard after the departure started, no later than five seconds after the
driver's News title wait returns, and before the answer is let go, so a read that failed in the old
document before unloading, or one ended by the route's own release or abort, is not taken for the
departure's. In either case, an observer checks the nodes added in each mutation record, including
their descendants, for the held answer's marked status line in News. Inserting and removing the
line in one task still counts. No part read may follow the held one in the log as it stands 2.2 s
later, nor the held answer ever enter the News page. In Chromium, run the smoke with
`SMOKE_PATCH_DEPARTURE_FAULT=wrong-first-read` or `SMOKE_PATCH_DEPARTURE_FAULT=transient-draw`
in the browser runner to make this check fail on purpose: the first sends a different part read
before the POST's receipt read, and the second inserts and immediately removes a marked subtree.
The check that a read the server
fails stops the reads takes as the press's read the first part read the check hears after the
alert's own POST, itself heard from just before the check asks for the key press on, so a part read
sent while the check fills or focuses the form is not taken for it. That read must be of the receipt
the press's own POST answer asks to be read again from (its read-again template's `data-from`, in
the answer at the end of the POST's redirects), so an earlier write's read answered 502 is not taken
for it. The answer is parsed in the page as the runtime parses a patch, its tag the last top-level
element with `data-corten-read-again`, and the `data-from` resolved against the page's base URL: a
tag in a comment is none, and the read's whole URL, origin included, must be the one resolved. It
requires that read sent within
five seconds of the press, counted from that same moment, and that read's own answer, with status
502, received in full (the browser finished
loading that exact request) within five seconds of that read being sent, each judged by the time
the check heard the browser's event (the request sent, and finished), not by when it looked, so a
read or an answer heard after its five seconds fails it however soon the check then sees it; only
then do its 2.2 s with no further read start, so a read still on its way cannot pass for one that
failed. Every same-origin part read of `/alerts` the check hears from the press on, whatever its
query (`?shown=2&saved=..` too), other than that one fails it. Its route and its listeners are
removed however it ends, each removal tried even if one before it fails. The slow part's reads
that a case holds unanswered are let go when it ends, once its route has stopped holding any, a wait
bounded to five seconds, after which its route is removed (bounded the same) and its page closed all
the same, as its request listener is removed. Each answer the slow part's routes give (a request let
through, a read aborted or held and let go, the empty patch below) is bounded to five seconds, and
the empty patch is not sent once its case has ended; a patch not sent fails its check. The first check of a held slow part looks at it only
once its load's read has reached the route, within five seconds counted from just before the load
(or, after a client navigation, the press of the link), judged by the time the route saw it; only a
read the route saw after that load or press began counts, not one an earlier document sent, and a
read seen in time counts however late the load or press returns: Firefox marks the
part busy as its fetch starts, which can be before the route sees it. The link a failed slow part
shows is pressed in the page too; the page it opens, at exactly the link's address (`/?picks=true`,
not another path with that query), must commit within five seconds counted from
just before the press, a budget the press task shares, and have its part read in within five
seconds of the check seeing that commit. A press that fails names its step: the press task finding
no link, failing or not returning in time, or the commit not coming in time or its wait failing. A
part not read in in time says whether the first request of `/?picks=true` after the press that could
be the navigation's (a load of the page, or a `corten: nav` or `page` read of it) was seen and, if
so, whether it was answered; another request with that query is not one. Nothing outside the
page ties a fetch to the navigation that made it, so it is named as that first request, not as the
navigation's own.
The check that a read whose patch leaves the part as it was marks it failed requires that load's
own read, answered by the route with its empty patch, and that answer's headers and its whole body
received without error (the response finished, and the request did not fail) within five seconds
from just before the load, since a read that fails, a body cut after its headers included, leaves
the same placeholder. It loads a fresh page of the same context, whose one document's read is the
one it waits for, so a late read of an earlier document of the held page is not taken for it, and
closes that page once its check is done, bounded to 30 seconds: its live streams would otherwise
stay open, and WebKit on Windows has only so many connections to the server across contexts, so the
read the failed part's link starts next could wait behind them and never be answered.

The account page's posts without JavaScript (the name, the refused name and the picture) each
press their button only once the page the previous post led to has loaded. That load, the post
being sent, its answer, the load of the page it leads to and the press returning share 30 seconds
counted from just before the first of them, the timeout each wait had alone before; a step that
fails, runs out of that time or settles only after it fails the post's check with the step that
did not happen, instead of stopping the smoke with a wait that timed out and no reason
([#2078 The no-JavaScript refused-name smoke case can lose its press under load and time out after 30 s with no reason](https://github.com/corten-run/corten/issues/2078)).
The post is the main frame's navigation sent as a POST after the press, and its answer and the
page that loads must be that request's own (the page the last of its redirects brought), so a click
that returns only after its post was answered is named as that, not as a press that sent nothing.
No later post is pressed once one has failed or the check of what it did has, so a post never
starts from a page other than the one its check names. Their context is closed in a `finally`,
making it and closing it each bounded to 30 seconds and setting its cookies to five.

The watchlist's first-change-after-a-link field check starts on `/smoke/quoted`, which has the
same shell key as `/smoke/fields` and no field arguments. `/news` has another shell key, so a
link from it loads the document in full instead of swapping the page. A visible control on that
full load can precede its scripts, when events correctly get the browser's default. The check
holds the field module's response, verifies that the control is not inserted while it waits,
then checks the first change and that the document stayed the same. Its five-second output
bound is unchanged.

## Cluster integration tests

`corten-cluster`'s tests run against real Postgres and NATS JetStream when two variables are
set, and are skipped otherwise (`$checkout` as in [Checks](#checks)):

```powershell
$checkout = Split-Path -Leaf $PWD
docker network create corten-test
docker run -d --name corten-test-pg --network corten-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=feeds postgres:19-alpine
docker run -d --name corten-test-nats --network corten-test nats:2-alpine -js
docker run --rm --network corten-test -v "${PWD}:/src" -v corten-cargo:/usr/local/cargo/registry -v "corten-target-${checkout}:/target" -e CARGO_TARGET_DIR=/target -e CORTEN_TEST_DATABASE_URL=postgres://postgres:postgres@corten-test-pg/feeds -e CORTEN_TEST_NATS_URL=nats://corten-test-nats:4222 -w /src rust:1-trixie cargo test -p corten-cluster -- --test-threads=1
docker rm -f -v corten-test-pg corten-test-nats
docker network rm corten-test
```

The standard command skips the opt-in TLS regression. To run it, keep
`CORTEN_TEST_DATABASE_URL` set to Postgres and `CORTEN_TEST_NATS_URL` set to a known-good
plaintext broker. Also set `CORTEN_TEST_NATS_TLS_URL` to a `tls://` URL for a TLS-enabled
JetStream listener whose certificate matches the URL's host, and `CORTEN_TEST_NATS_CA_FILE`
to its CA PEM file (mount it and use its container path if running in Docker). With all four
variables available to the test process, run:

```text
cargo test --locked -p corten-cluster a_cluster_client_with_a_root_ca_requires_tls -- --nocapture
```

This checks that the client refuses plaintext with a CA configured and delivers a committed
feed patch over TLS. It does not test TLS discovery or failover.

Set `CORTEN_TEST_NATS_CAPPED_URL` to a separate JetStream broker configured with
`max_subscriptions: 3` to also check that the relay retires a partially acknowledged batch
after reconnecting with a 64-entry subscription queue.

The failover benchmark is `node examples/listings-feed/bench/run.mjs`; see its header.

## Benchmark results

A normal full clone fetches every version of a committed file still reachable in history, even
after a later commit deletes it, so a benchmark commits its evidence, not its raw data. Committed evidence is the report, the provenance
and, where it is small and approved for public disclosure, the summary: small enough to diff and
review. A summary or other file left out is recorded in the provenance by its SHA-256. Raw data (per-request logs, traces, captures, a
round's archive) stays outside the tree. A maintainer chooses where it is kept and publishes it
there, and the committed provenance records a locator it can be fetched from and its SHA-256. A
digest alone is not a locator: it checks a copy but does not say where one is (a group result's
`provenance.json` records the digest as `archiveSha256`).

A benchmark's `.gitignore` keeps part of its default raw output out of `git add`, not all of it.
`bench/fullstack` ignores a round's packed `raw.tar.xz`, but not the loose raw files of a round
not yet packed; `node bench/fullstack/pack.mjs <round>` packs them and prints the archive's
SHA-256, and does not publish it or write the round's `raw.txt`. `bench/live` and
`bench/recoverable-live` ignore the gzip files `parity.mjs` writes under their `results/`,
leaving its `coverage.json`, `plan.json` and other JSON visible. Catalog and Marketplace ignore
their results directories. An output path given explicitly is used as given.

`npm run check` runs `scripts/bench-size.mjs`, which keeps raw data out of what a pull request
merges. It does not publish, fetch or verify an archive.

1. A file under `bench/` whose name ends in `.tar`, `.tgz`, `.gz`, `.xz`, `.zst`, `.bz2`,
   `.zip` or `.7z` (in any case), or that is larger than 256 KiB, fails unless
   `scripts/bench-size.allow` lists its path with its exact blob ID. The name is matched, not the
   contents: an archive under another name is not found by the check, and review has to.
2. The list holds the files that were in the tree when the check came. They stay where they are:
   removing one at the tip shrinks no full clone, since its blobs stay reachable in history, and
   their paths are cited. The list only shrinks: each line must be in the base's list at the same
   path and blob, so a new or changed line fails, even in the pull request that adds the file. The
   one exception is the list's first appearance: when the base has no list, each line must name a
   file already in the base's tree at that path and blob. A listed file that changes
   fails, and a line whose file is gone or no longer needs it fails until the line is removed.
3. Every commit the pull request brings is checked, not only its last one, since a merge commit
   keeps them all: a file added in one commit and deleted or shrunk in the next still fails, and
   the problem names the commit.
4. A dependency lock file larger than 256 KiB is source input, not output. It passes only at a
   path listed in `LOCKS` in `scripts/bench-size.mjs` (today the Fullstack Laravel and Nuxt locks
   and the Live Laravel lock), and only when it and the manifest `LOCKS` names are regular files
   in the same directory of the same commit (a directory, submodule or symbolic link named like the
   manifest does not count), in every commit the pull request brings that changes either of them.
   A listed lock may change blob, as a dependency update does, without an edit to `LOCKS`. Any
   other lock file over the limit fails until its path is added to `LOCKS` in the script, where
   review sees it: a file named like a lock beside one named like its manifest proves neither that
   it is a lock nor that an app builds from it.
5. A path under `bench/` that is not valid UTF-8, has a control character (a newline or a tab
   among them) or has a name starting or ending with white space fails as unsupported.

The base is the commit the change merges into: `--base <revision>`, else `CORTEN_BENCH_SIZE_BASE`,
else the merge base with `origin/main`, also when the checked commit is a merge commit: a topic
that has merged `main` keeps its own earlier commits behind its first parent, and they are part of
what it brings. For a topic aimed at another branch, give that branch with `--base`. An all-zero base, which GitHub gives a push that creates a branch or tag (a release
tag's first push among them), means the merge base with `origin/main` as it is when the check
runs. That is not a replay of the range the push brought: a rerun after `main` advances can check
a different range, a tag on a commit already on `main` checks its tree with no history, and a push
that creates `main` itself has none. A release needs green CI on the exact commit before it is
tagged ([RELEASING.md](RELEASING.md)), which is its history check; the tag's check is in addition. CI gives the base from its event rather than let the script guess:
a pull request's merge commit's first parent, and a push's `before` (after a push to `main`,
`origin/main` is the pushed commit, so its merge base would check nothing). In GitHub Actions the
check fails without one, and so does the CI step for an event it has no base for. A shallow clone
fails too, since the commits it lacks would go unread: fetch the whole history
(`git fetch --unshallow`). When no base resolves, the check fails and says how to give one.

## Pull requests

For nightly performance evidence, use the [marketplace v2 procedure](bench/marketplace/nightly.md).
Official `rN` rounds start at r17; `wN` stays for development. Require capability evidence for
every candidate in the reserved [framework group](bench/marketplace/nightly.md#framework-groups),
and both sources and every browser/content profile for each admitted app before load.
The nightly suite measures CPU, memory,
load and cold start only, with three short-window passes (`--duration 15 --warmup 10 --rate 150`)
on a dedicated c-8, app CPU 1, upstream CPUs 2-3 and load CPUs 4-7, or on several such droplets
when a [split round](bench/marketplace/nightly.md#split-rounds) is worth launching. Per source and
pass, time one page profile cycling through `en-US`, `fr-FR`, `de-DE`, and one neutral JSON profile.
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
   1. Work done in process (rendering, serialization, a handler's own code): instructions per
      request under callgrind (`valgrind --tool=callgrind`). Count a test that sends 1,200
      requests through the router in process with `oneshot` and one that
      sends 200: the difference over 1,000 leaves out startup and setup. Over a real socket,
      `bench/fullstack/count.mjs` counts with `perf stat`. A count barely moves with other load
      on the machine, so it shows a difference of a few percent that times on a laptop or
      Docker Desktop hide. Reading JSON: `read_cost` in `examples/card-market` reads the
      fixture's 500 item API responses once each, and its doc comment gives the command.

      For work around the handler (routing, middleware and other stages, headers read or
      written, future sizes, allocations or copies per request), give the instruction count
      **and** cycles per request under equivalent load on a quiet Linux bench host.
      For changes exercised by the catalog item page or item JSON, use
      [`bench/fullstack/count.mjs`](bench/fullstack/count.mjs) with target `page` or `json` and
      one repeat per invocation (`node bench/fullstack/count.mjs <round> 1 <app> <target>`).
      Use a fresh round name each time and tag each build in turn with the image name the script
      expects. Otherwise, measure the affected route with an equivalent under-load test; an
      unaffected route does not count. Alternate the two release builds, verify the response bytes
      and headers before measuring, and report any failed requests.

      Compare the change in **user plus kernel cycles per request within each pair** against
      the smallest worthwhile reduction, declared before running. A run's plan, with everything
      item 2 has declared before a run, is declared when it is posted on its pull request or
      issue, or pushed under a tag, and names the commits it reads (a change's base and head); a
      plan older than this sentence on `main` is declared as it was. Report the number of pairs,
      best, median and range, and the per-pair changes. Report the user and kernel split and,
      when adding or moving code, user L1 instruction-cache misses per request as diagnostics.
      The counter records perf's running percentage and requires a reported 100% for every
      counter it uses. Do not claim a CPU-cost win if either cycle count is missing or unusable
      (`null`) in either build, or if the bound on the paired changes does not establish the
      predeclared margin. Say what the run did not resolve. Retired instructions measure work,
      not speed; fewer cycles per request show lower CPU cost, not lower request latency.

      The no-regression margin is separate from that smallest worthwhile reduction: a workload the
      change should leave as fast as it was is held to +1%, declared before the run. Read on one
      build of each side, if the one-sided 95% upper bound on the median per-pair change in user
      plus kernel cycles per request is under +1%, the margin is met. If it is at or above +1%,
      the margin is not met, with one exception, for a negative control: a workload the run's
      plan (its `margin.md`) names before the run as one whose code paths the change does not
      touch, with the reason, which the pull request's review accepts. A workload the change
      touches is held to +1% with no floor, however flat its instructions, and so is a workload
      not named so before the run; a declaration is never added or changed after a run to clear
      its result, and a plan that made +1% decisive before this exception existed stays bound by
      it. This single-build reading and the CPU-win rule above do not decide a touched workload
      whose single-build bound's distance from its threshold is inside its recorded placement
      spread or, where none applies, the default band, or one read across placements; both are
      decided as described below.

      A negative control whose bound is at or above +1% but under the layout floor that applies
      to it may go ahead when its user instructions pass a screen: the median of the paired
      changes in user instructions per request is between -0.02% and +0.02% and its one-sided 95%
      upper bound is at or below +0.02%, compared unrounded. The pull request reports it as
      "missed +1%; placement and regression not distinguished", not as having met the margin or
      as unchanged speed, with its user and kernel split. This is a screening rule, not an
      equivalence test: it does not show that the control's instructions or CPU cost are
      unchanged. The exception never covers a bound at or above the floor or a regression other
      evidence corroborates, and does not replace the affected-route measurement above or the
      memory and waiting measurements below.

      A floor applies to a negative control in one of two ways; with neither, the control is held
      to +1%.

      The recorded floor, +1.62% ([design Choice 71](docs/design.md#choice-layout-floor)),
      applies to one workload, the one it was calibrated on: `plain`, a `GET /private` with no
      request header of its own to the probe app the Choice names, answered `200` with the record
      page for one visitor. It applies to no other workload or request, and only to a run that
      records a setup matching the calibration's in every item below. Any VM counts if it matches;
      a difference in any item means no recorded floor.

      1. CPU: Xeon Platinum 8358, one thread a core.
      2. Kernel: Linux 6.12.117 (Debian's `6.12.117+deb13-amd64`).
      3. Allocator: jemalloc 5.3.0 by `LD_PRELOAD=libjemalloc.so.2`, with
         `MALLOC_CONF=background_thread:true,tcache_max:65536` exactly: the starter image's
         setting when the floor was measured. The image now sets 512 KiB
         ([design Choice 23](docs/design.md#choice-jemalloc-image)), and a run with that has no
         recorded floor.
      4. Pinning: the server on one CPU, the load on two others and the driver and `perf` on a
         fourth, all four distinct.
      5. Build: rustc 1.100.0 and LLD 23.1.5; the probe built as the receipt's `build.sh` builds it,
         with the repository's release profile (`opt-level = 3`, thin LTO, one codegen unit),
         features `json` and `compress`, and zstd linked to the system's `libzstd`
         (`ZSTD_SYS_USE_PKG_CONFIG=1`); the same third-party crate versions as the receipt's
         `probe/Cargo.lock` and Debian's `libzstd1` 1.5.7+dfsg-1.
      6. Load: `wrk` 4.1.0 with `-t2 -c64` and 3 s turns; every turn, warm-up included, on a
         freshly started build; the two builds' order turned every pair; 100 recorded pairs after
         one that is not; the bound the 59th of the 100 sorted per-pair changes.

      Any other negative control, and `plain` on any other setup, gets a floor only from its own
      A/A layout control in the same run, under the run's protocol and measured on each negative
      control whose miss it would waive, named in the run's plan before the run and built from the
      candidate's base commit with the candidate's build inputs. On each such workload it makes
      three comparisons: main
      against main built twice, and main against main with each of the receipt's two pads (one
      never-called function of 40 bytes, and one of 3,100 bytes, `variants/pad40.diff` and
      `pad3100.diff`). Each is 100 recorded pairs after one that is not, read with the
      candidate's statistic: the one-sided 95% upper bound on the median per-pair change in user
      plus kernel cycles per request, the 59th of the 100 sorted changes. A comparison with fewer
      than 100 valid pairs gives no bound, and the control gives no floor. If the control
      qualifies, the larger of its two pad bounds on a workload is that workload's floor if it is
      at or below +2%. A layout bound above +2%
      gives no floor, not a floor of +2%: that run holds every workload to +1%. A negative control
      without its own qualifying A/A in that run is held to +1%.

      A layout control, the recorded one or a same-run one, qualifies only if the run records that
      it passes every check below. If any check fails, the control gives no floor and the run
      holds every workload to +1%.

      1. Each comparison's two builds answer the workload's request with byte-identical status,
         headers but `Date`, and body, compared with only the `Date` header removed. (The
         recorded control passed this as its kit compared, with more normalized; the Choice says
         why that is accepted for its receipt alone.)
      2. Main built twice is byte-identical and meets +1% on that workload.
      3. The pad is present in the padded binary and moved code: the count of function symbols in
         both binaries whose addresses changed is above zero.
      4. Every counter ran 100% of every turn, and the load tool reported no error in any turn.
      5. Each pad comparison passes the user-instruction screen above, as a candidate must: its
         median between -0.02% and +0.02% and its bound at or below +0.02%.

      A layout floor never applies to the benefit side: it cannot establish a CPU-cost win, which
      the rule above decides as before.

      A workload the change touches may instead be read across placements, when the run's plan
      names it before the run with the numbers below
      ([design Choice 72](docs/design.md#choice-placement-runs)). Builds of one commit whose code
      sits at different places have differed by up to about 4% in a touched request's cycles
      either way (one start each, so placement and the process's start were not told apart there),
      so a single build of each side can pass or miss +1%, or show a CPU-cost win, by where the
      linker put the code. That Choice
      records a placement spread for a workload (the lowest and highest placement median of its
      A/A across placements, as the Choice prints them to two decimals) and the setup it was
      measured on. A spread applies only to a run that matches that setup in each of: the probe
      program and its features, the workload's request and the configuration it is sent to, the
      allocator, its settings and any other library preloaded beside it, the turn protocol (every
      turn on a freshly started build, the
      server, the load and the driver with `perf` each pinned to CPUs of their own, `wrk -t2 -c64`
      and 3 s turns) and the CPU model (each recorded spread names its own: a Xeon Platinum 8358
      for the first run's two, an 8280 for the second's one). A
      run that differs in any has no recorded spread for the workload
      until a placement run on its setup records one, and is tested until then against the
      **default band**: from the lowest low end to the highest high end among the spreads the
      Choice records, as the Choice prints the band on `main` when the plan is declared (-2.98%
      to +3.33% today), whatever a later run records and whatever reads the workload,
      `bench/fullstack/count.mjs` as much as a probe. The test is one: a single-build bound's
      distance from its threshold (the bound less +1% for the margin; the bound plus the smallest
      worthwhile reduction for a CPU-cost win) is **inside** the spread that applies, or the
      default band where none does, when it is at
      or above its lowest and at or below its highest, and **outside** otherwise. Inside
      does not decide, a pass as much as a miss, and a win no more than a loss: the pull request
      reports it as "inside the placement spread: not decided" (or "inside the default band"),
      which does not pass and claims no
      win, and reads the workload across placements in a run whose plan is written before that
      run. Outside, the single-build bound is
      the reading by the rules above, binding by policy, not because placement is shown unable to
      move it. Each threshold a plan declared for a workload, its margin and a reduction, is
      tested on its own distance: one outside stays as one build read it, whatever a placement
      run then reads, and that run reads only those left inside.
      A workload with no single-build bound (a run that failed, too few pairs)
      does not pass, as before, and a control the plan declared keeps
      [design Choice 71](docs/design.md#choice-layout-floor)'s rule. Item 2's other requirements
      apply to a run read across placements as to any other: every counter at 100%; the user and
      kernel split and, when the change adds or moves code, user L1 instruction-cache misses per
      request, reported across placements as cycles are; and the affected-route, memory and
      waiting measurements. The plan states:

      1. Placements: each side is compiled once, and its K placements are that build's final link
         run again with one more object, a function of a declared size that nothing calls (a pad),
         placed first in `.text` by `-Wl,--symbol-ordering-file`, so every other function moves by
         the pad and keeps its order and its neighbours. The plan lists every such pad's size,
         spread across the phases of a 64-byte line and a 4 KiB page and up to about 40,000 bytes.
         Placement i of the change is base with pad p_i against head with pad p_i. Before
         anything is measured, the run records that the link run again without a pad is
         byte-identical to the build's own binary; that each placement has exactly that binary's
         functions and the pad, the pad first, every function moved by exactly the pad's size (so
         the placement has the line and page phase the plan declared; with code aligned beyond 16
         bytes on either side, the fifth point's check instead) and every pair of neighbours
         still next to each other in order; that each placement of one build has a SHA-256 no
         other placement of that build has (base and head at one pad may be one binary, when the
         change compiles to the same code); and that each answers the workload's requests as the unpadded binary does: status, headers but
         `Date`, and body as received, with nothing in the body masked and only the header values
         the plan names masked, each one that differs between two starts of one binary (a keyed
         `ETag`). A header value the workload's cost depends on, as `kept`'s depends on `Age`, is
         masked for that comparison only if it can differ between starts, and is then checked
         separately against the value or range the plan states, not accepted as any number.
         The run also records, from the unpadded link's map, what the fifth point asks of every
         run, with code aligned beyond 16 bytes or without.
      2. Pairs: R recorded pairs per placement after one that is not, every turn on a freshly
         started build, as above, so a placement and a process start are told apart.
      3. The statistic: per placement, the median of its R per-pair changes in user plus kernel
         cycles per request; across placements, the median of the K placement medians and its
         one-sided 95% upper bound, the j-th smallest of them, j the smallest rank with
         P(Binomial(K, 1/2) >= j) <= 5% (the 20th of 30, as the 59th of 100 is for pairs). K is
         one that has such a rank, at least 5. Its 95% is nominal: it holds if the placement
         medians are independent draws with a common median, and the plan's pads are a declared,
         phase-balanced set rather than a random sample of the builds a change can land in, so
         the bound reads the change across those placements, not across every placement.
      4. Resolution: the same run reads an A/A on the workload: the change's base commit against
         itself, compiled once with the change comparison's build inputs and run with its probe
         program, workload and load inputs, with the same K, R and statistic, base with pad p_i
         against base with pad q_i from a second list of sizes, no size in both lists, chosen so the
         pairs themselves differ in phase: across the K pairs, the 64-byte-line phases of p_i and
         q_i (each size mod 64, in steps of 16) take all 16 ordered combinations (K distinct ones
         when K is under 16), and q_i - p_i mod 4096 takes K distinct values, at least
         floor(K / 8) of them in each quarter of a page, which the plan lists and the run
         records. The A/A is read twice from the same pairs: as recorded, and with its lists' labels swapped (each
         per-pair change B / A - 1 read as A / B - 1), since a list whose placements happened to
         run faster would lower one reading's bound and raise the other's. Its bounds in the two
         readings are what the run can resolve, and its lowest and highest placement median as
         recorded are the spread the Choice records for the workload, if the plan declares
         before the run that it records one. If either bound is at or
         above +1%, the workload is **not resolved**, and not resolved does not pass, whatever the
         change's own bound. Only a complete, resolved A/A records or replaces a spread, through a
         pull request that changes the Choice; a run reads the spread recorded in the Choice on
         `main` when its plan is declared, whatever a later run records.
      5. Nothing about code aligned beyond 16 bytes, which the run records and checks. C code a
         dependency compiles can align input sections of `.text` to 32 or 64 bytes, and a pad can
         then move some functions, and the data after `.text`, by other than its size
         ([design Choice 72](docs/design.md#choice-placement-runs), which has the condition for a
         pull request with such code whose placement runs predate this point). In every placement
         run the unpadded link the first point compares with the build's own binary is made with
         LLD's map (`-Wl,-Map`). Before anything is measured, the run records from that map, and the
         pull request reports, each input section of `.text` aligned beyond 16 bytes, in order with
         its alignment, and every symbol the map lists in `.text` from the first of them on (the
         side's list of functions: the map gives a symbol no type), by symbol, archive and archive
         member, or object file where it is in no archive, as the map names them, less directories;
         each side's map is kept with the run's results. A run whose plan was declared before this
         point was on `main` is read by the rule as it then stood, and any other without that record
         has no reading across placements. A plan may not build the C code with flags chosen for
         the measurement that leave no such section, to be read under the first point alone. Where
         either side has such a section, the rest of this point holds for both, in the change
         comparison and the A/A; a pilot, an A/A with a plan of its own, is held to it by what its
         own sides show.

         Every placement then has a second pad, whose size no plan lists: a function nothing calls,
         aligned to 16 bytes, that the ordering file does not name and the link line gives last, so
         it is laid last in `.text`. One rule sizes it: `.data`'s offset in a 64-byte line is the
         unpadded link's plus the first pad's size, mod 64. The run links each placement with second
         pads of 16, 32, 48 and 64 bytes, keeps the smallest whose map shows `.data` there, and
         records a line a placement with that size and `.data`'s address.

         Each placement's measured binary is linked with its map, checked against the unpadded
         link's in place of "every function moved by exactly the pad's size": `.text` begins where
         it did and holds the first pad's section, of the plan's size, then the unpadded link's
         input sections in its order, each with its size and alignment, then the second pad's
         section, of one of the four sizes; in both links every input section begins at the first
         multiple of its alignment at or after the end of the one before it; every symbol of `.text`
         is in the same input section in both links, as far from its start; and `.data` is where the
         rule says. The first point's other checks stand, with both pads among a placement's
         functions and the first pad first.

         A side with no reading across placements does not pass and shows no win. A side has none,
         for any workload, in three cases: an input section of its `.text` is aligned beyond 64
         bytes; an input section whose name begins `.text.` and matches
         `\.(_R[A-Za-z0-9_.$]+|_ZN[A-Za-z0-9_.$]*17h[0-9a-f]{16}E(\.llvm\.\d+)?)$`, so ends in a
         Rust-mangled symbol (`_R...`, or the legacy `_ZN...17h<hash>E`), lies at or after the first
         section aligned beyond 16 bytes, or in another output section (Rust code under a name that
         is not mangled is not seen); or none of the four sizes puts a placement's `.data` where the
         rule says. The pads do not vary where a function on a side's list lies in a 64-byte line
         as they vary the code before it: from the first section aligned to 64 bytes on, a function
         is in every placement where the side's unpadded link has it, and one listed
         before that section, or on a side with none, is there or 32 bytes from there. That is a
         limit of the reading and refuses none: what one such place costs a request no reading says,
         and each side's list in the pull request shows which functions the limit covers.

      The margin stays +1% with no floor: the workload meets it when the change's bound across
      placements is under +1% and its A/A resolves. A placement that fails a check above, or has
      fewer than R valid pairs, leaves its comparison with no bound, which does not pass; no
      placement is rerun, replaced or dropped for its result. A layout floor never applies to a
      workload read across placements. A single-build run stays valid, and binding for each
      workload its plan read that way whose distance from its threshold is outside the spread or
      the default band, by the test above, or that had no spread that applied under a plan
      declared before the Choice on `main` gave a default band, which the band does not test
      (a control
      keeps [design Choice 71](docs/design.md#choice-layout-floor)'s rule): a placement
      run declared after it does not clear such a miss. The benefit side may use the same protocol
      if the plan declares it, with its smallest worthwhile reduction, before the run: a CPU-cost
      win then needs the change's upper bound across placements at or below minus that reduction,
      and its A/A's one-sided 95% lower bound (the (K + 1 - j)-th smallest placement median, the
      11th of 30) above it in both readings, and the A/A resolved as above: a run whose A/A is
      not resolved establishes no win either. The reading measures the change across the plan's
      placements, not the release binary, which has a placement of its own: the unpadded build,
      which no comparison the gate reads includes (the runs so far read it only in a
      diagnostic).
      A run of K = 30 placements of R = 8 pairs, for the
      change and the A/A on `kept` and an A/A on `plain`, takes about 2 hours on a c-8 (the first
      run: 99 minutes of turns after 2 minutes of checks, besides setup and builds). That size is
      the first run's, not one to assume: in the second run one of two A/As of that size did not
      resolve, its placement medians spreading 1.97% where the other's spread 1.17%, and the
      Choice works out, on a model of its own, that an A/A of 30 placements fails one of its two
      readings more often than not at the first figure and about one time in five at the first
      run's own. More placements generally narrow the bound wherever the spread comes from, though not
      at every step of K (the bound is an order statistic), and the plan
      sizes each workload's K before the run as the Choice says: from an A/A already read on its
      setup, workload and R that the Choice's checks find eligible, or, where there is none, from
      a pilot A/A at a K its own plan declares, read only for the spread of its placement
      medians, never with a change's comparison, whose turns are no part of the gated run. The
      kit's sizing gives the chance that an A/A fails at each K under two models, the normal
      model and a smoothed resample of the eligible A/A's medians: both are used when normality
      is not rejected, the smoothed resample alone when it is. The K the plan declares must
      itself meet 5% under each model used, for each workload it covers, and admit the pad lists
      above; when no K the pads allow does, the plan declares none and does not read that
      workload across placements, and it never takes a smaller K than the models ask. The size is
      that setup, workload and R's, not a constant (the Choice's fourth run took 100 placements on
      `old`, and its medians, at a standard deviation of 2.05%, give an estimated 69 by the
      smoothed resample, where the normal model, which they reject, gives 91); K = 30 is not to be
      used by default; and the run's own A/A still decides.
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
   A number cited in the repository's Markdown names the commit it ran on, in backticks. A commit
   no branch that merges will keep (a prototype's, or one on a branch remade before it merged) is
   pushed to corten-run/corten as an annotated tag `evidence/<name>` (usually the commit's short
   name) saying what it backs, since `npm run check` fails on a cited commit that is not on the
   checkout's history or under an evidence tag. The check runs on the pull request's merge with
   `main`, so a commit of the pull request's own passes there; a pull request that cites one is
   merged with a merge commit, which keeps it on `main`'s history, or pushes an evidence tag for
   it first, since a squash or rebase merge leaves it out.
3. Update the guide in `docs/guide/` that describes the behavior and add a file in
   [`changelog.d/`](changelog.d/) instead of editing `CHANGELOG.md`. Name it
   `pr-<PR-number>-<entry>.md`, using the pull request number, not the issue number, and a
   different positive integer suffix for each entry in the pull request. Before you have a PR
   number, use `branch-<unique-slug>-<entry>.md`. Pick a branch slug unique in this repository
   (lowercase letters, digits and hyphens; add the fork owner or another discriminator if needed).
   Say what changed for an app author in one to three lines and link the issue or pull request.
   Put measurements, reasoning and edge cases in the guide, pull request description or design
   Choice, not in the entry.
   Each file holds one top-level `- ` bullet: one to four spaces after the hyphen, then a
   paragraph of visible text. Indent continuation lines with spaces to at least the start of the
   first line's text. No blank lines or nested blocks. Start the bullet's text with
   `**Breaking:**` followed by a space for a breaking change.
   Use only single-line `[label](https://host/path)` links with a text label and a bare absolute
   HTTPS destination, without a title. Percent-encode any parentheses in the destination.
   These links work in both the pending file and the released changelog.
   Use emphasis and single-line code spans for prose; put literal brackets, angle brackets,
   backslashes, URLs, and link examples inside code spans. Do not use raw HTML, character
   references, images, or reference links or definitions. `npm run check` validates this format.
   It caps entries at 400 visible characters only in `branch-*` files and in numbered fragments
   for pull requests after [#1736 Keep changelog entries short and move released sections to their own files](https://github.com/corten-run/corten/pull/1736).
   Count Unicode code points, including spaces and
   emphasis marks, but not the bullet, Markdown indentation (ASCII spaces and tabs), trailing
   ASCII spaces, code-span delimiters, or link syntax and destinations. Each line wrap counts as
   one space. Count code-span contents after Markdown removes a matching pair of leading and
   trailing ASCII padding spaces from a span that is not all spaces.
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

Maintainers follow the [release policy and runbook](RELEASING.md).
