#!/usr/bin/env bash
# Copy the framework crates and the HttpArena entry from the worktree into a
# small Docker build context in WSL, and build the entry's image from it.
# Usage: stage-corten.sh <tag> [worktree]
set -euo pipefail
TAG=${1:-httparena-corten:gap}
SRC=${2:?the tree to build: crates, Cargo.toml}
STAGE=/root/work/httparena-gap/stage
export DOCKER_CONFIG=/root/work/httparena-gap/docker-config
mkdir -p "$DOCKER_CONFIG"
[ -f "$DOCKER_CONFIG/config.json" ] || echo '{}' > "$DOCKER_CONFIG/config.json"
case "$STAGE" in /root/work/httparena-gap/*) ;; *) echo "unexpected stage dir"; exit 1 ;; esac
rm -rf "$STAGE/entry" "$STAGE/corten" "$STAGE/Dockerfile"
mkdir -p "$STAGE/bench/httparena"
rsync -a --delete --exclude target --exclude node_modules "$SRC/crates" "$STAGE/"
cp "$SRC/Cargo.toml" "$STAGE/Cargo.toml"
rsync -a --delete --exclude target "${ENTRY_SRC:-$SRC/bench/httparena/corten}/" "$STAGE/bench/httparena/corten/"
[ -n "${PATCH:-}" ] && bash "$PATCH" "$STAGE"
cd "$STAGE"
docker build -t "$TAG" -f bench/httparena/corten/Dockerfile . > /root/work/httparena-gap/build.log 2>&1 || {
    grep -vE 'Compiling|Downloading|Downloaded|sha256|extracting' /root/work/httparena-gap/build.log | tail -${TAIL:-80}; exit 1; }
{ grep -E 'warning|Finished' /root/work/httparena-gap/build.log || true; } | tail -8
docker image inspect "$TAG" --format 'built {{.RepoTags}} {{.Size}}'
