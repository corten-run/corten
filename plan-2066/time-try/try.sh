#!/bin/bash
# try.sh: on the build host, after try-build.sh. No load and no reading. Starts each image with the
# arguments ab.mjs gives `docker run` (but a container name and a network of this try's own, with
# the alias ab-app), under ab.mjs's default CPU setting and under the plan's four CPUs, and prints
# from the app process's memory map whether libjemalloc is in it, the process's threads, and one
# answer to the json target's request. Then runs ab.mjs with no image, which does its argument and
# environment handling and no round.
set -u
T=/root/stage-a/try
L="--label agent.owner=author --label agent.task=stage-a"
mkdir -p "$T/answers"; chmod 777 "$T/answers"
docker network inspect sa-try >/dev/null 2>&1 || docker network create $L sa-try >/dev/null
one() { # <image> <tag for files> <cpu arguments...>
    image=$1; tag=$2; shift 2
    docker rm -f -v sa-try-app >/dev/null 2>&1
    docker run -d $L --name sa-try-app --network sa-try --network-alias ab-app "$@" --memory 1g \
        -v "$T/fixtures:/fixtures:ro" -e ITEM_SOURCE=fixture -e FIXTURE_PATH=/fixtures/items.json \
        -e PORT=8080 -e HOSTS=ab-app "$image" >/dev/null || { echo "run failed: $image $*"; return 1; }
    sleep 4
    pid=$(docker inspect -f '{{.State.Pid}}' sa-try-app)
    echo "== $image, $*: pid $pid, $(readlink /proc/$pid/exe)"
    echo "   environment: $(tr '\0' '\n' </proc/$pid/environ | grep -E '^(LD_PRELOAD|MALLOC_CONF)=' | tr '\n' ' ')"
    echo "   lines of the memory map that name libjemalloc: $(grep -c libjemalloc /proc/$pid/maps)"
    grep libjemalloc /proc/$pid/maps | awk '{print $6}' | sort -u | sed 's/^/   mapped: /'
    echo "   threads: $(ls /proc/$pid/task | wc -l): $(cat /proc/$pid/task/*/comm | sort | uniq -c | awk '{printf "%s x%s, ", $2, $1}')"
    docker run --rm $L --network sa-try -v "$T/answers:/out" rust:1-trixie \
        curl -sS --max-time 10 -D "/out/$tag.raw-headers" -o "/out/$tag.body" -H 'Accept-Encoding: identity' \
        -w "   answer: %{http_code}, %{size_download} bytes\n" http://ab-app:8080/api/items/item_1
    tr -d '\r' <"$T/answers/$tag.raw-headers" | grep -iv '^date:' >"$T/answers/$tag.headers"
    docker rm -f -v sa-try-app >/dev/null
}
one base-1 je-1 --cpus 1
one base-1-glibc gl-1 --cpus 1
one base-1 je-4 --cpuset-cpus 0-3
one base-1-glibc gl-4 --cpuset-cpus 0-3
echo "--- answers"
for p in "je-1 gl-1" "je-4 gl-4" "je-1 je-4"; do
    set -- $p
    h=same; cmp -s "$T/answers/$1.headers" "$T/answers/$2.headers" || h=DIFFER
    b=same; cmp -s "$T/answers/$1.body" "$T/answers/$2.body" || b=DIFFER
    echo "$1 and $2: headers but Date $h, body $b"
done
echo "headers of je-1:"; cat "$T/answers/je-1.headers"
sha256sum "$T"/answers/*.body
echo "--- ab.mjs with no image"
docker ps -a --format '{{.Names}}' | grep -x ab-app && { echo "REFUSED: a container named ab-app exists"; exit 3; }
file /usr/bin/docker 2>/dev/null | cut -c1-120
ab() { # <out> <environment...>
    out=$1; shift
    docker run --rm $L -v "$T/tree:/src" -v /var/run/docker.sock:/var/run/docker.sock -v /usr/bin/docker:/usr/bin/docker:ro \
        -w /src/bench/fullstack "$@" sa-try-node node ab.mjs "$out"
    echo "ab.mjs exit $?"
}
docker image inspect sa-try-node >/dev/null 2>&1 || {
    mkdir -p "$T/node"; printf 'FROM rust:1-trixie\nRUN apt-get update -q && apt-get install -y -q nodejs && rm -rf /var/lib/apt/lists/*\n' >"$T/node/Dockerfile"
    docker build $L -t sa-try-node "$T/node" >"$T/build-node.log" 2>&1; echo "build sa-try-node exit $?"
}
docker run --rm $L sa-try-node node --version
echo "one CPU, the default:"
ab results/sa-try-ab-1 -e AB_TARGETS=json -e AB_ENCODINGS=identity -e AB_ROUNDS=5
echo "four CPUs:"
ab results/sa-try-ab-4 -e AB_TARGETS=json -e AB_ENCODINGS=identity -e AB_ROUNDS=5 -e BENCH_APP_CPUS=0-3 -e BENCH_FIXTURE_LOAD_CPUS=4-6
echo "a wrong encoding name, to show the check is live:"
ab results/sa-try-ab-x -e AB_TARGETS=json -e AB_ENCODINGS=none -e AB_ROUNDS=5 2>&1 | grep -E 'Error|exit'
for d in sa-try-ab-1 sa-try-ab-4 sa-try-ab-x; do
    echo "$d: $(ls "$T/tree/bench/fullstack/results/$d" 2>/dev/null | tr '\n' ' ')"
    [ -f "$T/tree/bench/fullstack/results/$d/summary.json" ] && echo "   summary.json: $(cat "$T/tree/bench/fullstack/results/$d/summary.json")"
done
grep -E '"(image|version|platform)"' "$T/tree/bench/fullstack/results/sa-try-ab-1/tools.json"
docker ps -a --filter label=agent.task=stage-a --format 'left: {{.Names}}'
echo TRY-DONE
# end

