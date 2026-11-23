#!/usr/bin/env bash
# Runs on a droplet with Docker: time each way of compressing the given bodies, with flate2 on
# miniz_oxide and on zlib-rs. Usage: compbench2.sh <body>...
S=/root/kit/compbench
docker run --rm -v "$S:/src" -v compbench-target:/target -v /root/bodies:/bodies:ro \
    -e CARGO_TARGET_DIR=/target -w /src rust:1-trixie sh -c '
    apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq cmake >/dev/null 2>&1
    cargo build -q --release 2>&1 | tail -3 && cp /target/release/compbench /target/compbench-miniz &&
    cargo build -q --release --features zlibrs 2>&1 | tail -3 && cp /target/release/compbench /target/compbench-zlibrs &&
    for b in miniz zlibrs; do taskset -c 3 /target/compbench-$b "$@"; done' sh "$@"
echo "# compbench done"
