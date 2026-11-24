#!/usr/bin/env python3
"""Breaks one rule of the deadline's timer in a tree, for a test that must then fail.

    python3 mut2.py <tree> <name>

Each break replaces text that must be there exactly once. mut.py of the tag
evidence/deadline-timer (deadline-timer/kit/build/mut.py), for the form that makes a connection's
timer at its second request to wait, with four breaks added: made-at-the-first, made-when-polled,
never-made and thread-local-unchecked.
"""

import sys

DEADLINE = "crates/corten/src/deadline.rs"
APP = "crates/corten/src/app.rs"
TAKE = "let mut timer = TIMER.try_with(Cell::take).ok()??;"

BREAKS = {
    # (a) Served requests stop taking the connection's timer.
    "never-taken": [(DEADLINE, TAKE, "let mut timer = TIMER.try_with(|_| None::<Held>).ok()??;")],
    # (b) The thread is not put back when a connection's poll panics.
    "no-restore-on-panic": [
        (
            DEADLINE,
            "        if BY.replace(self.by) > ASKED {\n            swap(&mut self.mine.timer);",
            "        if std::thread::panicking() {\n            return;\n        }\n"
            "        if BY.replace(self.by) > ASKED {\n            swap(&mut self.mine.timer);",
        )
    ],
    # (c) A timer goes back to whichever connection with a number is being polled.
    "given-to-any-connection": [
        (DEADLINE, "if BY.try_with(Cell::get) == Ok(self.of) {", "if BY.try_with(Cell::get).is_ok_and(|by| by > ASKED) {")
    ],
    # (d) A deadline takes the thread's timer without asking whose poll it is in.
    "taken-without-asking-whose": [
        (
            DEADLINE,
            "        if of <= ASKED {\n            return None;\n        }\n        " + TAKE,
            "        " + TAKE,
        )
    ],
    # (e) A kept timer is not polled with the waker of the poll it is in.
    "kept-timer-keeps-no-waker": [
        (
            DEADLINE,
            '.expect("there until dropped").0.as_mut().poll(cx),',
            '.expect("there until dropped").0.as_mut().poll(&mut Context::from_waker(std::task::Waker::noop())),',
        )
    ],
    # (f) The connection is polled without what it keeps while it drains at shutdown.
    "drained-unwrapped": [
        (
            APP,
            "while tokio::time::timeout_at(by, conn.as_mut()).await.is_err() {",
            "while tokio::time::timeout_at(by, conn.as_mut().conn()).await.is_err() {",
        )
    ],
    # (7) As the code was before the first review: a deadline asks before it has made its own
    # timer, and the connection makes its timer with nothing to catch a panic.
    "asks-first-and-no-catch": [
        (
            DEADLINE,
            "                    let timer = tokio::time::sleep(limit);\n"
            "                    // After the timer is made, which panics on a runtime with no clock.\n"
            "                    ask();\n",
            "                    ask();\n                    let timer = tokio::time::sleep(limit);\n",
        ),
        (
            DEADLINE,
            "std::panic::catch_unwind(|| Box::pin(tokio::time::sleep(Duration::MAX))).ok().map(Held)",
            "Some(Held(Box::pin(tokio::time::sleep(Duration::MAX))))",
        ),
    ],
    # (7) The connection makes its timer with nothing to catch a panic.
    "no-catch": [
        (
            DEADLINE,
            "std::panic::catch_unwind(|| Box::pin(tokio::time::sleep(Duration::MAX))).ok().map(Held)",
            "Some(Held(Box::pin(tokio::time::sleep(Duration::MAX))))",
        )
    ],
    # (stress) A deadline that takes the connection's timer does not move it.
    "not-moved": [(DEADLINE, "        timer.0.as_mut().reset(after(limit));\n", "        let _ = after(limit);\n")],
    # The connection makes its timer at its first deadline to wait (the form as first built).
    "made-at-the-first": [
        (DEADLINE, "    if id == UNNAMED {\n        return Mine { id: WAITED, timer: None };\n    }\n", "    let _ = id;\n")
    ],
    # A connection one of whose deadlines has waited makes its timer at its next poll, whether a
    # second deadline waits in it or not.
    "made-when-polled": [
        (
            DEADLINE,
            "if BY.get() == ASKED && polled.is_pending() {",
            "if (BY.get() == ASKED || polling.mine.id == WAITED) && polled.is_pending() {",
        )
    ],
    # A connection one of whose deadlines has waited is never told of the second.
    "never-made": [(DEADLINE, "if matches!(BY.get(), UNNAMED | WAITED) {", "if BY.get() == UNNAMED {")],
    # A deadline takes the thread's timer with no check that the thread still has a place for one.
    "thread-local-unchecked": [(DEADLINE, TAKE, "let mut timer = TIMER.take()?;")],
}


def main():
    tree, name = sys.argv[1], sys.argv[2]
    for path, old, new in BREAKS[name]:
        with open(f"{tree}/{path}") as file:
            text = file.read()
        if text.count(old) != 1:
            raise SystemExit(f"{name}: the text to replace is there {text.count(old)} times in {path}")
        with open(f"{tree}/{path}", "w") as file:
            file.write(text.replace(old, new))


if __name__ == "__main__":
    main()
