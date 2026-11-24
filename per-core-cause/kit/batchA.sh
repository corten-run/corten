cd /root/pcc
sed -i 's/-F 499/-F 999/' run2.sh
V=httparena-corten:var
D="-e ARENA_MODE=default"; P="-e ARENA_MODE=percore-builtin"
LABEL=v-default SERVER_ENV="$D" bash run2.sh $V baseline,async 3
LABEL=v-percore SERVER_ENV="$P" bash run2.sh $V baseline,async 3
LABEL=stat-default SERVER_ENV="$D" PERF=stat OUT=/root/pcc/perf-runs.tsv bash run2.sh $V async,baseline 1
LABEL=stat-percore SERVER_ENV="$P" PERF=stat OUT=/root/pcc/perf-runs.tsv bash run2.sh $V async,baseline 1
LABEL=rec-default SERVER_ENV="$D" PERF=record OUT=/root/pcc/perf-runs.tsv bash run2.sh $V async,baseline 1
LABEL=rec-percore SERVER_ENV="$P" PERF=record OUT=/root/pcc/perf-runs.tsv bash run2.sh $V async,baseline 1
LABEL=v-percore SERVER_ENV="$P" bash run2.sh $V baseline,async 3
LABEL=v-default SERVER_ENV="$D" bash run2.sh $V baseline,async 3
echo BATCH-DONE
