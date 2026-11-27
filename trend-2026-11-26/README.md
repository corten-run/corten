# The trend's run of 2026-11-26

The first run of `bench/placement/trend.mjs`: `main` against the last release, the workloads
`plain` and `unstaged`, by the plan in `bench/placement/trend/plan.json` as `main` had it at the
head measured. The row it wrote is on `bench/placement/trend/README.md`.

| | |
| --- | --- |
| base | `v0.2.0`, `a833b4e3e55033c5fa179f50cb9291d190aeedfb` |
| head | `main` at `056aba61c56cce4b2672b8f299b4961e476654ef` |
| command | `node bench/placement/trend.mjs <run dir>`, once, after the kit's `setup.sh` and one dry run (`DRYRUN=1`) |
| started | 2026-11-26T18:03:43Z (`run.started`) |
| ended | 2026-11-27T00:52:27Z (`run.ended`) |
| exit | 0 (`run.exit`) |

The host was left alone from the start to the end: no login and no ping. The end was looked for by
a TCP connect to one port every ten minutes, which nothing listened on until the command had
ended.

## What is here

- `run/`: the run's directory as the command left it, each part's `results` as the kit leaves
  them (`plain-pilot`, `plain-gated`, `unstaged-pilot`, `unstaged-gated`, and the two checks),
  with `plan.json`, `row.md`, `declared.txt`, `check.json`, the expected differences of `plain`'s
  answers (`expect-plain.txt`) and the bodies' sizes and hashes. Each part's `work/` is the
  checkout the kit built from.
- `run.out`: what the command printed. `run.started`, `run.ended`, `run.exit`: written by the
  line that started the command.
- `files.sha256`: the SHA-256 of every file here but itself, `omitted.tsv`, `.gitattributes` and
  this page, taken on the host before the copy. `sha256sum -c files.sha256` from this directory
  checks them.
- `.gitattributes`: every file is stored byte for byte, with no line-ending conversion.

## What is left out

- The built binaries, the two build directories of each part and the linker's captured inputs:
  8,840 files of `run/`. `omitted.tsv` lists each by its SHA-256, its size in bytes and its path.
  The kit builds them again from `results/` and the two commits.
- The dry run's directory. It adds no row and reads nothing.
- The output of the host's preparation (`setup.sh`), which names the machine it ran on.

## How the row reads from it

Each workload's figures in the row are the ones in its gated part's `results/report.json`:
`run/plain-gated/results/report.json` and `run/unstaged-gated/results/report.json`. `node
bench/placement/report.mjs <a part's results>` prints a part's page again from the same files.
