# plan.sh: sourced by build.sh, verify.sh and run.sh: plan.env's numbers, trimmed for a dry run.
# DRYRUN=1 (a container test, not a measurement) keeps the first DRY_K (5) pads of each list,
# DRY_DIAG_K (2) diagnostic placements and DRY_R (2) pairs, and puts dry/ first on PATH, whose
# `perf` is a stand-in that writes made-up counts (a container has no counters).
. /m/1983/plan.env
DRY=${DRYRUN:-0}
if [ "$DRY" = 1 ]; then
    K=${DRY_K:-5}; R=${DRY_R:-2}; DIAG_K=${DRY_DIAG_K:-2}; DIAG_R=$R
    PADS_P=$(echo $PADS_P | tr ' ' '\n' | head -n "$K" | paste -sd' ' -)
    PADS_Q=$(echo $PADS_Q | tr ' ' '\n' | head -n "$K" | paste -sd' ' -)
    chmod +x /m/1983/dry/perf
    PATH=/m/1983/dry:$PATH; export PATH
fi
[ "$(echo $PADS_P | wc -w)" = "$K" ] && [ "$(echo $PADS_Q | wc -w)" = "$K" ] && [ "$DIAG_K" -le "$K" ] \
    || { echo "plan.env: PADS_P and PADS_Q must hold K=$K sizes each, and DIAG_K <= K"; exit 1; }
nth() { echo $2 | cut -d' ' -f"$1"; }
# The counters every turn reads, and the columns they are written to.
EVENTS=cycles:u,cycles:k,instructions:u,L1-icache-load-misses:u
COLUMNS=cycles_u,cycles_k,instructions_u,l1i_misses_u
# How every server is started: jemalloc and the clock shim preloaded (shim/clockstep.c; its step
# is taken only by a start of the workload `old`, when the driver signals it).
J="env LD_PRELOAD=libjemalloc.so.2:/m/1983/shim/clockstep.so CLOCKSTEP_SECONDS=$STEP MALLOC_CONF=background_thread:true,tcache_max:65536 PROBE_ALLOCATOR=jemalloc"
