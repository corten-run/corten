#!/bin/sh
# sh count.sh <cpu> <out> <commit>...: the README's runs for each commit's probe, each its own
# command with its exit status; idle readings three times each.
cpu=$1
out=$2
shift 2
mkdir -p "$out"
kit=/kit/bench/request-cost
run() {
    name=$1
    shift
    "$@" > "$out/$name.txt" 2>&1
    echo "$name exit $?" | tee -a "$out/status.txt"
}
for commit in "$@"; do
    probe=/rc/bin/$commit
    short=$(echo "$commit" | cut -c1-9)
    rm -rf "/rc/answers-$short"
    run "$short-answers" node $kit/count.mjs "$probe" --cpu "$cpu" --answers "/rc/answers-$short"
done
first=$(echo "$1" | cut -c1-9)
for commit in "$@"; do
    short=$(echo "$commit" | cut -c1-9)
    [ "$short" = "$first" ] || run "answers-diff-$first-$short" diff -r "/rc/answers-$first" "/rc/answers-$short"
done
for commit in "$@"; do
    probe=/rc/bin/$commit
    short=$(echo "$commit" | cut -c1-9)
    run "$short-count" node $kit/count.mjs "$probe" --cpu "$cpu"
    run "$short-depth16" node $kit/count.mjs "$probe" --cpu "$cpu" --depth 16 --cases pipeline,get,unstaged,text
    run "$short-allocations" node $kit/count.mjs "$probe" --cpu "$cpu" --allocations
done
for i in 1 2 3; do
    for commit in "$@"; do
        probe=/rc/bin/$commit
        short=$(echo "$commit" | cut -c1-9)
        run "$short-idle-$i" node $kit/idle.mjs "$probe" --cpu "$cpu"
        run "$short-idle-browser3-$i" node $kit/idle.mjs "$probe" --cpu "$cpu" --case get-browser --requests 3
        run "$short-idle-silent-$i" node $kit/idle.mjs "$probe" --cpu "$cpu" --silent
    done
done
echo done
