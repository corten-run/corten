#!/usr/bin/env bash
# Runs on the check droplet: the declared cycles run for a 512 KiB thread cache limit against the
# 64 KiB one (the second plan in plan.md).
set -uo pipefail
I=corten-card-market-base; F=/root/fixtures-sizes; O=/root/tc2; mkdir -p "$O"
sysctl -qw kernel.perf_event_paranoid=-1
bash /root/tc-pair2.sh "$I" "$F/n20" "br" 41 "$O/long-br.log"
bash /root/tc-pair2.sh "$I" "$F/n160" "br" 41 "$O/long202-br.log"
bash /root/tc-pair2.sh "$I" "$F/n400" "br" 41 "$O/long496-br.log"
bash /root/tc-pair2.sh "$I" "$F/n1" "br" 61 "$O/item-br.log"
bash /root/tc-pair2.sh "$I" "$F/n1" "gzip, deflate, br, zstd" 61 "$O/item-zstd.log"
bash /root/tc-pair2.sh "$I" "$F/n1" "identity" 61 "$O/item-identity.log"
echo "# tc2 done $(date -u +%H:%M:%S)" > "$O/done.txt"
