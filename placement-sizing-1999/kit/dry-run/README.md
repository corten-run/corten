# Dry run of kit 1999 after Amendment 1 (not a measurement)

A container test on Todd's workstation, 2026-11-24, image `debian:trixie` (Debian 13; setup.sh
installs rustc 1.100.0 and Debian's `nodejs`), not privileged, the kit bind-mounted at `/m/1999`,
run as `DRYRUN=1 DRY_K_B=2 sh setup.sh` then `DRYRUN=1 DRY_K_B=2 DRY_FAIL_SEQ=3 sh run.sh`.
`dry/perf` stands in for perf, so every count is made up. DRY_K_B=2 runs two placements of B, which
the declared plan cuts (K_B = 0), so the shell path of B is exercised too. DRY_FAIL_SEQ=3 gives the
placement at seq 3 a 1 s limit, to exercise the timeout and the recorded retry. The kit files the
run used are the packed kit's (`results/kit-sha256.txt` matches them; there was no tar on that
container, so its tar line says none).

1. `setup.out`: the OS check (Debian 13), packages, the four builds (base 131 s, head 155 s, x1
   133 s, x2 150 s), each captured link re-run byte-identical to cargo's binary, 16 binaries
   relinked and checked, `SETUP-DONE`.
2. `run.out` and `results/progress.log`: verify (14 binaries), the six per-comparison checks,
   the 15 placements of the seeded schedule (aa-old's five in the order 4, 5, 3, 2, 1). Seq 3,
   unpadded-base p1, was stopped by its 1 s limit (`results/run.log`: "stopped after 1 s
   (timeout, exit 124)"), its attempt kept in `results/failed/unpadded-base-p001-seq3`, and run
   again after the schedule as seq 16 (`results/retries.txt`: `16 unpadded-base 1 retry-of 3`),
   which finished. report.mjs exit 0; the run ends `RUN-ENDED complete: ...` then `ALL-DONE`.
3. `results/report.md` and `report.json`: written by run.sh's own report.mjs call (Node from
   Debian 13). It shows the Amendment 1 readings: run order as time with the seed, the drift test
   with a permutation p, the common median of zero, the sizing rule's model, the CPU line against
   the second run's Xeon 8280 (differs here, so the comparison is marked as unable to separate
   chance from the CPU), the shared pad pairs (not read: 5 pairs, fewer than 30), and each unpadded
   build ranked among A's padded placements.
4. Forced failures, each in its own throwaway container on the same kit before the run above:
   `fail-setup-os.out` (setup.sh with an Ubuntu 24.04 `/etc/os-release` mounted: refused before
   installing anything; `fail-setup-os.run.out` is the run.out it wrote: `RUN-ENDED setup-failed
   at the OS check ...` then `ALL-DONE`) and `fail-missing-binaries.out` (run.sh before any build:
   `RUN-ENDED missing-binaries: ...` then `ALL-DONE`, exit 1). A report.mjs crash (exit 3) and
   the other refusals are covered by check-report.mjs on made-up results, not by this container.
5. `check-report.txt`: `node check-report.mjs dry-run/results` (Node 24 on the workstation),
   92 of 92 (80 made-up cases and 12 on these results and their alterations).

An earlier attempt of this dry run, the same commands on the amended kit before a wording fix in
report.mjs (the shared-pairs line), one more check-report case and PLACEMENT_TIMEOUT 420 rather
than 300, also ended `RUN-ENDED complete` and `ALL-DONE`; its files were not kept. The dry run of
the kit before Amendment 1 is in `history/dry-run-1` (not packed).
