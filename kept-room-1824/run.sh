#!/bin/sh
# run.sh: corten-run/corten#1824's measurement kit (1824b), after setup.sh, nothing else run on or
# logged into the host meanwhile. Started detached by /root/start.sh (or by hand:
#   nohup sh /m/1824b/run.sh >/m/1824b/run.out 2>&1 &
# ); everything ends in /m/1824b/results, and run.out ends ALL-DONE. results/margin.md declares the
# plan, the margins and the time.
#
#   preflight  perf counts cycles:u,cycles:k,instructions:u at 100% here (else stop) with the two
#              software fault events; host.txt (CPU, kernel, THP, allocators, binaries)
#   faultcost  what making memory resident costs this host a 4 KiB page (faultcost.txt): one first
#              demand run of FIRST_MIB, then every free page touched once (so no later turn pays
#              for the hypervisor's first use of a page), then ROUNDS rounds of demand, populate,
#              thp and touched over 256 MiB, all on CPU 2
#   check      every comparison once with no recorded pair: its answers compared, one unrecorded
#              1 s pair counted, and each turn's after-check; a failure stops the run here
#   pairs      every comparison (run-pair.sh, a fresh start every turn, the order turned every
#              pair), one unrecorded warm-up pair and its recorded pairs; a failed comparison is
#              reported and the next goes on
#   summary    node summary.mjs results (summary.txt)
# Server CPU 2, wrk CPUs 4 and 5, this script and perf CPU 7, ports 18081-18082.
# Environment: PAIRS_SCALE (percent of each comparison's pairs, default 100), FIRST_MIB (4096),
# ROUNDS (5), PERF (0: no counters, for a container; not a measurement), RESULTS (the results
# directory, default /m/1824b/results; it must hold margin.md).
set -u
P=/m/1824b; R=${RESULTS:-$P/results}; B=$P/bin
SCALE=${PAIRS_SCALE:-100}; FIRST_MIB=${FIRST_MIB:-4096}; ROUNDS=${ROUNDS:-5}; PERF=${PERF:-1}
export PERF
mkdir -p $R
[ -f $R/margin.md ] || { echo "no $R/margin.md: it is written before the run"; exit 1; }
for b in main populate faultcost; do [ -x $B/$b ] || { echo "no $B/$b: run build.sh"; exit 1; }; done
say() { echo "$*" | tee -a $R/progress.log; }

# jemalloc as the template's image runs it, with huge pages, and glibc's allocator three ways.
J='env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc'
JT='env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536,thp:always PROBE_ALLOCATOR=jemalloc'
G='env -u LD_PRELOAD -u MALLOC_CONF -u GLIBC_TUNABLES PROBE_ALLOCATOR=glibc'
GT='env -u LD_PRELOAD -u MALLOC_CONF GLIBC_TUNABLES=glibc.malloc.hugetlb=1 PROBE_ALLOCATOR=glibc'
GP='env -u LD_PRELOAD -u MALLOC_CONF GLIBC_TUNABLES=glibc.malloc.top_pad=67108864:glibc.malloc.trim_threshold=268435456 PROBE_ALLOCATOR=glibc'
COMPARISONS=${COMPARISONS:-"je-room-off je-room-thp je-hit-thp je-plain-thp je-room-populate je-hit-populate je-plain-populate gl-room-off gl-room-thp gl-room-pad"}

# <name> <out dir> <pairs, or full> <warm-up pairs> <turn seconds>: runs that comparison.
comparison() {
    c_n=$1; c_out=$2; c_req=$3; c_w=$4; c_t=$5
    case $c_n in
        je-room-off) set -- 30 /page new-url.lua checks-new.txt "$J $B/main \$PORT room" "$J $B/main \$PORT off" kept-new unkept-new ;;
        je-room-thp) set -- 30 /page new-url.lua checks-new.txt "$J $B/main \$PORT room" "$JT $B/main \$PORT room" kept-new kept-new ;;
        je-hit-thp) set -- 40 /page get.lua checks-page.txt "$J $B/main \$PORT hit" "$JT $B/main \$PORT hit" kept kept ;;
        je-plain-thp) set -- 40 /private get.lua checks-private.txt "$J $B/main \$PORT plain" "$JT $B/main \$PORT plain" unkept unkept ;;
        je-room-populate) set -- 30 /page new-url.lua checks-new.txt "$J $B/main \$PORT room" "$J $B/populate \$PORT room" kept-new kept-new ;;
        je-hit-populate) set -- 30 /page get.lua checks-page.txt "$J $B/main \$PORT hit" "$J $B/populate \$PORT hit" kept kept ;;
        je-plain-populate) set -- 30 /private get.lua checks-private.txt "$J $B/main \$PORT plain" "$J $B/populate \$PORT plain" unkept unkept ;;
        gl-room-off) set -- 20 /page new-url.lua checks-new.txt "$G $B/main \$PORT room" "$G $B/main \$PORT off" kept-new unkept-new ;;
        gl-room-thp) set -- 20 /page new-url.lua checks-new.txt "$G $B/main \$PORT room" "$GT $B/main \$PORT room" kept-new kept-new ;;
        gl-room-pad) set -- 20 /page new-url.lua checks-new.txt "$G $B/main \$PORT room" "$GP $B/main \$PORT room" kept-new kept-new ;;
        *) echo "unknown comparison $c_n"; return 2 ;;
    esac
    # full: the pairs declared above (margin.md), scaled by PAIRS_SCALE; else the number given.
    if [ "$c_req" = full ]; then c_p=$(( $1 * SCALE / 100 )); [ $c_p -ge 1 ] || c_p=1; else c_p=$c_req; fi
    AFTER_A=$7 AFTER_B=$8 CHECKS=$P/$4 MASK=$P/mask.sed WARMUP=$c_w TURN=$c_t \
        taskset -c 7 sh $P/run-pair.sh "$c_out" "$c_n" "$c_p" "$2" "$P/lua/$3" "$5" "$6" || return 1
    # What each side's log must say: the allocator asked for, no refused MALLOC_CONF, and the
    # variant's one line where it kept answers with room.
    for c_v in base head; do
        c_f=$c_out/serve-$c_n-$c_v.log
        ! grep -qi 'invalid conf\|jemalloc.*error' "$c_f" || { echo "$c_n $c_v: jemalloc refused its settings: $(grep -i 'conf' "$c_f" | head -2)"; return 1; }
        case $c_n,$c_v in
            je-*) grep -q '^ALLOCATOR jemalloc' "$c_f" ;;
            gl-*) grep -q '^ALLOCATOR glibc' "$c_f" ;;
        esac || { echo "$c_n $c_v: not the allocator asked for"; return 1; }
    done
    if [ "$c_n" = je-room-populate ]; then
        grep -q '^POPULATE madvise' "$c_out/serve-$c_n-head.log" || { echo "$c_n: populate did not use madvise: $(grep '^POPULATE' "$c_out/serve-$c_n-head.log" | sort | uniq -c)"; return 1; }
        ! grep -q '^POPULATE' "$c_out/serve-$c_n-base.log" || { echo "$c_n: main logged POPULATE"; return 1; }
    fi
}

counts() { # <events> <perf output>
    perf stat -x, -e "$1" -o "$2" -- taskset -c 2 sh -c 'i=0; while [ $i -lt 1000000 ]; do i=$((i + 1)); done' >/dev/null 2>&1 || return 1
    for counts_e in $(echo "$1" | tr ',' ' '); do
        awk -F, -v e="$counts_e" 'BEGIN { n = e; sub(/:u$/, "", n) } ($3 == e || $3 == n) && $1 ~ /^[0-9]+$/ && $5 + 0 >= 100 { ok++ } END { exit ok != 1 }' "$2" || return 1
    done
}
pf=$R/preflight; mkdir -p $pf
if [ "$PERF" = 1 ]; then
    counts cycles:u,cycles:k,instructions:u,page-faults,minor-faults $pf/cycles.perf \
        || { say "perf cannot count cycles:u,cycles:k,instructions:u,page-faults,minor-faults at 100% here:"; cat $pf/cycles.perf; say ALL-DONE; exit 1; }
fi
{ date -u; lscpu; echo; grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list; echo;
  echo "perf_event_paranoid $(cat /proc/sys/kernel/perf_event_paranoid) nmi_watchdog $(cat /proc/sys/kernel/nmi_watchdog 2>/dev/null) (runs as $(id -un))"; uname -a;
  echo "cmdline: $(cat /proc/cmdline)";
  for t in enabled defrag khugepaged/defrag shmem_enabled; do echo "thp $t: $(cat /sys/kernel/mm/transparent_hugepage/$t 2>/dev/null)"; done;
  grep -E '^(MemTotal|MemAvailable|HugePages_Total|Hugepagesize)' /proc/meminfo;
  ldd --version | head -1; perf version 2>/dev/null; wrk -v 2>&1 | head -1; node -v;
  echo "main $(cat $P/src-main.commit); populate = main + variants/populate.diff (sha256 $(sha256sum $P/variants/populate.diff | cut -d' ' -f1))";
  dpkg -s libjemalloc2 libzstd1 libc6 wrk 2>/dev/null | grep -E '^(Package|Version)';
  echo "binaries (name, sha256, size):"; cat $B/sha256.txt;
  echo "jemalloc as the image: MALLOC_CONF=background_thread:true,tcache_max:65536; huge pages: the same with thp:always";
  echo "glibc: none set; huge pages GLIBC_TUNABLES=glibc.malloc.hugetlb=1; pad GLIBC_TUNABLES=glibc.malloc.top_pad=67108864:glibc.malloc.trim_threshold=268435456";
  echo "every turn on a fresh start; server CPU 2, wrk CPUs 4,5, driver and perf CPU 7; PAIRS_SCALE $SCALE"; } >"$R/host.txt" 2>&1
cp $B/sha256.txt $R/sha256.txt

say "== 1824b faultcost $(date -u +%T)"
fc() { # <label> <mode> <MiB>
    fc_l=$(taskset -c 2 $B/faultcost "$2" "$3" 2>&1) || { echo "$1 FAILED $fc_l"; return 1; }
    echo "$1 $fc_l"
}
{
    fc first demand $FIRST_MIB
    avail=$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)
    # Within a cgroup's limit too (a container); a droplet's root shell has none.
    cg=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo max)
    case $cg in ''|max|*[!0-9]*) ;; *) [ $((cg / 1048576)) -ge $avail ] || avail=$((cg / 1048576)) ;; esac
    warm=$((avail - 2048))
    if [ $warm -gt 256 ]; then fc warmed demand $warm; else echo "warmed SKIPPED: MemAvailable $avail MiB"; fi
    r=1
    while [ $r -le $ROUNDS ]; do
        for m in demand populate thp touched; do fc "round $r" $m 256; done
        r=$((r + 1))
    done
} >$R/faultcost.txt 2>&1
cat $R/faultcost.txt | tee -a $R/progress.log

say "== 1824b check start $(date -u +%T)"
C=$R/check-only
for c in $COMPARISONS; do
    comparison $c $C 0 1 1 >>$C.log 2>&1 || { tail -20 $C.log; say "CHECK-FAILED: $c"; say ALL-DONE; exit 1; }
    say "$c: $(cat $C/answers-$c/verdict.txt)"
done
say "== 1824b checks ok $(date -u +%T)"

FAILED=
for c in $COMPARISONS; do
    say "== $c start $(date -u +%T)"
    if comparison $c $R full 1 3 >>$R/run.log 2>&1; then say "== $c ok $(date -u +%T)"; else say "== $c FAILED $(date -u +%T)"; tail -15 $R/run.log; FAILED="$FAILED $c"; fi
done
if [ "$PERF" = 1 ]; then
    node $P/summary.mjs $R >$R/summary.txt 2>&1 || say "summary failed"
    grep -v '^JSON' $R/summary.txt
fi
say "failed:${FAILED:- none}"
say ALL-DONE