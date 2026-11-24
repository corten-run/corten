#!/usr/bin/env bash
# measure.sh <pass>: what a profile's coverage does to a request's instructions, on card-market.
# Run in a rust:1-trixie container with /w mounted: /w/main is the tree at the commit in
# /w/main.commit, /w/kit this directory. Writes /w/out/pass<pass> (and the binaries to
# /w/bin/pass<pass>).
#   1. builds the corten command from the tree, then card-market four times with it: without a
#      profile, and with --profile-from and train.sh's three profiles (all, no-item, no-br);
#   2. asks each binary for each case of count.py and compares what they answered;
#   3. counts each case three times on each binary, under callgrind.
# Pass 1 starts from an empty target directory. A later pass starts from the one before it, so
# it takes each profile again and builds each profiled release again from that profile.
set -uo pipefail
pass=${1:?measure.sh <pass>}
export DEBIAN_FRONTEND=noninteractive ZSTD_SYS_USE_PKG_CONFIG=1 CARGO_TARGET_DIR=/w/target
out=/w/out/pass$pass bin=/w/bin/pass$pass
mkdir -p $out $bin
fail() { echo "MEASURE-FAILED $*"; exit 1; }
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 python3 >/dev/null 2>&1 || fail packages
rustup component add llvm-tools >/dev/null 2>&1 || fail llvm-tools
{
    echo "commit $(cat /w/main.commit)"
    rustc -V; cargo -V; valgrind --version; curl -V | head -1; python3 -V
    dpkg-query -W libjemalloc2 libzstd1 libzstd-dev
    grep -m1 'model name' /proc/cpuinfo; uname -r
} >$out/versions.txt 2>&1
cd /w/main
echo "== pass $pass: the corten command $(date -u +%T)"
cargo build --release --locked -p corten-cli >$out/build-cli.log 2>&1 || fail "the corten command"
cp /w/target/release/corten $bin/corten
# The copy and the counted servers read the item from the smoke fixture, one item of 68 KB.
export ITEM_SOURCE=fixture FIXTURE_PATH=examples/card-market/fixtures/smoke.json
echo "== none $(date -u +%T)"
$bin/corten build --locked -p card-market >$out/build-none.log 2>&1 || fail "build none"
cp /w/target/release/card-market $bin/none
for profile in all no-item no-br; do
    echo "== $profile $(date -u +%T)"
    $bin/corten build --locked -p card-market --profile-from sh /w/kit/train.sh $profile >$out/build-$profile.log 2>&1 || fail "build $profile"
    cp /w/target/release/card-market $bin/$profile
done
(cd $bin && sha256sum none all no-item no-br && wc -c none all no-item no-br) >$out/binaries.txt
echo "== answers $(date -u +%T)"
cpu=1
for build in none all no-item no-br; do
    python3 /w/kit/count.py $bin/$build --port $((4100 + cpu)) --cpu $cpu --dump $out/answers-$build.txt || fail "answers $build"
    cpu=$((cpu + 1))
done
for build in all no-item no-br; do cmp $out/answers-none.txt $out/answers-$build.txt || fail "answers differ in $build"; done
echo "the four builds answered each case with the same status, coding, type and body lengths" | tee $out/answers.txt
echo "== counts $(date -u +%T)"
cpu=1
for build in none all no-item no-br; do
    python3 /w/kit/count.py $bin/$build --port $((4100 + cpu)) --cpu $cpu --reps 3 >$out/count-$build.txt 2>$out/count-$build.err &
    cpu=$((cpu + 1))
done
wait
for build in none all no-item no-br; do
    [ "$(wc -l <$out/count-$build.txt)" -eq 8 ] || { cat $out/count-$build.err; fail "count $build"; }
    echo "-- $build"; cat $out/count-$build.txt
done
echo "MEASURE-DONE pass $pass $(date -u +%T)"
