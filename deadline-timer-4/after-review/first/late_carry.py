#!/usr/bin/env python3
"""Carries the lateness test and the helpers it uses from one tree's tests to another's, which
has neither: late_carry.py <from tree> <to tree>."""
import sys

PATH = "crates/corten/src/tests/server.rs"
STARTS = [
    "async fn listening(",
    "async fn asked(",
    "async fn answered(",
    '#[tokio::test(flavor = "multi_thread", worker_threads = 2)]\n#[ignore]\nasync fn how_late_a_deadlines_answer_is()',
]


def main():
    source, target = sys.argv[1], sys.argv[2]
    with open(f"{source}/{PATH}", encoding="utf-8") as file:
        text = file.read()
    with open(f"{target}/{PATH}", encoding="utf-8") as file:
        had = file.read()
    blocks = []
    for start in STARTS:
        if text.count("\n" + start) != 1:
            raise SystemExit(f"not once in the source: {start[:40]}")
        if ("\n" + start.split("\n")[-1]) in had:
            raise SystemExit(f"the target has it already: {start[:40]}")
        begin = text.index("\n" + start) + 1
        end = text.index("\n}\n", begin) + 3
        blocks.append(text[begin:end])
    with open(f"{target}/{PATH}", "a", encoding="utf-8", newline="\n") as file:
        file.write("\n" + "\n".join(blocks))
    print(f"carried {len(blocks)} items, {sum(block.count(chr(10)) for block in blocks)} lines")


if __name__ == "__main__":
    main()
