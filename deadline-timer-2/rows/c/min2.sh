#!/usr/bin/env bash
# The crate's non-test code checked against tokio 1.44.0, from a package outside the workspace
# (the workspace's lock cannot go that low: an example's dependency needs tokio 1.51).
set -uo pipefail
cd /root/dl
: > min2.status
for t in c main; do
    rm -rf min-$t && cp -r $t min-$t && mkdir -p min-$t/minprobe/src && : > min-$t/minprobe/src/lib.rs
    cat > min-$t/minprobe/Cargo.toml <<'EOF'
[package]
name = "minprobe"
version = "0.0.0"
edition = "2021"
publish = false

[workspace]

[dependencies]
corten = { package = "corten-run", path = "../crates/corten", features = ["log", "json", "types", "compress", "feed", "agent", "zones"] }
tokio = "=1.44.0"
EOF
    docker run --rm -v "/root/dl/min-$t:/src" -v corten-cargo:/usr/local/cargo/registry -v corten-target-min:/target \
        -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src/minprobe rust:1-trixie \
        sh -c 'cargo check && echo LIB-OK && grep -A1 "^name = \"tokio\"$" Cargo.lock' > min2-$t.log 2>&1
    echo "# min2-$t rc=$?" >> min2.status
done
echo "# MIN2-DONE" >> min2.status
