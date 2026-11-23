# The plans, as the pull request stated them before each run

## Cycles under load: the plan, written before the run

1. Reduction claimed on the workload the change is for: `GET /json/{25,40,50}?m=4` with `Accept-Encoding: gzip, br`, JSON of about 4 to 8 KB written by `Json` and compressed per request, through the stages (jemalloc). Smallest worthwhile reduction: 5% of user plus kernel cycles per request. It is claimed only if the one-sided 95% upper bound on the median per-pair change is at or below -5%.
2. No regression on a workload the change touches without meaning to change: the same requests with `Accept-Encoding: gzip, deflate, br, zstd` (zstd 1 before and after, chosen by the same negotiation), held to +1% with no floor.
3. No regression on an answer that is not compressed: a text `GET` that names no coding, through the same stages, held to +1%. In process its instruction count was the same on both builds while its time was 3.5% higher on the candidate's three turns, so it is measured here under load.
4. Protocol: two builds of one small app from `bcf4aa073` (main) and `fdf94a6a7` (this branch), the same sources otherwise; the server in a container on 24 cores of a 48-core cloud host (one runtime per core, each with its own listener), the load generator on the other 24 with 4,096 keep-alive connections; each turn a freshly started server, 2 s of warm-up, then 3 s counted with `perf stat -e cycles:u,cycles:k,instructions:u` on the server process; the builds' order turned every pair; 40 recorded pairs after one that is not for the first workload and 60 after one for the second and the third; a pair with a failed request or a counter under 100% is reported.
5. The bound is the order statistic: the 26th of 40 sorted per-pair changes, the 37th of 60.
6. The answers: for the first workload the two builds' decoded bodies and headers are compared but `Date`, `Content-Encoding`, `ETag` and the length, which the change is meant to alter; for the other two, byte for byte but `Date`.

A first run of workloads 1 and 2 at `01ad562a3`, before gzip was limited to bodies up to 16 KiB, had been read when this plan was revised (bounds -29.23% over 40 pairs and +0.75% over 57). It is not the evidence for this pull request: the run above repeats both at the code that merges.

Not planned under load: a gzip-only client, a brotli-only client and a body past 16 KiB (counted in process and probed on card-market's image instead).

## A diagnostic for workload 2, written after its miss and before it ran

The miss on workload 2 stands whatever this shows: a touched workload has no floor, and nothing below is tested against a margin or replaces the result above. It is run to say whether the cycles follow the candidate's code or where the linker placed it, which the pull request reports either way.

1. Three comparisons on workload 2 under the protocol above, 60 recorded pairs each after one that is not, each also counting user L1 instruction-cache misses (`L1-icache-load-misses:u`): the same two images again; the base against the candidate built with a never-called function of 3,100 bytes of NOPs (`pad3100.diff` of the layout-floor receipt, `evidence/24c0d897`, kept by one `black_box` at startup); and the base against the base built with the same pad.
2. Reported for each: pairs, medians, range, the per-pair median change and its bound for cycles, user cycles, kernel cycles, instructions and the cache misses.
