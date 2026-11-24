#!/bin/bash
# Disposable local kernel fixtures only, never an official campaign or provider.
set -euo pipefail
test "$(id -u)" = 0
test "$(uname -s)" = Linux
test "$#" = 2
node=$(realpath "$1")
checkout=$(realpath "$2")
test -x "$node"
test -f "$checkout/bench/workloads/isolated/host-participant-linux.test.mjs"
cd "$checkout"
system_status=0
system_state=$(systemctl is-system-running --wait) || system_status=$?
case "$system_state:$system_status" in
  running:0|degraded:1) printf 'Native CI systemd host: %s\n' "$system_state" ;;
  *) printf 'Native CI requires running/degraded systemd (state=%s, exit=%s)\n' "$system_state" "$system_status" >&2; exit 1 ;;
esac
docker info >/dev/null
image=$("$node" --input-type=module -e 'import {nodeImage} from "./bench/json-api/contract.mjs"; console.log(nodeImage)')
# Docker Hub limits anonymous pulls per address, and a shared runner can be over it before this
# job starts (#1499). The image is pinned by digest, so when Hub refuses, the same bytes come from
# Google's mirror of Docker Hub: Docker checks the digest on pull, and the run uses that mirror
# reference (still by digest) instead of a retag. Any other image or a failed mirror pull fails.
pull_pinned() {
  local namespace name digest
  # A Docker Hub name: an optional namespace without a dot (a dot or localhost names a registry).
  [[ "$image" =~ ^(([a-z0-9_-]+)/)?([a-z0-9._-]+)(:[A-Za-z0-9._-]+)?@(sha256:[a-f0-9]{64})$ ]] || return 1
  namespace=${BASH_REMATCH[2]:-library} name=${BASH_REMATCH[3]} digest=${BASH_REMATCH[5]}
  test "$namespace" != localhost || return 1
  if docker pull "$image"; then return 0; fi
  name="$namespace/$name"
  image="mirror.gcr.io/$name@$digest"
  printf 'Docker Hub refused the pull; taking %s\n' "$image"
  docker pull "$image"
}
pull_pinned
nonce=$("$node" --input-type=module -e 'import {randomBytes} from "node:crypto"; console.log(randomBytes(8).toString("hex"))')
task="corten-evidence-kernel-$nonce"
work=$(mktemp -d)
id=
cleanup() {
  local result=$?
  trap - EXIT
  if test -n "$id"; then
    test "$(docker inspect --format '{{index .Config.Labels "agent.task"}}' "$id")" = "$task"
    docker rm -f -v "$id"
    test -z "$(docker container ls -aq --no-trunc --filter "id=$id")"
  fi
  # mktemp returned this owned directory; never remove caller-supplied paths.
  case "$work" in /tmp/tmp.*) rm -r -- "$work" ;; *) exit 2 ;; esac
  exit "$result"
}
trap cleanup EXIT
"$node" scripts/benchmark-mixed-mount-smoke.mjs "$image" "$task-mixed-mount" "$work"
id=$(docker run -d --pull=never --network none --label agent.owner=codex --label "agent.task=$task" \
  --cpus 1 --memory 1g "$image" node -e 'setInterval(()=>{},1000)')
[[ "$id" =~ ^[a-f0-9]{64}$ ]]

# Inspect real host procfs and real storage outside a private PID namespace.
"$node" --max-old-space-size=256 --experimental-test-module-mocks --test --test-reporter=tap --test-concurrency=1 \
  bench/workloads/isolated/host-boundary.test.mjs \
  bench/workloads/isolated/host-lifetime-durability.test.mjs | tee "$work/storage-boundary.tap"
grep -Fx '# fail 0' "$work/storage-boundary.tap"
grep -Fx '# cancelled 0' "$work/storage-boundary.tap"
grep -Fx '# skipped 0' "$work/storage-boundary.tap"

# Generate only fixed fixture invocations with the actual production bootstrap.
# No evidence-selected commands, budget changes, existing units or benchmark work.
for suite in lifetime participant churn; do
  unit="corten-bench-groups-r999999999-$nonce.service"
  test "$(systemctl show "$unit" --property=LoadState --value)" = not-found
  "$node" --input-type=module - "$unit" "$node" "$checkout" "$suite" > "$work/unit.sh" <<'JS'
import {supervisorBootstrap} from './bench/workloads/cloud-contract.mjs';
const [unit,node,checkout,suite] = process.argv.slice(2);
if (!['lifetime','participant','churn'].includes(suite)) throw Error('Unknown fixture');
const file = suite === 'churn' ? 'bench/workloads/isolated/host-lifetime-churn.test.mjs'
  : `bench/workloads/isolated/host-${suite}-linux.test.mjs`;
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
console.log('#!/bin/bash\nset -euo pipefail');
console.log(supervisorBootstrap(unit));
console.log(`cd ${quote(checkout)}`);
console.log(`exec ${quote(node)} --test --test-reporter=tap --test-concurrency=1 ${quote(file)}`);
JS
  systemd-run --quiet --wait --pipe --collect --unit "$unit" \
    --property='Delegate=cpu cpuset memory pids' --property=DelegateSubgroup=supervisor \
    --property=Restart=no --property=KillMode=control-group --property=RuntimeMaxSec=120 \
    --property=TimeoutStopSec=15 --working-directory "$checkout" \
    --setenv="PATH=$(dirname "$node"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    --setenv=BROWSER_PARTICIPANT_OS_TESTS=1 --setenv=BROWSER_PARTICIPANT_NAMESPACE=matched \
    --setenv="BROWSER_PARTICIPANT_ID=$id" /bin/bash "$work/unit.sh" | tee "$work/$suite.tap"
  grep -Fx '# fail 0' "$work/$suite.tap"
  grep -Fx '# cancelled 0' "$work/$suite.tap"
  grep -Fx '# skipped 0' "$work/$suite.tap"
  test "$(systemctl show "$unit" --property=LoadState --value)" = not-found
  nonce=$("$node" --input-type=module -e 'import {randomBytes} from "node:crypto"; console.log(randomBytes(8).toString("hex"))')
done

# Same Docker daemon, deliberately different PID namespace: never OS-qualified.
BROWSER_PARTICIPANT_OS_TESTS=1 BROWSER_PARTICIPANT_NAMESPACE=mismatched BROWSER_PARTICIPANT_ID="$id" \
  unshare --fork --pid --mount-proc "$node" --test --test-reporter=tap --test-concurrency=1 \
    bench/workloads/isolated/host-participant-linux.test.mjs | tee "$work/mismatch.tap"
grep -Fx '# fail 0' "$work/mismatch.tap"
grep -Fx '# cancelled 0' "$work/mismatch.tap"
grep -Fx '# skipped 0' "$work/mismatch.tap"
