#!/bin/bash
# look.sh: inside a rust:1-trixie container, off any measuring host. For each plan directory under
# /look, resolves a DRY gated part for one workload and runs the kit's build.sh, which builds each
# side once, records each side's map and starts nothing. Then starts each side's unpadded binary
# with each workload's start line and keeps its answer's headers and body, twice for the base.
# No load is sent and no counter is read.
set -u
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null 2>&1
apt-get install -y -q nodejs git libzstd-dev pkg-config libjemalloc2 curl binutils util-linux >/dev/null 2>&1
git config --global --add safe.directory /look/repo
rustup toolchain list | grep -q '^1.100.0' || rustup toolchain install 1.100.0 --profile minimal >/dev/null 2>&1
RUSTUP_TOOLCHAIN=1.100.0 rustc -V
node --version
cd /look/repo
git rev-parse HEAD
for pw in 2066:plain 2067:text; do
  p=${pw%%:*}; w=${pw##*:}
  echo "=== plan-$p"
  node bench/placement/plan.mjs /look/plan-$p/plan.json >/look/declare-$p.txt 2>&1; echo "declare $p exit $?"
  DRYRUN=1 node bench/placement/plan.mjs /look/plan-$p/plan.json gated $w /look/w-$p >/look/resolve-$p.txt 2>&1; echo "resolve $p exit $?"
  sh bench/placement/build.sh /look/w-$p >/look/build-$p.txt 2>&1; echo "build $p exit $?"
  tail -n 12 /look/build-$p.txt
done
echo LOOK-BUILD-DONE
# end
