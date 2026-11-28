# Hardening r112

Measured commit: `6345df88c530fe7fcca7f10bab934aa324179de5`.
Native run: 2026-11-27 21:25:58 UTC to 2026-11-28 00:02:16 UTC.

The official controller verified the collection manifest and replayed the saved
archive before confirming host retirement. An independent replay at the measured
commit also verified the archive, its collection manifest and native evidence
with no blockers or pending native roots. This is a coverage and qualification
report, not a numeric ranking: no adapter qualified for numeric comparison.

The run observed all 108 expected cells: nine adapters, two data sources, two
deployments (direct and edge), and three phases (request timeout, request limit,
dependency recovery). Timeout and limit probes returned expected outcomes in
72 of 72 cells. The API dependency probe reported recovery in 18 of 18 cells.
All 36 request-limit probes were accepted; this does not show rejection at the
tested limit. The timeout outcomes do not establish server-enforced deadlines.

Terminal health was a separate check: it passed in 64 of 72 timeout/limit cells
and 16 of 18 API recovery cells. In all 12 Spring cells the terminal check was
unsupported because liveness evidence was missing, not because the probe
observed a terminal failure. The other 16 fixture recovery terminal checks
passed. Fixture recovery cells are controls, not upstream-outage measurements.

| Adapter | Observed cells | Expected timeout/limit outcomes | Healthy timeout/limit terminals | API recovery observed | Healthy API recovery terminals | Production-qualified direct cells | Production-qualified edge cells |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Corten | 12/12 | 8/8 | 8/8 | 2/2 | 2/2 | 6/6 | 6/6 |
| ASP.NET | 12/12 | 8/8 | 8/8 | 2/2 | 2/2 | 6/6 | 6/6 |
| Spring | 12/12 | 8/8 | 0/8 | 2/2 | 0/2 | 0/6 | 0/6 |
| Next.js | 12/12 | 8/8 | 8/8 | 2/2 | 2/2 | 6/6 | 6/6 |
| Django | 12/12 | 8/8 | 8/8 | 2/2 | 2/2 | 6/6 | 6/6 |
| Express | 12/12 | 8/8 | 8/8 | 2/2 | 2/2 | 6/6 | 6/6 |
| Gin | 12/12 | 8/8 | 8/8 | 2/2 | 2/2 | 6/6 | 6/6 |
| Drogon | 12/12 | 8/8 | 8/8 | 2/2 | 2/2 | 6/6 | 6/6 |
| Topcoat | 12/12 | 8/8 | 8/8 | 2/2 | 2/2 | 6/6 | 6/6 |

Eight of nine adapters met the benchmark's scoped production checks. Spring's
observations remain in the matrix; its qualification gap applies to the
deployments and evidence captured by this benchmark.
