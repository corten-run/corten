#!/usr/bin/env bash
# Runs on a measuring droplet (Ubuntu 24.04 c-16): Docker, wrk, perf, card-market's image built
# from the tree in /root/tc-merged.tgz, and the fixtures. Ends "setup done" in /root/setup-tc.log.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
for i in $(seq 1 90); do
    if fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || fuser /var/lib/apt/lists/lock >/dev/null 2>&1 || fuser /var/lib/dpkg/lock >/dev/null 2>&1; then sleep 5; else break; fi
done
systemctl stop unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
apt-get update -q >/dev/null 2>&1
apt-get install -y -q wrk linux-tools-common linux-tools-generic "linux-tools-$(uname -r)" python3 psmisc >/dev/null 2>&1 || echo "FAIL apt"
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
command -v docker >/dev/null && command -v wrk >/dev/null && perf stat -x, -e cycles:u,cycles:k,instructions:u true >/dev/null 2>&1 || { echo "FAIL tools"; exit 1; }
rm -rf /root/corten-tc && mkdir -p /root/corten-tc && tar -xzf /root/tc-merged.tgz -C /root/corten-tc || { echo "FAIL tree"; exit 1; }
cd /root/corten-tc
docker build -f examples/card-market/Dockerfile -t corten-card-market-tc . > /root/build-tc.log 2>&1 || { echo "FAIL build"; tail -20 /root/build-tc.log; exit 1; }
id=$(docker create corten-card-market-tc) && docker cp "$id:/app/server" /root/server.bin 2>/dev/null; docker rm -f -v "$id" >/dev/null 2>&1
docker inspect -f '{{json .Config.Env}} {{json .Config.Entrypoint}} {{json .Config.Cmd}}' corten-card-market-tc
sha256sum /root/server.bin 2>/dev/null
python3 /root/sizes.py /root/corten-tc/examples/card-market/fixtures/smoke.json /root/fixtures-sizes 1 20 160 400
uname -r; lscpu | grep "Model name" | head -1; docker --version; wrk -v 2>&1 | head -1; perf --version
echo "setup done $(date -u +%H:%M:%S)"
