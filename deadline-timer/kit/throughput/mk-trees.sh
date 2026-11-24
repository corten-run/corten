#!/usr/bin/env bash
# Runs on the c-48. Makes the four source trees and builds httparena-corten:<name> for each.
#   base   the branch point            conn   the change (v1.patch)
#   thread V2, kept by the thread      sweep  V3, expired by the clock thread
set -uo pipefail
cd /root/dl
W=/root/work/arena
rm -rf src-base src-conn src-thread src-sweep
mkdir src-base && tar -xzf base-tree.tgz -C src-base
cp -r src-base src-conn && (cd src-conn && git apply --whitespace=nowarn /root/dl/v1.patch) || { echo "FAIL patch"; exit 1; }
cp -r src-conn src-thread && cp variants/v2-deadline.rs src-thread/crates/corten/src/deadline.rs
cp -r src-conn src-sweep && python3 variants/v3-apply.py src-sweep /root/dl/variants || { echo "FAIL v3"; exit 1; }
cp entry.tgz $W/trees/entry-var.tgz
for name in "$@"; do
    tar -czf $W/trees/$name.tgz -C src-$name Cargo.toml Cargo.lock crates
    S=$W/stage-$name
    rm -rf "$S" && mkdir -p "$S" && tar -xzf "$W/trees/$name.tgz" -C "$S" && tar -xzf "$W/trees/entry-var.tgz" -C "$S"
    # `App::per_core` is the prototype branch's, not main's: without it ARENA_MODE=percore-builtin
    # is one thread, and is not used here.
    sed -i 's/app()\.per_core()/app()/' "$S/bench/httparena/corten/src/main.rs"
    if docker build -f "$S/bench/httparena/corten/Dockerfile" -t "httparena-corten:$name" "$S" > "$W/build-corten-$name.log" 2>&1; then
        echo "built httparena-corten:$name $(grep -oE 'Compiling (tokio|hyper) v[0-9.]+' "$W/build-corten-$name.log" | sort -u | tr '\n' ' ')"
    else
        echo "FAIL build $name"; grep -E "error|-->" "$W/build-corten-$name.log" | head -40
    fi
done
echo "# BUILD-DONE"
