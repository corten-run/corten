#!/usr/bin/env bash
# Runs on the 48-CPU host. `setup.sh kernel` installs the newer kernel the load generator's io_uring
# buffer rings need and reboots; `setup.sh tools` (after the reboot) installs Docker, perf, the
# load tools' images and the host settings the earlier throughput runs had.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
while pgrep -x apt-get >/dev/null || pgrep -x dpkg >/dev/null; do sleep 3; done
if [ "${1:-}" = kernel ]; then
    apt-get update -qq >/dev/null 2>&1
    apt-get install -y -qq linux-image-generic-hwe-24.04 >/root/kernel-install.log 2>&1
    echo "kernel installed rc=$?; rebooting"
    systemctl reboot
    exit 0
fi
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq docker.io docker-buildx git python3 curl wrk "linux-tools-$(uname -r)" >/root/tools-install.log 2>&1 \
    || apt-get install -y -qq docker.io git python3 curl wrk linux-tools-generic-hwe-24.04 >>/root/tools-install.log 2>&1
docker --version || { tail -5 /root/tools-install.log; echo "NO DOCKER"; exit 1; }
mkdir -p /root/t48 && cd /root/t48
[ -d HttpArena ] || git clone -q --depth 1 https://github.com/MDA2AV/HttpArena.git
git -C HttpArena log -1 --format='HttpArena %H %cs'
sysctl -qw net.core.somaxconn=65535 net.ipv4.tcp_max_syn_backlog=65535 net.core.netdev_max_backlog=65535 \
    net.ipv4.ip_local_port_range='1024 65535' net.ipv4.tcp_max_tw_buckets=131072 net.ipv4.tcp_tw_reuse=1 \
    net.ipv4.ip_local_reserved_ports='5432,6379,8080,8081,8082,8443,9090' kernel.perf_event_paranoid=-1 kernel.kptr_restrict=0
docker build -q -t httparena-gcannon:gap -f HttpArena/docker/gcannon.Dockerfile HttpArena/docker > build-gcannon.log 2>&1 || { tail -15 build-gcannon.log; echo "NO GCANNON"; }
docker pull -q rust:1-trixie
docker pull -q debian:trixie-slim
uname -r; nproc; lscpu | sed -n 's/^Model name: *//p'
perf --version 2>&1 | head -1
perf stat -a -C 0-1 -e cycles,instructions -x, sleep 1 2>&1 | head -4
wrk --version 2>&1 | head -1
docker run --rm --network host httparena-gcannon:gap --help 2>&1 | head -30
ls HttpArena/requests | head -40
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | sort | tr '\n' ' '
echo
echo "# SETUP-DONE $(date -u +%T)"
