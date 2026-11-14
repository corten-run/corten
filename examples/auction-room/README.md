# auction-room

A live card auction. People sign in and bid on the same lots at once; everyone watching a lot sees
its price, its latest bids and the time left change as they happen, and a bidder who is outbid is
told on every page they have open, and no one else is. Bids are kept in SQLite and checked in one
transaction, so a bid below the price is refused even when two arrive together, and a bid sent
twice (a double click, a retry) counts once. A lot closes in the store, in the same lock bids
are written in, so its winner is the last bid it took. Each bidder may bid 20 times a minute, and
an address may fail to sign in 5 times a minute (so the house key cannot be guessed at speed).
Without JavaScript, bidding is a form and a lot's page reads itself again every 15 seconds while
the lot is open: often enough to follow it, and seldom enough that a bid being typed is rarely
lost to a reload.

Read it when several signed-in people act on the same thing in real time, or when your app keeps
its data in a database.

## Run it

From this directory:

```sh
HOUSE_KEY=<a long random key> corten dev     # http://localhost:3000
```

`corten` is the framework's command (`cargo install corten-cli`).

The example uses SQLx's `sqlite-unbundled` feature: install system SQLite **3.54.0 or later**
with its development headers, `pkg-config` and libclang before building. Older upstream SQLite is
affected by [CVE-2026-119375 / RUSTSEC-2026-0459](https://rustsec.org/advisories/RUSTSEC-2026-0459.html)
when opening a crafted database and WAL file. On Linux, `sudo sh scripts/install-sqlite.sh`
from the repository root installs checksum-verified upstream **3.54.1**; CI uses the same
script. The Dockerfile uses Bookworm plus that upstream system library, and copies the shared
library into its runtime image rather than using Bookworm's older SQLite. Other build and
deployment environments must supply a patched library too; unbundling alone is not a fix.

`Cargo.lock` still lists `libsqlite3-sys` 0.30.1, the FFI crate SQLx 0.8 requires, but its
`bundled` feature is off. Version-only OSV / `cargo audit` scans still report
RUSTSEC-2026-0459 for that lock entry: the advisory concerns the bundled C source, which this
example does not compile. This is an explained non-applicable finding, not a clean scan.
Check `cargo tree -e features -i libsqlite3-sys` for the absence of `bundled`, and run the
`system_sqlite_is_patched` test to check the library actually linked. Revisit this exception
when SQLx can use `libsqlite3-sys` 0.39 or later.

Or in Docker, from the repository root:

```sh
docker build -f examples/auction-room/Dockerfile -t corten-auction-room .
docker run --rm -p 3000:8080 -e HOUSE_KEY=<a long random key> -v auction-data:/app/data corten-auction-room
```

Open it in two browsers (or a private window), sign in under two names, and bid against yourself.
Sign in with the house key (`HOUSE_KEY`: set your own long random one so you know it) to end a lot
early from the house's page. The house runs the auction, so it does
not bid. Without a house key no one can sign in as the house.

| Variable | What | Default |
|---|---|---|
| `DATABASE_URL` | the SQLite database | `sqlite:auction.db?mode=rwc` (a file here) |
| `HOUSE_KEY` | what signs the house in | none: the house cannot sign in |

When it starts with no lot open, it adds six, ending 4 to 30 minutes later.

## Where things are

The routes and what each does are in the table at the top of [`src/app.rs`](src/app.rs).

| Piece | File |
|---|---|
| Sessions, lots and bids in SQLite; a bid's checks and write in one `BEGIN IMMEDIATE` transaction | [`src/store.rs`](src/store.rs) |
| What is live: each lot's standing, the lobby, each bidder's own notices (`watch` channels) | [`src/room.rs`](src/room.rs) |
| The routes; who is signed in (`Identify` for a bidder, a buyer and the house, with `Refused::sign_in`, `forbidden` and `unavailable`); the bid and sign-in limits (areas' middleware, `Refused::too_many`); the handlers; the task that closes lots | [`src/app.rs`](src/app.rs) |
| The layout with the bidder's notices, and the error page | [`src/views.rs`](src/views.rs) |
| The lobby; a lot's page, its standing and the bid form; the house's desk | [`src/views/`](src/views) |

Its browser test, with two bidders in two browsers: [`smoke.mjs`](smoke.mjs).

## What a real auction adds

1. Accounts with a password or a provider: here anyone may sign in as any name, so a name's
   notices and bid count are anyone's who types it.
2. More than one server process: the room is in memory, so each lot's changes would go through
   the database (Postgres `NOTIFY`) or a message bus to every process.
3. An end that moves when a bid comes in the last minute, so no one wins by bidding at the last
   second.
