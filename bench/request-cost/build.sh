#!/bin/sh
# sh build.sh <commit> <directory>: builds the probe against Corten as it is at <commit>, a
# release build with the repository's profile, and leaves it at <directory>/bin/<commit>.
#
# <directory>, which must be outside the checkout and any git repository, gets the commit's tree
# at work/ (what a build of the crates reads) and a copy of probe/ beside it with the commit's
# Cargo.lock, so the probe is built against that commit's Corten with that commit's locked
# crates, whatever this checkout has checked out. Use one <directory> for every commit of a
# comparison, one build after another: where a crate is built is part of the binary (README.md,
# What a count is not). zstd is linked from the system's libzstd, as the image `corten new`
# writes links it (pkg-config and libzstd-dev). A build that fails leaves no bin/<commit>.
set -eu
export LC_ALL=C

[ $# -eq 2 ] || { echo "usage: sh build.sh <commit> <directory>" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd -P)
root=$(cd "$(git -C "$here" rev-parse --show-toplevel)" && pwd -P)
commit=$(git -C "$root" rev-parse --verify "$1^{commit}")

# work/ and probe/ under <directory> are removed and written again. Inside the checkout that
# probe/ can be the kit's own, and inside another checkout of the repository that one's, so a
# directory inside this checkout or any git repository is refused before anything is made: by
# the nearest directory above it that exists, when it does not yet.
above=$2
until [ -d "$above" ]; do above=$(dirname "$above"); done
above=$(cd "$above" && pwd -P)
case "$above/" in "$root"/*) echo "build.sh: $2 is inside the checkout: give a directory outside it" >&2; exit 2 ;; esac
# git says so for a repository it will read. One it will not read, as another user's (a checkout
# mounted into a container run as root), it reports as none, so a `.git` entry in the directory
# or in one above it is a repository as well.
repository() {
    git -C "$1" rev-parse --git-dir > /dev/null 2>&1 && return 0
    at=$1
    while :; do
        if [ -e "$at/.git" ] || [ -L "$at/.git" ]; then return 0; fi
        up=$(dirname "$at")
        [ "$up" != "$at" ] || return 1
        at=$up
    done
}
if repository "$above"; then echo "build.sh: $2 is inside a git repository: give a directory outside any" >&2; exit 2; fi
mkdir -p "$2"
directory=$(cd "$2" && pwd -P)
# Nor may the checkout be in what is removed.
case "$root/" in "$directory"/work/* | "$directory"/probe/*) echo "build.sh: the checkout is inside $2/work or $2/probe" >&2; exit 2 ;; esac
mkdir -p "$directory/bin"

# The binary of an earlier build of this commit goes too: a build that fails leaves none.
rm -rf "$directory/work" "$directory/probe" "$directory/bin/$commit"
mkdir "$directory/work"
# -m: every file is as new as this build, so cargo builds the crates again; with the commit's
# own times a commit older than the last one built here would be taken for already built.
git -C "$root" archive "$commit" Cargo.toml Cargo.lock README.md crates docs | tar -x -m -C "$directory/work"
cp -R "$here/probe" "$directory/probe"
cp "$directory/work/Cargo.lock" "$directory/probe/Cargo.lock"

(cd "$directory/probe" && CARGO_TARGET_DIR="$directory/target" ZSTD_SYS_USE_PKG_CONFIG=1 cargo build --release)

# Cargo rewrites the copied lock file for the probe's own crates (--locked would refuse the copy,
# which names the whole workspace). Nothing it kept may be a version the commit's does not have.
# Names and versions are all that is compared: a crate of a locked name and version that came
# from another source, or with another checksum, is not noticed.
versions() { awk -F'"' '$1 == "name = " { name = $2 } $1 == "version = " { print name, $2 }' "$1" | sort -u; }
versions "$directory/work/Cargo.lock" > "$directory/locked.txt"
other=$(versions "$directory/probe/Cargo.lock" | grep -v '^request-cost-probe ' | comm -23 - "$directory/locked.txt")
rm "$directory/locked.txt"
[ -z "$other" ] || { echo "build.sh: built with versions the commit's Cargo.lock does not have:" >&2; echo "$other" >&2; exit 1; }

cp "$directory/target/release/probe" "$directory/bin/$commit"
echo "built $directory/bin/$commit"
