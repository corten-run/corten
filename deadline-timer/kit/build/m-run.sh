#!/usr/bin/env bash
# Runs on the build host: fmt, clippy and the crate's lib tests on the merged head, the size
# of the timer a connection keeps, then instructions a request for main and the merged head.
set -uo pipefail
mkdir -p /root/dl && cd /root/dl
export DEBIAN_FRONTEND=noninteractive
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
apt-get install -y -qq git python3 >/dev/null 2>&1
docker pull -q rust:1-trixie
for t in head main; do rm -rf $t; mkdir $t; tar -xzf $t.tgz -C $t; done
run() {
    tree=$1; shift
    docker run --rm -v "/root/dl/$tree:/src" -v corten-cargo:/usr/local/cargo/registry \
        -v "corten-target-$tree:/target" -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie "$@"
}
: > status.log
run head sh -c 'rustup component add rustfmt >/dev/null 2>&1; cargo fmt --all --check' > fmt.log 2>&1; echo "# fmt rc=$?" >> status.log
run head sh -c 'rustup component add clippy >/dev/null 2>&1; cargo clippy --workspace --all-features --all-targets -- -D warnings' > clippy.log 2>&1; echo "# clippy rc=$?" >> status.log
run head cargo test -p corten-run --all-features --lib > lib.log 2>&1; echo "# lib rc=$?" >> status.log
# The size of the boxed timer, from a test added to a copy of the tree only.
rm -rf head-size && cp -r head head-size
cat >> head-size/crates/corten/src/tests/server.rs <<'EOF'

#[test]
fn size_of_a_kept_timer() {
    println!(
        "size_of Sleep = {} bytes, align {}",
        std::mem::size_of::<tokio::time::Sleep>(),
        std::mem::align_of::<tokio::time::Sleep>()
    );
}
EOF
docker run --rm -v "/root/dl/head-size:/src" -v corten-cargo:/usr/local/cargo/registry -v "corten-target-head:/target" \
    -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie \
    cargo test -p corten-run --all-features --lib -- --exact --nocapture tests::server::size_of_a_kept_timer > size.log 2>&1
echo "# size rc=$?" >> status.log
echo "# CHECKS-DONE" >> status.log
# Instructions a request.
mkdir -p cg/out && cp count2.py cg/
for t in main head; do
    rm -rf cg/src-$t && cp -r $t cg/src-$t && tar -xzf entry.tgz -C cg/src-$t
    # `App::per_core` is the prototype branch's, not main's.
    sed -i 's/app()\.per_core()/app()/' cg/src-$t/bench/httparena/corten/src/main.rs
done
cat > cg/inside.sh <<'EOF'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive ZSTD_SYS_USE_PKG_CONFIG=1
apt-get update -q >/dev/null && apt-get install -y -q valgrind libjemalloc2 pkg-config libzstd-dev python3 util-linux >/dev/null 2>&1 || { echo "COUNT-FAILED packages"; exit 1; }
{ rustc -V; cargo -V; valgrind --version; uname -r; grep -m1 'model name' /proc/cpuinfo; nproc; } > /w/out/host.txt 2>&1
export RUSTFLAGS="--cfg tokio_unstable -C force-frame-pointers=yes"
for name in main head; do
    (cd /w/src-$name/bench/httparena/corten && CARGO_TARGET_DIR=/w/target-$name cargo build --release > /w/out/build-$name.log 2>&1) || { tail -30 /w/out/build-$name.log; echo "COUNT-FAILED build $name"; exit 1; }
    cp /w/src-$name/bench/httparena/corten/Cargo.lock /w/out/app-Cargo.lock-$name
    grep -oE 'Compiling (tokio|hyper) v[0-9.]+' /w/out/build-$name.log | sort -u | tr '\n' ' '; echo
done
for round in 1 2; do
    for name in main head; do
        echo "== default $name round $round $(date -u +%T)"
        ARENA_MODE=default python3 /w/count2.py /w/target-$name/release/httparena-corten --reps 3 | tee /w/out/count-default-$name-$round.txt
    done
done
for name in main head; do
    echo "== default, a connection for each request: $name $(date -u +%T)"
    ARENA_MODE=default python3 /w/count2.py /w/target-$name/release/httparena-corten --reps 5 --cases get,sdelay1 --each-its-own | tee /w/out/count-each-$name.txt
done
echo COUNT-DONE
EOF
docker run --rm -v /root/dl/cg:/w -v corten-cargo:/usr/local/cargo/registry rust:1-trixie bash /w/inside.sh > count.log 2>&1
echo "# ALL-DONE" >> status.log
