# Connections on each core's event loop under per_core: the sockets each epoll instance holds.
ROOT=/root/work/httparena-gap/HttpArena; REQ=$ROOT/requests; NAME=httparena-gap-server
count() {
  docker rm -f -v $NAME >/dev/null 2>&1
  docker run -d --name $NAME --network host --cpuset-cpus=0-23 --ulimit nofile=1048576:1048576 -v "$ROOT/data/dataset.json:/data/dataset.json:ro" -e ARENA_MODE=percore-builtin httparena-corten:var2 >/dev/null
  sleep 1.5
  PID=$(docker inspect -f '{{.State.Pid}}' $NAME)
  EP=$(for fd in /proc/$PID/fd/*; do [ "$(readlink $fd)" = "anon_inode:[eventpoll]" ] && basename $fd; done)
  docker run --rm --network host --cpuset-cpus=24-47 --security-opt seccomp=unconfined --ulimit memlock=-1:-1 --ulimit nofile=1048576:1048576 -v "$REQ:$REQ:ro" httparena-gcannon:gap $1 >/dev/null 2>&1 &
  sleep 6
  for fd in $EP; do grep -c '^tfd:' /proc/$PID/fdinfo/$fd; done | python3 -c "
import sys
v = sorted(int(x) for x in sys.stdin)
# each epoll instance is open twice; an idle one holds 3 descriptors (2 for the runtime main made)
inst = [x - 3 for x in v[::2] if x >= 3]
print('$2:', len(inst), 'event loops, connections', sum(inst), 'per loop', ' '.join(map(str, inst)))"
  wait
  docker rm -f -v $NAME >/dev/null 2>&1
}
count "http://localhost:8080 --raw $REQ/async-delay.raw -c 32000 -t 24 -d 9s -p 1" "async 32000"
count "http://localhost:8080 --raw $REQ/get.raw -c 4096 -t 24 -d 9s -p 1" "baseline 4096"
count "http://localhost:8080 --raw $REQ/get.raw -c 256 -t 24 -d 9s -p 1" "baseline 256"
count "http://localhost:8080 --raw $REQ/get.raw -c 64 -t 24 -d 9s -p 1" "baseline 64"
count "http://localhost:8080 --raw $REQ/get.raw -c 64 -t 24 -d 9s -p 1" "baseline 64 again"
count "http://localhost:8080 --raw $REQ/get.raw -c 24 -t 24 -d 9s -p 1" "baseline 24"
echo CONNS-DONE
