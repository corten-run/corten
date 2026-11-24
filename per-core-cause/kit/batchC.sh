# The pooled-wait load: the service on cores 40-47, the load on 24-39.
cd /root/pcc
V=httparena-corten:var
D="-e ARENA_MODE=default"; P="-e ARENA_MODE=percore-builtin"
export ECHO=1 LOAD_CPUS=24-39 THREADS=16 OUT=/root/pcc/pool.tsv
r() { LABEL=$1 SERVER_ENV="$2" bash run3.sh $V "$3" "${4:-3}"; }
for size in 1008 72; do
    S="-e ARENA_POOL=$size"
    r p$size-default         "$D $S" pool,spool
    r p$size-default-alt     "$D $S -e ARENA_TIMER=alt" pool,spool
    r p$size-percore-shared  "$P $S" pool,spool
    r p$size-percore-main    "$P $S -e ARENA_POOL_KIND=main" pool,spool
    r p$size-percore-own     "$P $S -e ARENA_POOL_KIND=percore" pool,spool
done
echo PASS1-DONE
for size in 72 1008; do
    S="-e ARENA_POOL=$size"
    r q$size-percore-own     "$P $S -e ARENA_POOL_KIND=percore" pool,spool
    r q$size-percore-main    "$P $S -e ARENA_POOL_KIND=main" pool,spool
    r q$size-percore-shared  "$P $S" pool,spool
    r q$size-default-alt     "$D $S -e ARENA_TIMER=alt" pool,spool
    r q$size-default         "$D $S" pool,spool
done
echo BATCH-DONE
