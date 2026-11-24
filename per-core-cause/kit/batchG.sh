cd /root/pcc
V=httparena-corten:var2
D="-e ARENA_MODE=default"; P="-e ARENA_MODE=percore-builtin"; A="$D -e ARENA_TIMER=alt"; X="-e ARENA_DEADLINE=off"; K="-e CORTEN_PROTO_KEEP_TIMERS=1"
r() { LABEL=$1 SERVER_ENV="$2" bash run3.sh $V "$3" "${4:-3}"; }
export OUT=/root/pcc/keep.tsv
r k-default      "$D" async-staged,baseline,async
r k-default-keep "$D $K" async-staged,baseline
r k-default-off  "$D $X" async-staged
r k-percore      "$P" async-staged,baseline,async
r k-percore-keep "$P $K" async-staged
r k-alt-keep     "$A $K" async-staged
r k-default-keep "$D $K" async-staged
r k-default      "$D" async-staged
echo G1-DONE
# 8 and 16 connections need no more load threads than connections.
export OUT=/root/pcc/few3.tsv
THREADS=8 LOAD_CPUS=24-31 r i-default "$D" baseline@8,baseline@16 4
THREADS=8 LOAD_CPUS=24-31 r i-percore "$P" baseline@8,baseline@16 4
echo G2-DONE
export ECHO=1 ECHO_CPUS=36-47 LOAD_CPUS=24-35 THREADS=12 OUT=/root/pcc/pool4.tsv
S="-e ARENA_POOL=4032"
r k-default      "$D $S" spool
r k-default-keep "$D $S $K" spool
r k-default-off  "$D $S $X" spool
r k-default-keep "$D $S $K" spool
r k-default      "$D $S" spool
echo BATCH-DONE
