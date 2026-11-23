#!/usr/bin/env bash
# Runs on the check droplet: the diagnostic for the uncompressed workload of the second cycles run
# (plan.md): 64 KiB against 512 KiB again, and 64 KiB against itself under two labels, 100 pairs
# each after one that is not.
set -uo pipefail
I=corten-card-market-base; F=/root/fixtures-sizes; O=/root/tc-diag; mkdir -p "$O"
sysctl -qw kernel.perf_event_paranoid=-1
A=tc64k B=tc512k bash /root/tc-pair2.sh "$I" "$F/n1" "identity" 101 "$O/identity-again.log"
A=tc64k B=tc64kb bash /root/tc-pair2.sh "$I" "$F/n1" "identity" 101 "$O/identity-aa.log"
echo "# tc-diag done $(date -u +%H:%M:%S)" > "$O/done.txt"
