# plan.sh: sourced by build.sh, verify.sh and run.sh: plan.env's numbers, trimmed for a dry run.
# DRYRUN=1 (a container test, not a measurement) keeps the first DRY_K (5) pads of each list,
# DRY_DIAG_K (2) diagnostic placements and DRY_R (2) pairs.
. /m/1965/plan.env
DRY=${DRYRUN:-0}
if [ "$DRY" = 1 ]; then
    K=${DRY_K:-5}; R=${DRY_R:-2}; DIAG_K=${DRY_DIAG_K:-2}; DIAG_R=$R
    PADS_P=$(echo $PADS_P | tr ' ' '\n' | head -n "$K" | paste -sd' ' -)
    PADS_Q=$(echo $PADS_Q | tr ' ' '\n' | head -n "$K" | paste -sd' ' -)
fi
[ "$(echo $PADS_P | wc -w)" = "$K" ] && [ "$(echo $PADS_Q | wc -w)" = "$K" ] && [ "$DIAG_K" -le "$K" ] \
    || { echo "plan.env: PADS_P and PADS_Q must hold K=$K sizes each, and DIAG_K <= K"; exit 1; }
nth() { echo $2 | cut -d' ' -f"$1"; }