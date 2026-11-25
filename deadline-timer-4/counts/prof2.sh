#!/bin/bash
# Count host: one count of row 1 and row 2 on the single-threaded runtime for the builds named,
# callgrind's files kept, then instructions by function against the head's. Usage: prof2.sh <build>...
cd /root/dl
cat > c3/prof2-inside.sh <<'EOF'
for name in "$@"; do
    for c in get sdelay1; do
        ARENA_MODE=percore-by-hand python3 /w/count7.py /w/bin/$name --cpu 14 --reps 1 --cases $c --keep /w/prof --label p2-$name-
    done
done
EOF
docker run --rm --ulimit nofile=1048576:1048576 -v /root/dl/c3:/w c3img bash /w/prof2-inside.sh head "$@"
cd c3/prof
for name in "$@"; do
    for c in get sdelay1; do
        echo "== $c, single-threaded: a = head, b = $name"
        python3 ../fnprof.py 1000 p2-head-$c.few p2-head-$c.many p2-$name-$c.few p2-$name-$c.many 4
    done
done
