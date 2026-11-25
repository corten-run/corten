#!/usr/bin/env bash
# Runs on the 48-CPU host: the workloads of tp48-plan.md in its order, ten rounds each; then each
# workload that stopped on a failed run once more, whole.
cd /root/t48
{ uname -r; nproc; lscpu | sed -n 's/^Model name: *//p'; cat log/toolchain.txt; sha256sum bin/* | cut -c1-16,65-; docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep -E '^(t48:|httparena-gcannon)' | sort; git -C HttpArena log -1 --format='HttpArena %H'; wrk --version 2>&1 | head -1; perf --version; date -u; } > host.txt 2>&1
again=
for w in ${*:-a10 a40 b1024 b8192 c4 c16 c48 f10 d64 d1024 em es}; do
    bash run48.sh $w 10 || again="$again $w"
done
for w in $again; do
    echo "# AGAIN $w $(date -u +%T)"
    grep -P "^$w\t" results.tsv >> results-stopped.tsv
    grep -vP "^$w\t" results.tsv > results.keep; mv results.keep results.tsv
    mv raw/$w.log raw/$w.stopped.log
    bash run48.sh $w 10 || echo "# FAILED-TWICE $w"
done
echo "# QUEUE-DONE $(date -u +%T)"
