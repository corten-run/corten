#!/bin/bash
# What the hosted job builds, what it runs and when it stops (.github/workflows/request-cost.yml;
# README.md, The hosted job). It gives no verdict: compare.mjs reads what this leaves.
#
# bash job.sh build <directory>
#   In a checkout of a pull request's merge: builds the probe against the merge base of the
#   merge's parents and then against its second parent, the head, both in <directory> (outside
#   the checkout and any git repository, as build.sh requires). Leaves each build's commit at
#   <directory>/<base|head>/commit and what the build printed at build.log beside it. A build
#   that fails, or does not end in 420 seconds, leaves why at <directory>/<side>/unbuilt and
#   fails nothing here. Exit status 1, with nothing built, when there is no merge base.
# bash job.sh read <directory> <cpu>
#   Each build's switch capability and answers, then each run `compare.mjs --readings` names,
#   on base and then on head, the probe held to <cpu>. A build with `unbuilt` is not run at all.
#   A run ends in 120 seconds or is stopped (and killed 10 seconds later if it has not ended),
#   and none starts once STOP_AT has come, which must be set: seconds since the epoch. A run that
#   fails or is stopped gave no figure: what it printed is removed, why is added to
#   <file>.refused, a line an attempt, and it is taken again, once. No run is taken again for
#   its figure.
set -eo pipefail

usage() { echo "usage: bash job.sh build <directory> | bash job.sh read <directory> <cpu>" >&2; exit 2; }
kit=$(cd "$(dirname "$0")" && pwd -P)
builds=${2:-}

case "${1:-}" in
build)
  [ $# -eq 2 ] || usage
  # The checkout's second parent is the head, and the merge base of its parents is where the
  # head left the base's branch.
  base=$(git merge-base 'HEAD^1' 'HEAD^2') || base=
  if [ -z "$base" ]; then
    echo "::error::the checkout is not the pull request's merge, or its parents have no merge base, so there is no commit to count the head against"
    exit 1
  fi
  head=$(git rev-parse 'HEAD^2')
  for side in base head; do
    commit=$base
    if [ "$side" = head ]; then commit=$head; fi
    mkdir -p "$builds/$side"
    echo "$commit" > "$builds/$side/commit"
    began=$SECONDS
    status=0
    timeout -k 10 420 sh "$kit/build.sh" "$commit" "$builds" > "$builds/$side/build.log" 2>&1 || status=$?
    cat "$builds/$side/build.log"
    if [ "$status" = 124 ]; then
      echo "the build did not end in 420 s" > "$builds/$side/unbuilt"
    elif [ "$status" != 0 ]; then
      echo "the build failed, $(tail -n 1 "$builds/$side/build.log")" > "$builds/$side/unbuilt"
    fi
    if [ -e "$builds/$side/unbuilt" ]; then echo "::warning::the probe did not build against $side $commit"; fi
    echo "build $side $((SECONDS - began))" >> "$builds/seconds"
  done
  ;;
read)
  [ $# -eq 3 ] || usage
  cpu=$3
  : "${STOP_AT:?job.sh read: STOP_AT is not set}"
  # A build's probe, or nothing: for a build with `unbuilt`, though a build that was stopped
  # may have left a binary.
  probe() {
    [ ! -e "$builds/$1/unbuilt" ] && [ -f "$builds/$1/commit" ] || return 0
    local binary
    binary=$builds/bin/$(cat "$builds/$1/commit")
    if [ -x "$binary" ]; then echo "$binary"; fi
  }
  within() {
    local left=$((STOP_AT - $(date +%s))) status=0
    if [ "$left" -le 0 ]; then echo "not attempted, the job's time for readings was spent" >&2; return 1; fi
    if [ "$left" -gt 120 ]; then left=120; fi
    timeout -k 10 "$left" "$@" || status=$?
    if [ "$status" = 124 ]; then echo "Error: did not end in $left s" >&2; fi
    return "$status"
  }
  began=$SECONDS
  for side in base head; do
    record=$builds/$side/own-http1
    rm -f "$record"
    binary=$(probe "$side")
    [ -n "$binary" ] || continue
    if [ -f "$binary.own-http1" ]; then cp "$binary.own-http1" "$record"; fi
    within node "$kit/count.mjs" "$binary" --cpu "$cpu" --answers "$builds/$side/answers" < /dev/null || echo "::warning::not every answer from $side"
  done
  if diff -r "$builds/base/answers" "$builds/head/answers"; then echo "the two builds answer the same"; fi
  echo "answers $((SECONDS - began))" >> "$builds/seconds"
  began=$SECONDS
  node "$kit/compare.mjs" --readings > "$builds/readings"
  while read -r file script options; do
    for side in base head; do
      binary=$(probe "$side")
      [ -n "$binary" ] || continue
      out=$builds/$side/$file
      for attempt in 1 2; do
        echo "$(date +%T) $side $file, attempt $attempt"
        status=0
        # shellcheck disable=SC2086 # the options are words
        within node "$kit/$script" "$binary" --cpu "$cpu" $options > "$out" 2> "$out.said" < /dev/null || status=$?
        if [ "$status" = 0 ]; then
          cat "$out"
          rm "$out.said"
          break
        fi
        cat "$out.said"
        # Why, a line an attempt: the kit's error, else the last thing said, else the status alone.
        why=$(grep -m 1 '^Error: ' "$out.said" || tail -n 1 "$out.said")
        case "$why" in *[![:space:]]*) ;; *) why="exit status $status, with nothing said" ;; esac
        echo "$why" >> "$out.refused"
        rm -f "$out" "$out.said"
        [ "$(date +%s)" -lt "$STOP_AT" ] || break
      done
    done
  done < "$builds/readings"
  echo "readings $((SECONDS - began))" >> "$builds/seconds"
  ;;
*) usage ;;
esac
