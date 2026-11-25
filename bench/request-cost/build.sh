#!/bin/sh
# sh build.sh <commit> <directory>: builds the probe against Corten as it is at <commit>, a
# release build with the repository's profile, into <directory>/target/release/probe.
#
# <directory> gets the commit's tree at work/ (what a build of the crates reads) and a copy of
# probe/ beside it with the commit's Cargo.lock, so the probe is built against that commit's
# Corten with that commit's locked crates, whatever this checkout has checked out. Each commit
# takes a directory of its own. zstd is linked from the system's libzstd, as the image
# `corten new` writes links it (pkg-config and libzstd-dev).
set -eu

[ $# -eq 2 ] || { echo "usage: sh build.sh <commit> <directory>" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel)
commit=$(git -C "$root" rev-parse --verify "$1^{commit}")
mkdir -p "$2"
directory=$(cd "$2" && pwd)

rm -rf "$directory/work" "$directory/probe"
mkdir "$directory/work"
git -C "$root" archive "$commit" Cargo.toml Cargo.lock README.md crates docs | tar -x -C "$directory/work"
cp -R "$here/probe" "$directory/probe"
cp "$directory/work/Cargo.lock" "$directory/probe/Cargo.lock"

cd "$directory/probe"
CARGO_TARGET_DIR="$directory/target" ZSTD_SYS_USE_PKG_CONFIG=1 cargo build --release
echo "built $directory/target/release/probe against $commit"
