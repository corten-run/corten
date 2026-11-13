#!/bin/sh
set -eu
pid=$(cat /tmp/http2-server.pid)
kill -TERM "$pid"
while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done
