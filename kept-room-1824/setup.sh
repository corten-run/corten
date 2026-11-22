#!/bin/sh
# setup.sh: prepares a fresh Debian 13 x64 host (c-8, dedicated CPU, root, nothing else running)
# for corten-run/corten#1824's kit (1824b) and builds it (build.sh). main's tree, the variant's
# diff, the probe, faultcost and the scripts travel in the tar; nothing is fetched with git.
# /root/start.sh runs this and then run.sh; by hand:
#   mkdir -p /m && tar -xf /root/cycles-1824b.tar -C /m && sh /m/1824b/setup.sh
# Everything lives under /m/1824b and /m/target-1824b*, so another kit can be unpacked beside it
# under /m and run before or after it (not at the same time: it uses CPUs 2, 4, 5, 7 and ports
# 18081-18082); a toolchain or package already installed is kept.
set -eu
[ -f /m/1824b/commits.env ] || { echo "unpack cycles-1824b.tar into /m first"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
systemctl stop unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
apt-get update -q
apt-get install -y -q build-essential patch linux-perf wrk curl libjemalloc2 libzstd-dev pkg-config nodejs ca-certificates util-linux procps
# A container cannot set these, so a failure here is reported, not fatal; run.sh records both.
sysctl -w kernel.perf_event_paranoid=-1 || echo "setup: could not set kernel.perf_event_paranoid"
sysctl -w kernel.nmi_watchdog=0 || echo "setup: could not set kernel.nmi_watchdog"
if ! command -v rustup >/dev/null 2>&1 && [ ! -x /root/.cargo/bin/rustup ]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.100.0
fi
[ -f /root/.cargo/env ] && . /root/.cargo/env
rustup toolchain list | grep -q '^1\.100\.0' || rustup toolchain install 1.100.0 --profile minimal
RUSTUP_TOOLCHAIN=1.100.0 rustc -V
perf stat -x, -e cycles:u,cycles:k,instructions:u true || echo "setup: perf cannot count cycles here (run.sh will stop)"
grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list
echo "thp enabled: $(cat /sys/kernel/mm/transparent_hugepage/enabled), defrag: $(cat /sys/kernel/mm/transparent_hugepage/defrag)"
sh /m/1824b/build.sh
echo SETUP-DONE