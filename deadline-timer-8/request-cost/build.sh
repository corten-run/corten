#!/bin/sh
# sh build.sh <kit commit> <commit>...: one checkout of the kit, each commit built in /rc in turn.
set -eu
kit=$1
shift
git config --global --add safe.directory '*'
if [ ! -d /kit/.git ]; then
    git clone -q --shared --no-checkout /repo.git /kit
    git -C /kit sparse-checkout set bench/request-cost
    git -C /kit checkout -q "$kit"
fi
echo "kit at $(git -C /kit rev-parse HEAD)"
for commit in "$@"; do
    echo "kit differs from $commit in bench/request-cost: $(git -C /kit diff --stat "$commit" HEAD -- bench/request-cost | tail -1)"
    sh /kit/bench/request-cost/build.sh "$commit" /rc 2>&1 | tail -4
done
ls -l /rc/bin
sha256sum /rc/bin/*
