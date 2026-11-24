#!/usr/bin/env bash
# Host setup and the three trees.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
apt-get install -y -qq git python3 >/dev/null 2>&1
docker pull -q rust:1-trixie
cd /root/dl
for t in main a c; do rm -rf $t; mkdir $t; tar -xzf $t.tgz -C $t; done
echo "# SETUP-DONE rc=$?"
