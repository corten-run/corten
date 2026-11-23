#!/bin/sh
# Checks the warm-up each build reported (the probe's "WARM <config>: <path> accept-encoding ...:
# content-encoding <c>, age <a>, <n> bytes" line in serve-<workload>-{base,head}.log, the answer
# to one more request after its warm-up) before a workload's pairs are run.
# Usage: check-warm.sh <results dir> <workload> <rule>
#   br-smaller   base zstd, head br, head's body smaller, both kept (an age)
#   same:<c>     both <c>, the same bytes, both kept
set -eu
[ $# -eq 3 ] || { sed -n '2,8p' "$0"; exit 2; }
r=$1; w=$2; rule=$3
field() { # <log> <field: coding|age|bytes>
    line=$(grep -m1 '^WARM ' "$1") || { echo "check-warm: $w: no WARM line in $1" >&2; exit 1; }
    case $2 in
        coding) echo "$line" | sed 's/.*content-encoding \([^,]*\),.*/\1/' ;;
        age) echo "$line" | sed 's/.*, age \([^,]*\),.*/\1/' ;;
        bytes) echo "$line" | sed 's/.*, \([0-9]*\) bytes$/\1/' ;;
    esac
}
b=$r/serve-$w-base.log; h=$r/serve-$w-head.log
bc=$(field "$b" coding); hc=$(field "$h" coding); ba=$(field "$b" age); ha=$(field "$h" age)
bn=$(field "$b" bytes); hn=$(field "$h" bytes)
say="base $bc age $ba $bn bytes; head $hc age $ha $hn bytes"
[ "$ba" != - ] && [ "$ha" != - ] || { echo "check-warm: $w: not kept: $say" >&2; exit 1; }
case $rule in
    br-smaller) [ "$bc" = zstd ] && [ "$hc" = br ] && [ "$hn" -lt "$bn" ] ;;
    same:*) [ "$bc" = "${rule#same:}" ] && [ "$hc" = "$bc" ] && [ "$hn" = "$bn" ] ;;
    *) echo "check-warm: unknown rule $rule" >&2; exit 2 ;;
esac || { echo "check-warm: $w: not $rule: $say" >&2; exit 1; }
echo "check-warm: $w: $rule: $say" | tee "$r/warm-$w.txt"