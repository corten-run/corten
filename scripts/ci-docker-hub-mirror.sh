#!/usr/bin/env bash
# Changes the Docker daemon's configuration on a disposable GitHub-hosted runner. Never run it on
# a developer machine or a self-hosted runner: it refuses unless RUNNER_ENVIRONMENT is
# github-hosted and CI is true, which GitHub sets on its hosted runners. The runner is thrown away
# after the job, so nothing is rolled back; a failed step fails the job.
#
# Adds Google's Docker Hub cache to the daemon's registry mirrors, which it tries before falling
# back to Docker Hub (#1499); Docker Hub has refused the kernel job's pull with toomanyrequests.
# The cache is appended after any mirrors already listed. References stay Docker Hub's, so a
# digest-pinned pull checks the same bytes whichever endpoint serves it.
#
# Docker is reloaded with systemctl reload docker (the packaged unit sends SIGHUP), not
# restarted. dockerd rereads registry-mirrors on SIGHUP and rejects a reload that conflicts with
# its flags without stopping
# (https://docs.docker.com/reference/cli/dockerd/#configuration-reload-behavior); a rejected
# reload leaves the mirror unlisted, so the check below fails the step.
#
# One deadline, CI_DOCKER_MIRROR_DEADLINE seconds after the step starts (default 60), measured on
# the monotonic /proc/uptime clock, covers the write, the reload and the check. Each command runs
# under timeout for the time left, capped at 10 s, with KILL 2 s after TERM, and none starts once
# the deadline has passed, so the step ends within the deadline plus 2 s.
# Usage: ci-docker-hub-mirror.sh <node> [daemon.json]
set -euo pipefail

fail() { echo "$*" >&2; exit 1; }
[[ ${RUNNER_ENVIRONMENT-} == github-hosted && ${CI-} == true ]] ||
  fail "refusing to change Docker's configuration outside a GitHub-hosted runner (RUNNER_ENVIRONMENT=github-hosted and CI=true)"
(($# == 1 || $# == 2)) || fail "usage: ci-docker-hub-mirror.sh <node> [daemon.json]"
node=$1 config=${2:-/etc/docker/daemon.json}
deadline=${CI_DOCKER_MIRROR_DEADLINE:-60}
[[ $deadline =~ ^[1-9][0-9]{0,3}$ ]] || fail "CI_DOCKER_MIRROR_DEADLINE must be a whole number of seconds"
for command in timeout systemctl docker; do
  command -v "$command" >/dev/null || fail "$command is not available"
done
[[ ${BASH_SOURCE[0]} == */* ]] && here=${BASH_SOURCE[0]%/*} || here=.

# Hundredths of a second since boot.
read -r up _ </proc/uptime
end=$((10#${up/./} + deadline * 100))
bounded() {
  local up left limit
  read -r up _ </proc/uptime
  left=$((end - 10#${up/./}))
  ((left > 0)) || { echo "the $deadline s deadline has passed; not starting $1" >&2; return 124; }
  ((left < 1000)) || left=1000
  printf -v limit '%d.%02d' $((left / 100)) $((left % 100))
  timeout --kill-after=2 "$limit" "$@"
}
listed() {
  local mirrors
  mirrors=$(bounded docker info --format '{{range .RegistryConfig.Mirrors}}{{println .}}{{end}}' 2>/dev/null) || return 1
  mirrors=$'\n'$mirrors$'\n'
  [[ $mirrors == *$'\nhttps://mirror.gcr.io\n'* || $mirrors == *$'\nhttps://mirror.gcr.io/\n'* ]]
}

change=$(bounded "$node" "$here/ci-docker-hub-mirror.mjs" "$config") || fail "did not add the mirror to $config"
if [[ $change == changed ]]; then
  bounded systemctl reload docker || fail "systemctl reload docker failed after adding the mirror to $config"
fi
until listed; do
  bounded sleep 1 || fail "Docker does not list https://mirror.gcr.io as a registry mirror within $deadline s"
done
echo "Docker lists https://mirror.gcr.io among its registry mirrors, which it tries before falling back to Docker Hub"
