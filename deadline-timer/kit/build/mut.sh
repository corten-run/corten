#!/usr/bin/env bash
# Runs on the build host: for each new test, breaks the rule it is for in a copy of the tree
# (mut.py) and runs the test, which must fail; then runs them all on the tree as it is, where they
# must pass. Usage: mut.sh <patch over the merged head>
set -uo pipefail
patch=$1
cd /root/dl
rm -rf m-clean && cp -r head m-clean
(cd m-clean && git init -q . 2>/dev/null; git apply --whitespace=nowarn "/root/dl/$patch") || { echo "MUT-FAILED patch"; exit 1; }
: > mut.log
run() {
    name=$1; test=$2; extra=${3:-}
    rm -rf m && cp -r m-clean m
    [ "$name" = none ] || python3 mut.py m "$name" || { echo "MUT-FAILED $name" >> mut.log; return; }
    touch m/crates/corten/src/deadline.rs m/crates/corten/src/app.rs m/crates/corten/src/tests/server.rs
    docker run --rm -v "/root/dl/m:/src" -v corten-cargo:/usr/local/cargo/registry -v "corten-target-head:/target" \
        -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie \
        cargo test -p corten-run --all-features --lib -- $extra "tests::server::$test" > "mut-$name.out" 2>&1
    rc=$?
    echo "== break: $name; test: $test; cargo test rc=$rc" >> mut.log
    grep -E "^test tests::server::.* \.\.\. (ok|FAILED)|^test result|^error(\[|:)" "mut-$name.out" >> mut.log
    grep -E "panicked at crates/corten/src/tests/server.rs" -A 3 "mut-$name.out" | grep -v "^--$" | head -8 >> mut.log
}
run never-taken a_served_request_waits_on_its_connections_timer --exact
run no-restore-on-panic a_connection_whose_poll_panics_has_its_timer_back --exact
run given-to-any-connection a_timer_dropped_in_another_connections_poll_is_not_given_to_that_connection --exact
run taken-without-asking-whose a_new_connection_polled_inside_anothers_poll_does_not_take_its_timer --exact
run kept-timer-keeps-no-waker a_kept_timer_wakes_what_polled_it_last --exact
run drained-unwrapped a_connection_draining_at_shutdown_makes_its_timer_as_before --exact
run asks-first-and-no-catch a_runtime_with_no_clock_answers_500_and_goes_on_serving_the_connection --exact
run no-catch a_connection_polled_where_there_is_no_clock_makes_no_timer --exact
run not-moved deadlines_on_four_threads_fire_and_none_before_its_limit --exact
run none ""
echo "# MUT-DONE" >> mut.log
