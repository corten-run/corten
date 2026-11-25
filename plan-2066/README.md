# The plan's files: the shutdown wait polled only when it was woken

What the cycle and time plan of corten-run/corten pull request 2066 names beside its prose, kept
under the tag `evidence/shutdown-poll-plan`. The plan is declared before any turn of it, and
these files decide nothing: when they were tagged no cycle of the head had been counted and no
time taken on any host, and no turn had been made on a measuring host. The commit's parent is the
plan's head, and it adds this directory alone.

- `plan.json`: the plan file the placement kit reads (`bench/placement` on `main` at
  `c6e9be955`, run unchanged). `node bench/placement/plan.mjs plan-2066/plan.json` prints what it
  declares, with its SHA-256 and that of the list of files it names by path.
- `probe/`: the probe program the plan file names (`probe.dir`), the kit's example probe byte
  for byte.
- `catalog-kit/`: the scripts around `bench/fullstack/count.mjs` for the catalog's `page` and
  `json`, which the plan counts once, on one build of each side (`catalog-kit/catalog/README.md`).
- `look/`: the look at each side's link map, made off the measuring hosts before the plan was
  posted: the kit's `build.sh` on a dry gated part (it starts nothing), then each side's unpadded
  binary asked each workload's request once. `look.sh` and `look2.sh` are what ran,
  `look.out` and `look2.out` what they printed (for this plan and the other declared with it),
  `plan-2066/` each side's map and the kit's record of it, `answers/` the answers.
- `time-try/`: a try of the time measurement's images, with no load and nothing read: one image
  of the base and its glibc image, each started once on one CPU and on four, its memory map, one
  answer each, and `bench/fullstack/ab.mjs` given no image. `try-build.sh` and `try.sh` are what
  ran, the two `.out` files what they printed.

The test of the catalog scripts is under the tag `evidence/scope-lines-plan`, at
`plan-2067/catalog-try/`: the scripts tested there differ from this plan's in the commits they
name, the rounds' prefix and the report's heading.

Each record has a `SHA256SUMS` of its files. The records are as they were written, with one word
changed in the two scripts of `time-try/`: the value of one container label of the build host
reads `author`, and those scripts' lines in `SHA256SUMS` are of the files as they are here. Paths
in the records are the build host's own. `.gitattributes` keeps every file here byte for byte.
