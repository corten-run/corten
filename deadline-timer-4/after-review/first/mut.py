#!/usr/bin/env python3
"""One mutation of the kept deadline timer, applied to a tree: mut.py <tree> <name>.

Each replaces one piece of text that must be there exactly once."""
import sys

D = "crates/corten/src/deadline.rs"
A = "crates/corten/src/app.rs"
MUTATIONS = {
    # The `ASKED` state may take the thread's timer.
    "M10": (D, "        if of <= ASKED {\n", "        if of < ASKED {\n"),
    # A deadline asks before it has made its own timer.
    "M14": (
        D,
        "                    let timer = tokio::time::sleep(limit);\n"
        "                    // After the timer is made, which panics on a runtime with no clock.\n"
        "                    ask();\n",
        "                    ask();\n"
        "                    let timer = tokio::time::sleep(limit);\n",
    ),
    # No 30-year cap.
    "M18": (D, "    Instant::now() + limit.min(Duration::from_secs(86400 * 365 * 30))\n", "    Instant::now() + limit\n"),
    # Giving back reads whose poll this is with no check that the thread-local is there.
    "M21a": (D, "        if BY.try_with(Cell::get) == Ok(self.of) {\n", "        if BY.with(Cell::get) == self.of {\n"),
    # Giving back puts the timer in the thread's place with no check that the place is there.
    "M21b": (
        D,
        "            let _ = TIMER.try_with(|home| home.set(self.timer.take()));\n",
        "            TIMER.with(|home| home.set(self.timer.take()));\n",
    ),
    # The first connection's number is `ASKED`.
    "M22": (D, "static NAMES: AtomicU64 = AtomicU64::new(ASKED + 1);\n", "static NAMES: AtomicU64 = AtomicU64::new(ASKED);\n"),
    # The connection closed now, with no shutdown, is polled without its wrapper.
    "M27": (
        A,
        "                let _ = tokio::time::timeout_at(tokio::time::Instant::now(), conn.as_mut()).await;\n",
        "                let _ = tokio::time::timeout_at(tokio::time::Instant::now(), conn.as_mut().conn()).await;\n",
    ),
}


def main():
    tree, name = sys.argv[1], sys.argv[2]
    path, old, new = MUTATIONS[name]
    with open(f"{tree}/{path}", encoding="utf-8", newline="") as source:
        text = source.read()
    if text.count(old) != 1:
        raise SystemExit(f"{name}: its text is in {path} {text.count(old)} times")
    with open(f"{tree}/{path}", "w", encoding="utf-8", newline="") as target:
        target.write(text.replace(old, new))
    print(f"{name}: applied to {path}")


if __name__ == "__main__":
    main()
