cd /root/pcc
V=httparena-corten:var
D="-e ARENA_MODE=default"; P="-e ARENA_MODE=percore-builtin"; A="$D -e ARENA_TIMER=alt"; X="-e ARENA_DEADLINE=off"
r() { LABEL=$1 SERVER_ENV="$2" bash run3.sh $V "$3" "${4:-3}"; }
# Very few connections, and a heavier answer.
export OUT=/root/pcc/few2.tsv
r h-default "$D" baseline@8,baseline@16,baseline@24,json@16,json@64,json@4096 4
r h-percore "$P" baseline@8,baseline@16,baseline@24,json@16,json@64,json@4096 4
echo F1-DONE
# The pooled wait with a pool that does not limit: the server's CPU does. The service gets 12 cores.
export ECHO=1 ECHO_CPUS=36-47 LOAD_CPUS=24-35 THREADS=12 OUT=/root/pcc/pool3.tsv
S="-e ARENA_POOL=4032"
r c-default         "$D $S" pool,spool
r c-default-off     "$D $S $X" spool
r c-alt             "$A $S" pool,spool
r c-percore-shared  "$P $S" pool,spool
r c-percore-shr-off "$P $S $X" spool
r c-percore-main    "$P $S -e ARENA_POOL_KIND=main" pool,spool
r c-percore-own     "$P $S -e ARENA_POOL_KIND=percore" pool,spool
echo F2a-DONE
r e-percore-own     "$P $S -e ARENA_POOL_KIND=percore" pool,spool
r e-percore-main    "$P $S -e ARENA_POOL_KIND=main" pool,spool
r e-percore-shr-off "$P $S $X" spool
r e-percore-shared  "$P $S" pool,spool
r e-alt             "$A $S" pool,spool
r e-default-off     "$D $S $X" spool
r e-default         "$D $S" pool,spool
echo BATCH-DONE
