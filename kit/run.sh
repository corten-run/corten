#!/bin/sh
# run.sh: 1846w, the held value's wait behind a kept page's brotli 5 job alone (corten-run/corten#1846,
# results/margin.md), after setup.sh, nothing else run on or logged into the host meanwhile.
# /root/start.sh runs setup.sh and this, detached, into /m/1846w/run.out; collect /m/1846w/results
# when run.out ends with ALL-DONE. Writes results/host.txt and results/sha256.txt, then runs
# wait.sh (results/wait/, results/summary-wait.txt, whose last lines give the declared checks and
# bounds). Environment: WAIT_ROUNDS (40), WAIT_REPS (21), CPUS (2,4,5,7). A dry run in a container:
#   WAIT_ROUNDS=2 WAIT_REPS=2 sh /root/start.sh   (its summary says it is not the declared matrix)
set -u
P=/m/1846w; R=$P/results
WAIT_ROUNDS=${WAIT_ROUNDS:-40}; WAIT_REPS=${WAIT_REPS:-21}; CPUS=${CPUS:-2,4,5,7}; export WAIT_ROUNDS WAIT_REPS CPUS
mkdir -p $R
[ -f $R/margin.md ] || { echo "no $R/margin.md: it is written before the run"; exit 1; }
for b in base head; do [ -x $P/bin/wait-$b ] || { echo "no $P/bin/wait-$b: run build.sh"; exit 1; }; done
[ -d $R/wait ] && { echo "$R/wait exists: a run's results are never written over"; exit 1; }
say() { echo "$*" | tee -a $R/progress.log; }
{ date -u; lscpu; echo; grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list; echo; uname -a;
  RUSTUP_TOOLCHAIN=1.100.0 rustc -vV 2>/dev/null; node --version;
  echo "base $(cat $P/src-base.commit) head $(cat $P/src-head.commit)";
  dpkg -s libjemalloc2 libzstd1 2>/dev/null | grep -E '^(Package|Version)';
  echo "binaries (side, commit, sha256, size):"; cat $P/bin/sha256.txt;
  echo "allocator: jemalloc (LD_PRELOAD=libjemalloc.so.2, MALLOC_CONF=background_thread:true,tcache_max:65536)";
  echo "pass: $WAIT_ROUNDS rounds of one process a build, $WAIT_REPS repetitions each, CPUs $CPUS"; } >"$R/host.txt" 2>&1
cp $P/bin/sha256.txt $R/sha256.txt
say "== 1846w wait start $(date -u +%T)"
if sh $P/wait.sh >>$R/run.log 2>&1; then say "== 1846w wait ok $(date -u +%T)"; grep -v '^JSON' $R/summary-wait.txt; else say "== 1846w wait FAILED $(date -u +%T)"; tail -20 $R/run.log; fi
say ALL-DONE
