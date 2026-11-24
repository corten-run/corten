#!/bin/sh
# Count host: not a measurement. Builds the kit's probe of each side as the kit builds it (the
# release profile, zstd from the system's libzstd) with LLD's map of the final link, and reads
# from each map whether .text has an input section aligned beyond 16 bytes.
exec > /root/map.out 2>&1
mkdir -p /m/dl/maps
for side in base head; do
    case $side in base) t=/root/dl/newbase.tgz ;; head) t=/root/dl/merge.tgz ;; esac
    echo "== $side ($(basename $t)) $(date -u +%T)"
    rm -rf /m/dl/work && mkdir -p /m/dl/work && tar -xzf $t -C /m/dl/work
    cp /m/dl/work/Cargo.lock /m/dl/probe/Cargo.lock
    docker run --rm -v /m/dl:/m/dl -v corten-cargo:/usr/local/cargo/registry -e CARGO_TARGET_DIR=/m/dl/target-map-$side \
        -e ZSTD_SYS_USE_PKG_CONFIG=1 -w /m/dl/probe rust:1-trixie sh -c \
        "apt-get update -q >/dev/null 2>&1; apt-get install -y -q pkg-config libzstd-dev >/dev/null 2>&1; pkg-config --modversion libzstd; cargo rustc --release -- -C link-arg=-Wl,-Map=/m/dl/maps/$side.map" \
        > /root/map-build-$side.log 2>&1 || { tail -20 /root/map-build-$side.log; echo "MAP-FAILED $side"; exit 1; }
    tail -1 /root/map-build-$side.log
    b=/m/dl/target-map-$side/release/probe
    echo "C archives the build made: $(find /m/dl/target-map-$side -path '*/out/lib/*' -name '*.a' | wc -l)"
    echo "libzstd: $(ldd $b | grep -c 'libzstd\.so'); linker: $(readelf -p .comment $b | grep -o 'Linker: LLD [0-9.]*')"
    echo "sha256 $(sha256sum $b | cut -c1-16); map $(wc -l < /m/dl/maps/$side.map) lines"
    node /root/mapsec.mjs /m/dl/maps/$side.map
done
echo "# MAP-DONE $(date -u +%T)"
