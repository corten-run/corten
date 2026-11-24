#!/usr/bin/env bash
# Runs on the build host, after the counts: the kit's probe with the two added routes builds
# on main and on the merged head and answers the three workloads' requests. Not a measurement.
set -uo pipefail
cd /root/dl
until grep -q "PAUSED-DONE\|PAUSED-FAILED" paused.log 2>/dev/null; do sleep 10; done
for t in main head; do
    rm -rf pk-$t && mkdir -p pk-$t/probe && cp -r $t pk-$t/work && cp -r probe-src/. pk-$t/probe/ && cp $t/Cargo.lock pk-$t/probe/Cargo.lock
done
cat > pk-inside.sh <<'EOF'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive ZSTD_SYS_USE_PKG_CONFIG=1
apt-get update -q >/dev/null && apt-get install -y -q pkg-config libzstd-dev curl >/dev/null 2>&1
for t in main head; do
    (cd /w/pk-$t/probe && CARGO_TARGET_DIR=/w/pk-$t/target cargo build --release > /w/pk-$t/build.log 2>&1) || { tail -30 /w/pk-$t/build.log; echo "PROBE-FAILED build $t"; exit 1; }
    /w/pk-$t/target/release/probe 18083 plain 2>/w/pk-$t/probe.err &
    pid=$!
    for i in $(seq 1 50); do curl -s -o /dev/null http://127.0.0.1:18083/private && break; sleep 0.1; done
    for path in /private /wait /unstaged; do
        curl -s -D /w/pk-$t/head.txt -o /w/pk-$t/body.bin -H 'Accept:' -H 'User-Agent:' "http://127.0.0.1:18083$path"
        echo "$t $path: $(head -1 /w/pk-$t/head.txt | tr -d '\r'), $(wc -c < /w/pk-$t/body.bin) bytes, sha256 $(sha256sum < /w/pk-$t/body.bin | cut -c1-16), headers: $(tail -n +2 /w/pk-$t/head.txt | tr -d '\r' | grep -iv '^date:' | cut -d: -f1 | tr '\n' ' ')"
    done
    kill $pid; wait $pid 2>/dev/null
done
echo PROBE-DONE
EOF
docker run --rm -v /root/dl:/w -v corten-cargo:/usr/local/cargo/registry rust:1-trixie bash /w/pk-inside.sh > probe-check.log 2>&1
echo "# PROBE-CHECK-DONE" >> probe-check.log
