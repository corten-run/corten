set -eu
# setup.sh: prepares a quiet host for #1865's run (the 1865v3 kit). Expects /root/cycles-1865v3.tar
# (pack.ps1). Installs the tools, rustc 1.100.0, checks perf's counters and the CPUs' siblings, then
# builds both probes with their declared locks (build.sh, --locked).
mkdir -p /m && tar -xf /root/cycles-1865v3.tar -C /m && chmod +x /m/*.sh /m/1865/*.sh
export DEBIAN_FRONTEND=noninteractive
systemctl stop unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
apt-get update -q
apt-get install -y -q build-essential linux-perf wrk curl libjemalloc2 libzstd-dev pkg-config nodejs git ca-certificates
sysctl -w kernel.perf_event_paranoid=-1
sysctl -w kernel.nmi_watchdog=0
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.100.0
. /root/.cargo/env
rustc -V
perf stat -x, -e cycles:u,cycles:k,instructions:u true
# The diagnostic pass's event (run-icache.sh checks it again and records a host that cannot count it).
perf stat -x, -e L1-icache-load-misses:u,instructions:u true || true
grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list
sh /m/build.sh
echo SETUP-DONE
