#!/usr/bin/env bash
# Runs on the check droplet: the declared cycles run for the thread cache limit.
set -uo pipefail
I=corten-card-market-base; F=/root/fixtures-sizes; O=/root/tc; mkdir -p "$O"
sysctl -qw kernel.perf_event_paranoid=-1
bash /root/tc-pair.sh "$I" "$F/n20" "br" 41 "$O/long-br.log"
bash /root/tc-pair.sh "$I" "$F/n160" "br" 41 "$O/long202-br.log"
bash /root/tc-pair.sh "$I" "$F/n1" "br" 61 "$O/item-br.log"
bash /root/tc-pair.sh "$I" "$F/n1" "gzip, deflate, br, zstd" 61 "$O/item-zstd.log"
bash /root/tc-pair.sh "$I" "$F/n1" "identity" 61 "$O/item-identity.log"
echo "# tc done $(date -u +%H:%M:%S)" > "$O/done.txt"
