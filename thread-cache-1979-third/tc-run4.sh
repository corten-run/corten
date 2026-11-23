#!/usr/bin/env bash
# Runs on a measuring droplet: one host's share of the third declared run for a 512 KiB thread
# cache limit against the 64 KiB one (plan-third.md): the 202,041-byte page with one encoding,
# first 64 KiB against itself (the same setting under two labels), then 64 KiB against 512 KiB,
# 200 recorded pairs each after one that is not. tc-pair3.sh is the second run's, unchanged.
# Usage: tc-run4.sh identity|zstd
set -uo pipefail
I=corten-card-market-tc; F=/root/fixtures-sizes; O=/root/tc4; mkdir -p "$O"
sysctl -qw kernel.perf_event_paranoid=-1
case "$1" in
    identity) ENC="identity" ;;
    zstd)     ENC="gzip, deflate, br, zstd" ;;
    *) echo "usage: tc-run4.sh identity|zstd"; exit 2 ;;
esac
{ date -u; uname -r; lscpu | grep -E "Model name|^CPU\(s\)|Thread"; docker --version; wrk -v 2>&1 | head -1; perf --version; id=$(docker create "$I"); docker cp "$id:/app/server" /root/server4.bin; docker rm -f -v "$id" >/dev/null; sha256sum /root/server4.bin; docker image inspect -f "{{.Id}}" "$I"; cut -d' ' -f1-3 /proc/loadavg; } > "$O/host.txt" 2>&1
A=tc64k B=tc64kb bash /root/tc-pair3.sh "$I" "$F/n160" "$ENC" 201 "$O/aa-long202-$1.log"
A=tc64k B=tc512k bash /root/tc-pair3.sh "$I" "$F/n160" "$ENC" 201 "$O/long202-$1.log"
echo "# tc4 $1 done $(date -u +%H:%M:%S)" > "$O/done.txt"
