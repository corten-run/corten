# What a request costs the server, over a socket

Three numbers for a change to the request path
([CONTRIBUTING.md](../../CONTRIBUTING.md#pull-requests), Pull requests, item 2), each read from a
small Corten app, the [probe](probe/src/main.rs), built against the commit being measured:

1. Instructions a request: everything the server process runs to read one HTTP/1.1 request off
   a keep-alive connection and write its answer, counted by callgrind.
2. Allocations a request: calls into the allocator, from a callgrind profile.
3. Memory an idle connection holds: how much the process's resident memory grows for each open
   connection, after one request, after three, or before any byte.

Nothing here is part of the workspace or of `corten`. The scripts are Node, standard library
only, and a POSIX shell.

## Which tool for which number

| Tool | What it runs | What its count holds |
| --- | --- | --- |
| [`crates/corten/tests/router_cost.rs`](../../crates/corten/tests/router_cost.rs) | The router in process, called with `oneshot`: no socket, no connection | Routing, the stages, the handler and the answer's body. Not reading or parsing the request, the connection's task, timers, or writing the answer. Use it for a change inside the router. |
| This kit | The probe as a server, one connection, under callgrind | The whole request as the process runs it: the read, the parse, the connection, the router, the write. User-space instructions only: callgrind does not see the kernel. Use it for a change to the connection or to anything a request passes on its way in or out. |
| [`bench/fullstack/count.mjs`](../fullstack/count.mjs) | A catalog app's container under load, counted by `perf stat` | User and kernel instructions and cycles of the catalog's item page or JSON. Use it when the change is exercised by those routes, and for cycles. |

A count from this kit is an instruction count, so it reads work, not speed: item 2 asks for
cycles under load as well for a change around the handler, and this kit does not give them.

## The cases

Each case is one request, sent to one of the probe's two configurations: `api`, an app with an
API and no pages, and `pages`, an app without an API. Both keep every `App` default.

| Case | Configuration | Request |
| --- | --- | --- |
| `get` | `api` | `GET /baseline11?a=1&b=2`: a staged route, typed query parameters in, a short `String` out |
| `post` | `api` | `POST /baseline11?a=1&b=2` with a two-byte `text/plain` body |
| `unstaged` | `api` | `GET /unstaged11?a=1&b=2`: the same answer from a route that says `unstaged` |
| `pipeline` | `api` | `GET /pipeline`: an `unstaged` route, `ok` out |
| `text` | `pages` | `GET /text`: `ok` out |
| `page` | `pages` | `GET /page`: a page of about 12 KB |
| `get-browser`, `text-browser`, `page-browser` | as above | The same with the seven header lines a browser sends with a navigation; the page is then compressed |

Every request has a `Host` line and nothing else it does not need. `count.mjs --depth 16` writes
16 requests at a time, as a client that pipelines does; the rows read that way are `pipeline`,
`get`, `unstaged` and `text`.

## Running it

On Linux, with the Rust toolchain, Node, `git`, `taskset`, valgrind, jemalloc (`libjemalloc.so.2`),
`pkg-config` and libzstd's headers. On Debian 13, or in the `rust:1-trixie` container with Node
added:

```sh
apt-get update && apt-get install -y valgrind libjemalloc2 pkg-config libzstd-dev
```

Build the probe against each commit to compare, one after another in one directory outside the
checkout, from a checkout that has the commits:

```sh
sh bench/request-cost/build.sh <commit> <directory>
```

[`build.sh`](build.sh) puts the commit's `crates`, `docs`, `README.md`, `Cargo.toml` and
`Cargo.lock` at `<directory>/work` and a copy of the probe beside it with that `Cargo.lock`,
builds it with the repository's release profile and leaves the binary at
`<directory>/bin/<commit>`. The probe's source is this checkout's, the same for every commit:
only Corten and its locked crates differ. The directory is the same for every commit because
where a probe is built changes its count (the first point under
[What a count is not](#what-a-count-is-not)).

Then, with `<probe>` for one of those binaries and `<cpu>` for a CPU the server is held to:

```sh
node bench/request-cost/count.mjs <probe> --cpu <cpu> --answers <directory>/answers
node bench/request-cost/count.mjs <probe> --cpu <cpu>
node bench/request-cost/count.mjs <probe> --cpu <cpu> --depth 16 --cases pipeline,get,unstaged,text
node bench/request-cost/count.mjs <probe> --cpu <cpu> --allocations
node bench/request-cost/idle.mjs <probe> --cpu <cpu>
node bench/request-cost/idle.mjs <probe> --cpu <cpu> --case get-browser --requests 3
node bench/request-cost/idle.mjs <probe> --cpu <cpu> --silent
```

1. `--answers` writes each case's answer as sent, with its `Date` and `ETag` values replaced.
   Compare the two builds' directories (`diff -r`) before counting: item 2 asks that the answers
   be verified, and a count of two builds that answer differently compares two different jobs.
2. The second and third lines print, for each case, the median, least and most of three counts
   (`--reps`) and the counts themselves, in instructions a request.
3. `--allocations` prints allocations and frees a request, and the calls they are made of.
4. `idle.mjs` prints bytes a connection for 5,000 connections (`--connections`). One client
   address has ports for about 28,000: for more, `--addresses` spreads them over that many
   loopback addresses, and both processes must be allowed that many open files (`ulimit -n`).

`--cases` takes a list of cases, and `--port` (8080 by default) the port the probe listens on,
for two runs side by side on CPUs of their own.

## How a number is read

**Instructions.** A count is two runs of the probe under callgrind. In one a client opens a
connection and sends 240 requests, each after it has read the answer before it; in the other,
1,240. Each run's total is everything the process ran from its start to its exit, so the
difference, over 1,000, leaves out startup, the connection's opening and closing, and shutdown.
The probe has one thread and the allocator's background thread is off, so the instructions are
that thread's.

**Allocations.** One run under callgrind with recording off, 240 requests, then recording on for
1,000 more on a new connection. The profile's calls to `malloc`, `calloc`, `realloc`, the aligned
forms and jemalloc's `mallocx` and `rallocx` are the allocations, and to `free`, `sdallocx` and
`dallocx` the frees; calls the allocator makes to itself are left out. The connection opened and
closed while recording shows as the hundredths.

**Idle memory.** The probe is started without callgrind and warmed with 50 connections. The
client then opens the connections one after another, sends what the case says on each and reads
the answers, and waits a second. The growth of the process's `VmRSS` over those connections,
divided by their number, is the figure. The kernel's socket buffers are not the process's and
are not in it.

A run in which the probe closed any of the connections fails, says so and prints no figure.
Corten waits 30 seconds for a connection's next request unless the app says otherwise, so a run
reads only as many connections as open in that time. 5,000 open in 0.4 to 1.6 seconds, and
100,000 over 16 addresses opened in 6 to 14: they read 2,641 bytes a connection before any byte
and 8,421 after one request, on the binary `c9666dc96` and `26ab0e37f` both build. A run of
100,000 started in the minute after another one, in the same network namespace, took 58 to 71
seconds to open and was refused (three runs). The earlier run's connections were then still in
`TIME_WAIT` (100,027 sockets, counted before one of the three), which is the likely cause. Wait
a minute between runs of that size, or give each a container of its own.

The allocator is jemalloc by `LD_PRELOAD`, as the image `corten new` writes sets it, with
`tcache_max:65536`; its background thread is off for the reason above. The probe refuses to
start when jemalloc is not the allocator in use.

## What a count is not

1. Not a property of Corten alone. The count is of this probe's binary. The same request to the
   same commit costs a different number of instructions in a program with other routes, or one
   that also serves TLS, because the compiler lays out and inlines the connection's and the
   router's code by everything that uses it. Where the probe is built counts too: `c9666dc96`
   built in two directories whose names differ counted 18,970 and 19,002 instructions for
   `get`, each the same on every repeat, and two commits with the same crates built in one
   directory gave the same binary, byte for byte. Compare two commits counted with this probe
   and built in one directory; never a count from here with a count of another program, or with
   one built somewhere else.
2. Not time or cycles, and not the kernel's work: see the table above.
3. Not HTTP/2, TLS, a streamed or chunked answer, or a request body longer than two bytes: the
   probe serves none, and the client reads answers by their `Content-Length`.
4. Not memory under attack. Peak memory under a list of hostile clients needs those clients and
   a sampler of the container's memory, which this kit does not have.

## The probe and placement runs

The probe is shaped as the probes of placement runs have been
([design Choice 72](../../docs/design.md#choice-placement-runs)), so that a plan for such a run
can name it for these requests rather than write another: its binary is called `probe`, it takes
Corten from `../work/crates/corten`, it is started as `<bin> <port> <configuration>`, it says
`READY` on standard error once it listens, and `PROBE_ALLOCATOR` makes it refuse to start under
another allocator.

## Tests

`node --test bench/request-cost/requests.test.mjs bench/request-cost/allocations.test.mjs`, which
`npm run check` runs, covers what needs no server: splitting a connection's bytes into answers,
the masking, the requests, and reading a profile. The rest is checked by running the kit.
