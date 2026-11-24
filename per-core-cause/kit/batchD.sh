# Few busy connections, as behind a proxy.
cd /root/pcc
V=httparena-corten:var
D="-e ARENA_MODE=default"; P="-e ARENA_MODE=percore-builtin"
export OUT=/root/pcc/few.tsv
r() { LABEL=$1 SERVER_ENV="$2" bash run3.sh $V "$3" "${4:-5}"; }
r f-default "$D" baseline@64,baseline@256
r f-percore "$P" baseline@64,baseline@256
r f-alt     "$D -e ARENA_TIMER=alt" baseline@64,baseline@256
r g-percore "$P" baseline@64,baseline@256
r g-default "$D" baseline@64,baseline@256
echo BATCH-DONE
