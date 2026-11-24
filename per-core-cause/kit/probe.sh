#!/usr/bin/env bash
# Runs on the droplet. A 30 s load on one variant, looked at in its steady state:
# per-thread time on a CPU and waiting for one (schedstat), mpstat, system calls a thread
# (perf trace -s), the stacks at which threads leave the CPU (sched:sched_switch).
# Usage: LABEL=x SERVER_ENV="-e A=b" probe.sh <image> [profile-args-name]
set -uo pipefail
ROOT=/root/work/httparena-gap/HttpArena
REQ=$ROOT/requests
IMAGE=$1
WHAT=${2:-async}
LABEL=${LABEL:-probe}
D=/root/pcc/probe/$LABEL.$WHAT
mkdir -p "$D"
NAME=httparena-gap-server
docker rm -f -v "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" --network host --cpuset-cpus=0-23 \
    --ulimit memlock=-1:-1 --ulimit nofile=1048576:1048576 \
    -v "$ROOT/data/dataset.json:/data/dataset.json:ro" ${SERVER_ENV:-} "$IMAGE" >/dev/null
sleep 1.5
PID=$(docker inspect -f '{{.State.Pid}}' "$NAME")
case "$WHAT" in
    async)    A="http://localhost:8080 --raw $REQ/async-delay.raw -c 32000 -t 24 -d 30s -p 1" ;;
    baseline) A="http://localhost:8080 --raw $REQ/get.raw,$REQ/post_cl.raw,$REQ/post_chunked.raw -c ${PCONNS:-4096} -t 24 -d 30s -p 1" ;;
esac
# shellcheck disable=SC2086
docker run --rm --network host --cpuset-cpus=24-47 --security-opt seccomp=unconfined \
    --ulimit memlock=-1:-1 --ulimit nofile=1048576:1048576 -v "$REQ:$REQ:ro" httparena-gcannon:gap $A > "$D/gcannon.out" 2>&1 &
G=$!
snap() { for t in /proc/$PID/task/*; do echo "$(basename "$t") $(cat "$t/comm") $(cat "$t/schedstat") $(awk '/ctxt_switches/ {printf "%s ", $2}' "$t/status")"; done > "$1"; }
sleep 8
snap "$D/threads0"; date +%s.%N > "$D/t0"
mpstat -P ALL 1 4 > "$D/mpstat" 2>&1
snap "$D/threads1"; date +%s.%N > "$D/t1"
perf stat -p "$PID" -e task-clock,context-switches,cpu-migrations,cycles,instructions -o "$D/perfstat" -- sleep 3 >/dev/null 2>&1
perf trace -s -p "$PID" -o "$D/trace" -- sleep 1 >/dev/null 2>&1
perf record -e sched:sched_switch -g -p "$PID" -o "$D/switch.data" -- sleep 1 >/dev/null 2>&1
perf record -F 999 -g -p "$PID" -o "$D/cpu.data" -- sleep 3 >/dev/null 2>&1
wait $G
grep -E "requests in|2xx|Latency|Reconnects" "$D/gcannon.out" | head -5
python3 - "$D" <<'PY'
import sys
d = sys.argv[1]
def read(p):
    r = {}
    for line in open(p):
        f = line.split()
        # tid comm... run_ns wait_ns slices vol nonvol
        r[f[0]] = (" ".join(f[1:-5]), int(f[-5]), int(f[-4]), int(f[-3]), int(f[-2]), int(f[-1]))
    return r
a, b = read(d + "/threads0"), read(d + "/threads1")
dt = float(open(d + "/t1").read()) - float(open(d + "/t0").read())
rows = []
for tid in b:
    if tid in a:
        rows.append((b[tid][0], (b[tid][1] - a[tid][1]) / 1e9 / dt * 100, (b[tid][2] - a[tid][2]) / 1e9 / dt * 100, (b[tid][4] - a[tid][4]) / dt, (b[tid][5] - a[tid][5]) / dt))
rows.sort(key=lambda r: -r[1])
print(f"window {dt:.2f}s; threads: name on-cpu% waiting-for-cpu% voluntary-switches/s involuntary/s")
tot = 0
for r in rows:
    tot += r[1]
    if r[1] > 0.5:
        print(f"  {r[0]:<18} {r[1]:6.1f} {r[2]:6.1f} {r[3]:9.0f} {r[4]:7.0f}")
print(f"  total on-cpu: {tot/100:.2f} cores; voluntary switches/s: {sum(r[3] for r in rows):.0f}")
PY
docker rm -f -v "$NAME" >/dev/null 2>&1
echo PROBE-DONE
