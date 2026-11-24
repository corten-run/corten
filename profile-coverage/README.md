# What a profile's coverage does to a request's instructions: what was measured, and with what

Backs the table in `docs/guide/deploy.md` (A profile-guided build) that says what a training
command must cover. Measured on 2026-11-24 on `examples/card-market` at
`be1192a7b9645d49f216af6fd2cffb1ded213608` (main), the commit this one is on.

## What ran

`measure.sh <pass>`, in a `rust:1-trixie` container on a 16-CPU Xeon Platinum 8280 host with the
tree at that commit:

1. Builds the `corten` command from the tree (`cargo build --release --locked -p corten-cli`).
2. Builds card-market four times with it, at the workspace's root, with the workspace's release
   profile and zstd linked to the image's `libzstd` (`ZSTD_SYS_USE_PKG_CONFIG=1`, as the
   example's Dockerfile sets it):
   `corten build --locked -p card-market` (`none`), and
   `corten build --locked -p card-market --profile-from sh train.sh <profile>` for each of
   `train.sh`'s three profiles. The copy and the counted servers read one item from
   `examples/card-market/fixtures/smoke.json` (`ITEM_SOURCE=fixture`).
3. Asks each binary for each case and compares what they answered (`answers-*.txt`).
4. Counts each case three times on each binary with `count.py`: callgrind over one keep-alive
   connection, the server on one CPU, 1,240 requests less 240 over 1,000, jemalloc preloaded
   (`background_thread:false,tcache_max:524288`).

`train.sh` sends 300 requests a line, five on a connection, with curl:

| Profile | Home page `/` | Item page `/items/item_5` | Item JSON `/api/items/item_5` |
|---|---|---|---|
| `all` | no coding, zstd, Brotli | no coding, zstd, Brotli | no coding |
| `no-item` | no coding, zstd, Brotli | not asked for | no coding |
| `no-br` | no coding, zstd | no coding, zstd | no coding |

"zstd" is a request with Chromium's and Firefox's `Accept-Encoding: gzip, deflate, br, zstd`,
which the app answers in zstd, and "Brotli" one with WebKit's over HTTPS, `gzip, deflate, br`.
The build logs have what each copy was sent and answered with (`train <profile>: ...`).

Pass 1 started from an empty target directory. Pass 2 started from pass 1's: it took each
profile again and built each profiled release again from it, so its three profiled binaries are
other files than pass 1's (`binaries.txt`), and `none` is the same file.

## Results

`results/run.log` is both passes' output as printed. `results/pass<N>/`:

1. `count-<build>.txt`: each case's three counts and their median, least and most.
2. `answers-<build>.txt` and `answers.txt`: each case's status, coding, type and body length,
   the same in the four builds.
3. `build-<build>.log`, `build-cli.log`: the builds, with the training's lines.
4. `binaries.txt`: each binary's SHA-256 and size. `versions.txt`: rustc, Cargo, valgrind, curl,
   Python, jemalloc, libzstd, the CPU and the kernel.

Instructions a request, the median of three counts, pass 1 / pass 2:

| Case | `none` | `all` | `no-item` | `no-br` |
|---|---|---|---|---|
| item | 77,800 / 77,754 | 65,421 / 65,414 | 80,967 / 80,965 | 64,477 / 64,449 |
| item-zstd | 348,251 / 348,251 | 334,610 / 334,605 | 350,013 / 350,014 | 333,601 / 333,573 |
| item-br | 844,544 / 844,536 | 770,959 / 770,970 | 905,245 / 905,243 | 989,576 / 989,510 |
| home | 32,384 / 32,362 | 24,259 / 24,257 | 23,737 / 23,735 | 23,982 / 23,941 |
| home-zstd | 116,034 / 116,009 | 106,533 / 106,461 | 105,757 / 105,749 | 106,151 / 106,191 |
| home-br | 230,893 / 230,893 | 197,244 / 197,215 | 194,153 / 194,155 | 252,889 / 252,861 |
| json | 65,729 / 65,728 | 56,860 / 56,856 | 56,580 / 56,582 | 56,641 / 56,625 |

Three counts of one binary differed by at most 69 instructions (`all`, item-zstd, pass 2), and a
median moved by at most 0.17% between the passes (`no-br`, home: 23,982 and 23,941).

Not measured: cycles or time. A count is the work a request takes, not how long it takes.

An earlier run of the same builds and counts, before `measure.sh` took a pass number, is not
kept here; its medians were within 0.1% of pass 1's.
