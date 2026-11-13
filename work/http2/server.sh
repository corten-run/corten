#!/bin/sh
set -eu
echo $$ > /tmp/http2-server.pid
exec valgrind --tool=callgrind --callgrind-out-file="/src/work/http2/$1.callgrind" --log-file="/src/work/http2/$1.log" /target/release/http2-probe
