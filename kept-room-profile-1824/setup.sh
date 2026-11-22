#!/bin/sh
# setup.sh: prepares a fresh Debian 13 x64 host (c-8, dedicated CPU, root, nothing else running)
# for corten-run/corten#1824's kit (1824c) and builds it (build.sh). main's tree, the probe,
# faultcost and the scripts travel in the tar; nothing is fetched with git.
# /root/start.sh runs this and then run.sh; by hand:
#   mkdir -p /m && tar -xf /root/cycles-1824c.tar -C /m && sh /m/1824c/setup.sh
# Everything lives under /m/1824c and /m/target-1824c*, so another kit can be unpacked beside it
# under /m and run before or after it (not at the same time: it uses CPUs 2, 4, 5, 7 and ports
# 18081-18082, as 1824b, 1846r and 1923 did); a toolchain or package already installed is kept.
set -eu
[ -f /m/1824c/commits.env ] || { echo "unpack cycles-1824c.tar into /m first"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
systemctl stop unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
apt-get update -q
apt-get install -y -q build-essential patch linux-perf wrk curl libjemalloc2 libzstd-dev pkg-config nodejs ca-certificates util-linux procps zstd
# A container cannot set these, so a failure here is reported, not fatal; run.sh records them
# and stops if perf cannot count or sample.
sysctl -w kernel.perf_event_paranoid=-1 || echo "setup: could not set kernel.perf_event_paranoid"
sysctl -w kernel.kptr_restrict=0 || echo "setup: could not set kernel.kptr_restrict"
sysctl -w kernel.nmi_watchdog=0 || echo "setup: could not set kernel.nmi_watchdog"
# Pass A samples about 2,700 times a second; the kernel would otherwise lower its sampling rate
# when an interrupt takes long (a guest's PMU interrupts do), and throttle the turns unevenly.
sysctl -w kernel.perf_cpu_time_max_percent=0 kernel.perf_event_max_sample_rate=100000 || echo "setup: could not set the perf sampling limits"
if ! command -v rustup >/dev/null 2>&1 && [ ! -x /root/.cargo/bin/rustup ]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.100.0
fi
[ -f /root/.cargo/env ] && . /root/.cargo/env
rustup toolchain list | grep -q '^1\.100\.0' || rustup toolchain install 1.100.0 --profile minimal
RUSTUP_TOOLCHAIN=1.100.0 rustc -V
perf stat -x, -e cycles:u,cycles:k,instructions:u true || echo "setup: perf cannot count cycles here (run.sh will stop)"
grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list
echo "thp enabled: $(cat /sys/kernel/mm/transparent_hugepage/enabled), defrag: $(cat /sys/kernel/mm/transparent_hugepage/defrag)"
sh /m/1824c/build.sh
echo SETUP-DONE