cd /root/pcc
V=httparena-corten:var
D="-e ARENA_MODE=default"; P="-e ARENA_MODE=percore-builtin"; A="$D -e ARENA_TIMER=alt"; X="-e ARENA_DEADLINE=off"
r() { LABEL=$1 SERVER_ENV="$2" bash run3.sh $V "$3" "${4:-3}"; }
# Steady state: 30 s runs.
export OUT=/root/pcc/steady.tsv
r s-default "$D" async30 2
r s-alt     "$A" async30 2
r s-percore "$P" async30 2
r s-alt     "$A" async30 1
r s-default "$D" async30 1
echo E1-DONE
# The deadline's timer on a staged route that sleeps.
export OUT=/root/pcc/deadline.tsv
r d-default      "$D" async-staged
r d-default-off  "$D $X" async-staged
r d-alt          "$A" async-staged
r d-alt-off      "$A $X" async-staged
r d-percore      "$P" async-staged
r d-percore-off  "$P $X" async-staged
echo E2-DONE
# Few busy connections.
export OUT=/root/pcc/few.tsv
r f-default "$D" baseline@64,baseline@256 5
r f-percore "$P" baseline@64,baseline@256 5
r f-alt     "$A" baseline@64,baseline@256 5
r g-percore "$P" baseline@64,baseline@256 5
r g-default "$D" baseline@64,baseline@256 5
echo E4-DONE
# The pooled wait with a pool that does not limit: the server's CPU does.
export ECHO=1 LOAD_CPUS=24-39 THREADS=16 OUT=/root/pcc/pool2.tsv
S="-e ARENA_POOL=4032"
r c-default         "$D $S" pool,spool
r c-default-off     "$D $S $X" spool
r c-alt             "$A $S" pool,spool
r c-percore-shared  "$P $S" pool,spool
r c-percore-shr-off "$P $S $X" spool
r c-percore-main    "$P $S -e ARENA_POOL_KIND=main" pool,spool
r c-percore-own     "$P $S -e ARENA_POOL_KIND=percore" pool,spool
echo E3a-DONE
r e-percore-own     "$P $S -e ARENA_POOL_KIND=percore" pool,spool
r e-percore-main    "$P $S -e ARENA_POOL_KIND=main" pool,spool
r e-percore-shr-off "$P $S $X" spool
r e-percore-shared  "$P $S" pool,spool
r e-alt             "$A $S" pool,spool
r e-default-off     "$D $S $X" spool
r e-default         "$D $S" pool,spool
echo BATCH-DONE
