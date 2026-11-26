#!/bin/sh
# Tools the request-cost kit asks for, and Node at the repository's version.
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq valgrind libjemalloc2 pkg-config libzstd-dev xz-utils util-linux > /dev/null
node_version=$1
cd /tmp
curl -fsSLO "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-x64.tar.xz"
curl -fsSLO "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt"
grep " node-v${node_version}-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
tar -xJf "node-v${node_version}-linux-x64.tar.xz" -C /usr/local --strip-components=1
node --version
rustc --version
valgrind --version
nproc
