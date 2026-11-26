#!/usr/bin/env python3
"""Breaks one rule in a tree of the pull request: a deadline that waits on its connection's kept
timer no longer has its wake reach the connection's task once shutdown has begun.

    lost.py <tree>

After `graceful_shutdown` a flag of the thread is set, and from then on a deadline on a kept timer
polls that timer with a waker that does nothing, so the timer's wake is lost and the request is
answered only when something else polls its connection. Each of the three edits must match its
file exactly once.
"""
import sys

tree = sys.argv[1]
EDITS = [
    ("crates/corten/src/deadline.rs",
     """            Waiting::Kept { kept } => kept.timer.as_mut().expect("there until dropped").0.as_mut().poll(cx),\n""",
     """            Waiting::Kept { kept } if MUTATION_LOST.get() => kept.timer.as_mut().expect("there until dropped").0.as_mut().poll(&mut Context::from_waker(std::task::Waker::noop())),\n"""
     """            Waiting::Kept { kept } => kept.timer.as_mut().expect("there until dropped").0.as_mut().poll(cx),\n"""),
    ("crates/corten/src/deadline.rs",
     """/// `limit` from now, and no further off than 30 years, the longest `tokio::time::sleep` waits.\n""",
     """thread_local! { pub(crate) static MUTATION_LOST: Cell<bool> = const { Cell::new(false) }; }\n\n"""
     """/// `limit` from now, and no further off than 30 years, the longest `tokio::time::sleep` waits.\n"""),
    ("crates/corten/src/app.rs",
     """            conn.as_mut().conn().graceful_shutdown();\n""",
     """            conn.as_mut().conn().graceful_shutdown();\n"""
     """            crate::deadline::MUTATION_LOST.set(true);\n"""),
]
for path, old, new in EDITS:
    with open(f"{tree}/{path}", encoding="utf-8", newline="") as f:
        text = f.read()
    if text.count(old) != 1:
        raise SystemExit(f"{path}: the line to break is there {text.count(old)} times, not once")
    with open(f"{tree}/{path}", "w", encoding="utf-8", newline="") as f:
        f.write(text.replace(old, new))
    print(f"broken: {path}")
