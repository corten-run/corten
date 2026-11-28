## Placement plan for the cycles of `App::own_http1`, declared before any run

This pull request says `Request path: measured`. This comment declares the plan that
[CONTRIBUTING.md](https://github.com/corten-run/corten/blob/2f8984ddce025c92bade4a6fafd21f4863d25085/CONTRIBUTING.md#pull-requests) (Pull requests, items 2 and 2.1) asks of a
measured change before any run: cycles a request under load, read across placements
([design Choice 72](https://github.com/corten-run/corten/blob/2f8984ddce025c92bade4a6fafd21f4863d25085/docs/design.md#choice-placement-runs)) with
[`bench/placement`](https://github.com/corten-run/corten/blob/2f8984ddce025c92bade4a6fafd21f4863d25085/bench/placement/README.md) as it is at `2f8984ddc`. It is two
comparisons, each one plan file of that kit, given whole below with the two `wrk` scripts they name.

No cycles have been read for this pull request. What was run before this declaration is dry runs
of the plans' parts (`DRYRUN=1`: 6 placements, 2 pairs, 1 s turns), which the kit heads "a test of
the scripts, read for nothing". Both plan files were written before the first of them, a dry run of
every part of both plans, comparison 1's on a Xeon Platinum 8280. After that dry run and before any
run, comparison 1's plan was changed in one field, the host's CPU model, from Xeon Platinum 8280 to
Xeon Platinum 8168, so that its workloads could be divided among hosts of one model. Comparison 2's
plan is unchanged. Every host that runs a workload has made a dry run of its workloads with the
plan file as given below: the host of comparison 2's `pipeline` and `get` in that first dry run,
which it made of all six of its plan's workloads, and each of the six others after the change. No
cycles of any dry run were read or are reported here.

### What is compared

1. **`own-http1-off`: the switch off against `main`.** Base `e733f3d888450707c049a17cd6100c891966bc87`, the merge base of this
   branch with `main`; head `2f8984ddce025c92bade4a6fafd21f4863d25085`, this pull request's head. This is what merges: an app that
   does not ask is served by hyper's connection. Every workload is read for the margin alone, and
   no reduction is declared.
2. **`own-http1-on`: the switch on against the switch off.** Base `2f8984ddce025c92bade4a6fafd21f4863d25085`; head `0bcb3138c69f69dab997486c9af87a3660eb0ed4`,
   which is that commit with one line changed, the default in `Connections::default()`
   (`crates/corten/src/app.rs`: `own: own_in_tests(),` becomes `own: true,`), under the tag
   `evidence/own-http1-on-variant`. It merges nowhere. Both sides are then built from one probe in one
   directory, and differ in the tree alone. This comparison reads, in cycles, the saving
   [design Choice 78](https://github.com/corten-run/corten/blob/2f8984ddce025c92bade4a6fafd21f4863d25085/docs/design.md#choice-own-http1) counts in instructions, and what
   asking for the switch costs.

### The probe and the setup

The probe is [`bench/request-cost/probe`](https://github.com/corten-run/corten/blob/2f8984ddce025c92bade4a6fafd21f4863d25085/bench/request-cost/probe/src/main.rs) as it is at
`2f8984ddc`, two files (`Cargo.toml`, SHA-256 `e4259374bdd73138761272e5851d9bdd72d729bb7a4ac29af79281ebceef3ab9`, and `src/main.rs`,
`f0829a721a1e0589d3b30f07b6983a635b4671462d23b0893c1b3a1e4f9536a4`), copied beside each plan file as `probe/`: the kit takes
`probe.dir` as a path from the plan file and refuses one that leads out of the plan's directory. No
placement run has been made with this probe, so no recorded placement spread applies to it, and
each workload's A/A is declared to record one (`recordsSpread`), which a pull request that changes
Choice 72 would do, and only for an A/A that is complete and resolves.

Each side is compiled once with rustc 1.100.0, `cargo build --release`, the probe's own release
profile (the repository's) and `ZSTD_SYS_USE_PKG_CONFIG=1`. The server is started with jemalloc
preloaded and `MALLOC_CONF=background_thread:true,tcache_max:524288`, the setting of the image
`corten new` writes. That is not the `tcache_max:65536` the recorded spreads and the trend use, and
not the `background_thread:false` `bench/request-cost` counts with. The server is pinned to one
CPU, `wrk -t2 -c64` to two others and the driver with `perf` to a fourth; turns are 3 s, every turn
on a freshly started binary; R = 8 recorded pairs a placement after one that is not; a placement's
time limit is 600 s.

A comparison's workloads are divided among hosts of the plan's model, a Xeon Platinum 8168 in both
plans: each host has 8 CPUs with one thread a core and Debian 13, and is prepared by the kit's
`setup.sh` and by nothing else. Comparison 1's four workloads run one to a host. Comparison 2's six
run two to a host, in the plan's order: `pipeline` and `get`, `deep` and `long`, `post` and
`page`. Each plan names its model, so the kit refuses a host of another, and each workload's pilot
and gated part run on one host. No figure is compared or combined across hosts: each workload is
read within its own host's placements.

### The workloads

| Workload | Request | `own-http1-off` | `own-http1-on` |
| --- | --- | --- | --- |
| `pipeline` | `GET /pipeline` to `api`: an unstaged route, 2 bytes, the shortest request the probe answers | margin | reduction 3%, margin |
| `get` | `GET /baseline11?a=1&b=2` to `api`: a staged API route, a short answer | margin | reduction 3%, margin |
| `page` | `GET /page` to `pages`: a staged page of 12,166 bytes, not compressed | margin | reduction 1%, margin |
| `post` | `POST /baseline11?a=1&b=2` with the body `20` to `api` (`post.lua`): a request with a body | margin | margin |
| `deep` | `GET /pipeline` to `api`, 16 written at a time on each connection (`deep.lua`) | not read | reduction 3%, margin |
| `long` | `GET /unstaged11?a=1&b=2` to `api` started with `HOSTS=*`, with a `Host` name of 4,096 bytes | not read | margin, declared as expected to cost more |

Why each, beyond what its `declared` text in the plan says:

1. Every workload is one the change touches, in both comparisons, so each is held to +1% with no
   floor and none is a negative control. With the switch off a request takes the same path through
   hyper, but the compiled program is not the same (Choice 78), so no request is left out as
   untouched.
2. `post` goes to hyper on both sides of comparison 2: its connection is handed over at its first
   request and stays hyper's. It is read to show a handed connection costs what hyper's own does,
   not for a win. `wrk` keeps its 64 connections for a turn, so this reads requests on a connection
   already handed over and very little of the handing over itself.
3. `deep` is where the two connections differ most: the answers to requests that arrived together
   leave in one write. It is not read in comparison 1, where both sides are hyper's connection and
   `pipeline` reads the route.
4. `long` is the case Choice 78 records as costing more with the switch on: a head longer than the
   own connection's first read of 2,560 bytes and shorter than hyper's of 8,192, which
   `bench/request-cost` counts at 8.0% more instructions (its `unstaged-any-long`). It is in the
   plan so that the run shows what that is in cycles. It is held to +1% like any touched workload,
   and it is declared here, before the run, as expected to miss: a miss on it is a known cost of the
   opt-in and not a surprise, and it is reported as the miss it is. It differs from the kit's case in
   one thing: a plan's header lines are the same for every server, so its `Host` has no port after
   the name.
5. The reductions are the smallest worth having, not forecasts: 3% on the three requests whose
   connection is a large share of them, and 1% on `page`, where Choice 78 counts 3.1% fewer
   instructions with the switch on.

### How each threshold is read

As Pull requests, item 2, gives them, by the kit's own report, with nothing computed by hand:

1. **The statistic.** For a placement, the median of its R per-pair changes in user plus kernel
   cycles a request. Across placements, the median of the K placement medians and its one-sided
   95% upper bound, the j-th smallest of them, j the smallest rank with
   P(Binomial(K, 1/2) >= j) <= 5%. The 95% is nominal, and the bound reads the change across the
   plan's placements, not across every placement and not the unpadded build.
2. **The margin.** A workload meets +1% when the change's bound across placements is under +1%
   and its A/A, the comparison's base against itself in the same gated part, resolves: its bound is
   under +1% as recorded and with its labels swapped. No floor applies. An A/A that does not
   resolve does not pass, whatever the change's bound.
3. **A reduction.** A CPU-cost win needs the change's upper bound across placements at or below
   minus the declared reduction, the A/A's one-sided 95% lower bound (the (K + 1 - j)-th smallest)
   above minus that reduction in both readings, and the A/A resolved. Without all three no win is
   claimed.
4. **A placement that fails.** A placement that fails a check (its answers, a failed request, a
   counter that is zero or under 100%, its time limit) or has fewer than R valid pairs leaves its
   comparison with no bound, which does not pass. No placement is run again, replaced or dropped
   for its result, and no part is run twice.
5. **Single builds.** This plan takes no single-build reading of a probe workload: every threshold
   it declares is read across placements (`reads`).

### K, the pads and the order

Every workload's K is `"pilot"`: no eligible A/A exists for this probe, these requests and this
setup. So each workload is one plan in two parts, declared here whole. Its pilot is an A/A of the
comparison's base at K = 100, read only for the spread of its placement medians and never with a
change. Its gated part is the change and its A/A at the smallest K from 5 to 254 at which the kit's
sizing check passes from that pilot (each model kept fails in at most 10,000 of 200,000 draws at
that K itself), with the pad lists `pads.mjs` at `2f8984ddc` gives for that K. The gated part
follows its pilot with no stop between them, so each K and its lists are fixed by that rule and
are reported with the results, not posted between the two parts. A workload whose pilot is not
eligible, or sizes no K the pads allow, is not read across placements under this plan, and no
second pilot is read for it under this plan.

The pilot's pads, the same lists for every workload of both plans (as `node plan.mjs <plan>`
prints them):

```text
the bound is the 59th smallest of the 100 placement medians, the lower bound the 42nd
pads p (base and head in the change, the A/A's first side): 320 15120 25824 40624 10304 21008 35808 5552 20288 30992 736 15536 26176 36880 10720 21424 36160 5904 16608 31408 1088 15888 26592 37296 11072 21776 36576 6320 16960 31760 1504 16304 26944 37648 11488 22192 32832 6672 17376 32176 1856 12560 27360 38064 11840 22544 33248 7088 17728 32528 2272 12976 27712 38416 12256 22960 33600 7440 18144 28848 2624 13328 28128 38832 8512 23312 34016 7856 18496 29200 3040 13744 28480 39184 8928 23728 34368 4112 18912 29616 3392 14096 24800 39600 9280 24080 34784 4528 19264 29968 3808 14512 25152 39952 9696 24496 35136 4880 19680 30384
pads q (the A/A's second side): 22848 12160 38336 27648 12880 2192 32464 17680 7008 33184 22496 11808 38000 27312 12528 1840 32064 17280 6592 32768 22096 11408 37584 26896 16224 1440 31712 16928 6256 36528 20528 12080 39424 27008 14400 832 33296 16656 7248 35664 23072 9504 37920 25440 12848 3376 31856 19312 5696 34240 21632 16256 40592 27984 14480 1936 30304 16736 4192 36768 23152 10608 39088 25520 12928 512 28864 19392 6864 35216 21712 9168 37536 28064 15520 7136 34480 17840 5360 36848 24256 15936 39168 26688 18192 1488 28944 16400 7904 35296 22752 10272 37616 25072 12592 3120 31488 19072 5440 33920
200 distinct sizes from 320 to 40624 bytes; p by 64-byte-line phase (0, 16, 32, 48): 25, 25, 25, 25, by quarter of a page: 25, 25, 25, 25; q: 28, 24, 24, 24 and 26, 22, 29, 23
the pairs: 16 ordered combinations of the line phases of p and q; q - p mod 4096 takes 100 distinct values, 25, 25, 25, 25 by quarter of a page (at least 12 asked in each)
```

Each workload's placements run in an order drawn from its seed, the date and the workload's place
in its plan (2026112701 to 2026112704, and 2026112711 to 2026112716). On a host the parts run in
the plan's order of workloads, a workload's pilot and then its gated part.

What the kit binds a run to: each plan file's SHA-256, and the SHA-256 of the list of files the
plan names by path (the probe's two files and the request script), which is declared with it.

| Plan file | SHA-256 |
| --- | --- |
| `own-http1-off.json` | `f0c299630cd32cea90a94e5f292b360a38b87c86fb446a3e9efd26f644aca225` |
| `own-http1-on.json` | `3ec67c264a0150f9e83d263665d81bcce12b18882e413d8bae52f62984b240b3` |
| `post.lua` | `e4d185c7d2a203742ff65b81136dd44ce6cbda386addc1963b5d984e1963b916` |
| `deep.lua` | `c56ba81b7e9877d2c4843ccef416157bcb92fd582beba01c9395f6cd5df3f55b` |

Inputs lists, by workload: in `own-http1-off`, `pipeline` `9fe6c0b6df86cb921c828b773dd7be1e7f92dd091616cdbfe8e9093884355787`, `get` `9fe6c0b6df86cb921c828b773dd7be1e7f92dd091616cdbfe8e9093884355787`, `page` `9fe6c0b6df86cb921c828b773dd7be1e7f92dd091616cdbfe8e9093884355787`, `post` `bc3ae620f69f9361d583acec6c205837fb977df427c23640313db3914582f065`; in `own-http1-on`,
`pipeline` `9fe6c0b6df86cb921c828b773dd7be1e7f92dd091616cdbfe8e9093884355787`, `get` `9fe6c0b6df86cb921c828b773dd7be1e7f92dd091616cdbfe8e9093884355787`, `deep` `f0a71d4d02f5556d4dfea7ad195720558d6c43d7984867db48da98280dcca0a6`, `long` `9fe6c0b6df86cb921c828b773dd7be1e7f92dd091616cdbfe8e9093884355787`, `post` `bc3ae620f69f9361d583acec6c205837fb977df427c23640313db3914582f065`, `page` `9fe6c0b6df86cb921c828b773dd7be1e7f92dd091616cdbfe8e9093884355787`.

### Reported with the cycles

For each workload, from its gated part's report: K, the change's median, bound and lower bound,
both readings of its A/A, and the kit's own reading of each threshold, in its words. Across
placements as cycles are: the user and kernel split, user instructions a request and, since the
change adds code, user L1 instruction-cache misses a request. Every counter at 100% in every turn
and no failed request, or the placement fails. From each side's unpadded link's map: every input
section of `.text` aligned beyond 16 bytes and the side's list (the dry runs' maps showed none on
any side, so no second pad is expected; the run records what it finds). Each pilot's eligibility,
the models kept and the K it sizes. What the run did not resolve is said as that.

### The catalog's `page` and `json`

The change with the switch off is exercised by the catalog's item page and item JSON, as by every
request. For the case item 2 gives a plan that reads a probe across placements, this plan names,
in comparison 1: for the catalog's `page`, the workload `page`; for the catalog's `json`, the
workload `get`. The reason is the same for both: the code this change compiles differently is the
connection, its service and the router's future, which a staged page and a staged API route's
short answer pass through on the probe as the catalog's two requests do.

Both targets are also counted, once for this plan, and the count is declared here before it is taken:
`bench/fullstack/count-pairs.mjs` with targets `page,json`, one build of each side of comparison 1
(the base's image from `e733f3d88`, the head's from `2f8984ddc`), 100 recorded pairs
after pair 0, with the count's own A/A, the base's image against itself, in the same run. Its
checks are the ones that script holds an invocation to: the side's image by its ID, 5,000 requests
in each of its two loads with none failed, every check of the load tool passed, and every count
with `perf`'s running percentage at 100%. Each bound is reported with where its distance from +1%
lands against the default band as `main` prints it today, -2.98% to +3.33%, beside its A/A's two
bounds. No win is claimed from either count, and neither is taken again for its result.
Comparison 2 takes no catalog count: its head is a variant made for the measurement, and the
catalog's app as this pull request leaves it does not ask for the switch.

### What the kit does not check here

1. The kit captures the answers it compares with one `GET` of the workload's path. For `post` those
   are the answers to a `GET` of that path and not to the `POST` the load sends; for `deep`, the
   answers to one request sent alone and not to 16 written together. Under load both are held only
   to `wrk`'s count of failed requests, which must be zero in every turn. In comparison 2 the two
   sides are then compared on a request the switch changes the connection of (`deep`) and on one
   it does not (`post`'s `GET`, which stays on Corten's own connection where the `POST` is handed
   to hyper).
2. In the dry runs every placement of both comparisons answered as its unpadded binary and the two
   sides of every placement answered the same, so neither plan has an expected difference.

### What this plan does not cover

1. Memory. The pull request gives what an idle connection holds and the peaks under the attacks;
   nothing here reads memory.
2. Waiting and latency. Fewer cycles a request show lower CPU cost, not lower latency. No latency,
   throughput or cold start is read by this plan.
3. TLS and a wrapped IO, HTTP/2, and any request through a proxy.
4. A real network. The load and the server are on one host, over loopback, with 64 connections
   kept open.
5. A request with a browser's header lines, where Choice 78 counts no saving in instructions
   (0.3% fewer to 0.1% more). Every request here has a `Host` line and nothing else.
6. An app's runtime of several threads: the probe serves on one thread on one CPU.
7. A streamed or chunked answer, a body longer than two bytes, and a client that closes its side.
8. The binary that ships, which has a placement of its own.

### Size

Estimated, not measured: a workload is a pilot of 100 placements and a gated part of 2K. The one
finished run of this kit, the trend's of 2026-11-26, took 62.5 s a placement (measured there) and
sized K = 60 and K = 28. The kit has since gained checks around each start and stop, and the dry
runs' placements put one at about 70 to 78 s on these hosts (estimated). At K from 28 to 60 that is
about 3.4 to 4.7 hours a workload, and a pilot that sizes a larger K takes longer: about 6.4 hours
a workload at K = 100. With the workloads divided among hosts as above, a comparison takes as long
as its slowest host: about 3.4 to 6.4 hours for comparison 1, one workload to a host, and about 7
to 13 hours for comparison 2, two to a host. Nothing is cut after a part has run.

### `own-http1-off.json`

```json
{
  "plan": 1,
  "name": "own-http1-off",
  "base": "e733f3d888450707c049a17cd6100c891966bc87",
  "head": "2f8984ddce025c92bade4a6fafd21f4863d25085",
  "probe": {
    "dir": "probe",
    "tree": [
      "Cargo.toml",
      "Cargo.lock",
      "README.md",
      "crates",
      "docs"
    ],
    "toolchain": "1.100.0",
    "env": {
      "ZSTD_SYS_USE_PKG_CONFIG": "1"
    },
    "build": "cargo build --release",
    "binary": "release/probe",
    "start": "env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:524288 PROBE_ALLOCATOR=jemalloc $BIN $PORT api"
  },
  "host": {
    "cpuModel": "Xeon(R) Platinum 8168",
    "cpus": {
      "server": 2,
      "load": [
        4,
        5
      ],
      "driver": 7
    }
  },
  "load": {
    "threads": 2,
    "connections": 64,
    "seconds": 3
  },
  "R": 8,
  "placementSeconds": 600,
  "pilot": {
    "K": 100
  },
  "workloads": [
    {
      "name": "pipeline",
      "declared": "GET /pipeline to the probe's configuration api, no request header of its own: a route that says unstaged and answers 2 bytes, the shortest request the probe answers, so the connection's code is the largest share of it. Touched: with the switch off a connection takes one more branch when it is accepted and a request takes the same path through hyper, but the compiled program is not the same (design Choice 78), so every request runs code this change compiles differently. Held to +1% with no floor; no reduction is declared.",
      "request": {
        "path": "/pipeline",
        "headers": []
      },
      "status": 200,
      "mask": [],
      "K": "pilot",
      "seed": 2026112701,
      "reads": [
        "margin"
      ],
      "reduction": null,
      "recordsSpread": true
    },
    {
      "name": "get",
      "declared": "GET /baseline11?a=1&b=2 to the probe's configuration api, no request header of its own: a staged API route, typed query parameters in and a short answer out. Touched: with the switch off a connection takes one more branch when it is accepted and a request takes the same path through hyper, but the compiled program is not the same (design Choice 78), so every request runs code this change compiles differently. Held to +1% with no floor; no reduction is declared. Named for the catalog's json target: both are a staged API route's short answer through the same connection, service and router future, which is the code this change compiles differently.",
      "request": {
        "path": "/baseline11?a=1&b=2",
        "headers": []
      },
      "status": 200,
      "mask": [],
      "K": "pilot",
      "seed": 2026112702,
      "reads": [
        "margin"
      ],
      "reduction": null,
      "recordsSpread": true
    },
    {
      "name": "page",
      "declared": "GET /page to the probe's configuration pages, no request header of its own: a staged page of about 12 KB, not compressed. Touched: with the switch off a connection takes one more branch when it is accepted and a request takes the same path through hyper, but the compiled program is not the same (design Choice 78), so every request runs code this change compiles differently. Held to +1% with no floor; no reduction is declared. Named for the catalog's page target: both are a staged page through the same connection, service and router future, which is the code this change compiles differently.",
      "request": {
        "path": "/page",
        "headers": []
      },
      "start": "env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:524288 PROBE_ALLOCATOR=jemalloc $BIN $PORT pages",
      "status": 200,
      "mask": [],
      "K": "pilot",
      "seed": 2026112703,
      "reads": [
        "margin"
      ],
      "reduction": null,
      "recordsSpread": true
    },
    {
      "name": "post",
      "declared": "POST /baseline11?a=1&b=2 with the 2-byte text/plain body 20 to the probe's configuration api (post.lua): a request with a body, which hyper reads. Touched: with the switch off a connection takes one more branch when it is accepted and a request takes the same path through hyper, but the compiled program is not the same (design Choice 78), so every request runs code this change compiles differently. Held to +1% with no floor; no reduction is declared. The kit captures the answers it compares with a GET, so the answers compared are those to a GET of this path; the POST's own answers are held only to wrk's count of failed requests, which must be zero in every turn.",
      "request": {
        "path": "/baseline11?a=1&b=2",
        "headers": [],
        "script": "post.lua"
      },
      "status": 200,
      "mask": [],
      "K": "pilot",
      "seed": 2026112704,
      "reads": [
        "margin"
      ],
      "reduction": null,
      "recordsSpread": true
    }
  ]
}
```

### `own-http1-on.json`

```json
{
  "plan": 1,
  "name": "own-http1-on",
  "base": "2f8984ddce025c92bade4a6fafd21f4863d25085",
  "head": "0bcb3138c69f69dab997486c9af87a3660eb0ed4",
  "probe": {
    "dir": "probe",
    "tree": [
      "Cargo.toml",
      "Cargo.lock",
      "README.md",
      "crates",
      "docs"
    ],
    "toolchain": "1.100.0",
    "env": {
      "ZSTD_SYS_USE_PKG_CONFIG": "1"
    },
    "build": "cargo build --release",
    "binary": "release/probe",
    "start": "env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:524288 PROBE_ALLOCATOR=jemalloc $BIN $PORT api"
  },
  "host": {
    "cpuModel": "Xeon(R) Platinum 8168",
    "cpus": {
      "server": 2,
      "load": [
        4,
        5
      ],
      "driver": 7
    }
  },
  "load": {
    "threads": 2,
    "connections": 64,
    "seconds": 3
  },
  "R": 8,
  "placementSeconds": 600,
  "pilot": {
    "K": 100
  },
  "workloads": [
    {
      "name": "pipeline",
      "declared": "GET /pipeline to the probe's configuration api, no request header of its own: a route that says unstaged and answers 2 bytes, the shortest request the probe answers. Touched: with the switch on its connection is Corten's own from the first byte to the last. Read for a reduction of 3%, the smallest reduction worth having, not a forecast, and held to +1% with no floor.",
      "request": {
        "path": "/pipeline",
        "headers": []
      },
      "status": 200,
      "mask": [],
      "K": "pilot",
      "seed": 2026112711,
      "reads": [
        "margin",
        "reduction"
      ],
      "reduction": 0.03,
      "recordsSpread": true
    },
    {
      "name": "get",
      "declared": "GET /baseline11?a=1&b=2 to the probe's configuration api, no request header of its own: a staged API route, typed query parameters in and a short answer out. Touched: with the switch on its connection is Corten's own. Read for a reduction of 3%, the smallest reduction worth having, not a forecast, and held to +1% with no floor.",
      "request": {
        "path": "/baseline11?a=1&b=2",
        "headers": []
      },
      "status": 200,
      "mask": [],
      "K": "pilot",
      "seed": 2026112712,
      "reads": [
        "margin",
        "reduction"
      ],
      "reduction": 0.03,
      "recordsSpread": true
    },
    {
      "name": "deep",
      "declared": "GET /pipeline to the probe's configuration api, 16 requests written at a time on each connection (deep.lua). Touched: with the switch on the answers to requests that arrived together leave in one write, where hyper flushes each. Read for a reduction of 3%, the smallest reduction worth having, not a forecast, and held to +1% with no floor. The answers the kit compares are those to one GET of this path sent alone; the answers to the 16 written together are held only to wrk's count of failed requests, which must be zero in every turn.",
      "request": {
        "path": "/pipeline",
        "headers": [],
        "script": "deep.lua"
      },
      "status": 200,
      "mask": [],
      "K": "pilot",
      "seed": 2026112713,
      "reads": [
        "margin",
        "reduction"
      ],
      "reduction": 0.03,
      "recordsSpread": true
    },
    {
      "name": "long",
      "declared": "GET /unstaged11?a=1&b=2 to the probe's configuration api started with HOSTS=* (an app that answers to any host), with a Host line whose name is 4,095 a and one _ and has no port: a route that says unstaged, with a head longer than the 2,560 bytes of the own connection's first read and shorter than the 8,192 of hyper's. Touched, and declared as expected to cost more with the switch on: bench/request-cost counts 8.0% more instructions on its case unstaged-any-long (design Choice 78), which this request is but for the port after the name. Read for the margin, +1% with no floor, so that the run shows what that cost is in cycles; a miss on it is a known cost of the opt-in and not a surprise. No reduction is declared.",
      "request": {
        "path": "/unstaged11?a=1&b=2",
        "headers": [
          "Host: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_"
        ]
      },
      "start": "env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:524288 PROBE_ALLOCATOR=jemalloc HOSTS='*' $BIN $PORT api",
      "status": 200,
      "mask": [],
      "K": "pilot",
      "seed": 2026112714,
      "reads": [
        "margin"
      ],
      "reduction": null,
      "recordsSpread": true
    },
    {
      "name": "post",
      "declared": "POST /baseline11?a=1&b=2 with the 2-byte text/plain body 20 to the probe's configuration api (post.lua): a request with a body. Touched: with the switch on its connection is handed to hyper at its first request and stays hyper's, so this reads whether a handed connection costs what hyper's own does. Held to +1% with no floor; no reduction is declared. The kit captures the answers it compares with a GET, so the answers compared are those to a GET of this path; the POST's own answers are held only to wrk's count of failed requests, which must be zero in every turn.",
      "request": {
        "path": "/baseline11?a=1&b=2",
        "headers": [],
        "script": "post.lua"
      },
      "status": 200,
      "mask": [],
      "K": "pilot",
      "seed": 2026112715,
      "reads": [
        "margin"
      ],
      "reduction": null,
      "recordsSpread": true
    },
    {
      "name": "page",
      "declared": "GET /page to the probe's configuration pages, no request header of its own: a staged page of about 12 KB, not compressed. Touched: with the switch on its connection is Corten's own, which is a small share of this request. Read for a reduction of 1%, the smallest reduction worth having, not a forecast, and held to +1% with no floor.",
      "request": {
        "path": "/page",
        "headers": []
      },
      "start": "env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:524288 PROBE_ALLOCATOR=jemalloc $BIN $PORT pages",
      "status": 200,
      "mask": [],
      "K": "pilot",
      "seed": 2026112716,
      "reads": [
        "margin",
        "reduction"
      ],
      "reduction": 0.01,
      "recordsSpread": true
    }
  ]
}
```

### `post.lua` (both plans)

```lua
-- A POST of the URL on wrk's command line with a 2-byte text/plain body, as bench/request-cost sends its post case.
wrk.method = "POST"
wrk.body = "20"
wrk.headers["Content-Type"] = "text/plain"

done = function(summary, latency, requests)
    io.write(string.format("RESULT %d %d %d %d %d %d\n", summary.requests, summary.errors.connect,
        summary.errors.read, summary.errors.write, summary.errors.status, summary.errors.timeout))
end
```

### `deep.lua` (`own-http1-on`)

```lua
-- 16 GETs of the URL on wrk's command line written at a time on each connection.
init = function(args)
    local r = {}
    for i = 1, 16 do r[i] = wrk.format() end
    req = table.concat(r)
end

request = function()
    return req
end

done = function(summary, latency, requests)
    io.write(string.format("RESULT %d %d %d %d %d %d\n", summary.requests, summary.errors.connect,
        summary.errors.read, summary.errors.write, summary.errors.status, summary.errors.timeout))
end
```
