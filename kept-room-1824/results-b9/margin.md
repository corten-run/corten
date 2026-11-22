# Margin for corten-run/corten#1824's "measured before it is built" run (1824b), declared before the run

Prepared 2026-11-22; not yet run. <!-- commits --> Main `7a275ef1534efb3a1e1130a4bac5de2322ad380f`
(origin/main when the kit was made); the `populate` build is main with `variants/populate.diff`
(a measurement variant, not a candidate).

## Question

[#1824](https://github.com/corten-run/corten/issues/1824)'s last comment recommends option 1 first,
"measured before it is built": keep a new answer in memory the store has touched before, so a kept
answer does not fault in new pages. With room, a new URL took 108,731 cycles on main against
68,006 with the store off (50,977 against 29,559 in the kernel), with 1.6 page faults a request
for a page of 4,944 bytes.

What the code says before any run: with room, a kept answer is net new memory (its body copied to
its own length, `kept.rs` `Missed::keep`, its head cloned, its key boxed, its `Entry` in an `Arc`,
its URL's copy list and the table's and clock's growth), and nothing is freed while the store has
room, so there is no touched memory for it to reuse. The allocator already reuses what each
request frees (the render buffer, the head) for the next request; whatever the copy is made in,
the process grows by the same pages. A free list of dropped kept buffers changes nothing with room
(nothing is dropped) and nothing in a full store, where the allocator already reuses freed memory
(0.03 faults a request measured). So "memory touched before" can only mean memory made resident
ahead of need, and the question becomes what a page made resident costs, by which means, and
whether making it resident ahead (in larger pieces) saves the kernel half of the store's share.
This run measures that, end to end and per page, and declares here what would justify building it.

## Builds and configurations

One probe program (`probe/`, the 1846r kit's record page, about 6 KB uncompressed; wrk asks with
no Accept-Encoding, so no coded form is made), built twice on the host with rustc 1.100.0, the
repository's release profile and main's Cargo.lock: `main`, and `populate`, main with the variant
(while the store has room, a kept body, at most 256 KiB, is copied into the store's own 2 MiB
chunk instead of an allocation of its own length; each chunk is made resident in one
`madvise(MADV_POPULATE_WRITE)` when it is made, so the body is written into pages touched
before; the copy is a `Bytes` sharing the chunk, which is given back when every body in it is
dropped; a full store copies as main does). The head, key, entry and table growth stay as main
makes them (about 1.8 of the 7.9 KB a kept request adds). The variant keeps no bound on what its
chunks hold once the store fills and drops pages, since a chunk stays while any body in it is kept:
with it, `crates/corten/tests/kept_memory.rs` fails locally (6,255,972 bytes held under a 4 MiB
bound). No configuration here fills the store, so this run does not see that cost; a design built
on this result would have to count whole chunks against the bound or copy survivors out of them,
and that is not measured here.

A first variant, set aside before this run: 2 MiB allocated, made resident and freed at once, for
the allocator to hand out to the copies after it. Locally (a WSL2 container, 3 pairs) it changed
perf's faults a kept request by -0.10 of 1.87 and /proc's minflt (its own pages included) by
+0.03: jemalloc did not hand the freed 2 MiB to the copies (probably its
`lg_extent_max_active_fit`, which keeps a dirty extent more than 64 times a request's size from
being split for it). It measured the allocator, not the idea, so the store holds the memory
itself here (`local/populate-free-and-reuse.diff` in the kit's source, not packed).

Configurations: `room` (`kept_answers(8 GiB)`, so no turn fills the store; every request a new URL
by `lua/new-url.lua`), `off` (`kept_answers(0)`, the same URLs), `hit` (the default app, `/page`
kept before the port opens; `lua/get.lua`), `plain` (the default app, `/private`, the same page not
`Public`).

Allocators: jemalloc as the template's image runs it (`LD_PRELOAD=libjemalloc.so.2`,
`MALLOC_CONF=background_thread:true,tcache_max:65536`), the same with `thp:always` (no code: jemalloc
asks for transparent huge pages on its mappings), glibc's allocator as it comes, with
`GLIBC_TUNABLES=glibc.malloc.hugetlb=1` (huge pages), and with
`glibc.malloc.top_pad=67108864:glibc.malloc.trim_threshold=268435456` (a 64 MiB pad and no trim
below 256 MiB: a control, expected to change no fault, since the heap's pages are made resident
when first written however far the heap was grown).

## Comparisons (A, then B), pairs fixed now

| name | A | B | pairs |
| --- | --- | --- | ---: |
| je-room-off | main room, jemalloc | main off, jemalloc | 30 |
| je-room-thp | main room, jemalloc | main room, jemalloc thp:always | 30 |
| je-hit-thp | main hit, jemalloc | main hit, jemalloc thp:always | 40 |
| je-plain-thp | main plain, jemalloc | main plain, jemalloc thp:always | 40 |
| je-room-populate | main room, jemalloc | populate room, jemalloc | 30 |
| je-hit-populate | main hit, jemalloc | populate hit, jemalloc | 30 |
| je-plain-populate | main plain, jemalloc | populate plain, jemalloc | 30 |
| gl-room-off | main room, glibc | main off, glibc | 20 |
| gl-room-thp | main room, glibc | main room, glibc hugetlb=1 | 20 |
| gl-room-pad | main room, glibc | main room, glibc top_pad and trim | 20 |

290 recorded pairs, each comparison after one unrecorded warm-up pair. The one-sided 95% upper bound
on a median per-pair change is the 15th of 20, the 20th of 30 and the 26th of 40 sorted changes
(distribution-free).

## Method

The 1846r kit's fresh-start method (`run-pair.sh`): every turn on a freshly started server pinned to
CPU 2, `wrk -t2 -c64` for 3 s on CPUs 4 and 5, this script and perf on CPU 7, the order turned every
pair (A first in odd pairs). perf stat counts the server process over the turn: `cycles:u`,
`cycles:k`, `instructions:u` (each at 100% running, else the run stops) and the software events
`page-faults` and `minor-faults`. From `/proc`, after the server answers and before the load, and
after the load: `minflt` (which also counts the pages `MADV_POPULATE_WRITE` makes resident, which
perf's fault events do not), `VmRSS`, and at the end `VmHWM` and `AnonHugePages`. Per request:
counts over the requests wrk saw answered; resident bytes a request = (VmRSS after - VmRSS before)
/ requests.

Answers: before each comparison's first turn A and B are each started once and asked the
comparison's check (curl, Date dropped, an Age line dropped, a tag masked): A twice and B once, all
200 and the same. After every turn's counts, before the server stops, it is asked again and the run
stops unless: in `room`, a URL not asked before is answered without an Age and then with one (the
store kept it); in `off`, the second has none; in `hit`, `/page` has one; in `plain`, `/private`
has none; and every one is a 200 of the bytes the check had. Any wrk error (connect, read, write,
status, timeout) stops the comparison: a stopped comparison is reported as failed, not as a result,
and the next goes on. The serve logs must show the allocator asked for, no setting jemalloc
refused, and for `je-room-populate` B's `POPULATE madvise` line and none from A.

Before the comparisons, `faultcost` (std only) measures what making private anonymous memory
resident costs this host a 4 KiB page, on CPU 2, by kernel and user cycles from `perf_event_open`
around that step alone: one first demand run of 4,096 MiB; then every free page but 2 GiB touched
once, so that no later turn pays for the hypervisor's first use of a guest page (a production host
that has run a while has touched its memory; the earlier rounds on new droplets had not, all of
it); then five rounds of `demand` (a fault a page), `populate` (one `MADV_POPULATE_WRITE` over 256
MiB), `thp` (`MADV_HUGEPAGE`, then a write a page) and `touched` (pages already resident written
again: the floor any reuse reaches). Then every comparison once with no recorded pair (its answers,
one unrecorded pair of 1 s turns and the after-checks); a failure there stops the run.

Host: a new quiet dedicated-CPU droplet (c-8, debian-13-x64, root), set up by `setup.sh` and built
by `build.sh` there; nothing else run or logged into while it runs. `host.txt` records the CPU, the
kernel and its command line, the transparent huge page settings, glibc, jemalloc and the binaries.

## Margins

Let S_k be the store's kernel share with room: the median kernel cycles a request of A less that of
B in `je-room-off` (and in `gl-room-off` for glibc's arms). Judged by `summary.mjs`:

1. Attribution (reported, no margin): S_k, the user share, minor faults and resident bytes a kept
   request, and whether the faults are first touch: minflt x 4 KiB over resident bytes a request
   between 0.8 and 1.25. Outside that, the faults are not only new memory (refaults of memory the
   allocator gave back), and that would reopen the free-list idea this margin sets aside.
2. A variant on `room` (`je-room-thp`, `je-room-populate`; `gl-room-thp`, `gl-room-pad` against
   glibc's S_k) halves the kernel share when the median per-pair difference in kernel cycles a
   request is at most -S_k/2 and its one-sided 95% upper bound is below 0; and it takes fewer cycles
   when the bound on the per-pair change in user+kernel cycles is below 0.
3. Memory: a variant's resident bytes a request on `room` may rise by at most 5% at the median
   (B - A over A), and its resident memory before the load by at most 2 MiB at the median.
   (`populate`'s first chunk, 2 MiB made resident with the first kept answer, shows in `hit`'s
   memory before the load, which is reported and not judged: a design built on this would size
   its first chunk.)
4. No regression on a kept page or a page not kept: the one-sided 95% bound on the per-pair change
   in user+kernel cycles is under +1% on `hit` and on `plain`. Where it is not and user
   instructions moved less than 0.1% at the median, the result is "not resolved (layout, #1923)",
   which is not a pass.

**Option 1 (store code that keeps new answers in memory made resident ahead) is justified** when
`je-room-populate` meets 2 (both) and 3, and `je-hit-populate` and `je-plain-populate` meet 4. If 4
is only "not resolved", it is justified for a candidate run of its own, not for merging on this
one. **Huge pages for the image's allocator** (no store code: `thp:always` in the image's
`MALLOC_CONF`, a change to Choice 23) are worth a candidate when `je-room-thp` meets 2 and 3 and
`je-hit-thp` and `je-plain-thp` meet 4 (the same binary on both sides, so no layout difference).
Otherwise neither is built on this run's evidence. The glibc arms bound the gain under the other
allocator and decide nothing on their own; `gl-room-pad` is expected to change no fault.

The faultcost rounds explain the end-to-end results and decide nothing on their own; they are
reported with the ratio of populate's and thp's kernel cycles a page to demand's. A comparison
stopped by a failure, a multiplexed or non-numeric counter, or a failed after-check is reported as
such, not as a result. No rerun or pooling is declared here.

## Time

Locally (a WSL2 container, 4 CPUs) main took 345 s to build and the variant 263 s more (its
corten and the probe again, with LTO); the kit unpacked by `start.sh` in a clean Debian 13
container built them in 189 s and 166 s. A dry run of `run.sh` there took about 10 s a pair
without perf and 14 s with it (a busier, virtualized desktop; the 1846 kit measured 6.85 s a pair
on a c-8 with the same fresh-start turns). On the c-8, estimated: setup and builds 8 to 12
minutes; faultcost 1 to 3 minutes; the check of every comparison about 2 to 3 minutes; the 300
pairs with the warm-ups at 7 to 12 s each, 35 to 60 minutes. About 50 to 78 minutes in all, under
the 90 set. `run-pair.sh` prints its own estimate after each warm-up pair (run.log); if the first
comparison's estimate puts the whole above 90 minutes, nothing is changed mid-run: the time is
reported.