# plan.sh: sourced by build.sh, verify.sh and run.sh once W names the host's workload: plan.env's
# numbers for that workload, trimmed for a dry run. DRYRUN=1 (a test of the scripts, not a
# measurement) keeps the first DRY_K (3) pads of each of the workload's lists, DRY_R (2) pairs and
# DRY_TURN (1) second turns. PADS_P and PADS_Q are then the workload's own lists (padlists.mjs).
P=/m/dl
. $P/plan.env
. $P/commits.env
DRY=${DRYRUN:-0}
# A dry run alone may try the gated part's scripts with the base as both sides
# (DRYRUN=1 DRY_GATED_BASE=1, whatever part plan.env names): the head's place is taken by the
# base's own tree, so the second side's build, map record and checks and the gated reading all
# run, and no cycle of the head is counted. Outside a dry run the name is refused.
DRY_GATED=${DRY_GATED_BASE:-0}
if [ "$DRY_GATED" != 0 ]; then
    [ "$DRY" = 1 ] && [ "$DRY_GATED" = 1 ] || { echo "plan.sh: DRY_GATED_BASE is 1 and a dry run's alone (DRYRUN=1): refused"; exit 1; }
    PART=gated; HEAD=$BASE
fi
case "${W:-}" in plain|wait|close|unstaged|after|beside|besidemt) ;; *) echo "plan.sh: the workload is plain, wait, close, unstaged, after, beside or besidemt, not '${W:-}'"; exit 2 ;; esac
case "$PART" in pilot|gated) ;; *) echo "plan.env: PART is pilot or gated, not '$PART'"; exit 1 ;; esac
U=$(echo "$W" | tr a-z A-Z)
eval "K=\${K_$U:-}; SEED=\${SEED_$U:-}; PADS_P=\${PADS_P_$U:-}; PADS_Q=\${PADS_Q_$U:-}"
[ "${K:-x}" -ge 5 ] 2>/dev/null && [ "$K" -le 254 ] || { echo "plan.env: K_$U must be a whole number from 5 to 254"; exit 1; }
[ "$(echo $PADS_P | wc -w)" = "$K" ] && [ "$(echo $PADS_Q | wc -w)" = "$K" ] || { echo "plan.env: PADS_P_$U and PADS_Q_$U must hold K_$U=$K sizes each"; exit 1; }
[ "${SEED:-x}" -ge 0 ] 2>/dev/null && [ "${PLACEMENT_TIMEOUT:-x}" -gt 0 ] 2>/dev/null \
    || { echo "plan.env: SEED_$U and PLACEMENT_TIMEOUT must be whole numbers"; exit 1; }
# No placement is run again: a plan.env that names a count of retries is another kit's.
[ -z "${RETRY_MAX+x}" ] || { echo "plan.env: RETRY_MAX is set, and this kit runs no placement again"; exit 1; }
if [ "$DRY" = 1 ]; then K=${DRY_K:-3}; R=${DRY_R:-2}; TURN=${DRY_TURN:-1}; fi
PADS_P=$(echo $PADS_P | tr ' ' '\n' | head -n "$K" | paste -sd' ' -)
PADS_Q=$(echo $PADS_Q | tr ' ' '\n' | head -n "$K" | paste -sd' ' -)
nth() { echo $2 | cut -d' ' -f"$1"; }
# The sides build.sh compiles and the comparisons run.sh turns: the pilot reads the base alone.
if [ "$PART" = pilot ]; then SIDES="base"; CMPS="pilot-$W"; else SIDES="base head"; CMPS="aa-$W change-$W"; fi
# The commit each side's source must be (commits.env): build.sh and run.sh refuse any other, and
# bin/built-for.txt names them with the part, the workload and K.
commit_of() { if [ "$1" = base ]; then echo "$BASE"; else echo "$HEAD"; fi; }
# The tree a side is built from: src-<side>, and in a dry run of the gated part's scripts with
# the base as both sides the base's for both (no src-head is written or read then).
src_of() { if [ "$DRY_GATED" = 1 ]; then echo base; else echo "$1"; fi; }
# The kit on the host is the kit that was packed: every file by its sha256 (kit-files.sha256,
# which pack.sh writes; plan.md, put beside the kit, is not in it) and each side's tree by the
# sha256 of its files' sha256sum lines (kit-trees.sha256). build.sh and run.sh stop otherwise;
# kit_check prints why.
kit_check() {
    [ -f $P/kit-files.sha256 ] && [ -f $P/kit-trees.sha256 ] || { echo "no kit-files.sha256 or kit-trees.sha256: the kit was not packed by pack.sh"; return 1; }
    ( cd $P && sha256sum -c --quiet kit-files.sha256 >/tmp/dl-kit-check 2>&1 ) || { echo "a file of the kit is not the one packed: $(head -3 /tmp/dl-kit-check | tr '\n' ' ')"; return 1; }
    for kc_s in $SIDES; do
        kc_t=src-$(src_of $kc_s)
        kc_l="$(cd $P && find $kc_t -type f | LC_ALL=C sort | xargs sha256sum | sed 's/^\([0-9a-f]\{64\}\) [ *]/\1  /' | sha256sum | cut -d' ' -f1)  $kc_t/"
        grep -qxF "$kc_l" $P/kit-trees.sha256 || { echo "$kc_t is not the tree packed (kit-trees.sha256)"; return 1; }
    done
}
BUILT_FOR="part $PART workload $W K $K sides $SIDES commits$(for s in $SIDES; do printf ' %s' "$(commit_of $s)"; done)"
# The counters every turn reads.
EVENTS=cycles:u,cycles:k,instructions:u,L1-icache-load-misses:u
# How every server is started.
J="env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:524288 PROBE_ALLOCATOR=jemalloc"
# The workload's request and the wrk script that sends it; the probe's configuration (plain: one
# single-threaded runtime; plain-mt: tokio's multi-threaded runtime with one worker); the load
# (wrk's threads and connections and the CPUs it is held to); and, for the two workloads that
# have one, the path an idle connection asks for three times before each turn (idle.mjs).
conf=plain; load_t=2; load_c=64; load_cpus=4,5; idle=
case "$W" in
    plain) path=/private; lua=get.lua ;;
    wait) path=/wait; lua=get.lua ;;
    close) path=/wait; lua=close.lua ;;
    unstaged) path=/unstaged; lua=get.lua ;;
    # The URL is the request that is counted; the script sends each thread's first requests to /wait.
    after) path=/private; lua=after.lua ;;
    # One connection that never waits, beside one that waited three times and is idle.
    beside) path=/private; lua=get.lua; load_t=1; load_c=1; load_cpus=4; idle=/wait ;;
    besidemt) path=/private; lua=get.lua; load_t=1; load_c=1; load_cpus=4; idle=/wait; conf=plain-mt ;;
esac
