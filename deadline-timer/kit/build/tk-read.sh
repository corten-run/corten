#!/usr/bin/env bash
# Runs on the build host: reads tokio's published source at the crate's minimum version (1.44.0)
# and at the version in the lock file (1.54.1) for what a timer made, moved and dropped takes.
set -uo pipefail
mkdir -p /root/tk && cd /root/tk
[ -d tokio-1.44.0 ] || (curl -sSL https://static.crates.io/crates/tokio/tokio-1.44.0.crate | tar xz)
[ -d tokio-1.54.1 ] || docker run --rm -v corten-cargo:/r -v /root/tk:/o rust:1-trixie sh -c 'cp -r /r/src/*/tokio-1.54.1 /o/ && chmod -R a+rX /o/tokio-1.54.1'
for v in 1.44.0 1.54.1; do
    cd /root/tk/tokio-$v/src
    echo "######## tokio $v"
    echo "== pub fn sleep"; awk '/^pub fn sleep\(/,/^}/' time/sleep.rs
    echo "== far_future"; grep -n "fn far_future" -A 8 time/instant.rs
    echo "== Sleep::new_timeout"; awk '/fn new_timeout\(/,/^    }/' time/sleep.rs | grep -v "tracing\|^ *//" | head -60
    echo "== Sleep::reset_inner"; awk '/fn reset_inner\(/,/^    }/' time/sleep.rs | grep -v "^ *//" | head -40
    echo "== TimerEntry::new"; awk '/pub\(crate\) fn new\(/,/^    }/' runtime/time/entry.rs
    echo "== TimerEntry::reset"; awk '/pub\(crate\) fn reset\(/,/^    }/' runtime/time/entry.rs
    echo "== extend_expiration"; awk '/fn extend_expiration\(/,/^    }/' runtime/time/entry.rs
    echo "== TimerEntry::cancel and Drop"; awk '/pub\(crate\) fn cancel\(/,/^    }/' runtime/time/entry.rs | grep -v "^ *//"; awk '/^impl Drop for TimerEntry/,/^}/' runtime/time/entry.rs
    echo "== clear_entry"; awk '/unsafe fn clear_entry\(/,/^    }/' runtime/time/mod.rs
    echo "== Handle::id"; grep -n "pub fn id" -B 12 runtime/handle.rs | grep -n "cfg\|pub fn id\|unstable"
    echo "== alt timer"; grep -rn "enable_alt_timer" -B 8 runtime/builder.rs | grep "cfg\|pub fn enable_alt_timer\|unstable" | head
done
echo TK-DONE
