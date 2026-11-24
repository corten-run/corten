#!/usr/bin/env bash
export DEBIAN_FRONTEND=noninteractive
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
apt-get install -y -qq git python3 >/dev/null 2>&1
docker pull -q rust:1-trixie
mkdir -p /root/dl
echo "# SETUP-DONE"
