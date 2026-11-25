#!/bin/sh
# sh build.sh <commit> <directory>: builds the probe against Corten as it is at <commit>, a
# release build with the repository's profile, and leaves it at <directory>/bin/<commit>.
#
# <directory> gets the commit's tree at work/ (what a build of the crates reads) and a copy of
# probe/ beside it with the commit's Cargo.lock, so the probe is built against that commit's
# Corten with that commit's locked crates, whatever this checkout has checked out. Use one
# <directory> for every commit of a comparison, one build after another: where a crate is built
# is part of the binary, and of its count (README.md, What a count is not). zstd is linked from
# the system's libzstd, as the image `corten new` writes links it (pkg-config and libzstd-dev).
set -eu

[ $# -eq 2 ] || { echo "usage: sh build.sh <commit> <directory>" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel)
commit=$(git -C "$root" rev-parse --verify "$1^{commit}")
mkdir -p "$2/bin"
directory=$(cd "$2" && pwd)

rm -rf "$directory/work" "$directory/probe"
mkdir "$directory/work"
# -m: every file is as new as this build, so cargo builds the crates again; with the commit's
# own times a commit older than the last one built here would be taken for already built.
git -C "$root" archive "$commit" Cargo.toml Cargo.lock README.md crates docs | tar -x -m -C "$directory/work"
cp -R "$here/probe" "$directory/probe"
cp "$directory/work/Cargo.lock" "$directory/probe/Cargo.lock"

(cd "$directory/probe" && CARGO_TARGET_DIR="$directory/target" ZSTD_SYS_USE_PKG_CONFIG=1 cargo build --release)
cp "$directory/target/release/probe" "$directory/bin/$commit"
echo "built $directory/bin/$commit"
