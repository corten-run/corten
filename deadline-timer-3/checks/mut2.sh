#!/usr/bin/env bash
# Runs on the build host: for each test that holds a rule of the deadline's timer, breaks that
# rule in a copy of the tree (mut2.py) and runs the test, which must fail; then runs them all on
# the tree as it is, where they must pass. Usage: mut2.sh <tree>
set -uo pipefail
tree=$1
cd /root/dl
: > mut2.log
run() {
    name=$1; shift
    rm -rf m && cp -r "$tree" m
    [ "$name" = none ] || python3 mut2.py m "$name" || { echo "MUT-FAILED $name" >> mut2.log; return; }
    touch m/crates/corten/src/deadline.rs m/crates/corten/src/app.rs m/crates/corten/src/tests/server.rs
    filters=""
    for t in "$@"; do filters="$filters tests::server::$t"; done
    docker run --rm -v "/root/dl/m:/src" -v corten-cargo:/usr/local/cargo/registry -v "corten-target-mut:/target" \
        -e CARGO_TARGET_DIR=/target -e CARGO_TERM_COLOR=never -w /src rust:1-trixie \
        cargo test -p corten-run --all-features --lib -- $filters > "mut2-$name.out" 2>&1
    rc=$?
    echo "== break: $name; tests: $*; cargo test rc=$rc" >> mut2.log
    grep -E "^test tests::server::.* \.\.\. (ok|FAILED)|^test result|^error(\[|:)|fatal runtime error|SIGABRT" "mut2-$name.out" >> mut2.log
    grep -E "panicked at crates/corten/src/tests/server.rs" -A 3 "mut2-$name.out" | grep -v "^--$" | head -16 >> mut2.log
}
run never-taken a_served_request_waits_on_its_connections_timer a_request_on_a_handlers_own_runtime_is_answered_500_once_the_connections_runtime_has_shut_down
run no-restore-on-panic a_connection_whose_poll_panics_has_its_timer_back
run given-to-any-connection a_timer_dropped_in_another_connections_poll_is_not_given_to_that_connection
run taken-without-asking-whose a_new_connection_polled_inside_anothers_poll_does_not_take_its_timer
run kept-timer-keeps-no-waker a_kept_timer_wakes_what_polled_it_last
run drained-unwrapped a_connection_draining_at_shutdown_makes_its_timer_as_before
run asks-first-and-no-catch a_runtime_with_no_clock_answers_500_and_goes_on_serving_the_connection
run no-catch a_connection_polled_where_there_is_no_clock_makes_no_timer
run not-moved deadlines_on_four_threads_fire_and_none_before_its_limit
run made-at-the-first a_connections_timer_is_made_once_and_dropped_with_the_connection a_deadline_waits_on_its_connections_timer_from_the_third_that_waits a_served_request_waits_on_its_connections_timer a_connection_makes_its_timer_only_when_a_second_deadline_waits
run made-when-polled a_connection_makes_its_timer_only_when_a_second_deadline_waits a_connections_timer_is_made_once_and_dropped_with_the_connection
run never-made a_connections_timer_is_made_once_and_dropped_with_the_connection a_deadline_waits_on_its_connections_timer_from_the_third_that_waits a_served_request_waits_on_its_connections_timer
run thread-local-unchecked a_deadline_polled_while_its_thread_ends_makes_its_own_timer
run none ""
echo "# MUT-DONE" >> mut2.log
