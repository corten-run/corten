# The plan's files: a scope's lines given in one pass

What the cycle plan of corten-run/corten pull request 2067 names beside its prose, kept under the
tag `evidence/scope-lines-plan`. The plan is declared before any turn of it, and these files
decide nothing: when they were tagged no cycle of the head had been counted on any host, and no
turn had been made on a measuring host. The commit's parent is the plan's head, and it adds this
directory alone.

- `plan.json`: the plan file the placement kit reads (`bench/placement` on `main` at
  `c6e9be955`, run unchanged). `node bench/placement/plan.mjs plan-2067/plan.json` prints what it
  declares, with its SHA-256 and that of the list of files it names by path.
- `probe/`: the probe program the plan file names (`probe.dir`).
- `catalog-kit/`: the scripts around `bench/fullstack/count.mjs` for the catalog's `page` and
  `json`, which the plan counts once, on one build of each side (`catalog-kit/catalog/README.md`).
- `look/`: the look at each side's link map, made off the measuring hosts before the plan was
  posted: the kit's `build.sh` on a dry gated part (it starts nothing), then each side's unpadded
  binary asked each workload's request once. `look.sh` and `look2.sh` are what ran,
  `look.out` and `look2.out` what they printed (for this plan and the other declared with it),
  `plan-2067/` each side's map and the kit's record of it, `answers/` the answers.
- `catalog-try/`: a test of `catalog-kit`'s `verify.mjs`, `run.sh` and `report.mjs` on the
  base's image alone, off the measuring hosts, read for nothing. `cat-try.sh` is what ran,
  `cat-try.out` what it printed, `catalog-state/` what the scripts wrote, `results-sample/` one
  invocation's output of `count.mjs`.

Each record has a `SHA256SUMS` of its files. The records are as they were written, with one word
changed in the script of `catalog-try/`: the value of one container label of the build host
reads `author`, and that script's line in `SHA256SUMS` is of the file as it is here. Paths in the
records are the build host's own. `.gitattributes` keeps every file here byte for byte.
