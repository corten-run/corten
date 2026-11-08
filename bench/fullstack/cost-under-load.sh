# What each of Corten's production defaults costs a request under load: card-market's image as a
# round builds it (examples/card-market/Dockerfile, so jemalloc and Debian's libzstd) as it is and
# with each patch in ablate/ applied (each removes one default), then ab.mjs runs them one at a
# time, alternating, on the bench host's pinned cores: the item page and its JSON, with
# `Accept-Encoding: identity` and with a browser's, at a fixed 300 a second and with 64 users. Its
# summary gives each build's requests per CPU-second in each phase, counted from the app's
# cgroup, with the median and range across rounds; cost-under-load.mjs turns them into each
# default's cost. cost-by-default.sh counts the same builds' instructions on one connection.
# Run from the repository root on a Linux host with Docker and Node, with fixtures/items.json and
# the rustbench network. Images are cbd-<variant>, labelled with a hash of the source they were
# built from; an image already built is used only when that hash is this source's.
# VARIANTS (as-is and every patch), OUT (results/cost-under-load), AB_ROUNDS (3), BENCH_APP_CPUS
# and BENCH_FIXTURE_LOAD_CPUS (else BENCH_LOAD_CPUS) as a round sets them. OUT/source.txt records
# the commit, the source hash, each image's id and the CPU settings the run had.
set -eo pipefail
here=bench/fullstack
[ -s $here/fixtures/items.json ] || { echo "no $here/fixtures/items.json: run fixtures/fetch.mjs, or copy one" >&2; exit 1; }
variants=${VARIANTS:-"as-is $(cd $here/ablate && ls *.patch | sed 's/\.patch$//' | tr '\n' ' ')"}
# One copy of the source to build each variant from, without outputs or other rounds' results.
rm -rf /tmp/cost-pristine && mkdir -p /tmp/cost-pristine
tar --exclude=./.git --exclude=./target --exclude=node_modules --exclude=./bench/fullstack/results -cf - . | tar -C /tmp/cost-pristine -xf -
src_hash=$(cd /tmp/cost-pristine && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)
images=()
for v in $variants; do
  images+=("cbd-$v")
  [ "$(docker image inspect -f '{{ index .Config.Labels "corten.cost-source" }}' "cbd-$v" 2>/dev/null)" = "$src_hash" ] && continue
  rm -rf /tmp/cost-work && cp -a /tmp/cost-pristine /tmp/cost-work
  [ "$v" = as-is ] || (cd /tmp/cost-work && git apply "bench/fullstack/ablate/$v.patch")
  docker build -q --label "corten.cost-source=$src_hash" -f /tmp/cost-work/examples/card-market/Dockerfile -t "cbd-$v" /tmp/cost-work >/dev/null
done
rm -rf /tmp/cost-work /tmp/cost-pristine
# Each patch must change the image, or its row would measure the build as it is.
if [ "$(for i in "${images[@]}"; do docker image inspect -f '{{.Id}}' "$i"; done | sort -u | wc -l)" != "${#images[@]}" ]; then
  echo "two variants built the same image" >&2; exit 1
fi
out=bench/fullstack/${OUT:-results/cost-under-load}
mkdir -p "$out"
{
  echo "commit $(git rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "source $src_hash"
  for i in "${images[@]}"; do echo "image $i $(docker image inspect -f '{{.Id}}' "$i")"; done
  echo "BENCH_APP_CPUS=${BENCH_APP_CPUS-} BENCH_FIXTURE_LOAD_CPUS=${BENCH_FIXTURE_LOAD_CPUS-} BENCH_LOAD_CPUS=${BENCH_LOAD_CPUS-} AB_ROUNDS=${AB_ROUNDS-}"
  echo "cpu $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ //')"
} > "$out/source.txt"
docker network create rustbench >/dev/null 2>&1 || true
AB_TARGETS=page,json AB_ENCODINGS=identity,browser node $here/ab.mjs "${OUT:-results/cost-under-load}" "${images[@]}"
