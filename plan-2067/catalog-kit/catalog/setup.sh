#!/bin/sh
# catalog/setup.sh: prepares the plan's Debian 13 x64 measuring host with 8 dedicated CPUs (root,
# nothing else running), after its last placement part has ended, for the catalog's two workloads,
# as bench/fullstack/droplet.mjs provisions a bench host for count.mjs: no package updates during
# the run, the kernel set to restart on a lockup, Docker, and the bench network. Node and perf are
# the ones the placement kit's setup.sh installed (Debian 13's); they are installed only if absent.
# It refuses while a placement part is turning on the host. Then what count.mjs needs is
# checked (cgroup v2, Docker under systemd's cgroup driver, perf) and the items' digest, and the
# host is recorded. The trees and the items travel in the tar; nothing is fetched with git.
#   sh /m/hc/catalog/setup.sh        (README.md says how /m/hc is laid out)
# Ends with SETUP-DONE.
set -eu
P=/m/hc; C=$P/catalog; T=$P/tree-head; S=$P/catalog-state
ITEMS_SHA=0da002709abafeced901f93ba07b5c1a30606ca5572be7771f7e8d27fcbd3183
ITEMS_BYTES=27693929
[ -f $P/commits.env ] && [ -d $T/bench/fullstack ] || { echo "lay out /m/hc first (README.md)"; exit 1; }
os=$( [ -f /etc/os-release ] && . /etc/os-release && echo "${ID:-} ${VERSION_ID:-} (${PRETTY_NAME:-})" ) || os="no /etc/os-release"
case "$os" in
    "debian 13 "*) echo "setup: $os" ;;
    *) echo "setup: the plan's hosts are Debian 13; /etc/os-release says '$os': refused, nothing installed"; exit 1 ;;
esac
# Watched for ten seconds, by process name: a part's turns, checks and builds run one of these.
w=0
while [ $w -lt 20 ]; do
    ! pgrep -x 'wrk|perf|probe|cargo|rustc' >/dev/null || { echo "setup: a placement part is running on this host (wrk, perf, a probe or a build): refused, nothing installed"; exit 1; }
    w=$((w + 1)); sleep 0.5
done
[ "$(nproc)" = 8 ] || { echo "setup: $(nproc) CPUs, not 8: the app is on CPU 1 and the load on CPUs 4 to 7"; exit 1; }
mkdir -p $S
export DEBIAN_FRONTEND=noninteractive
cloud-init status --wait >/dev/null 2>&1 || true
# No package updates during the run, and an apt run already started is waited out.
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
timeout 900 systemd-run --quiet --property=After=apt-daily.service --property=After=apt-daily-upgrade.service --wait /bin/true
# A host that locks up restarts itself.
printf 'kernel.softlockup_panic = 1\nkernel.panic_on_rcu_stall = 1\nkernel.panic = 10\n' >/etc/sysctl.d/90-corten-bench.conf
sysctl -q -p /etc/sysctl.d/90-corten-bench.conf
(modprobe softdog && printf 'softdog\n' >/etc/modules-load.d/corten-bench.conf && mkdir -p /etc/systemd/system.conf.d \
    && printf '[Manager]\nRuntimeWatchdogSec=5min\n' >/etc/systemd/system.conf.d/corten-bench.conf && systemctl daemon-reexec) || echo "setup: no software watchdog"
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh >/dev/null
command -v node >/dev/null || (curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null && apt-get install -y -qq nodejs >/dev/null)
command -v perf >/dev/null || apt-get install -y -qq linux-perf >/dev/null
docker network create rustbench >/dev/null 2>&1 || true

# What count.mjs needs.
[ "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs ] || { echo "setup: /sys/fs/cgroup is $(stat -fc %T /sys/fs/cgroup), not cgroup v2"; exit 1; }
drv=$(docker info --format '{{.CgroupDriver}} {{.CgroupVersion}}')
[ "$drv" = "systemd 2" ] || { echo "setup: Docker's cgroup driver and version are '$drv', not 'systemd 2': count.mjs names the container's cgroup system.slice/docker-<id>.scope"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "setup: not root"; exit 1; }
perf stat -C 1 -x, -e instructions:u,instructions:k,cycles:u,cycles:k,L1-icache-load-misses:u -- sleep 1 2>$S/perf-setup.txt || { cat $S/perf-setup.txt; echo "setup: perf cannot count"; exit 1; }
cat $S/perf-setup.txt

# The items both sides read.
items=$T/bench/fullstack/fixtures/items.json
[ -f "$items" ] || { echo "setup: no $items"; exit 1; }
got="$(sha256sum "$items" | cut -d' ' -f1) $(stat -c %s "$items")"
[ "$got" = "$ITEMS_SHA $ITEMS_BYTES" ] || { echo "setup: items.json is '$got', not the plan's $ITEMS_SHA $ITEMS_BYTES"; exit 1; }
echo "items.json: sha256 $ITEMS_SHA, $ITEMS_BYTES bytes" | tee $S/items.txt

# bench/ is the same bytes on both sides, so the head's copy of the script counts both.
diff -rq -x fixtures -x results $P/tree-base/bench $P/tree-head/bench >/dev/null || { echo "setup: bench/ differs between the two trees"; exit 1; }
echo "bench/ is the same bytes in both trees"

# If the host restarts during a run, the run goes on from the next pair (run.sh; the pair it
# interrupted is failed and not run again).
cat >/etc/systemd/system/hc-catalog.service <<'EOF'
[Unit]
Description=The catalog's pairs, gone on with after a restart
After=docker.service network-online.target
Wants=docker.service network-online.target
ConditionPathExists=/m/hc/catalog-state/armed

[Service]
Type=oneshot
Environment=HOME=/root
ExecStart=/bin/sh -c 'exec sh /m/hc/catalog/run.sh >>/m/hc/catalog.out 2>&1'
TimeoutStartSec=infinity

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --quiet hc-catalog.service

{ date -u; lscpu; echo; lscpu -e; echo; free -m; echo "kernel $(uname -r)"; echo "os $os"
  docker --version; echo "docker cgroup: $drv"; echo "node $(node --version)"; perf --version
  echo "cgroup: $(stat -fc %T /sys/fs/cgroup)"; echo "items.json: $got"
  echo "base $(cat $P/tree-base.commit)"; echo "head tree $(cat $P/tree-head.commit) (the script, bench/, is run from it)"
  grep -H . /sys/devices/system/cpu/cpu*/topology/thread_siblings_list; } >$S/host.txt 2>&1
{ echo "model $(awk -F': *' '/^model name/ { print $2; exit }' /proc/cpuinfo)"
  echo "microcode $(awk -F': *' '/^microcode/ { print $2; exit }' /proc/cpuinfo)"
  echo "kernel $(uname -r)"; echo "os $os"; } >$S/host-id.txt
cat $S/host-id.txt
echo SETUP-DONE
