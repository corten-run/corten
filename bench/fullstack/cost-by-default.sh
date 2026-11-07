# Measures what each of Corten's production defaults costs a request. card-market's release build
# runs under callgrind as it is and then with each patch in ablate/ applied (each removes one
# default), serving the item page and its JSON over one keep-alive connection as N1 and then N2
# requests in two runs, with `Accept-Encoding: identity` and with a browser's, counting only while
# the requests are served. The difference over N2 - N1 is one request's user instructions with the
# connection's own cost cancelled out;
# cost-by-default.mjs takes a default's cost as the build with it less the build without it. Run
# from the repository root in an image with valgrind and curl, as the README's "What each production
# default costs" says. Items come from /fixtures/items.json (fixtures/fetch.mjs writes it). Results go to
# /out: results.tsv, and each build's answer headers in /out/headers; the builds go to /out/bins, and a build
# already there is used as it is, so a run that stopped after its builds starts measuring at once.
# VARIANTS (as-is and every patch), TARGETS (page json), ENCODINGS (identity browser), REPEATS (5),
# each passed to docker run with -e. Every request must answer 200 over one connection, or it stops.
set -eo pipefail
export USER=${USER:-root}
[ -s /fixtures/items.json ] || { echo "no /fixtures/items.json: run fixtures/fetch.mjs, or mount a copy" >&2; exit 1; }
command -v valgrind >/dev/null && command -v curl >/dev/null ||
  { apt-get update -qq >/dev/null && apt-get install -y -qq valgrind curl >/dev/null 2>&1; }
browser='gzip, deflate, br, zstd'
variants=${VARIANTS:-"as-is $(cd /src/bench/fullstack/ablate && ls *.patch | sed 's/\.patch$//' | tr '\n' ' ')"}
# One copy of the source to start each build from, without outputs or other rounds' results.
bins=/out/bins
rm -rf /tmp/pristine && mkdir -p /tmp/pristine $bins
tar -C /src --exclude=./.git --exclude=./target --exclude=node_modules --exclude=./bench/fullstack/results -cf - . | tar -C /tmp/pristine -xf -
# Builds already in /out/bins are reused only if they were built from this source and compiler:
# what the patches and the two crates they touch read, the release profile, and rustc's version.
source=$( (cd /tmp/pristine && find Cargo.toml Cargo.lock crates/corten crates/corten-macros examples/card-market \
  bench/fullstack/ablate -type f ! -path '*/node_modules/*' -print0 | sort -z | xargs -0 sha256sum; rustc -vV) |
  sha256sum | cut -c1-16)
if [ -n "$(ls $bins)" ] && [ "$(cat $bins/source.txt 2>/dev/null)" != "$source" ]; then
  echo "/out/bins holds builds of other source ($(cat $bins/source.txt 2>/dev/null || echo unstamped), this is $source): remove it to rebuild" >&2; exit 1
fi
# Stamped before building, and each build moved in only when whole, so a run stopped partway
# keeps the builds it finished.
echo "$source" > $bins/source.txt
rm -rf /out/headers && mkdir -p /out/headers
for v in $variants; do
  [ -x $bins/$v ] && continue
  rm -rf /tmp/work && cp -a /tmp/pristine /tmp/work && cd /tmp/work
  [ $v = as-is ] || git apply bench/fullstack/ablate/$v.patch
  # A restored file keeps its old time, which cargo would take for an unchanged one: every build
  # recompiles the two crates the patches touch.
  find crates/corten/src examples/card-market/src -name '*.rs' -exec touch {} +
  cargo build -q --release -p card-market
  cp $CARGO_TARGET_DIR/release/card-market $bins/.$v.tmp && mv $bins/.$v.tmp $bins/$v
done
cd /
# Each patch must change the binary, or its row would measure the build as it is.
if [ "$(cd $bins && sha256sum $variants | cut -d' ' -f1 | sort -u | wc -l)" != "$(echo $variants | wc -w)" ]; then
  (cd $bins && sha256sum $variants); echo "two builds are the same binary" >&2; exit 1
fi
url() { [ $1 = json ] && echo /api/items/item_$2 || echo /items/item_$2; }
coding() { [ $1 = browser ] && echo "$browser" || echo identity; }
start() {
  HOST=127.0.0.1 PORT=8080 ITEM_SOURCE=fixture FIXTURE_PATH=/fixtures/items.json "$@" >/tmp/server.log 2>&1 &
  server=$!
  until curl -s -o /dev/null http://127.0.0.1:8080/health/live; do
    kill -0 $server 2>/dev/null || { cat /tmp/server.log >&2; exit 1; }
    sleep 1
  done
}
# What each build answers, to show the patch removed what it says it removes.
for v in $variants; do
  start $bins/$v
  for target in ${TARGETS:-page json}; do for enc in ${ENCODINGS:-identity browser}; do
    code=$(curl -sS -D /out/headers/$v-$target-$enc.txt -o /dev/null -w '%{http_code}' -H "accept-encoding: $(coding $enc)" "http://127.0.0.1:8080$(url $target 1)")
    [ "$code" = 200 ] || { echo "$v $target $enc: answered $code" >&2; cat /tmp/server.log >&2; exit 1; }
  done; done
  kill -TERM $server; wait $server || true
done
printf 'variant\ttarget\tencoding\trepeat\trequests\tinstructions\n' > /out/results.tsv
for rep in $(seq ${REPEATS:-5}); do for v in $variants; do
  for target in ${TARGETS:-page json}; do for enc in ${ENCODINGS:-identity browser}; do
    for n in 300 1300; do
      : > /tmp/run.txt
      for i in $(seq $n); do printf 'url = "http://127.0.0.1:8080%s"\noutput = /dev/null\n' "$(url $target $(( (i % 500) + 1 )))" >> /tmp/run.txt; done
      # Counted only while the requests are served: dumped once the server answers (a dump
      # resets the count) and again before it stops, so startup and shutdown (freeing the 27 MB of
      # items, which glibc consolidates in some runs and not others, about 8.6 million
      # instructions) are not in the second dump. callgrind_control exits 0 whether or not it
      # reached the process, so each dump is checked by its file.
      rm -f /tmp/cg.out*
      start valgrind --tool=callgrind --callgrind-out-file=/tmp/cg.out $bins/$v
      # valgrind names its control pipe after `HOST`, the app's own setting, so the control asks under it.
      HOST=127.0.0.1 callgrind_control -d $server >/dev/null 2>&1 || true
      [ -s /tmp/cg.out.1 ] || { echo "$v: callgrind_control did not dump the startup count" >&2; exit 1; }
      curl -sS -H "accept-encoding: $(coding $enc)" -w '%{http_code} %{num_connects}\n' -K /tmp/run.txt > /tmp/codes.txt
      HOST=127.0.0.1 callgrind_control -d $server >/dev/null 2>&1 || true
      [ -s /tmp/cg.out.2 ] || { echo "$v: callgrind_control did not dump the requests' count" >&2; exit 1; }
      kill -TERM $server; wait $server || true
      if grep -qv '^200 ' /tmp/codes.txt || [ "$(grep -c '^200 1' /tmp/codes.txt)" != 1 ]; then
        echo "$v $target $enc: not every request answered 200 over one connection" >&2; exit 1
      fi
      total=$(sed -n 's/^summary: *\([0-9]*\).*/\1/p' /tmp/cg.out.2 2>/dev/null || true)
      [ -n "$total" ] || { echo "$v $target $enc: no callgrind count" >&2; cat /tmp/server.log >&2; exit 1; }
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' $v $target $enc $rep $n $total | tee -a /out/results.tsv
    done
  done; done
done; done
echo EXIT=0
