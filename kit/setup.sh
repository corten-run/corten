#!/bin/sh
# setup.sh: prepares a fresh Debian 13 x64 host (c-8, root, nothing else running) for 1846w, the
# held value's wait alone (corten-run/corten#1846; results/margin.md), and builds its two probes
# (build.sh, ends BUILD-DONE). The trees and the probe travel in the tar; nothing is fetched with
# git. /root/start.sh runs this and run.sh, detached, into /m/1846w/run.out.
# Everything lives under /m/1846w and /m/target-1846w-wait, so another kit can be unpacked beside
# it under /m and run before or after it, not at the same time (it uses CPUs 2, 4, 5 and 7); a
# toolchain or package already installed is kept.
set -eu
[ -f /m/1846w/commits.env ] || { echo "unpack cycles-1846w.tar into /m first"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
systemctl stop unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
apt-get update -q
apt-get install -y -q build-essential curl libjemalloc2 libzstd-dev pkg-config nodejs ca-certificates util-linux
if ! command -v rustup >/dev/null 2>&1 && [ ! -x /root/.cargo/bin/rustup ]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.100.0
fi
[ -f /root/.cargo/env ] && . /root/.cargo/env
rustup toolchain list | grep -q '^1\.100\.0' || rustup toolchain install 1.100.0 --profile minimal
RUSTUP_TOOLCHAIN=1.100.0 rustc -V
grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list
sh /m/1846w/build.sh
echo SETUP-DONE
