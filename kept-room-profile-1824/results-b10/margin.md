# Margin for corten-run/corten#1824's kernel profile (1824c), declared before the run

Prepared 2026-11-22; not yet run. <!-- commits --> Main `7a275ef1534efb3a1e1130a4bac5de2322ad380f`,
the commit the 1824b run measured (origin/main was `14bcce6b8` when this kit was made; nothing
under `crates/` changed between the two). Diagnostic: no merge gate, no candidate code.

## Question

The 1824b run (a quiet c-8, Xeon Platinum 8280, Linux 6.12, THP `enabled=always`,
`defrag=madvise`) found that with jemalloc as the template's image runs it
(`MALLOC_CONF=background_thread:true,tcache_max:65536`) a new URL kept in a store with room costs
the kernel 9,774 cycles a request more than the same request with the store off (37,740 against
27,967 at the median, 30 pairs), with 0.036 page faults and 7,865 resident bytes a request, and
about 1 GiB of `AnonHugePages` at the end of a turn of about 137,000 requests. With glibc's
allocator the share is 17,383 cycles with 1.877 faults a request (one a new 4 KiB page). Where
does the kernel spend jemalloc's 9,774?

What is expected before any run (arithmetic on 1824b's figures, not a measurement): the 1 GiB of
`AnonHugePages` is the store itself (137,000 x 7,865 bytes is 1.08 GB), so with jemalloc the
store's memory arrives as 2 MiB transparent huge pages, about one huge-page fault for every 267
requests (0.0037 a request), each zeroing 2 MiB. 1824b's `faultcost` measured 3,396 to 3,571
kernel cycles for each 4 KiB of memory made resident that way (`thp`), so 7,865 bytes a request
would cost about 6,700 cycles: about two thirds of the 9,774. If so, the profile shows
`clear_page_erms` (or `folio_zero_user` / `clear_huge_page`) under `do_huge_pmd_anonymous_page`
for about 6,700 cycles a request, and the question becomes what the other third is. glibc has a
gap of the same kind: 1.877 faults at faultcost's 5,244 demand cycles is about 9,800 of its 17,383.
1824b's other arms fit this reading: `thp:always` changed nothing (the host already gave huge
pages), and memory made resident ahead with `MADV_POPULATE_WRITE` saved only 900 (it zeroes the
same huge pages, one call earlier). This kit measures where the cycles go; it does not test a fix.

## Builds and configurations

One probe (`probe/`, 1824b's program with its header and package name changed: the 1846r kit's
record page, 6,124 bytes answered, wrk asking with no Accept-Encoding), built once on the host with
rustc 1.100.0, the repository's release profile and main's Cargo.lock. Both sides of every
comparison run that one binary: A is `room` (`kept_answers(8 GiB)`, so no turn fills the store;
every request a new URL by `lua/new-url.lua`), B is `off` (`kept_answers(0)`, the same URLs). So
there is no layout difference between A and B. Allocators: jemalloc as the template's image runs
it (`LD_PRELOAD=libjemalloc.so.2`, `MALLOC_CONF=background_thread:true,tcache_max:65536`) and
glibc's allocator as it comes, as 1824b's `je-room-off` and `gl-room-off`.

## Passes and comparisons (A room, B off), pairs fixed now

| name | pass | allocator | what is taken | pairs |
| --- | --- | --- | --- | ---: |
| a-je-flat | A | jemalloc | `perf record -C 2 -e cycles -c 1000003 -P`, no call graphs | 5 |
| a-je-graph | A | jemalloc | the same with `-g --kernel-callchains` (plain `-g` where perf lacks it) | 5 |
| a-gl-flat | A | glibc | as a-je-flat | 5 |
| a-gl-graph | A | glibc | as a-je-graph | 5 |
| b-je-core | B | jemalloc | `perf stat -p`: cycles:u, cycles:k, instructions:u, instructions:k, page-faults, minor-faults, major-faults, context-switches, cpu-migrations | 30 |
| b-gl-core | B | glibc | as b-je-core | 30 |
| b-je-tlb | B | jemalloc | cycles:k, instructions:k, dTLB-load-misses:k, dTLB-store-misses:k, iTLB-load-misses:k, page-faults, context-switches | 30 |
| b-gl-tlb | B | glibc | as b-je-tlb | 30 |
| b-je-cache | B | jemalloc | cycles:k, instructions:k, cache-misses:k (last-level), cache-references:k, L1-icache-load-misses:k and :u, page-faults, context-switches | 30 |
| b-gl-cache | B | glibc | as b-je-cache | 30 |

Each comparison after one unrecorded warm-up pair. Pass B's counters are split in three sets so
that no set needs more than four general-purpose counters (cycles and instructions take the fixed
ones), and every hardware event must run 100% of the turn: the preflight drops, and records in
`events.txt`, an event this host cannot count that way (core's must all count, else the run
stops). Every set repeats cycles:k, so the kernel's share is measured three times.

## Method

1824b's fresh-start method (`run-pair.sh`): every turn on a freshly started server pinned to CPU 2,
`wrk -t2 -c64` for 3 s on CPUs 4 and 5, the driver and perf on CPU 7, the order turned every pair
(A first in odd pairs), the answers checked before the first turn (A twice, B once, all the same
200) and after every turn (in A a URL not asked before is answered without an Age and then with
one; in B the second has none; every answer 6,124 bytes); any wrk error stops the comparison, which
is then reported as failed, not as a result. Before the comparisons, 1824b's `faultcost`: one
4,096 MiB demand run, every free page touched once (so no turn pays for the hypervisor's first use
of a guest page, as in 1824b), five rounds of demand, populate, thp and touched over 256 MiB.

Every turn of both passes also records `/proc/vmstat` before and after the turn (the host's
counters: the deltas of `thp_*`, `compact_*`, `numa_*`, `pgalloc_*`, `pgfault`, `pgmajfault`,
`pgfree`, `nr_anon_pages`, `nr_anon_transparent_hugepages`) and the server's whole
`/proc/<pid>/smaps_rollup` at its end. `host.txt` records every file under
`/sys/kernel/mm/transparent_hugepage`, the vm settings that steer compaction, the cgroup and its
memory limit, the kernel, perf, glibc and jemalloc versions and the binaries' hashes.

**Pass A, sampled profile** (what it is for: naming the functions the extra kernel cycles run in,
and the way into the kernel they came by). `perf record -C 2` samples everything on the server's
CPU (the server and any kernel work run there: softirqs, kworkers) every 1,000,003 cycles (about
9,000 samples a turn), the data written to tmpfs during the turn. Afterwards `profile.sh` runs,
for each turn, `perf report --no-children --sort sym` (the top 50 kept as text), the same by
symbol and by command and object as parseable tables, `perf report --stats` (lost and throttled
samples), and for the call-graph turns `perf script` through `entries.mjs` (the way each sample
entered the kernel, and inclusive markers: a sample counts for every marker function its kernel
chain holds) and, for pairs 1 and 2, the call chains of each symbol over 1%. `profile.mjs`
merges a side's turns: a symbol's cycles a request is the sum of its periods over the side's turns
divided by the requests those turns answered. Beside the sampling, `perf stat -C 2` counts CPU 2's
`cycles:u` and `cycles:k` over the same time, and each turn's sampled kernel and user periods are
scaled to those counts, so samples the kernel throttles do not shrink one side more than the other
(`setup.sh` also turns off the kernel's lowering of the sampling rate when its interrupts take
long, `perf_cpu_time_max_percent=0`; where the count cannot run at 100% beside the sampling, the
profile is left unscaled and `events.txt` says so). The flat pass gives the sizes (call-graph sampling
slows the server); the call-graph pass gives the paths. Where the host cannot sample cycles, the
pass samples `cpu-clock` and its figures are nanoseconds (recorded in `events.txt`). The raw
`perf.data` files are kept, compressed with zstd and with `/proc/kallsyms`, only while they come
to 50 MB or less (else the flat pass's alone, else none); the text reports are always kept.

**Pass B, counters** (what it is for: the size of the share by an independent count, the
process's own, and whether the kernel does more work, the same work slower, or waits on memory).
Kernel instructions a cycle falling with room means the same instructions run slower (zeroing with
`rep stosb` retires few instructions for many cycles; cache or TLB misses); kernel instructions a
request rising means more kernel work. LLC and dTLB misses in kernel mode say whether the kernel's
other work runs against a colder cache with room.

## Categories (declared; the code of record is `profile.mjs` CATS and `entries.mjs` MARKERS)

Each kernel symbol of the flat profile goes to the first category whose pattern matches its name
(a compiler suffix such as `.constprop.0` dropped):
zeroing (`clear_page_erms`, `clear_page_rep`, `clear_page_orig`, `clear_huge_page`,
`folio_zero_user`, `process_huge_page`, `clear_subpage`); compaction and khugepaged; memcg (charge,
the lruvec counters and cgroup statistics); page allocator (`__alloc_pages`, `get_page_from_freelist`,
`rmqueue`, `prep_compound_page`, freeing, zone and node counters, memory policy); fault handling
(`asm_exc_page_fault` to `do_anonymous_page`, `do_huge_pmd_anonymous_page`, VMA lookup, page
tables, rmap, LRU add); unmapping and TLB
(madvise, munmap, zap, split huge page, TLB flush, IPIs); scheduler and wakeups (futex included);
network; copies to and from user; epoll and syscall entry; slab; interrupts, timers and RCU; idle;
locks; other kernel. "New memory" is zeroing + page allocator + memcg + fault handling. User-mode
samples are "user" and are reported, not judged here.

## Readings (computed by `summary.mjs`; S is the flat profile's kernel A - B for that allocator)

0. **Method (R0)**: with glibc, where 1824b showed one fault a new page, the page-fault paths
   (inclusive: every call-graph sample whose kernel chain holds `asm_exc_page_fault`,
   `exc_page_fault` or `handle_mm_fault`) must be at least 50% of glibc's kernel A - B in the
   call-graph pass (faultcost alone puts glibc's 1.877 faults at about 57% of its 17,383: the bar
   asks only that the profile find the known cause as the largest). Otherwise the jemalloc readings
   are reported as unconfirmed. Also reported: the
   same paths against faultcost's estimate of first touch (glibc: minflt x demand cycles a page;
   jemalloc: resident bytes / 4 KiB x thp cycles a page), which says whether a fault in the running
   server costs what it costs in faultcost's tight loop. Agreement: S against Pass B's kernel
   A - B (b-*-core, median per pair); a ratio outside 0.75 to 1.33 is reported as a disagreement,
   and the shares are then approximate.
1. **R1, new memory**: jemalloc's page-fault paths at least 50% of its kernel A - B in the
   call-graph pass (where there is no call-graph pass, the flat categories zeroing + page
   allocator + memcg + fault handling at least 50% of S; both are reported, since the flat
   categories leave out work done under a fault in functions of other categories, the slab and
   the lruvec counters among them). With it, the call-graph pass says where the zeroing runs: at
   least half of it under a page fault means zeroing at first touch (the expected reading); under
   khugepaged or a syscall it is collapse or populate work instead. `summary.mjs` also gives kernel
   cycles a resident byte for new memory against faultcost's thp and demand cycles a byte.
2. **R2, compaction or khugepaged**: that category at least 25% of S, or `compact_stall` plus
   `thp_collapse_alloc` more than 0.001 a request with room.
3. **R3, unmapping and TLB** (jemalloc purging dirty pages, splitting huge pages): at least 25%.
4. **R4, scheduler and wakeups** (jemalloc's background thread): at least 25%, or 0.05 more
   context switches a request with room.
5. **R5, indirect**: network, copies, syscall entry, slab, interrupts and locks together at least
   25%, with kernel LLC misses or kernel dTLB-load misses a request higher with room (the 90%
   interval of the per-pair difference above zero): the kernel's ordinary work run against a cache
   and TLB the store's growth keeps cold.

## What would justify which next step

1. R1 holds and R2, R3 and R4 do not: **store-side allocation sizing**. The kernel's share is the
   price of new memory (the memcg charge under the fault included: a container charges it too) and follows the bytes a kept answer makes resident (7,865 against a 6,124-byte
   body in 1824b): fewer bytes a kept answer (no copied head, a smaller entry, a body kept only
   compressed) cut it in proportion; no jemalloc setting is indicated, since huge pages already
   make a new byte the cheapest the host offers (faultcost: thp under demand and populate).
2. R2 holds: **a jemalloc setting candidate** that avoids huge-page compaction or collapse (for
   example `thp:never`), measured on room, hit and plain, against the 4 KiB faults it brings back.
3. R3 or R4 holds: **a jemalloc purge or background-thread setting candidate**
   (`dirty_decay_ms`, `muzzy_decay_ms`, `background_thread`), measured on room, hit and plain.
4. R5 holds without R1: store-side allocation sizing as in 1, for the cache and TLB pressure.
5. None holds, or the shares do not reach half of S together: **option 2** (profile the ask in a
   full store), with the share with room left unexplained by this run.

More than one can hold; each is printed. Nothing here changes Corten or the template; a setting or
a sizing change is a candidate with margins of its own, measured on room, hit and plain. The user
cycles (1824b: 10,952 a request more with room, mostly the copy) are reported by Pass A's user
rows and judged by nothing here.

## Time

Locally the kit was dry-run in a privileged WSL2 container with two or three pairs a comparison
(not a measurement; `local/`): every step ran, about 7 minutes after setup. The build took 126 s
in a clean Debian 13 container (1824b's took 43 s on the c-8). On the c-8, estimated from 1824b's
run (7.1 s a pair of fresh-start turns): setup and build 3 to 5 minutes; faultcost under 1; the
check of every comparison about 1; Pass A's 24 pairs 3 to 4, its reports 3 to 5 and the
compression about 1; Pass B's 186 pairs about 22. About 35 to 45 minutes in all, under the 60 set.
`run-pair.sh` prints its own estimate after each warm-up pair (`run.log`); nothing is changed
mid-run if it runs longer: the time is reported (`progress.log` ends with the minutes taken after
setup).