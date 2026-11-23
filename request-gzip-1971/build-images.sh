#!/usr/bin/env bash
# Build the load generator and comparison framework images.
cd /root/work/httparena-gap/HttpArena || exit 1
# Public base images only: an empty client config avoids the Windows
# credential helper, which cannot be executed from this shell.
export DOCKER_CONFIG=/root/work/httparena-gap/docker-config
mkdir -p "$DOCKER_CONFIG"
[ -f "$DOCKER_CONFIG/config.json" ] || echo '{}' > "$DOCKER_CONFIG/config.json"
build() {
    local tag=$1; shift
    if docker image inspect "$tag" >/dev/null 2>&1; then echo "have $tag"; return; fi
    echo "building $tag"
    docker build -q -t "$tag" "$@" 2>&1 | tail -15
}
for target in "$@"; do
    case "$target" in
        gcannon) build httparena-gcannon:gap -f docker/gcannon.Dockerfile docker ;;
        wrk)     build httparena-wrk:gap -f docker/wrk.Dockerfile docker ;;
        zrk)     build httparena-zrk:gap -f docker/zrk.Dockerfile docker ;;
        *)       build "httparena-$target:gap" "frameworks/$target" ;;
    esac
done
docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep ':gap'
