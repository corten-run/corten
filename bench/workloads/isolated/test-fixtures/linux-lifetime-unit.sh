#!/bin/sh
# Local OS fixture only. Caller owns this fresh transient unit; no cloud or benchmark.
set -eu
test "$#" = 2
unit_path=$(sed -n 's/^0:://p' /proc/self/cgroup)
case "$unit_path" in
  */corten-bench-groups-r999999999-????????????????.service/supervisor) unit_path="${unit_path%/supervisor}" ;;
  */corten-bench-groups-r999999999-????????????????.service) ;;
  *) exit 2 ;;
esac
# Execute the actual production layout code, not a fixture-specific replica.
cd "$2"
exec /bin/bash -ec "$("$1" --input-type=module -e '
import { supervisorBootstrap } from "./bench/workloads/cloud-contract.mjs";
console.log(supervisorBootstrap(process.argv[1]));
console.log(`exec "$1" --test --test-concurrency=1 "$2/bench/workloads/isolated/host-lifetime-linux.test.mjs"`);
' "${unit_path##*/}")" fixture "$1" "$2"
