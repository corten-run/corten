# The deadline's timer, eighth evidence directory (2026-11-26)

What was counted after the branch of pull request 2029 merged `main` a fourth time, at
`d15d3ac3a` (the merge commit is `ffc686e39`), for design Choice `choice-deadline-timer` (77) and
for the line design Choice `choice-connection-info` (60) holds a change to the connection task to.
A review of that merge asked for each count; the pull request's note of 2026-11-26 has what was
read from them.

Nothing here is a cycle count, and nothing here is read for a margin: the change's cycles were
measured on `f8934bc99` against `26ab0e37f` across placements (the fifth, sixth and seventh
directories). These are counts of instructions and bytes by Valgrind, of one build of each tree.

Every file is stored byte for byte as it was written, with no line-ending conversion
(`.gitattributes` here says so to git), but `out/versions.txt` (below).

## How it was run

Four sessions on one machine (and a fifth before them, `request-cost/` below), each in a
container of its own made from one image (`image/Dockerfile`: `rust:1-trixie` with valgrind,
jemalloc and python). Each container had this directory's scripts at `/s`, where they are
written to be found and where they wrote `out/`; the
repository's `.git` at `/repo.git`, read only; one volume at `/w` for the trees, the builds and
the binaries; and a limit of 1,048,576 open files. `prep.sh` ran first and once: it wrote the
record of the tools and extracted five trees by `git archive`, which `out/trees.txt` names:

| Name in the files | Commit | What it is |
|---|---|---|
| `main` | `26ab0e37f` | `main` as the branch had merged it before this merge (the control's base) |
| `b` | `f8934bc99` | the branch before this merge (the control's head) |
| `newbase` | `d15d3ac3a` | `main` as this merge took it |
| `merge` | `ffc686e39` | the merge commit |
| `k1` | `9060dfb2a` | the commit Choice 60 gives its line at |

The commands that started the containers are not kept: they name the machine's directories.

## Choice 60's harness (`c60-run.sh`)

`c60h/` is the harness Choice 60's Last checked describes, as it was built again on 2026-11-25:
`c60h/c60/` (a crate of its own with one typed `GET /` answering `served`, served by
`corten::serve` on a current-thread runtime, default features off, thin LTO and one codegen
unit) and `c60h/c60.py` (the client and the count: Callgrind, the run of 1,200 requests less
the run of 200, over 1,000, the builds alternating round by round, every status and body
checked; `C60_JEMALLOC=1` preloads jemalloc). `c60-run.sh` is the session as run: the crate
built against each of three trees with that tree's `Cargo.lock` (`k1`, and `newbase` and
`merge` under the names `base` and `head`), then two sessions of three rounds, each with
glibc's allocator and with jemalloc preloaded.

1. `out/c60/built.txt`: each binary's first 12 digits of sha256 and its tokio and hyper.
   `build-*.log` and `Cargo.lock-*` are each build's log and lock file.
2. `out/c60/glibc-1.txt`, `glibc-2.txt`, `je-1.txt`, `je-2.txt`: every count of the two sessions
   (instructions a request, with the two totals it is the difference of), then each build's
   median and range. `out/c60-run.log` is the session's own output.

Read from them, instructions a request, the median of three rounds with its range, the first
session and then the second:

| Build | glibc's allocator | jemalloc preloaded |
|---|---|---|
| `9060dfb2a` | 17,554.920 (17,554.778-17,556.058); 17,554.916 (17,553.216-17,555.770) | 16,000.617 (15,957.159-16,000.727); 16,001.631 (15,957.729-16,045.045) |
| `d15d3ac3a` | 16,972.596 (16,971.613-16,975.479); 16,974.877 (16,972.395-16,975.306) | 15,412.503 (15,412.020-15,412.678); 15,414.189 (15,413.809-15,457.125) |
| `ffc686e39` | 16,998.608 (16,997.765-17,001.696); 16,997.529 (16,997.230-16,998.568) | 15,434.935 (15,434.348-15,435.178); 15,435.759 (15,391.683-15,435.940) |

The merge over `main` as it took it: 26.0 and 22.7 more with glibc's allocator, 22.4 and 21.6
more with jemalloc preloaded. With jemalloc preloaded five of the eighteen readings lie about 43
from their build's level (three of `9060dfb2a`, one of each of the others) and no median moved.
The binary of `9060dfb2a` has the digest the session of 2026-11-25 recorded for it
(`51bafc31e8e2`).

## Choice 77's rows (`rows-run.sh`)

The session the third directory's `rows/r6-count.sh` ran, for the four trees `main`, `b`,
`newbase` and `merge`: the benchmark app (`entry.tgz`, unpacked into each tree, with its one call
of `App::per_core`, which `main` does not have, taken out) built against each tree with that
tree's `Cargo.lock` and `--cfg tokio_unstable`, then rows 1 to 4, 5 and 6 and 9 on both
runtimes, two rounds with the builds in opposite orders, three counts each, by `ev/count6.py`
(the third directory's counter, unchanged).

1. `out/rows/`: every count, each build's log and lock file, and `built.txt` (each build's hyper
   and tokio and the first 16 digits of its binary's sha256). `out/rows-run.log` is the
   session's output.
2. `out/rows.txt`: the table made from `out/rows/` by `ev/rows.mjs`: for each row and runtime,
   both rounds' medians of both pairs and each pair's difference.

The session read worse than those the third and fourth directories hold: the machine ran other
work beside it, three counts of one build are up to 125 apart on the kept-alive rows and up to
648 on a connection for each request, and the control's differences are as far from what the
same code counted before as the merged pair's are from the control's. Choice 77 says what is
and is not read from it.

## An idle connection's bytes, and the poll by function (`after-run.sh`)

On the four binaries the rows session built, while that session was still counting on CPU 0 in
its own container: so this one put `shim/taskset` first on its path, which pins the server to
CPU 6 where the counters ask for CPU 0. Instructions and bytes do not depend on which CPU it is.

1. `out/after/idle-*.txt`: DHAT's bytes and blocks live for each of 600 idle connections less
   100, over 500, in five states, two runs each, by `ev/idle5.py` over `ev/extra.py` and
   `ev/count2.py` (the fourth directory's, `after-review/first/`, unchanged).
2. `out/after/prof-count-*.txt`: one count of the staged request that does not wait (row 1) for
   each binary and runtime, by `ev/count7.py --keep` (the fourth directory's, `counts/`).
3. `out/after/prof.txt`: from the Callgrind files those counts kept, by `ev/fnprof.py` (the
   fourth directory's) and `callsof.py` (new here): each pair's difference by function, and for
   each binary the own instructions a request of the functions that poll a connection and the
   calls a request to them with their callers.
4. `out/after/symbols.txt`: each binary's symbols that name the wrapper or the connection's poll
   (`nm -C`).
5. `out/after-run.log` is the session's output.

The 16 Callgrind files themselves (about 300 kB each) are not kept;
`out/after/callgrind-left-out.sha256` has each one's name and sha256.

Read from them: a connection holds 20,158 bytes on `main` in every state, 20,286 on `b` after a
request that does not wait or one that does and 20,398 after two or three that wait; 20,198 on
`newbase` in every state, and 20,326 and 20,438 on `merge`. The function that polls a
connection counts 386 instructions a request with the wrapper and 369 without it, at one call a
request, in both pairs and on both runtimes.

## A test against a lost wake (`lost/`)

The review asked for a test in which a deadline waits on its connection's kept timer when
shutdown begins and is required to fire at its own time, not when its connection's time is up.
`lost/lost.sh` is its check as run on the tree of the commit `out/lost/tree.txt` names, which
has the test: the test named there before it and the new one, on the tree as it is, and then with
one rule broken by `lost/lost.py` (once shutdown has begun, a deadline on a kept timer polls it
with a waker that does nothing, so the timer's wake never reaches the connection's task).
`out/lost/as-it-is.log` and `out/lost/wake-lost.log` are the two runs, each ending with cargo's
exit status, and `out/lost-run.log` the session's output.

Read from them: on the tree as it is both tests pass (exit 0). With the wake lost the earlier
test passes and the new one fails, "at its deadline, not when its connection's time was up:
1.802512398s" (exit 101).

## The request-cost kit's counts (`request-cost/`)

Taken on the day of the merge, before the sessions above, with `main`'s own kit
(`bench/request-cost` at `ffc686e39`, whose files are the same in `d15d3ac3a`) as its page says,
in a container of `rust:1-trixie` with the tools `setup.sh` adds (valgrind, jemalloc, Node
26.13.1). `build.sh` built each commit's probe with the kit's own `build.sh`, and `count.sh` ran
the page's runs for each, each its own command with its exit status in `status.txt`: the answers
written and compared, instructions a request one at a time and 16 at a time, allocations a
request, and three idle readings of each kind. `run1/` is `d15d3ac3a` and `ffc686e39`; `run2/`
is `26ab0e37f` and `f8934bc99`. The output of the two builds was not kept.

Read from them, the merge over `main` as it took it: 22 more instructions on `get` (of 18,335),
30 on `unstaged` (of 12,528), 31 on `pipeline` (of 10,569) and 21 on `text` (of 17,181); 16 at a
time 5 fewer, 3 more, 2 more and 5 fewer. Each is within 2 of `f8934bc99` over `26ab0e37f`.

## What is left out, and why

1. Three lines of the record of the tools. `prep.sh` wrote the compiler, cargo, valgrind, the
   kernel's release, the CPU's model and count, and jemalloc's package version. The kernel, the
   CPU's model and its count name the machine, and this repository does not record that;
   `out/versions.txt` is that file without those three lines, and is the one file here that is
   not the bytes a session wrote.
2. The commands that started the containers, for the same reason.
3. The 16 Callgrind files of the profile, for their size (listed by name and sha256).

## How to check it

`files.sha256` is the output of `find . -type f ! -name files.sha256 | LC_ALL=C sort | xargs
sha256sum` in this directory: one line `<sha256>  ./<path>` for each file but itself.

```sh
cd deadline-timer-8 && sha256sum -c files.sha256
```
