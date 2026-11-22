#!/bin/sh
# run.sh: corten-run/corten#1824's diagnostic kit (1824c), after setup.sh, nothing else run on or
# logged into the host meanwhile. Started detached by /root/start.sh (or by hand:
#   nohup sh /m/1824c/run.sh >/m/1824c/run.out 2>&1 &
# ); everything ends in /m/1824c/results, and run.out ends ALL-DONE. results/margin.md declares the
# plan, what each pass is for, the readings and the time.
#
#   preflight  perf counts Pass B's core set at 100% here (else stop); each other set is checked
#              and an event the PMU cannot count at 100% is dropped and recorded (events.txt);
#              perf record samples REC_EVENT on CPU 2 and names kernel functions (else Pass A is
#              skipped and recorded); host.txt (CPU, kernel, THP and vm settings, allocators,
#              binaries, cgroup)
#   faultcost  as 1824b: one first demand run of FIRST_MIB, every free page touched once (so no
#              later turn pays for the hypervisor's first use of a page), ROUNDS rounds of
#              demand, populate, thp and touched over 256 MiB, all on CPU 2
#   check      every comparison once with no recorded pair: its answers compared, one unrecorded
#              1 s pair counted or sampled, and each turn's after-check; a failure stops the run
#   pass A     sampled profile: a-je-flat, a-je-graph, a-gl-flat, a-gl-graph, A_PAIRS pairs each
#              (perf record -C 2, room against off, a fresh start every turn), then profile.sh
#              (perf report and perf script of every turn) and profile.mjs (profile.md)
#   pass B     counters: b-je-core, b-gl-core, b-je-tlb, b-gl-tlb, b-je-cache, b-gl-cache,
#              B_PAIRS pairs each (perf stat -p of the server)
#   summary    node summary.mjs results (summary.txt: counters, vmstat, the declared readings)
# A failed comparison is reported and the next goes on. Server CPU 2, wrk CPUs 4 and 5, the
# driver and perf CPU 7, ports 18081-18082.
# Environment: A_PAIRS (5), B_PAIRS (30), FIRST_MIB (4096), ROUNDS (5), PERF (0: no counters and
# no profile, for a container without them; not a measurement), RESULTS (the results directory,
# default /m/1824c/results; it must hold margin.md), PASSES ("A B"), REC_PERIOD (1000003).
set -u
P=/m/1824c; R=${RESULTS:-$P/results}; B=$P/bin
A_PAIRS=${A_PAIRS:-5}; B_PAIRS=${B_PAIRS:-30}; FIRST_MIB=${FIRST_MIB:-4096}; ROUNDS=${ROUNDS:-5}
PERF=${PERF:-1}; PASSES=${PASSES:-A B}; REC_PERIOD=${REC_PERIOD:-1000003}
export PERF REC_PERIOD
PERF_DIR=$P/perf-data
mkdir -p $R
[ -f $R/margin.md ] || { echo "no $R/margin.md: it is written before the run"; exit 1; }
for b in main faultcost; do [ -x $B/$b ] || { echo "no $B/$b: run build.sh"; exit 1; }; done
say() { echo "$*" | tee -a $R/progress.log; }
t_start=$(date +%s)

# jemalloc as the template's image runs it, and glibc's allocator as it comes (1824b's J and G).
J='env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc'
G='env -u LD_PRELOAD -u MALLOC_CONF -u GLIBC_TUNABLES PROBE_ALLOCATOR=glibc'

# Pass B's event sets. Each holds cycles:k and instructions:k (the fixed counters where perf puts
# them) and at most four events of the general counters; core's are the ones every turn needs.
CORE=cycles:u,cycles:k,instructions:u,instructions:k,page-faults,minor-faults,major-faults,context-switches,cpu-migrations
TLB=cycles:k,instructions:k,dTLB-load-misses:k,dTLB-store-misses:k,iTLB-load-misses:k,page-faults,context-switches
CACHE=cycles:k,instructions:k,cache-misses:k,cache-references:k,L1-icache-load-misses:k,L1-icache-load-misses:u,page-faults,context-switches
SOFT='^(page-faults|minor-faults|major-faults|context-switches|cpu-migrations)$'

busy() { taskset -c 2 dd if=/dev/zero of=/dev/null bs=4k count=${1:-200000} 2>/dev/null; }
# 0 when perf counts every event of <events> as a number at 100% here.
countable() { # <events>
    perf stat -x, -e "$1" -o $R/preflight/try.perf -- sh -c 'taskset -c 2 dd if=/dev/zero of=/dev/null bs=4k count=200000 2>/dev/null' >/dev/null 2>&1 || return 1
    awk -F, -v evs="$1" '
        BEGIN { n = split(evs, e, ","); i = 0; ok = 1 }
        /^#/ || NF == 0 { next }
        { i++; bare = e[i]; sub(/:[A-Za-z]+$/, "", bare)
          if (i > n || ($3 != e[i] && $3 != bare) || $1 !~ /^[0-9]+$/ || $5 + 0 < 100) ok = 0 }
        END { exit !(ok && i == n) }' $R/preflight/try.perf
}
# <name> <events>: the set as this host can count it (an event alone it cannot count is dropped,
# then the last hardware event while the whole cannot run at 100%); prints it, logs every drop.
fit() {
    f_n=$1; f_kept=
    for f_e in $(echo "$2" | tr ',' ' '); do
        if echo "$f_e" | grep -Eq "$SOFT" || [ "$f_e" = cycles:k ] || [ "$f_e" = instructions:k ] || countable "cycles:k,$f_e"; then
            f_kept="$f_kept${f_kept:+,}$f_e"
        else
            echo "$f_n: dropped $f_e (not countable alone at 100% here)" >>$R/events.txt
        fi
    done
    while ! countable "$f_kept"; do
        f_last=$(echo "$f_kept" | tr ',' '\n' | grep -Ev "$SOFT" | grep -v '^cycles:k$' | grep -v '^instructions:k$' | tail -1)
        [ -n "$f_last" ] || { echo "$f_n: not countable at 100% even with cycles:k and instructions:k alone" >>$R/events.txt; echo; return; }
        f_kept=$(echo "$f_kept" | tr ',' '\n' | grep -vx "$f_last" | paste -sd, -)
        echo "$f_n: dropped $f_last (the set ran below 100% with it)" >>$R/events.txt
    done
    echo "$f_kept"
}

pf=$R/preflight; mkdir -p $pf
: >$R/events.txt
REC_EVENT=cycles; GRAPH=-g; PROFILE=1; CPUSTAT=1
if [ "$PERF" = 1 ]; then
    countable "$CORE" || { say "perf cannot count $CORE at 100% here:"; cat $R/preflight/try.perf; say ALL-DONE; exit 1; }
    echo "core: $CORE" >>$R/events.txt
    TLB=$(fit tlb "$TLB"); echo "tlb: ${TLB:-(skipped)}" >>$R/events.txt
    CACHE=$(fit cache "$CACHE"); echo "cache: ${CACHE:-(skipped)}" >>$R/events.txt
    # Sampling: cycles on CPU 2, else cpu-clock (then a sample's period is nanoseconds, and the
    # profile's figures are ns a request, not cycles).
    rec() { # <event> <period> [flags]: samples written of a kernel-heavy loop on CPU 2
        r_e=$1; r_p=$2; shift 2
        rm -f /dev/shm/1824c-pf.data
        perf record -C 2 -e "$r_e" -c "$r_p" -P -N -m 8M "$@" -o /dev/shm/1824c-pf.data -- sh -c 'taskset -c 2 dd if=/dev/zero of=/dev/null bs=4k count=400000 2>/dev/null' >/dev/null 2>$pf/record.err || return 1
        sed -n 's/.*(\([0-9]*\) samples).*/\1/p' $pf/record.err | tail -1
    }
    s=$(rec cycles "$REC_PERIOD" || true)
    if [ -z "$s" ] || [ "$s" -le 0 ]; then
        say "perf record cannot sample cycles on CPU 2 here: $(cat $pf/record.err)"
        REC_EVENT=cpu-clock; REC_PERIOD=100000
        s=$(rec cpu-clock 100000 || true)
        [ -n "$s" ] && [ "$s" -gt 0 ] || { say "nor cpu-clock: Pass A is skipped"; PROFILE=0; }
    fi
    if [ $PROFILE = 1 ]; then
        g=$(rec "$REC_EVENT" "$REC_PERIOD" -g --kernel-callchains || true)
        if [ -n "$g" ] && [ "$g" -gt 0 ]; then GRAPH="-g --kernel-callchains"; else GRAPH=-g; g=$(rec "$REC_EVENT" "$REC_PERIOD" -g || true); fi
        [ -n "$g" ] && [ "$g" -gt 0 ] || { say "perf record -g cannot sample here: the graph comparisons are skipped"; GRAPH=; }
        perf report -i /dev/shm/1824c-pf.data --stdio --no-children --sort sym -g none 2>/dev/null >$pf/report.txt || true
        # Pass A counts CPU 2's cycles beside the sampling (perf stat -C 2): both at once must leave
        # the count at 100%, else the count is left out and the profile is not scaled.
        perf record -C 2 -e "$REC_EVENT" -c "$REC_PERIOD" -P -N -m 8M $GRAPH -o /dev/shm/1824c-pf2.data -- sleep 1.5 >/dev/null 2>&1 &
        pfrec=$!
        sleep 0.2
        perf stat -x, -C 2 -e cycles:u,cycles:k -o $pf/cpustat.perf -- sh -c 'taskset -c 2 dd if=/dev/zero of=/dev/null bs=4k count=200000 2>/dev/null' >/dev/null 2>&1 || true
        wait $pfrec || true
        rm -f /dev/shm/1824c-pf2.data
        if awk -F, '/^#/ || NF == 0 { next } { n++; if ($1 !~ /^[0-9]+$/ || $5 + 0 < 100) bad = 1 } END { exit !(n == 2 && !bad) }' $pf/cpustat.perf; then
            CPUSTAT=1; echo "pass A: CPU 2's cycles:u and cycles:k counted at 100% beside the sampling" >>$R/events.txt
        else
            CPUSTAT=0; echo "pass A: CPU 2's cycles not countable at 100% beside the sampling; the profile is not scaled: $(grep -v '^#' $pf/cpustat.perf | tr '\n' ' ')" >>$R/events.txt
        fi
        named=$(grep -c '\[k\] [A-Za-z_]' $pf/report.txt || true); bare=$(grep -c '\[k\] 0x' $pf/report.txt || true)
        echo "preflight sampling: $REC_EVENT every $REC_PERIOD, $s samples; call graphs: ${GRAPH:-none}; kernel functions named $named, by address only $bare" >>$R/events.txt
        [ "$named" -gt 0 ] && [ "$bare" -le "$named" ] || { say "perf report does not name kernel functions here (kptr_restrict $(cat /proc/sys/kernel/kptr_restrict)): Pass A is skipped"; PROFILE=0; }
        rm -f /dev/shm/1824c-pf.data
    fi
fi
export REC_EVENT CPUSTAT
cat $R/events.txt | tee -a $R/progress.log
{ date -u; lscpu; echo; grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list; echo;
  echo "perf_event_paranoid $(cat /proc/sys/kernel/perf_event_paranoid) kptr_restrict $(cat /proc/sys/kernel/kptr_restrict) nmi_watchdog $(cat /proc/sys/kernel/nmi_watchdog 2>/dev/null) perf_event_max_sample_rate $(cat /proc/sys/kernel/perf_event_max_sample_rate) perf_cpu_time_max_percent $(cat /proc/sys/kernel/perf_cpu_time_max_percent) (runs as $(id -un))"; uname -a;
  echo "cmdline: $(cat /proc/cmdline)";
  echo "transparent huge pages:"; grep -r . /sys/kernel/mm/transparent_hugepage/ 2>/dev/null | sed 's#^/sys/kernel/mm/transparent_hugepage/##';
  for v in overcommit_memory compaction_proactiveness extfrag_threshold watermark_scale_factor zone_reclaim_mode min_free_kbytes max_map_count; do echo "vm.$v $(cat /proc/sys/vm/$v 2>/dev/null)"; done;
  echo "cgroup: $(cat /proc/self/cgroup)"; c=$(sed -n 's/^0:://p' /proc/self/cgroup); for f in memory.max memory.high memory.current; do echo "$f $(cat /sys/fs/cgroup$c/$f 2>/dev/null)"; done;
  grep -E '^(MemTotal|MemAvailable|HugePages_Total|Hugepagesize|AnonHugePages)' /proc/meminfo;
  ldd --version | head -1; perf version 2>/dev/null; wrk -v 2>&1 | head -1; node -v;
  echo "main $(cat $P/src-main.commit)";
  dpkg -s libjemalloc2 libzstd1 libc6 wrk linux-perf 2>/dev/null | grep -E '^(Package|Version)';
  echo "binaries (name, sha256, size):"; cat $B/sha256.txt;
  echo "jemalloc as the image: MALLOC_CONF=background_thread:true,tcache_max:65536; glibc: none set";
  echo "pass A: perf record -C 2 -e $REC_EVENT -c $REC_PERIOD -P, flat and ${GRAPH:-(no graph)}; $A_PAIRS pairs a comparison; profile $PROFILE";
  echo "pass B sets:"; cat $R/events.txt;
  echo "every turn on a fresh start; server CPU 2, wrk CPUs 4,5, driver and perf CPU 7; B_PAIRS $B_PAIRS; passes $PASSES"; } >"$R/host.txt" 2>&1
cp $B/sha256.txt $R/sha256.txt

say "== 1824c faultcost $(date -u +%T)"
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

# <name> <out dir> <pairs, or full> <warm-up pairs> <turn seconds>: runs that comparison (A: the
# store with room, B: the store off, the same binary and allocator).
comparison() {
    c_n=$1; c_out=$2; c_req=$3; c_w=$4; c_t=$5
    case $c_n in
        a-je-*|b-je-*) c_x=$J; c_alloc=jemalloc ;;
        a-gl-*|b-gl-*) c_x=$G; c_alloc=glibc ;;
        *) echo "unknown comparison $c_n"; return 2 ;;
    esac
    case $c_n in
        a-*-flat) c_mode=record; c_flags=; c_full=$A_PAIRS; c_ev= ;;
        a-*-graph) c_mode=record; c_flags=$GRAPH; c_full=$A_PAIRS; c_ev=
            [ -n "$GRAPH" ] || { echo "$c_n: skipped (perf record -g cannot sample here)"; return 1; } ;;
        b-*-core) c_mode=stat; c_ev=$CORE; c_full=$B_PAIRS ;;
        b-*-tlb) c_mode=stat; c_ev=$TLB; c_full=$B_PAIRS ;;
        b-*-cache) c_mode=stat; c_ev=$CACHE; c_full=$B_PAIRS ;;
        *) echo "unknown comparison $c_n"; return 2 ;;
    esac
    if [ $c_mode = stat ] && [ -z "$c_ev" ]; then echo "$c_n: skipped (no countable events: events.txt)"; return 1; fi
    if [ $c_mode = record ] && [ "$PERF" = 1 ] && [ $PROFILE != 1 ]; then echo "$c_n: skipped (no profile here: events.txt)"; return 1; fi
    if [ "$c_req" = full ]; then c_p=$c_full; else c_p=$c_req; fi
    MODE=$c_mode EVENTS=$c_ev REC_FLAGS=$c_flags PERF_DIR=$PERF_DIR AFTER_A=kept-new AFTER_B=unkept-new \
        CHECKS=$P/checks-new.txt MASK=$P/mask.sed WARMUP=$c_w TURN=$c_t \
        taskset -c 7 sh $P/run-pair.sh "$c_out" "$c_n" "$c_p" /page "$P/lua/new-url.lua" "$c_x $B/main \$PORT room" "$c_x $B/main \$PORT off" || return 1
    # What each side's log must say: the allocator asked for and no refused MALLOC_CONF.
    for c_v in base head; do
        c_f=$c_out/serve-$c_n-$c_v.log
        ! grep -qi 'invalid conf\|jemalloc.*error' "$c_f" || { echo "$c_n $c_v: jemalloc refused its settings: $(grep -i 'conf' "$c_f" | head -2)"; return 1; }
        grep -q "^ALLOCATOR $c_alloc" "$c_f" || { echo "$c_n $c_v: not the allocator asked for"; return 1; }
    done
}

A_LIST="a-je-flat a-je-graph a-gl-flat a-gl-graph"
B_LIST="b-je-core b-gl-core b-je-tlb b-gl-tlb b-je-cache b-gl-cache"
LIST=
case " $PASSES " in *" A "*) LIST="$A_LIST" ;; esac
case " $PASSES " in *" B "*) LIST="$LIST $B_LIST" ;; esac
say "== 1824c check start $(date -u +%T)"
C=$R/check-only
for c in $LIST; do
    if comparison $c $C 0 1 1 >>$C.log 2>&1; then
        say "$c: $(cat $C/answers-$c/verdict.txt)"
    elif grep -q "^$c: skipped" $C.log; then
        say "$(grep "^$c: skipped" $C.log | tail -1)"
    else
        tail -20 $C.log; say "CHECK-FAILED: $c"; say ALL-DONE; exit 1
    fi
done
say "== 1824c checks ok $(date -u +%T)"

FAILED=
run() { # <comparison>
    say "== $1 start $(date -u +%T)"
    if comparison $1 $R full 1 3 >>$R/run.log 2>&1; then say "== $1 ok $(date -u +%T)"; else say "== $1 FAILED or skipped $(date -u +%T)"; tail -5 $R/run.log; FAILED="$FAILED $1"; fi
}
case " $PASSES " in *" A "*)
    rm -rf $PERF_DIR; mkdir -p $PERF_DIR
    for c in $A_LIST; do run $c; done
    if [ "$PERF" = 1 ] && [ $PROFILE = 1 ]; then
        say "== profile reports $(date -u +%T)"
        echo "perf_event_max_sample_rate after pass A: $(cat /proc/sys/kernel/perf_event_max_sample_rate)" >>$R/host.txt
        taskset -c 7 sh $P/profile.sh $R $PERF_DIR >>$R/run.log 2>&1 || say "profile.sh failed (run.log)"
        node $P/profile.mjs $R >$R/profile.md 2>>$R/run.log || say "profile.mjs failed (run.log)"
        # The raw samples, compressed, only while all of them come to 50 MB or less (else the
        # flat pass's alone, else none); the text reports are always kept.
        ( cd $PERF_DIR && ls *.data >/dev/null 2>&1 ) && {
            cp /proc/kallsyms $PERF_DIR/kallsyms.txt 2>/dev/null
            tar -C $PERF_DIR -cf - . | zstd -q -19 -T6 -o $R/perf-data.tar.zst
            size=$(stat -c %s $R/perf-data.tar.zst)
            if [ $size -gt 52428800 ]; then
                rm -f $R/perf-data.tar.zst
                ( cd $PERF_DIR && tar -cf - kallsyms.txt *-flat-*.data ) | zstd -q -19 -T6 -o $R/perf-data-flat.tar.zst
                fsize=$(stat -c %s $R/perf-data-flat.tar.zst)
                if [ $fsize -gt 52428800 ]; then rm -f $R/perf-data-flat.tar.zst; say "raw perf data not kept: $size bytes compressed, $fsize the flat pass alone"
                else say "raw perf data: the flat pass alone kept, perf-data-flat.tar.zst, $fsize bytes (all of it was $size)"; fi
            else say "raw perf data kept: perf-data.tar.zst, $size bytes"; fi
        }
    fi ;;
esac
case " $PASSES " in *" B "*) for c in $B_LIST; do run $c; done ;; esac
if [ "$PERF" = 1 ]; then
    node $P/summary.mjs $R >$R/summary.txt 2>&1 || say "summary failed"
    grep -v '^JSON' $R/summary.txt
fi
say "failed or skipped:${FAILED:- none}"
say "took $(( ($(date +%s) - t_start) / 60 )) minutes after setup"
say ALL-DONE