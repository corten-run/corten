# The cycles run's plan, written before the run

As it stood in corten-run/corten#1979's description before the run started.

The change is one line of the image's environment, so both sides are the same binary
(card-market's image built at `bcf4aa073`), run with
`MALLOC_CONF=background_thread:true,tcache_max:65536` and with `tcache_max:1048576`. Placement is
therefore not a variable and no floor is asked for.

1. Reduction claimed: card-market's item page made 32,501 bytes long (its contents and field
   values repeated twenty times under varied names), asked with `Accept-Encoding: br`. Smallest
   worthwhile reduction: 5% of user plus kernel cycles per request, claimed only if the one-sided
   95% upper bound on the median per-pair change is at or below -5%. 40 recorded pairs after one
   that is not.
2. Reduction claimed, same margin and pairs: that page made 202,041 bytes long (repeated 160
   times), `Accept-Encoding: br`.
3. No regression, held to +1%, 60 recorded pairs after one that is not, each: the smoke fixture's
   item page (9,793 bytes) with `Accept-Encoding: br`, whose buffers the 64 KiB limit already
   keeps; the same page with `Accept-Encoding: gzip, deflate, br, zstd`; the same page with
   `Accept-Encoding: identity`.
4. Protocol: DigitalOcean c-16; the app pinned to one CPU with one runtime, `wrk` 4.1.0 `-t2 -c64`
   on two other CPUs, `perf stat -e cycles:u,cycles:k,instructions:u` on the server process from a
   fourth; each turn a freshly started container, 2 s of warm-up, then a 3 s run inside a 3.4 s
   count; the settings' order turned every pair; a pair with a failed request or a counter under
   100% is reported.
5. The bound is the order statistic: the 26th of 40 sorted per-pair changes, the 37th of 60.
6. The two settings' answers are compared byte for byte but `Date` before each workload.

Already read when this plan was written, on the same host: page faults and coarse CPU time a
request by page length and limit (three rounds), which is where the 5% and the choice of pages
come from; the first runs of the floods; and one test pair of workload 1 to try the script
(1,150,874 against 790,817 cycles a request), which is not recorded. Not planned under load: a
client with gzip alone, pages past 202 KB, and more than one runtime.

Planned after this plan and before either ran: the memory with eight CPUs
(`mem8.sh`), and three more flood runs of the 64 KiB and the 1 MiB limit, asked for because one
of the first three runs at 1 MiB held 220 MiB at its highest where the others held 194 to 202.
