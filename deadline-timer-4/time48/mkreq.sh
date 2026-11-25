#!/usr/bin/env bash
# Runs on the 48-CPU host: the two request files of the measurement, in the form of HttpArena's own
# (shown first), and what the checkout has of the data the server's container mounts.
cd /root/t48
for f in get.raw async-delay.raw; do echo "== HttpArena/requests/$f"; od -c HttpArena/requests/$f | head -8; done
mkdir -p req
printf 'GET /sdelay/10 HTTP/1.1\r\nHost: localhost:8080\r\n\r\n' > req/sdelay10.raw
printf 'GET /baseline11?a=1&b=2 HTTP/1.1\r\nHost: localhost:8080\r\n\r\n' > req/get.raw
for f in req/*.raw; do echo "== $f"; od -c $f | head -5; done
ls -la HttpArena/data/dataset.json HttpArena/data/static HttpArena/certs 2>&1 | head -12
docker run --rm --network host httparena-gcannon:gap --version 2>&1 | head -2
