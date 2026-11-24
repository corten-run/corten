#!/usr/bin/env bash
# Runs on the build host, after tk-read.sh: how many locks tokio's timer wheel has at each version,
# which one a timer takes, and the longest tokio's sleep waits.
set -uo pipefail
for v in 1.44.0 1.54.1; do
    cd /root/tk/tokio-$v/src
    echo "######## tokio $v"
    echo "== wheels and their locks (runtime/time/mod.rs)"; grep -n "wheels\|shard\|Mutex<\|RwLock<\|fn lock\b\|fn lock(" runtime/time/mod.rs | head -40
    echo "== which shard an entry takes"; grep -rn "shard_id\|get_shard_size\|generate_shard_id" runtime/time/entry.rs runtime/time/mod.rs runtime/builder.rs runtime/context.rs runtime/scheduler/mod.rs 2>/dev/null | head -24
    echo "== reregister"; awk '/unsafe fn reregister\(/,/^    }/' runtime/time/mod.rs | grep -v "^ *//" | head -50
    echo "== safe_delay"; grep -rn "fn safe_delay" -A 12 time/ | head -20
done
echo TK2-DONE
