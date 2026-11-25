#!/usr/bin/env bash
# Runs on the 48-CPU host. Builds the benchmark entry against four trees with one toolchain, one set
# of flags and one lock file, and makes an image of each: t48:base t48:head t48:old t48:oldbase.
# Expects in /root/t48: trees/{base,head,old,oldbase}.tgz and entry.tgz.
set -uo pipefail
cd /root/t48
mkdir -p log bin
cat > log/Dockerfile.build <<'EOF'
FROM rust:1-trixie
RUN apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q pkg-config libzstd-dev && rm -rf /var/lib/apt/lists/*
EOF
cat > log/Dockerfile.run <<'EOF'
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends libzstd1 libjemalloc2 && rm -rf /var/lib/apt/lists/*
ENV LD_PRELOAD=libjemalloc.so.2
ENV MALLOC_CONF=background_thread:true,tcache_max:65536
ENV HOST=0.0.0.0
CMD ["/server"]
EOF
docker build -q -t t48build -f log/Dockerfile.build log > log/image-build.log 2>&1 || { tail -5 log/image-build.log; echo "# IMAGE-FAILED build"; exit 1; }
docker build -q -t t48run -f log/Dockerfile.run log > log/image-run.log 2>&1 || { tail -5 log/image-run.log; echo "# IMAGE-FAILED run"; exit 1; }
docker run --rm t48build sh -c 'rustc -V; cargo -V' | tee log/toolchain.txt
docker run --rm t48run sh -c 'dpkg -s libjemalloc2 | grep Version' | tee -a log/toolchain.txt
APP=bench/httparena/corten
prep() {
    name=$1
    rm -rf src-$name && mkdir -p src-$name
    tar -xzf trees/$name.tgz -C src-$name && tar -xzf entry.tgz -C src-$name || return 1
    # `App::per_core` is the prototype branch's, not main's, as every earlier build removed it.
    sed -i 's/app()\.per_core()/app()/' src-$name/$APP/src/main.rs
}
build() {
    name=$1
    docker run --rm -v /root/t48:/w -v t48-cargo:/usr/local/cargo/registry -e ZSTD_SYS_USE_PKG_CONFIG=1 \
        -e RUSTFLAGS="--cfg tokio_unstable -C force-frame-pointers=yes" -e CARGO_TARGET_DIR=/w/target-$name -e CARGO_TERM_COLOR=never \
        -w /w/src-$name/$APP t48build cargo build --release > log/build-$name.log 2>&1
    if [ $? -eq 0 ] && cp target-$name/release/httparena-corten bin/$name; then
        cp src-$name/$APP/Cargo.lock log/Cargo.lock-$name
        rm -rf img-$name && mkdir img-$name && cp bin/$name img-$name/server
        printf 'FROM t48run\nCOPY server /server\n' > img-$name/Dockerfile
        docker build -q -t t48:$name img-$name > log/image-$name.log 2>&1 || { echo "# IMAGE-FAILED $name"; return 1; }
        echo "built $name: $(grep -E '^name = "(tokio|hyper)"$' -A 1 log/Cargo.lock-$name | grep version | tr '\n' ' ') sha256 $(sha256sum < bin/$name | cut -c1-16) image $(docker images -q t48:$name) $(date -u +%T)"
    else
        echo "# BUILD-FAILED $name"; grep -E "^(error|warning: unused)" -A 12 log/build-$name.log | head -60
    fi
}
for name in base head old oldbase; do prep $name || { echo "# PREP-FAILED $name"; exit 1; }; done
md5sum src-*/$APP/src/main.rs src-*/$APP/Cargo.toml | awk '{print $1}' | sort | uniq -c
build base
# The base's lock file for the other three, so that all four resolve the same versions.
for name in head old oldbase; do cp log/Cargo.lock-base src-$name/$APP/Cargo.lock; done
build head &
build old &
build oldbase &
wait
for name in head old oldbase; do
    if diff -q log/Cargo.lock-base log/Cargo.lock-$name > /dev/null; then echo "lock of $name: the base's"; else echo "lock of $name DIFFERS:"; diff log/Cargo.lock-base log/Cargo.lock-$name | head -20; fi
done
grep -E "^warning" -A 6 log/build-*.log | head -30
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep '^t48:' | sort
echo "# BUILD-DONE $(date -u +%T)"
