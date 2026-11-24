#!/bin/sh
# setup.sh <workload>: prepares a fresh Debian 13 x64 host (8 dedicated CPUs, root, nothing else
# running) for this kit and builds that workload's binaries (build.sh). The trees, the probe and
# the scripts travel in the tar; nothing is fetched with git.
#   mkdir -p /m && tar -xf /root/cycles-deadline.tar -C /m && sh /m/dl/setup.sh <workload>
# The linker is rustc's own (LLD, through cc -fuse-ld=lld); no system lld is installed or used.
# It refuses any host but Debian 13 before installing anything. Ends with SETUP-DONE.
set -eu
W=${1:-}
case "$W" in plain|wait|close|unstaged) ;; *) echo "usage: setup.sh plain|wait|close|unstaged"; exit 2 ;; esac
[ -f /m/dl/commits.env ] || { echo "unpack the kit's tar into /m first"; exit 1; }
os=$( [ -f /etc/os-release ] && . /etc/os-release && echo "${ID:-} ${VERSION_ID:-} (${PRETTY_NAME:-})" ) || os="no /etc/os-release"
case "$os" in
    "debian 13 "*) echo "setup: $os" ;;
    *) echo "setup: this kit runs on Debian 13; /etc/os-release says '$os': refused, nothing installed"; exit 1 ;;
esac
export DEBIAN_FRONTEND=noninteractive
systemctl stop unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
# A first boot may already be running apt's daily jobs; stopping their timers does not stop them.
w=0
while systemctl is-active --quiet apt-daily.service apt-daily-upgrade.service 2>/dev/null; do
    [ $w -lt 600 ] || { echo "setup: apt's daily jobs still running after 600 s; going on"; break; }
    w=$((w + 5)); sleep 5
done
APT="-o DPkg::Lock::Timeout=600"
apt-get $APT update -q
apt-get $APT install -y -q build-essential binutils linux-perf wrk curl libjemalloc2 libzstd-dev pkg-config nodejs ca-certificates util-linux
# Root may count the kernel anyway; the watchdog holds a counter on some CPUs.
sysctl -w kernel.perf_event_paranoid=-1 || echo "setup: could not set kernel.perf_event_paranoid"
sysctl -w kernel.nmi_watchdog=0 || echo "setup: could not set kernel.nmi_watchdog"
if ! command -v rustup >/dev/null 2>&1 && [ ! -x /root/.cargo/bin/rustup ]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.100.0
fi
[ -f /root/.cargo/env ] && . /root/.cargo/env
rustup toolchain list | grep -q '^1\.100\.0' || rustup toolchain install 1.100.0 --profile minimal
RUSTUP_TOOLCHAIN=1.100.0 rustc -V
node --version
perf stat -x, -e cycles:u,cycles:k,instructions:u,L1-icache-load-misses:u true || echo "setup: perf cannot count the plan's events here (run.sh will stop)"
grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list
sh /m/dl/build.sh "$W"
echo SETUP-DONE
