# #1865's cycle kit, 1865v3

Local scratch for [#1865 Send a Public answer's Cache-Control without reading it again or making it per answer](https://github.com/corten-run/corten/pull/1865),
made for its round 7 review. Not repository documentation. It replaces `../1865v2` (left as it was;
its run was stopped before its main pass and none of its results are evidence) and is
self-contained. What changed from 1865v2:

1. The pair: base the `origin/main` the branch merged in its merge of `fef1f83de` (the merge's main
   parent), head the branch head, whose production sources are the merge's (`1865/commits.env`).
   1865v2's declaration is kept in `1865/history/margin-1865v2.md` (not packed).
2. `1865/gate.mjs`: every CSV counter and request count must equal the turn's one raw perf reading
   and one wrk `RESULT`; turns must be in the declared order in both the CSV and the raw log;
   `status.txt` must be unambiguous (each step once, in order, no other line); the +1% margin is
   applied to exact integer cross-products (BigInt), so a bound of exactly +1% is not under it;
   and each workload's verdict must be `checked <n> requests: same` with its declared positive n
   (5 for `staged` and `unstaged`, 1 for the others) and `checks.txt` must hold n requests.
3. `run-pair.sh` and `run-pair-fresh.sh` share one `answers` block: curl writes headers and body to
   files and its own exit status is checked (no pipe), the body must match one Content-Length, any
   nonzero `cmp` or `diff` exit fails, and an empty check list fails. `EXPECT` is refused.

On the workstation, in order:

1. Set `1865/commits.env` and run `pwsh -File export-src.ps1 -Repo <checkout>` after
   `git fetch origin`: the trees `1865/src-{base,head}` and the commits line of
   `1865/results/margin.md`.
2. `sh /m/lock.sh` in a Linux container with cargo, node and the registry (/m is this directory).
3. Declare `1865/results/margin.md`, then `pwsh -File pack.ps1`: `../cycles-1865v3.tar`.

On the quiet host: upload the tar as `/root/cycles-1865v3.tar` and `setup.sh` beside it, run
`sh /root/setup.sh`, then `sh /m/run-all.sh` with nothing else on the host. Copy `/m/1865/results`
back and run `node 1865/gate.mjs <results>`: exit 0 the gate is met, 1 not met, 2 the evidence is
incomplete or inconsistent and no bound is read.

The local dry run (no perf or wrk), the synthetic gate fixtures and the mock-curl negatives are in
`../1865v3-dryrun`.