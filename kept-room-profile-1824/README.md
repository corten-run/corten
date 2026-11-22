# corten-run/corten#1824: where the kernel spends a kept-with-room request's cycles (1824c)

The next step named in the last comment on
[#1824 A `Public` page asked for once costs 44% more cycles than the same page not kept](https://github.com/corten-run/corten/issues/1824):
1824b found that with jemalloc (the template image's allocator) a page kept in a store with room
costs the kernel 9,774 cycles a request more than the store off, with only 0.036 page faults a
request. This kit profiles that comparison (jemalloc room against off) and glibc's (where one fault
a new page explains it) with `perf record` on the server's CPU, and counts kernel cycles,
instructions, TLB and cache misses, faults and context switches with `perf stat`, with
`/proc/vmstat` and `smaps_rollup` every turn. Diagnostic only. Local scratch, not repository
documentation. `results/margin.md` declares the passes, what each is for, the readings and which
next step each would justify, and the time (about 35 to 45 minutes on a c-8, estimated), before
the run.

## Run it

On a fresh Debian 13 x64 c-8 droplet (dedicated CPU, root, nothing else running), upload
`D:\Temp\cycles\cycles-1824c.tar` (made by `pack.ps1`) as `/root/cycles-1824c.tar`, then:

```sh
tar -xOf /root/cycles-1824c.tar 1824c/start.sh >/root/start.sh && sh /root/start.sh
```

`start.sh` unpacks the kit into `/m`, runs `setup.sh` (packages, rustc 1.100.0, `build.sh`) and
`run.sh`, detached, both logging to `/m/1824c/run.out`, which ends `ALL-DONE` (or `SETUP-FAILED`).
Then copy back `/m/1824c/results`: `summary.txt` (Pass B's tables, vmstat, the readings and the
NEXT lines), `profile.md` (Pass A's merged top-50 tables, differences, categories, ways into the
kernel, inclusive markers), `profile/<comparison>/` (each turn's `perf report` text and tables),
`perf-data.tar.zst` (the raw samples with `/proc/kallsyms`, only if 50 MB or less), `host.txt`,
`events.txt`, `faultcost.txt`, the CSVs and logs. Do not log in or run anything else while it runs.
Everything is under `/m/1824c` and `/m/target-1824c*`; it uses CPUs 2, 4, 5, 7 and ports
18081-18082, like the 1824b, 1846r and 1923 kits, so not at the same time as any of them.
`setup.sh` sets `kernel.perf_event_paranoid=-1`, `kernel.kptr_restrict=0`, `kernel.nmi_watchdog=0`
and `kernel.perf_cpu_time_max_percent=0` on the host (a throwaway droplet).

In a container: `RESULTS=<dir with margin.md> A_PAIRS=2 B_PAIRS=3 FIRST_MIB=256 ROUNDS=1 sh
/m/1824c/run.sh` runs every step with a few pairs (not a measurement); with `PERF=0` it runs the
turns without perf. That was run locally before packing (`local/`).

## Files

1. `commits.env`, `src-main/`, `src-main.commit`: main's tree (`git archive 7a275ef15 crates
   examples Cargo.toml Cargo.lock .cargo`), the commit 1824b measured, byte for byte 1824b's.
2. `probe/`: 1824b's server (`probe <port> room|off|...`), its header and package name changed.
3. `faultcost/`: 1824b's per-page cost of making memory resident; here also the step that touches
   every free page before the turns, as in 1824b.
4. `setup.sh`, `build.sh`, `run.sh`, `run-pair.sh`, `profile.sh`, `entries.mjs`, `profile.mjs`,
   `summary.mjs`, `start.sh`: their headers say what each does. `lua/`, `checks-new.txt`,
   `mask.sed`: the load scripts and the answer check, as 1824b's.
5. `pack.ps1`: writes the tar after checking the tree, the lock, the margin and line endings.
6. `local/` (not packed): what was run on the workstation: `dry3/` and `dry3.out` (the whole of`n   `run.sh` in a privileged WSL2 container, 2 pairs a comparison, perf counting and sampling;`n   `profile.md` and `summary.txt` regenerated after the last fix to `profile.mjs` and `summary.mjs`),`n   `dry0/` (`PERF=0`, 1 pair), `setup-privileged.out` (`setup.sh` there) and `clean-start.txt``n   (`start.sh` from the tar in a bare unprivileged Debian 13 container, up to the perf stop). The`n   container's THP was `madvise` (the c-8's is `always`), its CPUs shared with other work, and its`n   kernel throttled sampling to 750 a second: none of its numbers is a measurement.