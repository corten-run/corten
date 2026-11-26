#!/bin/sh
# setup.sh <rust toolchain>: prepares a fresh Debian 13 x64 host (dedicated CPUs, root, nothing
# else running) for a placement run: the packages the scripts use (a C compiler and binutils,
# perf, wrk, curl, git, Node, jemalloc and libzstd for a probe that is started or linked with
# them), the toolchain the plan names (its LLD is the linker: no system lld is installed or
# used), and the two kernel settings perf needs to count every turn whole. It refuses any host
# but Debian 13 before installing anything, since the package names are Debian 13's. Ends with
# SETUP-DONE.
set -eu
T=${1:-}
[ -n "$T" ] || { echo "usage: setup.sh <rust toolchain>   (the plan's probe.toolchain)" >&2; exit 2; }
os=$( [ -f /etc/os-release ] && . /etc/os-release && echo "${ID:-} ${VERSION_ID:-} (${PRETTY_NAME:-})" ) || os="no /etc/os-release"
case "$os" in
    "debian 13 "*) echo "setup: $os" ;;
    *) echo "setup: these packages are Debian 13's; /etc/os-release says '$os': refused, nothing installed" >&2; exit 1 ;;
esac
export DEBIAN_FRONTEND=noninteractive
systemctl stop unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
# A first boot may already be running apt: its daily jobs, which stopping their timers does not
# stop, or the image's own first-boot installs. apt-get update does not wait for their lock.
w=0
while systemctl is-active --quiet apt-daily.service apt-daily-upgrade.service 2>/dev/null || pgrep -x apt-get >/dev/null || pgrep -x dpkg >/dev/null; do
    [ $w -lt 600 ] || { echo "setup: apt still running after 600 s; going on"; break; }
    w=$((w + 5)); sleep 5
done
APT="-o DPkg::Lock::Timeout=600"
apt-get $APT update -q
apt-get $APT install -y -q build-essential binutils linux-perf wrk curl git libjemalloc2 libzstd-dev pkg-config nodejs ca-certificates util-linux
# Root may count the kernel anyway; the watchdog holds a counter on some CPUs.
sysctl -w kernel.perf_event_paranoid=-1 || echo "setup: could not set kernel.perf_event_paranoid"
sysctl -w kernel.nmi_watchdog=0 || echo "setup: could not set kernel.nmi_watchdog"
if ! command -v rustup >/dev/null 2>&1 && [ ! -x "$HOME/.cargo/bin/rustup" ]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain "$T"
fi
[ ! -f "$HOME/.cargo/env" ] || . "$HOME/.cargo/env"
rustup toolchain list | grep -q "^$T" || rustup toolchain install "$T" --profile minimal
RUSTUP_TOOLCHAIN="$T" rustc -V
node --version
perf stat -x, -e cycles:u,cycles:k,instructions:u,L1-icache-load-misses:u true || echo "setup: perf cannot count the events here (run.sh will stop)"
grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list
echo SETUP-DONE
