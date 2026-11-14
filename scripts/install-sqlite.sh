#!/bin/sh
# A patched system SQLite for auction-room, shared by CI and its Docker image.
# Requires curl, OpenSSL, a C compiler, make and pkg-config (present in rust:*bookworm).
set -eu

prefix=${1:-/usr/local}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
cd "$work"
curl --fail --location --silent --show-error \
    https://www.sqlite.org/2026/sqlite-autoconf-3540100.tar.gz -o sqlite.tar.gz
# SHA3-256 published at https://www.sqlite.org/download.html for SQLite 3.54.1.
test "$(openssl dgst -sha3-256 -r sqlite.tar.gz | cut -d ' ' -f 1)" = \
    b6ced585c750916b1052667239a12c25a7ff34e7f06e1e6e01ecb0427657d9c4
tar -xzf sqlite.tar.gz
cd sqlite-autoconf-3540100
CFLAGS='-O2 -DSQLITE_ENABLE_UNLOCK_NOTIFY -DSQLITE_ENABLE_COLUMN_METADATA' \
    ./configure --prefix="$prefix" --disable-static --disable-readline
make -j 2
make install
if [ "$prefix" = /usr/local ]; then ldconfig; fi
"$prefix/bin/sqlite3" :memory: 'SELECT sqlite_version();'
