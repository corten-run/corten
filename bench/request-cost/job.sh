#!/bin/bash
# What the hosted job builds, what it runs and when it stops (.github/workflows/request-cost.yml;
# README.md, The hosted job). It gives no verdict: compare.mjs reads what this leaves.
#
# bash job.sh build <directory>
#   In a checkout of a pull request's merge: builds the probe against the merge base of the
#   merge's parents and then against its second parent, the head, both in <directory> (outside
#   the checkout and any git repository, as build.sh requires). Leaves each build's commit at
#   <directory>/<base|head>/commit and what the build printed at build.log beside it, and for a
#   build that built, its probe's SHA-256 at sha256, which compare.mjs reads to tell one binary
#   from two. An unsuccessful build leaves its error or timeout's status and timing at
#   <directory>/<side>/unbuilt (see compare.mjs's STOPPED) and fails nothing here.
#   Exit status 1, with nothing built, when there is no merge base.
# bash job.sh read <directory> <cpu>
#   Each build's answers, then each run `compare.mjs --readings` names, on base and then on
#   head, the probe held to <cpu>. A build with `unbuilt` is not run at all, whatever it left.
#   Just before launching timeout, sample the clock and skip the run if it is at or past
#   STOP_AT (seconds since the epoch, required); otherwise the limit is the time left at that
#   sample, at most 120 seconds, with 10 seconds' grace before KILL. A run that fails or is
#   stopped gave no figure: what it printed is removed, why is added to
#   <file>.refused, a line an attempt, and it is taken again, once. No run is taken again for
#   its figure.
# bash job.sh diagnose <directory> <cpu> <new-diagnostic-directory>
#   The separate observer-on idle plan, with the same bounds and both builds, but no
#   answer captures, request counts or allocation profiles. Never reuses a diagnostic directory.
set -eo pipefail

usage() { echo "usage: bash job.sh build <directory> | bash job.sh read <directory> <cpu> | bash job.sh diagnose <directory> <cpu> <new-diagnostic-directory>" >&2; exit 2; }
kit=$(cd "$(dirname "$0")" && pwd -P)
builds=${2:-}

run_timed() {
  local limit=$1 start end status=0
  shift
  timeout_report=
  read -r start _ < /proc/uptime
  timeout -k 10 "$limit" "$@" || status=$?
  if [ "$status" = 124 ] || [ "$status" = 137 ]; then
    read -r end _ < /proc/uptime
    # Uptime gives hundredths of a second. Neither the status nor the elapsed time proves a deadline fired.
    timeout_report="status $status after $(((10#${end/./} - 10#${start/./}) / 100)) s (limit $limit s)"
  fi
  return "$status"
}

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
    # Only the stand-in tests shorten the hosted job's 420-second build limit.
    run_timed "${REQUEST_COST_BUILD_LIMIT:-420}" sh "$kit/build.sh" "$commit" "$builds" > "$builds/$side/build.log" 2>&1 || status=$?
    cat "$builds/$side/build.log"
    if [ -n "$timeout_report" ]; then
      echo "the build ended with $timeout_report" > "$builds/$side/unbuilt"
    elif [ "$status" != 0 ]; then
      echo "the build failed, $(tail -n 1 "$builds/$side/build.log")" > "$builds/$side/unbuilt"
    fi
    if [ -e "$builds/$side/unbuilt" ]; then
      echo "::warning::the probe did not build against $side $commit"
    elif [ -f "$builds/bin/$commit" ]; then
      sha256sum < "$builds/bin/$commit" | cut -c 1-64 > "$builds/$side/sha256"
      echo "the probe built against $side: sha256 $(cat "$builds/$side/sha256")"
    fi
    echo "build $side $((SECONDS - began))" >> "$builds/seconds"
  done
  ;;
read|diagnose)
  mode=$1
  if [ "$mode" = read ]; then [ $# -eq 3 ] || usage; else [ $# -eq 4 ] || usage; fi
  cpu=$3
  : "${STOP_AT:?job.sh $mode: STOP_AT is not set}"
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
    reading_end=
    if [ "$left" -le 0 ]; then echo "not attempted, the job's time for readings was spent" >&2; return 1; fi
    if [ "$left" -gt 120 ]; then left=120; fi
    run_timed "$left" "$@" || status=$?
    if [ -n "$timeout_report" ]; then
      reading_end="Error: the reading ended with $timeout_report"
      echo "$reading_end" >&2
    fi
    return "$status"
  }
  output=$builds
  if [ "$mode" = read ]; then
    began=$SECONDS
    for side in base head; do
      binary=$(probe "$side")
      [ -n "$binary" ] || continue
      within node "$kit/count.mjs" "$binary" --cpu "$cpu" --answers "$builds/$side/answers" < /dev/null || echo "::warning::not every answer from $side"
    done
    if diff -r "$builds/base/answers" "$builds/head/answers"; then echo "the two builds answer the same"; fi
    echo "answers $((SECONDS - began))" >> "$builds/seconds"
    plan=readings
    options=()
  else
    output=$4
    if ! mkdir -- "$output"; then
      echo "job.sh diagnose: give a new diagnostic directory" >&2
      exit 1
    fi
    declare -A diagnostic_probes
    for side in base head; do
      binary=$(probe "$side")
      if [ -z "$binary" ]; then
        echo "job.sh diagnose: no executable probe for $side" >&2
        exit 1
      fi
      checksum=$builds/$side/sha256
      if [ ! -f "$checksum" ]; then
        echo "job.sh diagnose: no build checksum for $side" >&2
        exit 1
      fi
      if ! sha256sum < "$binary" | cut -c 1-64 | cmp -s -- - "$checksum"; then
        echo "job.sh diagnose: probe checksum does not match the build for $side" >&2
        exit 1
      fi
      diagnostic_probes[$side]=$binary
    done
    mkdir -- "$output/base" "$output/head"
    printf '%s\n' "${diagnostic_probes[base]##*/}" "${diagnostic_probes[head]##*/}" > "$output/complete.tmp"
    plan=allocator-readings
    options=(--allocator)
  fi
  began=$SECONDS
  node "$kit/compare.mjs" --readings "${options[@]}" > "$output/$plan"
  while read -r file script options; do
    for side in base head; do
      if [ "$mode" = diagnose ]; then
        binary=${diagnostic_probes[$side]}
      else
        binary=$(probe "$side")
        [ -n "$binary" ] || continue
      fi
      out=$output/$side/$file
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
        # A line an attempt: what timeout reported, else the kit's error, last line or status.
        why=${reading_end:-$(grep -m 1 '^Error: ' "$out.said" || tail -n 1 "$out.said")}
        case "$why" in *[![:space:]]*) ;; *) why="exit status $status, with nothing said" ;; esac
        echo "$why" >> "$out.refused"
        rm -f "$out" "$out.said"
        [ "$(date +%s)" -lt "$STOP_AT" ] || break
      done
      if [ "$mode" = diagnose ]; then
        digest=-
        if [ "$status" = 0 ]; then
          digest=$(sha256sum < "$out")
          digest=${digest%% *}
        fi
        printf '%s %s %s\n' "$side" "$file" "$digest" >> "$output/complete.tmp"
      fi
    done
  done < "$output/$plan"
  echo "$plan $((SECONDS - began))" >> "$output/seconds"
  if [ "$mode" = diagnose ]; then
    # Publish the commits and receipt digests only once the plan finishes.
    mv -- "$output/complete.tmp" "$output/complete"
  fi
  ;;
*) usage ;;
esac
