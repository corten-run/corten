#!/bin/sh
# profile.sh: the text reports of corten-run/corten#1824's Pass A (1824c), from every recorded
# turn's perf.data (run.sh runs it after the pass, before Pass B; nothing is measured meanwhile).
# Usage: profile.sh <results dir> <perf data dir>
# For each recorded turn of turns-a-*.csv, in <results>/profile/<comparison>/:
#   <pair>-<version>.top50.txt   perf report --no-children --sort sym, its header and first 50 rows
#   <pair>-<version>.sym.tsv     the same for every symbol: period|samples|symbol (all of them,
#                                parsed by profile.mjs)
#   <pair>-<version>.comm.tsv    period|samples|command|shared object
#   <pair>-<version>.stats.txt   perf report --stats (samples, lost and throttle events)
# and for the call-graph comparisons:
#   <pair>-<version>.entries.json  every sample's kernel call chain read by entries.mjs (what
#                                  entered the kernel, and the chosen functions anywhere in it)
#   <pair>-<version>.callers.txt   (pairs 1 and 2) perf report --no-children --sort sym with the
#                                  call chains of each symbol over 1% (first 4,000 lines)
set -eu
R=$1; D=$2; P=/m/1824c
for csv in "$R"/turns-a-*.csv; do
    [ -f "$csv" ] || continue
    name=$(basename "$csv" .csv); name=${name#turns-}
    out=$R/profile/$name; mkdir -p "$out"
    tail -n +2 "$csv" | while IFS=, read -r pair version rest; do
        case $pair in w*) continue ;; esac
        f=$D/$name-$pair-$version.data; b=$out/$pair-$version
        [ -f "$f" ] || { echo "profile.sh: no $f"; exit 1; }
        perf report -i "$f" --stdio --no-children --sort sym -g none 2>/dev/null \
            | awk '/^#/ || NF == 0 { if (!started) print; next } { started = 1; if (++n <= 50) print }' >"$b.top50.txt"
        perf report -i "$f" --stdio --no-children --sort sym -F period,sample,sym -t '|' -g none 2>/dev/null \
            | grep -v '^#' | grep . >"$b.sym.tsv" || true
        perf report -i "$f" --stdio --no-children --sort comm,dso -F period,sample,comm,dso -t '|' -g none 2>/dev/null \
            | grep -v '^#' | grep . >"$b.comm.tsv" || true
        perf report -i "$f" --stats >"$b.stats.txt" 2>&1 || true
        [ -s "$b.sym.tsv" ] || { echo "profile.sh: $f gave no symbols"; exit 1; }
        case $name in *-graph)
            perf script -i "$f" -F comm,tid,period,ip,sym,dso 2>/dev/null | node $P/entries.mjs >"$b.entries.json"
            case $pair in 1|2)
                perf report -i "$f" --stdio --no-children --sort sym -g caller,0.5,callee,function,percent --percent-limit 1 2>/dev/null | head -4000 >"$b.callers.txt" ;;
            esac ;;
        esac
        echo "profile.sh: $name $pair $version: $(wc -l <"$b.sym.tsv") symbols"
    done
done