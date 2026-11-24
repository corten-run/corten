# plan.sh: sourced by build.sh, verify.sh and run.sh once W names the host's workload: plan.env's
# numbers for that workload, trimmed for a dry run. DRYRUN=1 (a test of the scripts, not a
# measurement) keeps the first DRY_K (3) pads of each of the workload's lists, DRY_R (2) pairs and
# DRY_TURN (1) second turns. PADS_P and PADS_Q are then the workload's own lists (padlists.mjs).
P=/m/dl
. $P/plan.env
. $P/commits.env
DRY=${DRYRUN:-0}
case "${W:-}" in plain|wait|close|unstaged) ;; *) echo "plan.sh: the workload is plain, wait, close or unstaged, not '${W:-}'"; exit 2 ;; esac
case "$PART" in pilot|gated) ;; *) echo "plan.env: PART is pilot or gated, not '$PART'"; exit 1 ;; esac
U=$(echo "$W" | tr a-z A-Z)
eval "K=\${K_$U:-}; SEED=\${SEED_$U:-}; PADS_P=\${PADS_P_$U:-}; PADS_Q=\${PADS_Q_$U:-}"
[ "${K:-x}" -ge 5 ] 2>/dev/null && [ "$K" -le 254 ] || { echo "plan.env: K_$U must be a whole number from 5 to 254"; exit 1; }
[ "$(echo $PADS_P | wc -w)" = "$K" ] && [ "$(echo $PADS_Q | wc -w)" = "$K" ] || { echo "plan.env: PADS_P_$U and PADS_Q_$U must hold K_$U=$K sizes each"; exit 1; }
[ "${SEED:-x}" -ge 0 ] 2>/dev/null && [ "${PLACEMENT_TIMEOUT:-x}" -gt 0 ] 2>/dev/null && [ "${RETRY_MAX:-x}" -ge 0 ] 2>/dev/null \
    || { echo "plan.env: SEED_$U, PLACEMENT_TIMEOUT and RETRY_MAX must be whole numbers"; exit 1; }
if [ "$DRY" = 1 ]; then K=${DRY_K:-3}; R=${DRY_R:-2}; TURN=${DRY_TURN:-1}; fi
PADS_P=$(echo $PADS_P | tr ' ' '\n' | head -n "$K" | paste -sd' ' -)
PADS_Q=$(echo $PADS_Q | tr ' ' '\n' | head -n "$K" | paste -sd' ' -)
nth() { echo $2 | cut -d' ' -f"$1"; }
# The sides build.sh compiles and the comparisons run.sh turns: the pilot reads the base alone.
if [ "$PART" = pilot ]; then SIDES="base"; CMPS="pilot-$W"; else SIDES="base head"; CMPS="aa-$W change-$W"; fi
# The counters every turn reads.
EVENTS=cycles:u,cycles:k,instructions:u,L1-icache-load-misses:u
# How every server is started.
J="env LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=background_thread:true,tcache_max:524288 PROBE_ALLOCATOR=jemalloc"
# The workload's request and the wrk script that sends it.
case "$W" in
    plain) path=/private; lua=get.lua ;;
    wait) path=/wait; lua=get.lua ;;
    close) path=/wait; lua=close.lua ;;
    unstaged) path=/unstaged; lua=get.lua ;;
esac
