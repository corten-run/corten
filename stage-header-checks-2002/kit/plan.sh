# plan.sh: sourced by build.sh, verify.sh and run.sh: plan.env's numbers, trimmed for a dry run.
# DRYRUN=1 (a test of the scripts, not a measurement) keeps the first DRY_K (5) pads of each list
# and DRY_R (2) pairs.
. /m/stage/plan.env
DRY=${DRYRUN:-0}
if [ "$DRY" = 1 ]; then
    K=${DRY_K:-5}; R=${DRY_R:-2}
    PADS_P=$(echo $PADS_P | tr ' ' '\n' | head -n "$K" | paste -sd' ' -)
    PADS_Q=$(echo $PADS_Q | tr ' ' '\n' | head -n "$K" | paste -sd' ' -)
fi
[ "$(echo $PADS_P | wc -w)" = "$K" ] && [ "$(echo $PADS_Q | wc -w)" = "$K" ] \
    || { echo "plan.env: PADS_P and PADS_Q must hold K=$K sizes each"; exit 1; }
nth() { echo $2 | cut -d' ' -f"$1"; }
