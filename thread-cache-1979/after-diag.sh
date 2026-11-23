#!/usr/bin/env bash
# Runs on the check droplet once the diagnostic is done: the fault counts of faults6.sh for the
# 512 KiB limit with the three other Accept-Encoding values, then burst.sh. Usage: after-diag.sh <image>
until [ -f /root/tc-diag/done.txt ]; do sleep 10; done
NS="1 20 160" CONFS="524288" ENC="gzip, deflate, br, zstd" OUT=/root/faults-enc-512k-gzipdeflateb.out bash /root/faults6.sh "$1"
NS="1 20 160" CONFS="524288" ENC="identity" OUT=/root/faults-enc-512k-identity.out bash /root/faults6.sh "$1"
NS="1 20 160" CONFS="524288" ENC="gzip" OUT=/root/faults-enc-512k-gzip.out bash /root/faults6.sh "$1"
bash /root/burst.sh "$1"
date -u > /root/after-diag.done
