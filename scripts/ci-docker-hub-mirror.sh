#!/usr/bin/env bash
# Hosted CI only, as root: let the runner's Docker daemon take Docker Hub images from Google's
# cache first (#1499). Docker Hub has refused the kernel job's pull with toomanyrequests.
# The daemon falls back to Docker Hub when the cache lacks an image, and references stay Docker
# Hub's, so a digest-pinned pull checks the same bytes either way. Contributors' machines keep
# their own Docker configuration; the benchmark drivers never edit it.
# Usage: ci-docker-hub-mirror.sh <node> [daemon.json]
set -euo pipefail
node=$1 config=${2:-/etc/docker/daemon.json}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$(dirname "$config")"
# An assignment, not a test: set -e does not stop on a failure inside [[ ]].
merge=$("$node" "$here/ci-docker-hub-mirror.mjs" "$config")
if [[ $merge == changed ]]; then
  timeout 120 systemctl restart docker
fi
for _ in $(seq 60); do
  if timeout 10 docker info >/dev/null 2>&1; then break; fi
  sleep 1
done
mirrors=$(timeout 10 docker info --format '{{range .RegistryConfig.Mirrors}}{{println .}}{{end}}')
if ! grep -Fxq -e 'https://mirror.gcr.io/' -e 'https://mirror.gcr.io' <<<"$mirrors"; then
  echo "Docker does not list https://mirror.gcr.io as a registry mirror" >&2
  exit 1
fi
echo "Docker takes Docker Hub images from https://mirror.gcr.io first"
