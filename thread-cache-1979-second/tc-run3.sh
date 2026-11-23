#!/usr/bin/env bash
# Runs on a measuring droplet: one host's share of the second declared run for a 512 KiB thread
# cache limit against the 64 KiB one (plan.md, "The second declared run"). Each host takes one
# no-regression workload: first 64 KiB against itself (the same setting under two labels), then
# 64 KiB against 512 KiB, 200 recorded pairs each after one that is not; then one long page for
# the reduction, 40 recorded pairs after one that is not.
# Usage: tc-run3.sh identity|zstd|br
set -uo pipefail
I=corten-card-market-tc; F=/root/fixtures-sizes; O=/root/tc3; mkdir -p "$O"
sysctl -qw kernel.perf_event_paranoid=-1
case "$1" in
    identity) ENC="identity"; LONG=n20; LONGNAME=long33 ;;
    zstd)     ENC="gzip, deflate, br, zstd"; LONG=n160; LONGNAME=long202 ;;
    br)       ENC="br"; LONG=n400; LONGNAME=long496 ;;
    *) echo "usage: tc-run3.sh identity|zstd|br"; exit 2 ;;
esac
{ date -u; uname -r; lscpu | grep -E "Model name|^CPU\(s\)|Thread"; docker --version; wrk -v 2>&1 | head -1; perf --version; id=$(docker create "$I"); docker cp "$id:/app/server" /root/server.bin; docker rm -f -v "$id" >/dev/null; sha256sum /root/server.bin; docker image inspect -f "{{.Id}}" "$I"; cut -d' ' -f1-3 /proc/loadavg; } > "$O/host.txt" 2>&1
A=tc64k B=tc64kb bash /root/tc-pair3.sh "$I" "$F/n1" "$ENC" 201 "$O/aa-item-$1.log"
A=tc64k B=tc512k bash /root/tc-pair3.sh "$I" "$F/n1" "$ENC" 201 "$O/item-$1.log"
A=tc64k B=tc512k bash /root/tc-pair3.sh "$I" "$F/$LONG" "br" 41 "$O/$LONGNAME-br.log"
echo "# tc3 $1 done $(date -u +%H:%M:%S)" > "$O/done.txt"
