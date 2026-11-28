# The two placement comparisons for `App::own_http1`

The placement kit at `2f8984ddce025c92bade4a6fafd21f4863d25085` ran the
plans declared for [#2133 Answer an HTTP/1.1 connection's requests without a body on Corten's own connection when an app asks (App::own_http1, off unless set)](https://github.com/corten-run/corten/pull/2133).
`declaration.md` gives the setup and thresholds as declared before the runs.

| Plan | What it compares | Plan SHA-256 |
| --- | --- | --- |
| `plan-off/own-http1-off.json` | `e733f3d888450707c049a17cd6100c891966bc87` against `2f8984ddce025c92bade4a6fafd21f4863d25085`, both with the switch off | `f0c299630cd32cea90a94e5f292b360a38b87c86fb446a3e9efd26f644aca225` |
| `plan-on/own-http1-on.json` | `2f8984ddce025c92bade4a6fafd21f4863d25085` with the switch off against `0bcb3138c69f69dab997486c9af87a3660eb0ed4` with it on (`evidence/own-http1-on-variant`) | `3ec67c264a0150f9e83d263665d81bcce12b18882e413d8bae52f62984b240b3` |

## What is here

- `plan-off/`, `plan-on/`: each plan and the probe source and request scripts it names.
- `off-get/`, `off-page/`, `off-pipeline/`, `off-post/`: one workload per directory from the first comparison.
- `on-deep-long/`, `on-pipeline-get/`, `on-post-page/`: the pairs of workloads from the second comparison.
- In each workload or workload-pair directory, `run/` keeps each workload's pilot and gated `results/` byte for byte, with the plan, build and run output. The enclosing directory keeps the declaration output, run timing, output and status.
- `files.sha256`: SHA-256 of the declaration, both plans and their inputs, and every copied run file. Run `sha256sum -c files.sha256` from this directory to check the copies. `.gitattributes` keeps the bytes unchanged in Git.

## What is left out

The dry runs are tests of the kit, not measurements. Build trees, built binaries, captured linking inputs and duplicate build-side copies are not kept: the plans, results and commits identify the inputs needed to build again. Setup and staging output and collection bookkeeping are not measurement records. The separate catalog counts are not part of this evidence.

## How to read it

Use `results/report.md` and `report.json` from each gated part. At the kit commit, `node bench/placement/report.mjs <a part's results>` prints the report again; run it on a copy if the original JSON must not be rewritten. The second comparison's `get` A/A did not resolve, so its margin did not pass and no reduction was established for it.
