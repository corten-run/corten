# What a request costs the server, over a socket

Three numbers for a change to the request path
([CONTRIBUTING.md](../../CONTRIBUTING.md#pull-requests), Pull requests, item 2), each read from a
small Corten app, the [probe](probe/src/main.rs), built against the commit being measured:

1. Instructions a request: what the thread that serves runs to read one HTTP/1.1 request off a
   keep-alive connection and write its answer, counted by callgrind.
2. Allocations a request: calls into the allocator, from the same callgrind profile.
3. Memory an idle connection holds: how much the process's resident memory grows for each open
   connection, after one request, after three, or before any byte.

Nothing here is part of the workspace or of `corten`. The scripts are Node, standard library
only, and a POSIX shell.

## Which tool for which number

| Tool | What it runs | What its count holds |
| --- | --- | --- |
| [`crates/corten/tests/router_cost.rs`](../../crates/corten/tests/router_cost.rs) | The router in process, called with `oneshot`: no socket, no connection | Routing, the stages, the handler and the answer's body. Not reading or parsing the request, the connection's task, timers, or writing the answer. Use it for a change inside the router. |
| [`bench/fullstack/cost-by-crate.sh`](../fullstack/cost-by-crate.sh) and [`cost-by-default.sh`](../fullstack/cost-by-default.sh) | `examples/card-market` (or the benchmark's axum app) as a server, one keep-alive connection, under callgrind | The whole request, as this kit counts it, for the item page and its JSON, of the checkout as it is: split by crate, or with each production default removed by a patch. Use them for where an app's request spends its instructions and for what a default costs. |
| This kit | The probe as a server, one connection, under callgrind | The whole request too: the read, the parse, the connection, the router, the write. What it adds to the two scripts above: requests whose handlers do nearly nothing, so that a change to the connection is a large part of the count, a build of any named commit beside another, the requests written 16 at a time, allocations, and the memory of an idle connection. Use it to compare two commits on a change to the connection or to anything a request passes on its way in or out. |
| [`bench/fullstack/count.mjs`](../fullstack/count.mjs) | A catalog app's container under load, counted by `perf stat` | User and kernel instructions and cycles of the catalog's item page or JSON. Use it when the change is exercised by those routes, and for cycles. |

Callgrind counts user-space instructions only: it does not see the kernel. A count from this kit
reads work, not speed: it decides a change item 2 has counted, and of one it has measured
item 2 asks for cycles under load as well, which this kit does not give.

## The cases

Each case is one request, sent to one of the probe's two configurations: `api`, an app with an
API and no pages, and `pages`, an app without an API. Both keep every `App` default, and answer
to the names an app answers to by default (`localhost`, a name under it and IP addresses) but in
the eight cases with `-any` in their name, where the probe is started with `HOSTS=*` and answers
to any host. A `HOSTS` in the environment the kit is run in never reaches the probe.

| Case | Configuration | Request | Answer |
| --- | --- | --- | --- |
| `get` | `api` | `GET /baseline11?a=1&b=2`: a staged route, typed query parameters in, a short `String` out | `3` |
| `post` | `api` | `POST /baseline11?a=1&b=2` with a two-byte `text/plain` body | `23` |
| `post-absolute` | `api` | `post` with an absolute-form target and a matching `Host` and `Origin`, no `Sec-Fetch-Site` | `23` |
| `unstaged` | `api` | `GET /unstaged11?a=1&b=2`: the same answer from a route that says `unstaged` | `3` |
| `pipeline` | `api` | `GET /pipeline`: an `unstaged` route | `ok` |
| `text` | `pages` | `GET /text` | `ok` |
| `page` | `pages` | `GET /page` | A page of about 12 KB |
| `get-browser`, `text-browser`, `page-browser` | as above | The same with the seven header lines a browser sends with a navigation | The same; the page compressed with zstd |
| `get-any`, `unstaged-any` | `api`, `HOSTS=*` | As `get` and `unstaged` | `3` |
| `get-any-last`, `unstaged-any-last` | `api`, `HOSTS=*` | As `get` and `unstaged` with the browser's seven lines before `Host`, which is the last of eight | `3` |
| `unstaged-any-name` | `api`, `HOSTS=*` | As `unstaged` to `Host: shop-2.example-cdn.region-9.example.test` and the port, a name of 40 bytes | `3` |
| `unstaged-any-long` | `api`, `HOSTS=*` | As `unstaged` to a name of 4,095 `a` and a `_` and the port | `3` |
| `unstaged-any-encoded` | `api`, `HOSTS=*` | As `unstaged` to a name of 4,093 `a` and `%4a` and the port | `3` |
| `unstaged-any-short` | `api`, `HOSTS=*` | As `unstaged` to `Host: a.test` and the port, a name of 6 bytes | `3` |
| `unstaged-subdomain` | `api` | As `unstaged` to `Host: seller-desk.localhost` and the port, a name under `localhost` whose 11 bytes before it are read as a name | `3` |
| `get-own`, `post-own`, `unstaged-own`, `pipeline-own`, `get-browser-own`, `page-browser-own`, `unstaged-any-long-own` | as the case without `-own`, with `App::own_http1(true)` | The same | The same |

**The cases with the switch on.** Every case above runs with `App::own_http1` off, as an app has
it unless it asks. The seven with `-own` in their name send the same request to the same
configuration with the switch on, so that a change to Corten's own HTTP/1.1 connection
([design Choice 78](../../docs/design.md#choice-own-http1)) is counted. They are the requests that
connection changes most: the bare `get`, `unstaged` and `pipeline` (also 16 at a time), `get-browser` and
`page-browser` with a browser's lines, `unstaged-any-long`, whose head is longer than that
connection's first read of 2,560 bytes, and `post`, whose body hands its connection to hyper,
so that it counts the handoff. They are seven and not all nineteen because the hosted job has 24
minutes for its readings (The hosted job, below). The probe is started for them with
`PROBE_OWN_HTTP1=1`, read once as it starts; every other case is started without it, whatever
the environment the kit runs in holds, so the cases without `-own` count what they counted
before the switch was a case.

A commit whose Corten has no `App::own_http1`, as any from before the switch was added, has
no switch to turn on. [`build.sh`](build.sh) builds the probe with its `own-http1` feature, which
is what calls the method, only for a commit whose `crates/corten/src` defines
`pub fn own_http1(`, so the probe still builds against such a commit; built without the feature,
it refuses `PROBE_OWN_HTTP1=1` with a line that begins `NO own_http1:`. For such a probe
`count.mjs` and `idle.mjs` print that line in place of a figure, as `not run:` or, with `--json`,
as the run's `unsupported`, `count.mjs --answers` writes it to `<case>.unsupported` in place of
the answer, and each goes on to the next case and exits 0.

`get` and `unstaged` differ by more than the stages. The staged handler, which also answers
`post`, takes the request's body; a handler of a route that says `unstaged` cannot (the compiler
refuses it), so that one reads none.

Every request has a `Host` line and nothing else it does not need. An app that answers to any host
reads its `Host` by itself and not against names, and finds it on a later line by other searches
than on the first: the cases of `HOSTS=*` count those reads, with `Host` first and last, with a
name of 6 bytes, fewer than the eight a name needs to be read in line, and with names longer than
`localhost`: one of the letters, digits, `-` and `.` most names are made of, and
one whose last byte is none of those, which is read to its end before that byte is found, and one
whose last three bytes are a percent-encoded byte, which is read from the look that found the `%`
and not again from the name's start. That case counts the read but does not by itself catch a
reader given the name from its start again, as the merge base it is counted against reads the
whole name twice; a unit test in `crates/corten/src/security.rs`
(`a_long_names_encoded_bytes_are_read_from_the_look_that_found_them`) does, by seeing the bytes
that reader is given. An app that names its hosts matches `localhost` and its own names as they
are written; a name it holds subdomains under is matched at the end, and what is before it is
read as a name (a name it matches no way is read whole before its 421):
`unstaged-subdomain` counts the subdomain's read, of `seller-desk` in `seller-desk.localhost`, 11 bytes,
which are read in line. Every answer is checked
against the table: a 200, the encoding or none, and the body, which for the page is the whole of
it from its doctype to its last row. The compressed page is decompressed (with Node's own zstd)
and checked as the page is. `count.mjs --depth 16` writes 16
requests at a time, as a client that pipelines does; the rows read that way have been
`pipeline`, `get`, `unstaged` and `text`, and are those four and `pipeline-own`.

## Running it

On Linux, with the Rust toolchain, Node (the repository's `.node-version`; 22.15 at least, for
zstd), `git`, `taskset`, `getconf`, valgrind, jemalloc (`libjemalloc.so.2`), `pkg-config` and libzstd's
headers. On Debian 13, or in the `rust:1-trixie` container with Node added:

```sh
apt-get update && apt-get install -y valgrind libjemalloc2 pkg-config libzstd-dev
```

Build the probe against each commit to compare, one after another in one directory outside the
checkout and any other git repository, from a checkout that has the commits:

```sh
sh bench/request-cost/build.sh <commit> <directory>
```

[`build.sh`](build.sh) puts the commit's `crates`, `docs`, `README.md`, `Cargo.toml` and
`Cargo.lock` at `<directory>/work` and a copy of the probe beside it with that `Cargo.lock`,
builds it with the repository's release profile and leaves the binary at
`<directory>/bin/<commit>`. Three things about it:

1. It removes `work` and `probe` in the directory first, so it refuses a directory inside this
   checkout or inside any git repository, where a `probe` could be a checkout's own.
2. It fails when the build used a crate, by name and version, that the commit's `Cargo.lock`
   does not have. Names and versions are all it compares: a crate of a locked name and version
   from another source, or with another checksum, is not noticed.
3. A build that fails for either reason, or does not compile, leaves no `bin/<commit>`: the
   binary of an earlier build of that commit is removed first.

The probe's source is this checkout's, the same for every commit: only Corten and its locked
crates differ. Use one checkout of the kit and one directory for every commit of a comparison
(the first point under [What a count is not](#what-a-count-is-not)).

None of CI's own checks builds the probe: Corten is at `../work/crates/corten` only after
`build.sh` has put a commit there. `corten fmt --check`, which CI runs over `bench`, reads its
markup; a change to Corten that stops it compiling shows the next time the kit is run, which
for a pull request [the hosted job](#the-hosted-job) counts is in that job.

Then, with `<probe>` for one of those binaries and `<cpu>` for a CPU the server is held to:

```sh
node bench/request-cost/count.mjs <probe> --cpu <cpu> --answers <directory>/answers
node bench/request-cost/count.mjs <probe> --cpu <cpu>
node bench/request-cost/count.mjs <probe> --cpu <cpu> --depth 16 --cases pipeline,get,unstaged,text,pipeline-own
node bench/request-cost/count.mjs <probe> --cpu <cpu> --allocations
node bench/request-cost/idle.mjs <probe> --cpu <cpu>
node bench/request-cost/idle.mjs <probe> --cpu <cpu> --case get-browser --requests 3
node bench/request-cost/idle.mjs <probe> --cpu <cpu> --silent
node bench/request-cost/idle.mjs <probe> --cpu <cpu> --case pipeline-own
node bench/request-cost/idle.mjs <probe> --cpu <cpu> --case get-browser-own --requests 3
node bench/request-cost/idle.mjs <probe> --cpu <cpu> --silent --case pipeline-own
```

The last three are the idle readings with `App::own_http1` on, which holds another connection
and other buffers for it; each is decided against base's reading with the switch on, not
against the one with it off.

1. `--answers` writes each case's answer as sent, with its `Date` and `ETag` values replaced.
   Compare the two builds' directories (`diff -r`) before counting: item 2 asks that the answers
   be verified, and a count of two builds that answer differently compares two different jobs.
   Every reading also checks each answer against the case's own, as above.
2. The second and third lines print, for each case, the median, least and most of three counts
   (`--reps`) and the counts themselves, in instructions a request. Between them are two
   columns to read a count by: `seconds`, how long the longest of the three windows lasted, and
   `other threads`, the most that threads other than the serving one ran in a window and how
   many they were (`243 in 1`). [How a number is read](#how-a-number-is-read) says what each
   is for.
3. `--allocations` prints allocations and frees a request, and the calls they are made of.
4. `idle.mjs` prints bytes a connection for 5,000 connections (`--connections`), and the growth
   in bytes and the page size it is read from (Idle memory, below). One client
   address has ports for about 28,000: for more, `--addresses` spreads them over that many
   loopback addresses, and both processes must be allowed that many open files (`ulimit -n`).

`--cases` takes a list of cases, and `--port` (8080 by default) the port the probe listens on,
for two runs side by side on CPUs of their own. `--depth` takes at most 240. `--json`, on a
count, on `--allocations` or on `idle.mjs`, prints in place of the text a line of JSON a case
with what was measured, unrounded: each window's instructions, seconds and other threads, the
allocator's calls and the requests they are over, an idle run's bytes a connection, its
connections, its before and after, its growth and its page size. It is what
[`compare.mjs`](compare.mjs) reads; the text is for people. A count of several cases prints
each case's line as it is counted, so one that fails at a later case has printed the earlier
ones: the hosted job counts one case an invocation. `idle.mjs` prints its line once the probe
has stopped.

## How a number is read

**Instructions.** A count is one run of the probe under callgrind. A client opens a connection
and sends 240 requests, each after it has read the answer before it; the probe is then made to
dump its counts (`callgrind_control -d`), which also sets them to zero; the client sends 1,000
more requests on the same connection; and the probe dumps again. The count is what the second
dump holds for the thread that serves, over 1,000 (over 992 at a depth of 16, which sends whole
batches), to the nearest instruction. So the probe's start, the connection's opening and
closing, the first requests' one-time work and shutdown are before the first dump or after the
second, and are not in it. What is in it beside the requests: what the serving thread does to
write a dump, 775 instructions measured over a window with no request (under 1 a request); and
what it does by the clock, below.

*One thread's work, and only that.* The probe has two threads. Its first serves: its runtime is
a current-thread one, on the thread `main` starts on. The other is the clock Corten starts to
close idle connections, which wakes once a second, runs 243 instructions and sleeps. Callgrind
is run with `--separate-threads=yes`, so a dump is a file a thread, and the count is read from
the file of callgrind's thread 1, the process's first thread. Nothing another thread runs is in
a count. That is right for the clock and wrong for anything else: a commit that moved a
request's work to another thread would read as a saving it is not, and Corten has such a thread
outside this probe's cases (`corten-compress`, which compresses held values off the request).
So each run
reads every thread's file of the window, and `count.mjs` prints, in `other threads`, what the
others ran together and how many they were. A run is refused, with no figure, in two cases:

1. The first thread ran less than one instruction a request: it did not serve them. The probe
   rebuilt on a multi-thread runtime with one worker is refused this way ("the probe's first
   thread ran 0 instructions for 1000 requests, so it did not serve them (2 other threads ran
   19574250)"). The kit cannot count such a probe.
2. The other threads together ran more than the clock's ticks explain: 300 instructions a tick,
   for each whole second of the window and two more (600 for a window under a second). The 300
   is the 243 with room for a commit that changes the clock a little; it is not measured again
   for each commit.

Work of another thread below that allowance is not refused and not counted: read the column.

The clock is also why a count is not callgrind's total at exit, nor the difference of two such
totals (a run of 240 requests and one of 1,240), which is how this kit first read it. When the
probe is stopped just before a tick, the clock's thread ends before the process does and gives
back its allocator cache, about 42,000 instructions that are in one run's total and not in the
other's: 42 a request. Stops aimed at that moment brought it out in 17 of 60 runs. With the two
dumps, 60 runs aimed the same way read `get` as 18,987 every time, the clock's thread having
ended first in 14 of them.

*A count grows with how long its window lasts.* The serving thread does one thing by the
second, not by the request: hyper keeps the `Date` line it sends and renders it again when the
second has changed, about 600 instructions each time. So a window that lasts a second longer
counts 0.6 more a request. With the 1,000 requests paced to stretch the window (on `c9666dc96`):

| Window | `get` | `post` | `Date` lines rendered |
| --- | --- | --- | --- |
| 0.9 seconds | 18,987.4 | 23,656.1 | 1 |
| 1.8 to 1.9 seconds | 18,987.4 | 23,656.8 | 1 and 2 |
| 3.7 to 3.8 seconds | 18,988.6 | 23,657.4 | 3 |
| 6.6 to 6.7 seconds | 18,991.1 | 23,659.2 | 7 and 6 |
| 17.1 seconds | 18,997.1 | 23,665.8 | 17 |

The count is not corrected for it. The line is rendered while these requests are served and is
part of what serving them cost; how many seconds a window crosses is not its length but where it
began in a second; and the 600 is this commit's, which a commit to compare could change. So
`count.mjs` prints the seconds, and two counts are compared as they are when their seconds are
alike. On the 16-CPU host these were read on, a window lasted 0.7 to 1.9 seconds for the nine
cases in that run and 0.7 to 0.8 at a depth of 16. One binary's counts agreed closely: 30 counts
of each of that run's 13 rows spanned at most 1 instruction, and 30 of `get`, `post`, `text` and
`page` with two busy loops on the probe's own CPU spanned at most 1 and read at most 1 more
(rustc 1.100.0, valgrind 3.24.0). That is that host's, not the method's. On a slower, loaded
machine, where windows last longer and vary more, the second review of the pull request that
added this kit
([#2097 Add bench/request-cost: what a request costs the server over a socket, and what an idle connection holds](https://github.com/corten-run/corten/pull/2097))
read one binary's counts up to 3 apart within one condition (24 and 22 counts each of four
cases) and up to 4 apart across the two.

**Allocations.** The same dump, written without name compression. The serving thread's calls to
`malloc`, `calloc`, `realloc`, the aligned forms and jemalloc's `mallocx` and `rallocx` are the
allocations, and to `free`, `sdallocx` and `dallocx` the frees; calls the allocator makes to
itself are left out. A dump with fewer allocations than requests is refused: every case
allocates for each request, so it is not a profile of them.

**Idle memory.** The probe is started without callgrind and warmed with 50 connections. The
client then opens the connections one after another, sends what the case says on each and reads
the answers, and waits a second. The growth of the process's `VmRSS` over those connections,
divided by their number, is the figure. The kernel's socket buffers are not the process's and
are not in it. Resident memory moves a page at a time (`getconf PAGESIZE`, 4,096 bytes on
x86-64 Linux), so two readings differ by whole pages, and one page, under a byte a connection
over 5,000 with 4,096-byte pages (13 with 65,536-byte ones), is the least they can differ by: the step of the reading, not a measured bound on
its accuracy. The run prints the growth in bytes and the page
size beside the figure, and CONTRIBUTING's gate compares the growths, not the figures, which are
rounded: two pages more can round to one byte a connection more. [`idleRise`](figures.mjs) is
that comparison, and it refuses readings over fewer connections than a page has bytes, where one
page is more than a byte a connection: over 40, one 4,096-byte page is 102 bytes a connection, a
step the gate would let pass unseen.

A run prints no figure, and says why, when the probe did not hold every connection: when it
closed any of them, or when its open files (`/proc/<pid>/fd`) did not grow by their number, as
when it may open fewer files than there are connections and the rest wait in its listen queue.
A request on a connection waiting there is not answered while it waits, and such a run ends in
one of two ways: no answer has come for 30 seconds, or the probe closed connections first,
since Corten closes the ones it holds at its own 30 seconds and then accepts those that
waited. Which of the two comes first is a race between those two clocks; either way the run
exits 1 and prints no figure. Corten waits 30 seconds for a connection's next request unless
the app says otherwise, so a run reads only as many connections as open in that time. How long
that takes is the machine's: on the 16-CPU host these were read on, 5,000 opened in 0.4 to 1.9
seconds and
100,000 over 16 addresses in 6 to 19, reading 2,641 to 2,645 bytes a connection before any byte
and 8,421 after one request (on `c9666dc96`). A run of 100,000 started in the minute after
another one, in the same network namespace, took 58 to 71 seconds to open and was refused (three
runs). The earlier run's connections were then still in `TIME_WAIT` (100,027 sockets, counted
before one of the three), which is the likely cause. Wait a minute between runs of that size, or
give each a container of its own.

**The allocator** is jemalloc by `LD_PRELOAD`, with the thread cache the image `corten new`
writes sets (`tcache_max:524288`). That image also turns jemalloc's background thread on; here
it is off, so what the allocator does is done by the thread that asked and is in its count. The
probe refuses to start when jemalloc is not the allocator in use. With the 64 KiB cache of
earlier images the nine cases measured then counted up to 22 instructions fewer (`get` 18,972 against 18,987,
`unstaged` 12,838 against 12,860, `page-browser` the same).

## What a count is not

1. Not a property of Corten alone. The count is of this probe's binary, run one way. Beside
   Corten's commit five things move it: the allocator's setting and how long the window lasted,
   both above, and these three.
   - The program. The same request to the same commit costs a different number of instructions
     in a program with other routes, or one that also serves TLS, because the compiler lays out
     and inlines the connection's and the router's code by everything that uses it. Never
     compare a count from here with a count of another program.
   - The probe's source. A page carries an id made from where its markup is in the source. A
     comment that moved the probe's markup two lines down changed that id, 22 bytes of the
     answer, and `page-browser`, which compresses the page, read 162 instructions more (221,971
     against 221,809) where `page` read the same. Compare counts taken with one checkout of the
     kit.
   - Where it is built. The directory's name is in the binary. `c9666dc96` built in five
     directories gave five different binaries. Four counted every case within 2 of each other.
     The fifth counted 32 to 37 more on seven cases (`get` 19,019 against 18,987) and the same
     on `unstaged` and `pipeline`, on every repeat and however the count was read. Two commits
     with the same crates built one after the other in one directory gave the same binary, byte
     for byte. Build every commit of a comparison in one directory.
2. Not time or cycles, and not the kernel's work: see the table above.
3. Not HTTP/2, TLS, a streamed or chunked answer, or a request body longer than two bytes: the
   probe serves none, and the client reads answers by their `Content-Length`.
4. Not an app's runtime, and not what any thread but the first runs. The probe serves on one
   thread; the app `corten new` writes runs a runtime of several. A count says nothing of what
   threads cost each other, and work a commit does on another thread is not in it: the run is
   refused when that is more than the clock's ticks, and printed beside the count either way.
5. Not memory under attack. Peak memory under a list of hostile clients needs those clients and
   a sampler of the container's memory, which this kit does not have.

## The probe and placement runs

The probe is shaped as the placement kit asks of a plan's probe
([`bench/placement`](../placement/README.md), `probe.dir`;
[design Choice 72](../../docs/design.md#choice-placement-runs)), so that a plan for such a run
can name it for these requests rather than write another: its binary is called `probe` and it
takes Corten from `../work/crates/corten`. It is started as `<bin> <port> <configuration>`, says
`READY` on standard error once it listens, and `PROBE_ALLOCATOR` makes it refuse to start under
another allocator, which a plan's `probe.start` would have to say. No placement run has been
made with it, so the spread such a run records has not been recorded for this probe. Until one
is, a difference between two commits of a few tens of instructions, as the 32 to 37 above, may
be where the code was placed and not the change.

## The hosted job

A pull request that changes what a request is built from is counted against its base by the
`Request Cost` workflow
([`.github/workflows/request-cost.yml`](../../.github/workflows/request-cost.yml)), so its
author prepares no host. Its one job counts when the pull request changes `crates/corten`,
`crates/corten-macros`, `crates/corten-feed`, `crates/corten-protocol`, the root `Cargo.toml`
or `Cargo.lock`, this kit, the workflow, the script that scopes it, `.node-version` or a
`.gitattributes` in any directory (which says what the archive `build.sh` builds from holds),
and otherwise says in its summary that it counted nothing, and passes
(`scripts/benchmark-scope.mjs`, by the diff of the pull request's merge against the base). A
scope step that says neither fails the job. The probe is built from the first two crates
alone; the feed's are there because a request for a feed runs them, though no case here does,
so a change to them alone reads the same on both builds. The probe is a workspace of its own
with its own release profile, so a profile or a `[patch]` changed in the root's `Cargo.toml`
selects the job and is not what either probe is built with: such a change is measured, by the
fourth kind of item 2.1's list. The root's `.cargo` configuration is in neither build and
selects nothing.

On one runner it does what [Running it](#running-it) says, the first three by
[`job.sh`](job.sh):

1. Builds the probe against the merge base and then against the head, in one directory, with
   the kit of the pull request's merge, so the probe's source is the same for both. The head
   is counted against the commit where it left the base's branch, not as merged: what the
   base gained since is in neither build. A build that fails or does not end in 7 minutes
   leaves what it said; that build is then not run at all, whatever it left, and the table is
   written without its figures.
2. Writes both builds' answers (`count.mjs --answers`).
3. Takes each run [`compare.mjs`](compare.mjs) names (`node compare.mjs --readings`) with
   `--json`, on base and then on head, a case a run: each case's instructions, three counts
   each, the five at a depth of 16, each case's allocations, and the six idle readings, three
   with the switch off and three with it on, three times a build. The cases with the switch
   on took the readings from 297 seconds to 452 on an 8-CPU host (`job.sh read`, one run
   each, with the kit at `2f8984ddc` and at `8c4957bea`), about half as long again; the hosted
   job's readings took 155 to 288 seconds before them, in its last four runs of the pull
   request that adds the switch (on `17aa12549`, `69bfdbebf`, `554e0c57f` and `2f8984ddc`),
   so half as long again is well inside its 24 minutes, an estimate and not a hosted reading. A run ends in 120 seconds or is stopped, and none starts once 24
   minutes have gone since the job's first step, which leaves six of the job's 30 for the
   table, a reserve in name and not a guarantee, since a run stopped at its time can take 10
   seconds more to end. The checkout, the toolchain and the two builds are not held to those 24: a job
   they take past its 30 minutes ends there with no table. A run the kit refuses, or that
   does not end, gave no figure and is taken again, once, with why kept for each attempt (the
   kit's error, else the last thing the run said, else its exit status); no run is taken
   again for its figure.
4. Runs `compare.mjs` on the two builds' directories with the pull request's description, and
   writes what it prints to the job's summary: for each case base, head, the difference and
   the percent, every count of every run with its longest window and the most that other
   threads ran in one, the allocator's calls, every idle run's growth in bytes with its rounded
   figure a connection and what base's runs allow, each idle run's line with its before, after,
   growth and page size (which stands in for the line `idle.mjs` printed), each attempt that gave
   no figure, and one
   line of verdict. Its exit status is the job's.

`compare.mjs` holds the figures to the rule of
[CONTRIBUTING.md](../../CONTRIBUTING.md#pull-requests) (Pull requests, item 2.1, Counted): no
case's instructions a request more than +0.5% over base's by the kit's medians, no case's
allocations up (by the allocator's calls over the same requests, so 16,004 against 16,000 in
1,000 requests is a rise, though both print as 16.00), and no idle reading that rises by
[`idleRise`](figures.mjs): the median of head's three growths of resident memory, each run's
after less its before in bytes, above base's by more than the larger of base's three span and
one page. The figures a connection are rounded and do not decide it: one page more over base's
three equal 62,812,160 bytes passes, though the figures read 12,562 and 12,563, and two pages
more fail, though their figures can also be one byte a connection apart. A figure is read only from the whole JSON of the run asked
for: its case, depth, requests and 5,000 connections from one address, three counts whose
median is the one stated, and for an idle run its growth equal to its after less its before
and a page size, which a run of `idle.mjs` from before they were printed does not give, so its
growth is not guessed from its figure. The job's connections stay 5,000: on a runner whose page
has more bytes than that (65,536-byte pages), a page is more than a byte a connection, and
`idleRise` refuses the reading; `compare.mjs` refuses six runs not all of one page size before
asking `idleRise`. Either way the reading is not decided and cannot be counted. An answer is a capture that is one
whole answer, by its `Content-Length`, with nothing after it, and the case's. Anything else
is no figure or no answer, and a reading with no figure on either build, a case either build
gave no answer to, an idle reading not decided, and a base that did not build are each a case
that cannot be counted. The
job fails when the head does not build, whatever is declared.

One kind of row is neither counted nor a case that cannot be counted: a case with the switch
on that base's probe printed it could not run (`unsupported`, above), base being a commit whose
Corten has no `App::own_http1`. Such a row is not compared, reads `not compared` in each table,
and neither passes nor fails, and the verdict names those cases and adds what base's probe said.
The rule then holds or not by the other rows alone, which it does not say covers the change's
code; a change whose code only those rows would run is still of the fifth kind of item 2.1's
list. Where head's probe could not run a case that base's ran, or the line is not the probe's
own, the row has no figure, a case that cannot be counted. The kit, and so the probe's source,
is the checkout's for both builds: a pull request against a branch whose Corten has
`App::own_http1` but whose kit has no case with the switch on counts the new rows on both
builds, and compares them as any other.
The description's line says what a miss does:

| The description says | The rule holds | It does not |
| --- | --- | --- |
| `Request path: counted` | Passes | Fails, naming each case, and says the change is then measured |
| `Request path: measured` | Passes: the counts are reported and decide nothing | The same |
| No such line, or more than one | Passes, and names the line to add | Fails, and names the line to add |

A declaration line is a line of the description's text, as it is written, that is
`Request path: counted` or `Request path: measured` from its first character with nothing
after it but spaces, whether the line ends in a line feed or in a carriage return and a line
feed. The description declares a way when it holds exactly one. The job reads no Markdown,
so such a line counts wherever it stands, in an example's block, a quote or a comment as in
the text, and a description that says the line and also quotes it whole in an example holds
two: more than one is read as none, whether or not they agree. So write the line once, on a
line of its own, and where the description speaks of the line, write it inside a sentence.
The verdict says what was read: the way and its line's number, that there is no declaration
line, or how many there are and at which lines. Builds that answer differently are named
above the table and fail nothing: a change may be meant to change an answer, and the review
weighs a count of two different jobs.

The description is the one the event carried when the run started. A line added afterwards is
read by the next run a push starts, not by a rerun, and an edit starts no run, since it would
count the same commits again and so draw them again. So a red check on a pull request that
has since declared `measured` stands, with its reason in its summary, until the next push: a
maintainer reads the summary and the description as it now is, and the check's color only for
the commit and description it ran with.

A green check is evidence for a reviewer to read, not an attestation: the counts are of the
pull request's own tree, by its own workflow, scope, kit and comparison. A pull request that
changes any of those has that change reviewed for what it does to the verdict.

The same comparison of two builds counted on a host of one's own, each run's `--json` output in
a file named as `--readings` names it:

```sh
node bench/request-cost/compare.mjs --readings
node bench/request-cost/compare.mjs <base's directory> <head's directory> --description <file>
```

What hosted runners gave, in the job's first four runs, for the pull request that added it
([#2124 Count what a request costs for a pull request against its base in a hosted job](https://github.com/corten-run/corten/pull/2124)):
`651d61f71`, `28d9af174` and `20960f56d`, each against `1bef46229`, and `1df3829c6` against
`aa526350f`, each base's crates the same as its head's, so that a run's two probes were one
binary, byte for byte (the second, third and fourth runs printed their checksums). Each runner
had 4 CPUs, of an Intel Xeon Platinum 8573C, an AMD EPYC 9V45 and, twice, an AMD EPYC 7763,
with valgrind 3.26.0 and rustc 1.100.0:

1. The job took 5 minutes 19 seconds, 4 minutes 7, 5 minutes 42 and 5 minutes 46. In the
   first, third and fourth, the probe built against base, with nothing built before, in 52, 64
   and 63 seconds, and against head, with base's crates built, in 40, 39 and 41; the 62 runs of
   the kit took 193, 212 and 212. The second restored the first's compiled crates from a cache
   (66 MB), as the workflows' other Rust jobs do: 32 and 26 seconds to build, and 154 for the
   runs, on another runner. Installing valgrind, jemalloc and libzstd's headers took 8 to 13
   seconds. That is one run with a cache beside three without, on runners that differ, so
   what a cache saves was not measured; the job ends in about five minutes and keeps none.
2. No run was refused, of 248. The runners allow 65,536 open files, each idle run's 5,000
   connections opened in 0.2 to 2.2 seconds, and 13,215 to 13,979 sockets were in
   `TIME_WAIT` when a job's last run ended.
3. In the first three runs each row's eighteen counts, six a job, spanned at most 1
   instruction in all 13 rows, on the three CPU models alike (`get` 18,504 and 18,505,
   `page-browser` 219,794 and 219,795), which is as close as the 16-CPU host under
   [How a number is read](#how-a-number-is-read) read one binary. In the fourth, twelve rows'
   six counts did, and `get`'s spanned 3, base's being 18,387, 18,388 and 18,390, where the
   budget is 91. In no run did a median differ from the other build's by more than 1, and
   every allocation count was the same.
4. An idle reading's six runs spanned 0 to 4 bytes a connection in a job (over the four:
   8,430 to 8,433 after one request, 12,521 to 12,525 after three of a browser's, 2,655 to
   2,661 before any byte). In a fifth run, of `bd7506d60`, the six before any byte spanned 5,
   2,657 to 2,662.

The idle rule can read a rise between two builds that are the same, since it compares two
medians of three by a span of three, or one page when that is more: base's growths a page
apart and a head two pages above base's median would be one. A model says how often, not the
runners. When the rule compared the figures a connection by base's span alone, with every run
drawn independently from one distribution, it did so in 8.7% of comparisons and 23.8% of jobs,
a job being three readings, when the draws are normal, and in 5.5% and 15.7% when they are
normal with a standard deviation of 1.5 bytes a connection and rounded to whole bytes. On the
growths, with that standard deviation over 5,000 connections (7,500 bytes, 1.8 pages of 4,096),
each draw rounded to whole pages and the mean placed anywhere in a page, the same draws read
one by base's span alone in 5.9% of comparisons and 16.7% of jobs, and with the one page
allowed in 5.4% and 15.3% (each simulated, 1,000,000 jobs): most of the fall from 8.7% is the
rounding, and the one page allowed takes away about half a point more at that spread. None of
the five runs read one, whose
figures were compared, not their growths, which those runs did not print. A job that fails on idle memory alone, by a byte or
two, is to be read with that in mind; by the rule its runs are still not taken again for
their result.

## Tests

`node --test bench/request-cost/*.test.mjs`, which `npm run check` runs file by file. No test
runs the probe, valgrind or cargo: [`stand-in.mjs`](stand-in.mjs) and scripts on `PATH` stand in
for them.

| File | What it holds |
| --- | --- |
| `requests.test.mjs` | Each case's request byte for byte, its `HOSTS` and whether it turns `App::own_http1` on, and the answer it must get, splitting a connection's bytes into answers, the masking |
| `figures.test.mjs` | The arithmetic of a count and of an idle reading, and when a window or a run is refused |
| `allocations.test.mjs` | Reading a profile |
| `probe.test.mjs` | The client against a stand-in server: every request sent, whole batches at a depth, an answer that is not the case's refused, an answer that never comes |
| `run.test.mjs` | `count.mjs` and `idle.mjs` run whole against the stand-ins: which dump and which thread a count reads, that its window holds the 1,000 requests on the connection of the 240 and neither its opening nor its closing, the `HOSTS` each case starts the probe with and that only a case with the switch on starts it with `PROBE_OWN_HTTP1=1`, what a probe built without the switch makes each script print for such a case, what is printed, and each refusal |
| `build.test.mjs` | `build.sh` with a stand-in cargo: the directories it refuses, the versions it refuses, that a failed build leaves no binary, and the `own-http1` feature turned on for a commit whose Corten has `App::own_http1` and not for one without it |
| `compare.test.mjs` | `compare.mjs` against two builds' directories written as the kit prints with `--json`: inside the budget, over it on one case, an allocation rise smaller than a rate shows, idle memory decided by growths in bytes (one page over base's agreeing three passing, two pages failing, more than base's span failing), a reading over too few connections for its page or of two page sizes not decided, a run without its page size and growth no figure, a run refused on one build, a refusal taken again, output cut short or of another run, a build that failed, answers missing, empty, cut short or with more after them, which lines declare, what each declaration does with the verdict, and a case with the switch on that base's probe could not run (not compared, whatever head's figures), that head's could not run (no figure) or that neither could |
| `job.test.mjs` | `job.sh` with stand-ins for `build.sh` and the kit's scripts, in a checkout made for it: no merge base, a build against base or against head that fails, a run refused and taken again, no second run of one that gave its output, and a run stopped when the time is spent |

`run.test.mjs` (but its refusals of an option), `build.test.mjs` and `job.test.mjs` need Linux
with `sh` or `bash` and `git`, and are skipped elsewhere: on Windows 50 of the 80 tests run.
The hosted check runs on Linux. What no test covers is checked by running the kit: the probe
itself, callgrind's own dumps, and a real build. Of the hosted job, the workflow's own steps
around `job.sh` have no test but the workflow's shape (`scripts/benchmark-scope.test.mjs`).

The resident memory `idle.mjs` reads in `run.test.mjs` is the stand-in's. `idle.mjs` reads only
the probe's `/proc/<pid>/status`; the tests start it with `node --import` of
[`stand-in-status.mjs`](stand-in-status.mjs), which turns that read into one of the status
`stand-in.mjs` writes, and nothing else loads that file. The stand-in's status is 10,240 kB and a
page each connection it closed left behind, and two pages more for each open connection and one
for each request answered on it. Each idle run that reads it and prints a figure is checked for
its exact before, after, growth and figure, so a run that read memory once, or read its before
ahead of the warm connections, fails. Two runs are checked less: one starts `idle.mjs` without
the preload and reads the stand-in's own status in `/proc`, as a host does, and is checked only for
a growth that is its after less its before, a figure that is that growth over the connections and
a before that is not the stand-in's; the `--json` run with a 65,536-byte page is checked only for
the page size it carries.
