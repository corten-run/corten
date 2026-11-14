#!/bin/sh
# Caller owns the fresh delegated unit and original Docker fixture ID and cleanup.
set -eu
test "$#" = 2
test "${BROWSER_PARTICIPANT_OS_TESTS:-}" = 1
test "${BROWSER_PARTICIPANT_NAMESPACE:-}" = matched
test "${#BROWSER_PARTICIPANT_ID}" = 64
case "$BROWSER_PARTICIPANT_ID" in *[!a-f0-9]*) exit 2 ;; esac
unit_path=$(sed -n 's/^0:://p' /proc/self/cgroup)
case "$unit_path" in
  */corten-bench-groups-r999999999-????????????????.service/supervisor) unit_path="${unit_path%/supervisor}" ;;
  */corten-bench-groups-r999999999-????????????????.service) ;;
  *) exit 2 ;;
esac
cd "$2"
exec /bin/bash -ec "$("$1" --input-type=module -e '
import { supervisorBootstrap } from "./bench/workloads/cloud-contract.mjs";
console.log(supervisorBootstrap(process.argv[1]));
console.log(`exec "$1" --test --test-concurrency=1 "$2/bench/workloads/isolated/host-participant-linux.test.mjs"`);
' "${unit_path##*/}")" fixture "$1" "$2"
