# plan.sh: sourced by build.sh, verify.sh, run.sh and run-pair-old.sh: plan.env's numbers, trimmed
# for a dry run. DRYRUN=1 (a container test, not a measurement) keeps the first DRY_K_A (5) pads of
# each list, DRY_K_B placements of B (5, or 0 when the plan has none; set it to test B anyway),
# DRY_K_C (2) of each unpadded comparison, DRY_R (2) pairs and DRY_TURN (1) second turns, and puts
# dry/ first on PATH, whose `perf` is a stand-in that writes made-up counts (a container has none).
P=/m/1999
. $P/plan.env
. $P/commits.env
DRY=${DRYRUN:-0}
if [ "$DRY" = 1 ]; then
    if [ "$K_B" -gt 0 ]; then K_B=${DRY_K_B:-5}; else K_B=${DRY_K_B:-0}; fi
    K_A=${DRY_K_A:-5}; K_C=${DRY_K_C:-2}; R=${DRY_R:-2}; R_C=$R; TURN=${DRY_TURN:-1}
    PADS_P=$(echo $PADS_P | tr ' ' '\n' | head -n "$K_A" | paste -sd' ' -)
    PADS_Q=$(echo $PADS_Q | tr ' ' '\n' | head -n "$K_A" | paste -sd' ' -)
    chmod +x $P/dry/perf
    PATH=$P/dry:$PATH; export PATH
fi
[ "$(echo $PADS_P | wc -w)" = "$K_A" ] && [ "$(echo $PADS_Q | wc -w)" = "$K_A" ] && [ "$K_B" -le "$K_A" ] && [ "$K_C" -le "$K_A" ] \
    || { echo "plan.env: PADS_P and PADS_Q must hold K_A=$K_A sizes each, and K_B, K_C <= K_A"; exit 1; }
[ "${SCHEDULE_SEED:-x}" -ge 0 ] 2>/dev/null && [ "${PLACEMENT_TIMEOUT:-x}" -gt 0 ] 2>/dev/null && [ "${RETRY_MAX:-x}" -ge 0 ] 2>/dev/null \
    || { echo "plan.env: SCHEDULE_SEED, PLACEMENT_TIMEOUT and RETRY_MAX must be whole numbers"; exit 1; }
nth() { echo $2 | cut -d' ' -f"$1"; }
# The sides build.sh compiles (commits.env: BASE, HEAD, X1, X2) and the pads each is placed with:
# base with every p_i and q_i, head with p_1..p_K_C (part C); x1 and x2 are unpadded builds only.
SIDES="base head x1 x2"
HEAD_PADS=$(echo $PADS_P | tr ' ' '\n' | head -n "$K_C" | paste -sd' ' -)
# The counters every turn reads, and the columns they are written to.
EVENTS=cycles:u,cycles:k,instructions:u,L1-icache-load-misses:u
COLUMNS=cycles_u,cycles_k,instructions_u,l1i_misses_u
# How every server is started: jemalloc and the clock shim preloaded (shim/clockstep.c; its step
# is taken only by a start of the workload `old`, when the driver signals it).
J="env LD_PRELOAD=libjemalloc.so.2:$P/shim/clockstep.so CLOCKSTEP_SECONDS=$STEP MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc"