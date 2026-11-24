#!/bin/sh
# setup.sh: prepares a fresh Debian 13 x64 host (c-8, root, nothing else running) for kit 1999
# (corten-run/corten#1999, #1996) and builds it (build.sh). The four trees, the probe and the
# scripts travel in the tar; nothing is fetched with git. Upload cycles-1996-1999.tar as
# /root/cycles-1996-1999.tar, then:
#   mkdir -p /m && tar -xf /root/cycles-1996-1999.tar -C /m && sh /m/1999/setup.sh
#   nohup sh /m/1999/run.sh >/m/1999/run.out 2>&1 &
# Everything lives under /m/1999 and /m/target-1999-{base,head,x1,x2}. The linker is rustc's own
# (LLD, through cc -fuse-ld=lld), as kit 1965's; no system lld is installed or used.
# It refuses any host but Debian 13 (/etc/os-release), before installing anything. If it stops for
# any reason, it writes "RUN-ENDED setup-failed at <step> ..." and then ALL-DONE to /m/1999/run.out
# (the line the collector waits for; run.sh writes the same pair when it ends), and SETUP-DONE is
# never printed.
set -eu
[ -f /m/1999/commits.env ] || { echo "unpack cycles-1996-1999.tar into /m first"; exit 1; }
step=start
ended() {
    trap - EXIT
    if [ "$1" != 0 ]; then
        { echo "RUN-ENDED setup-failed at $step: setup.sh exit $1, nothing was measured"; echo ALL-DONE; } | tee -a /m/1999/run.out
    fi
    exit "$1"
}
trap 'ended $?' EXIT
step="the OS check"
os=$( [ -f /etc/os-release ] && . /etc/os-release && echo "${ID:-} ${VERSION_ID:-} (${PRETTY_NAME:-})" ) || os="no /etc/os-release"
case "$os" in
    "debian 13 "*) echo "setup: $os" ;;
    *) echo "setup: this kit runs on Debian 13 (DigitalOcean image debian-13-x64); /etc/os-release says '$os': refused, nothing installed"; step="the OS check (not Debian 13: $os)"; exit 1 ;;
esac
export DEBIAN_FRONTEND=noninteractive
step="waiting for apt"
systemctl stop unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
# A first boot may already be running apt's daily jobs; stopping their timers does not stop them.
w=0
while systemctl is-active --quiet apt-daily.service apt-daily-upgrade.service 2>/dev/null; do
    [ $w -lt 600 ] || { echo "setup: apt's daily jobs still running after 600 s; going on (dpkg's lock timeout still holds)"; break; }
    w=$((w + 5)); sleep 5
done
APT="-o DPkg::Lock::Timeout=600"
step="apt-get update"
apt-get $APT update -q
step="apt-get install"
apt-get $APT install -y -q build-essential binutils linux-perf wrk curl libjemalloc2 libzstd-dev pkg-config nodejs ca-certificates util-linux
# Root may count the kernel anyway; the watchdog holds a counter on some CPUs. A container cannot
# set either, so a failure here is reported, not fatal; run.sh records both values.
sysctl -w kernel.perf_event_paranoid=-1 || echo "setup: could not set kernel.perf_event_paranoid"
sysctl -w kernel.nmi_watchdog=0 || echo "setup: could not set kernel.nmi_watchdog"
step="rustup"
if ! command -v rustup >/dev/null 2>&1 && [ ! -x /root/.cargo/bin/rustup ]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.100.0
fi
[ -f /root/.cargo/env ] && . /root/.cargo/env
rustup toolchain list | grep -q '^1\.100\.0' || rustup toolchain install 1.100.0 --profile minimal
RUSTUP_TOOLCHAIN=1.100.0 rustc -V
node --version
grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list || true
step="build.sh"
sh /m/1999/build.sh
step=done
echo SETUP-DONE
