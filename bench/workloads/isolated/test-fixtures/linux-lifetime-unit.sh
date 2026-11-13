#!/bin/sh
# Local OS fixture only. Caller owns this fresh transient unit; no cloud or benchmark.
set -eu
test "$#" = 2
unit_path=$(sed -n 's/^0:://p' /proc/self/cgroup)
case "$unit_path" in */corten-bench-groups-r999999999-????????????????.service) ;; *) exit 2 ;; esac
parent="/sys/fs/cgroup$unit_path"
while IFS= read -r pid; do test "$pid" = "$$"; done < "$parent/cgroup.procs"
mkdir "$parent/supervisor"
printf '%s' "$$" > "$parent/supervisor/cgroup.procs"
printf '%s' '+cpu +cpuset +memory +pids' > "$parent/cgroup.subtree_control"
exec "$1" --test --test-concurrency=1 "$2/bench/workloads/isolated/host-lifetime-linux.test.mjs"
