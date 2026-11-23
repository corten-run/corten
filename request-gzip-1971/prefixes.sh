#!/usr/bin/env bash
# Runs on the check droplet: bytes out by coder for the first N bytes of each body, to find the
# size from which libdeflate's gzip 1 is no longer smaller than brotli 1.
S=/root/kit/compbench
B=/root/bodies
L=()
if [ ! -s "$B/guide-app.html" ]; then
    docker run --rm "${L[@]}" -v /root/corten-pr:/repo:ro -v "$B:/bodies" python:3-slim sh -c '
        pip install -q --root-user-action=ignore markdown >/dev/null 2>&1
        for pair in docs/guide/app.md:guide-app README.md:readme docs/guide/views.md:guide-views docs/design.md:design; do
            python -m markdown -x tables -x fenced_code "/repo/${pair%%:*}" > "/bodies/${pair##*:}.html"
        done'
fi
ls -la "$B"
docker run --rm "${L[@]}" -v "$S:/src" -v compbench-target:/target -v "$B:/bodies:ro" -e CARGO_TARGET_DIR=/target -e PREFIXES=1 -w /src rust:1-trixie sh -c '
    apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq cmake >/dev/null 2>&1
    cargo build -q --release 2>&1 | tail -3 && /target/release/compbench "$@"' sh "$@"
echo "# prefixes done"
