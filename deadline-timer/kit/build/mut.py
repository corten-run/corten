#!/usr/bin/env python3
"""Breaks one rule of the deadline's timer in a tree, for a test that must then fail.

    python3 mut.py <tree> <name>

Each break replaces text that must be there exactly once.
"""

import sys

DEADLINE = "crates/corten/src/deadline.rs"
APP = "crates/corten/src/app.rs"

BREAKS = {
    # (a) Served requests stop taking the connection's timer.
    "never-taken": [(DEADLINE, "let mut timer = TIMER.take()?;", "let mut timer = TIMER.with(|_| None::<Held>)?;")],
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
            "        if of <= ASKED {\n            return None;\n        }\n        let mut timer = TIMER.take()?;",
            "        let mut timer = TIMER.take()?;",
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
    # (7) As the code was before the review: a deadline asks before it has made its own timer, and
    # the connection makes its timer with nothing to catch a panic.
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
