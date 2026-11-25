#!/bin/sh
# catalog/build.sh <base|head>: the side's image of the catalog's reference app, built on the
# measuring host from the side's whole tree as git has it (tree-<side>/, a git archive of the
# commit in tree-<side>.commit), as the benchmark README builds it:
#   docker build -f examples/card-market/Dockerfile -t cb-corten-<side> .
# with the build cache emptied first, so neither side builds on the other's target directory.
# The Dockerfile's base images are tags that move, so what this build used is recorded
# (catalog-state/build-<side>.txt): the digests of rust:1-trixie and debian:trixie-slim as the
# build resolved them, the rustc in the first, the libjemalloc2 in the image, and the image's ID.
# After the head is built its record is compared with the base's: if a digest, the rustc or the
# libjemalloc2 differs, both sides are built again, once, and must then agree.
# A dry run builds the base alone and this script refuses to build the head under DRYRUN=1.
# Ends with BUILD-DONE.
set -eu
side=${1:-}
P=/m/hc; S=$P/catalog-state
. $P/commits.env
case "$side" in base) want=$BASE ;; head) want=$HEAD ;; *) echo "usage: build.sh base|head"; exit 2 ;; esac
[ "$side" != head ] || [ "${DRYRUN:-0}" != 1 ] || { echo "a dry run builds the base alone"; exit 1; }
[ ! -e $S/armed ] || { echo "a run is going on ($S/armed): nothing is built meanwhile"; exit 1; }
mkdir -p $S
one() { # <side> <commit>
    s=$1; T=$P/tree-$s
    [ "$(cat $P/tree-$s.commit)" = "$2" ] || { echo "tree-$s.commit is '$(cat $P/tree-$s.commit)', not commits.env's"; exit 1; }
    started=$(date +%s)
    docker builder prune -af >/dev/null
    (cd $T && DOCKER_BUILDKIT=1 docker build --progress=plain -f examples/card-market/Dockerfile -t cb-corten-$s . >$S/build-$s.log 2>&1) \
        || { tail -30 $S/build-$s.log; echo "BUILD FAILED: $s"; exit 1; }
    rust=$(grep -o 'docker.io/library/rust:1-trixie@sha256:[0-9a-f]*' $S/build-$s.log | sort -u | paste -sd' ' -)
    debian=$(grep -o 'docker.io/library/debian:trixie-slim@sha256:[0-9a-f]*' $S/build-$s.log | sort -u | paste -sd' ' -)
    case "$rust" in docker.io/library/rust:1-trixie@sha256:*" "*|"") echo "$s: the build log names not one rust:1-trixie digest: '$rust'"; exit 1 ;; esac
    case "$debian" in docker.io/library/debian:trixie-slim@sha256:*" "*|"") echo "$s: the build log names not one debian:trixie-slim digest: '$debian'"; exit 1 ;; esac
    rustc=$(docker run --rm "docker.io/library/rust@${rust#*@}" rustc -V 2>/dev/null | tail -1)
    jemalloc=$(docker run --rm --entrypoint dpkg-query cb-corten-$s -W -f '${Version}' libjemalloc2)
    id=$(docker image inspect -f '{{.Id}}' cb-corten-$s)
    [ -n "$rustc" ] && [ -n "$jemalloc" ] && [ -n "$id" ] || { echo "$s: could not read the rustc, the libjemalloc2 or the image's ID"; exit 1; }
    { echo "rust $rust"; echo "debian $debian"; echo "rustc $rustc"; echo "libjemalloc2 $jemalloc"
      echo "image $id"; echo "commit $2"; echo "built $(date -u +%FT%TZ) in $(( $(date +%s) - started )) s"; } >$S/build-$s.txt
    cat $S/build-$s.txt
}
inputs() { head -4 $S/build-$1.txt; }
one $side $want
if [ "$side" = head ]; then
    [ -f $S/build-base.txt ] || { echo "no base image's record: build the base first"; exit 1; }
    if [ "$(inputs base)" != "$(inputs head)" ]; then
        echo "the two builds' inputs differ; building both again:"; inputs base; inputs head
        cp $S/build-base.txt $S/build-base-first.txt; cp $S/build-head.txt $S/build-head-first.txt
        one base $BASE; one head $HEAD
        [ "$(inputs base)" = "$(inputs head)" ] || { echo "BUILD FAILED: the two builds' inputs differ again"; exit 1; }
    fi
    [ "$(sed -n 's/^image //p' $S/build-base.txt)" != "$(sed -n 's/^image //p' $S/build-head.txt)" ] || { echo "BUILD FAILED: the two sides are one image"; exit 1; }
    echo "the two builds' inputs agree: $(inputs head | paste -sd';' -)"
fi
echo BUILD-DONE
