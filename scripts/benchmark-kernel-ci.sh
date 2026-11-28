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
# The real Docker exit race is experimental until exercised on hosted hardware.
exercise_exit=${CORTEN_NATIVE_DOCKER_EXIT:-0}
[[ "$exercise_exit" == 0 || "$exercise_exit" == 1 ]]
cd "$checkout"
system_status=0
system_state=$(systemctl is-system-running --wait) || system_status=$?
case "$system_state:$system_status" in
  running:0|degraded:1) printf 'Native CI systemd host: %s\n' "$system_state" ;;
  *) printf 'Native CI requires running/degraded systemd (state=%s, exit=%s)\n' "$system_state" "$system_status" >&2; exit 1 ;;
esac
docker info >/dev/null
image=$("$node" --input-type=module -e 'import {nodeImage} from "./bench/json-api/contract.mjs"; console.log(nodeImage)')
docker pull "$image"
nonce=$("$node" --input-type=module -e 'import {randomBytes} from "node:crypto"; console.log(randomBytes(8).toString("hex"))')
task="corten-evidence-kernel-$nonce"
work=$(mktemp -d)
id=
exit_id=
exit_task=
exit_docker() {
  timeout --kill-after=2s 15s docker --host unix:///var/run/docker.sock "$@"
}
cleanup_exit_fixture() {
  local target="$exit_id" owner remaining
  if [[ -z "$target" ]]; then
    target=$(exit_docker container ls -aq --no-trunc --filter "label=agent.task=$exit_task") || return 1
  fi
  # An unacknowledged create with no visible ID is not proof of cleanup.
  [[ "$target" =~ ^[a-f0-9]{64}$ ]] || return 1
  owner=$(exit_docker container inspect --format '{{.Id}} {{index .Config.Labels "agent.owner"}} {{index .Config.Labels "agent.task"}}' "$target") || return 1
  [[ "$owner" == "$target codex $exit_task" ]] || return 1
  exit_docker rm -f -v "$target" || return 1
  remaining=$(exit_docker container ls -aq --no-trunc --filter "label=agent.task=$exit_task") || return 1
  [[ -z "$remaining" ]]
}
cleanup() {
  local result=$?
  trap - EXIT
  if [[ -n "$exit_task" ]] && ! cleanup_exit_fixture; then
    printf '%s\n' 'Experimental Docker exit fixture cleanup could not be confirmed' >&2
    result=1
  fi
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

if [[ "$exercise_exit" == 1 ]]; then
  exit_gate="$work/docker-exit"
  mkdir -m 700 "$exit_gate"
  mkfifo -m 600 "$exit_gate/exit"
  exit_task="$task-exit"
  exit_id=$(exit_docker create --pull=never --network none --label agent.owner=codex --label "agent.task=$exit_task" \
    --cpus 1 --memory 1g --mount "type=bind,src=$exit_gate,dst=/corten-docker-exit" "$image" node -e '
      const fs = require("node:fs/promises");
      const deadline = setTimeout(() => process.exit(2), 45000);
      (async () => {
        const fd = await fs.open("/corten-docker-exit/exit", "r");
        try {
          await fs.writeFile("/corten-docker-exit/ready", "", { flag: "wx" });
          const byte = Buffer.alloc(1);
          const { bytesRead } = await fd.read(byte, 0, byte.length, null);
          if (bytesRead !== 1 || byte[0] !== 120) process.exitCode = 1;
        } finally { await fd.close(); }
      })().catch(() => { process.exitCode = 1; }).finally(() => clearTimeout(deadline));
    ')
  [[ "$exit_id" =~ ^[a-f0-9]{64}$ ]]
  exit_docker start "$exit_id" >/dev/null
fi

# Generate only fixed fixture invocations with the actual production bootstrap.
# No evidence-selected commands, budget changes, existing units or benchmark work.
for suite in lifetime participant churn; do
  unit="corten-bench-groups-r999999999-$nonce.service"
  extra_env=()
  if [[ "$suite" == lifetime && "$exercise_exit" == 1 ]]; then
    extra_env=(--setenv="BROWSER_EXIT_FIXTURE_ID=$exit_id" --setenv="BROWSER_EXIT_FIXTURE_TASK=$exit_task"
      --setenv="BROWSER_EXIT_FIXTURE_GATE=$exit_gate")
  fi
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
    --setenv="BROWSER_PARTICIPANT_ID=$id" "${extra_env[@]}" /bin/bash "$work/unit.sh" | tee "$work/$suite.tap"
  grep -Fx '# fail 0' "$work/$suite.tap"
  grep -Fx '# cancelled 0' "$work/$suite.tap"
  grep -Fx '# skipped 0' "$work/$suite.tap"
  if [[ "${#extra_env[@]}" != 0 ]]; then
    grep -Ex 'ok [0-9]+ - actual Docker exit after the exact participant cgroup disappears' "$work/$suite.tap"
  fi
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
