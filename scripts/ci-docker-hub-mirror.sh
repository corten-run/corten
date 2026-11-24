#!/usr/bin/env bash
# Hosted CI only, as root: add Google's Docker Hub cache to the runner's Docker daemon registry
# mirrors, which the daemon tries before falling back to Docker Hub (#1499). Docker Hub has
# refused the kernel job's pull with toomanyrequests. The cache is appended after any mirrors the
# daemon already lists (a hosted runner normally lists none). References stay Docker Hub's, so a
# digest-pinned pull checks the same bytes whichever endpoint serves it. Contributors' machines
# keep their own Docker configuration; the benchmark drivers never edit it.
#
# Docker is reloaded, never restarted. dockerd rereads registry-mirrors from daemon.json on
# SIGHUP, and a reload it rejects leaves it running on its old settings
# (https://docs.docker.com/reference/cli/dockerd/#configuration-reload-behavior). A mirror
# also given as a --registry-mirror flag would conflict, so that daemon is refused before any
# write. If the reload fails or Docker does not list the mirror in time, the original file (or
# its absence) is put back, Docker is reloaded again and the step fails.
# One elapsed deadline, CI_DOCKER_MIRROR_DEADLINE seconds (default 60), covers the reload and
# the check; CI_DOCKER_MIRROR_CALL seconds (default 10) bounds each command. Tests shorten them.
# Usage: ci-docker-hub-mirror.sh <node> [daemon.json]
set -euo pipefail
node=$1 config=${2:-/etc/docker/daemon.json}
deadline=${CI_DOCKER_MIRROR_DEADLINE:-60} call=${CI_DOCKER_MIRROR_CALL:-10}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SECONDS=0

fail() { echo "$*" >&2; exit 1; }
merge() { "$node" "$here/ci-docker-hub-mirror.mjs" "$@"; }
# Each command gets at most $call seconds, then KILL two seconds after TERM.
fixed() { timeout --kill-after=2 "$call" "$@"; }
# The same, but never past the deadline; an expired deadline runs nothing.
bounded() {
  local left=$((deadline - SECONDS))
  ((left > 0)) || return 124
  timeout --kill-after=2 "$((left < call ? left : call))" "$@"
}
unit() { fixed systemctl show --property="$1" --value docker; }

pid=$(unit MainPID)
[[ $pid =~ ^[1-9][0-9]*$ ]] || fail "Docker is not running under systemd (MainPID '$pid')"
[[ -r /proc/$pid/cmdline ]] || fail "cannot read the Docker daemon's command line (/proc/$pid/cmdline)"
flags=$(unit ExecStart)$'\n'$(tr '\0' '\n' <"/proc/$pid/cmdline")
if grep -Eq -e '--registry-mirror([= ]|$)' <<<"$flags"; then
  fail "the Docker daemon sets --registry-mirror on its command line, which conflicts with registry-mirrors in $config; leaving $config as it is"
fi
# Ubuntu's docker.service reloads with ExecReload=/bin/kill -s HUP $MAINPID; without one, signal it.
if [[ -n $(unit ExecReload) ]]; then
  reload() { "$@" systemctl reload docker; }
else
  reload() { "$@" kill -s HUP "$pid"; }
fi
listed() {
  local mirrors
  mirrors=$("$@" docker info --format '{{range .RegistryConfig.Mirrors}}{{println .}}{{end}}' 2>/dev/null) || return 1
  grep -Fxq -e 'https://mirror.gcr.io/' -e 'https://mirror.gcr.io' <<<"$mirrors"
}

work=$(mktemp -d)
saved=$work/saved active=0
finish() {
  local status=$?
  if [[ -e $saved && $active == 0 ]]; then
    ((status != 0)) || status=1
    if merge restore "$config" "$saved" && reload fixed; then
      echo "restored $config and reloaded Docker" >&2
    else
      echo "could not restore $config and reload Docker; the runner's Docker may still list the mirror" >&2
    fi
  fi
  rm -rf -- "$work"
  exit "$status"
}
trap finish EXIT

mkdir -p -m 0755 "$(dirname "$config")"
# An assignment, not a test: set -e does not stop on a failure inside [[ ]].
change=$(merge add "$config" "$saved")
if [[ $change == changed ]]; then
  reload bounded || fail "could not reload Docker to load $config"
fi
until listed bounded; do
  ((SECONDS < deadline)) || fail "Docker does not list https://mirror.gcr.io as a registry mirror within $deadline s"
  sleep 1
done
active=1
echo "Docker lists https://mirror.gcr.io among its registry mirrors, which it tries before falling back to Docker Hub"
