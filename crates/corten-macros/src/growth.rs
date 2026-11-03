//! A test's check that a case runs in about linear time, by its growth rather than the clock.

use std::time::Duration;

/// `case` at size `n` runs in about linear time. Under a second is (the quadratic version of
/// each case that uses it takes far longer); slower, on a busy machine, it is checked by its
/// growth instead: at `n` about four times as long as at `n / 4`, not sixteen, the fastest of
/// the runs at each size, so the load slows both alike rather than failing a bound on the clock.
/// The sizes alternate (whole, quarter, whole, quarter), so a burst of load falls on both, and a
/// check that would fail runs one more pair first; its message names every run. Load that slows
/// only the smaller runs can let a slow case pass, never fail a fast one.
pub(crate) fn linear(name: &str, n: usize, case: impl Fn(usize)) {
    linear_with(name, n, |n| {
        let started = std::time::Instant::now();
        case(n);
        started.elapsed()
    });
}

/// [`linear`] with the time a case takes at a size given by `time`.
fn linear_with(name: &str, n: usize, time: impl Fn(usize) -> Duration) {
    let first = time(n);
    if first < Duration::from_secs(1) {
        return;
    }
    let mut runs = vec![(n, first)];
    for size in [n / 4, n, n / 4] {
        runs.push((size, time(size)));
    }
    if !grows_linearly(fastest(&runs, n / 4), fastest(&runs, n)) {
        for size in [n, n / 4] {
            runs.push((size, time(size)));
        }
    }
    let (quarter, whole) = (fastest(&runs, n / 4), fastest(&runs, n));
    assert!(grows_linearly(quarter, whole), "{name}: {whole:?} at {n}, {quarter:?} at {} (every run: {runs:?})", n / 4);
}

/// The fastest of the runs at `size`.
fn fastest(runs: &[(usize, Duration)], size: usize) -> Duration {
    runs.iter().filter(|(at, _)| *at == size).map(|(_, took)| *took).min().unwrap_or(Duration::MAX)
}

/// The verdict on two times, at a quarter of the size and at the whole: under ten times as long
/// (about four is linear, sixteen quadratic), with 20 ms for a size so small that timer noise is
/// most of it.
fn grows_linearly(quarter: Duration, whole: Duration) -> bool {
    whole < quarter * 10 + Duration::from_millis(20)
}

/// The check fails a case that grows with the square of its size once it takes a second, on
/// times given rather than measured, so a busy machine cannot change the outcome.
#[test]
#[should_panic(expected = "quadratic")]
fn the_check_fails_a_quadratic_case() {
    linear_with("quadratic", 1_000, |n| Duration::from_micros((n * n) as u64 * 11 / 10));
}

/// And passes one that grows with its size, and one under a second whatever it grows by.
#[test]
fn the_check_passes_a_linear_case_and_a_fast_one() {
    linear_with("linear", 1_000, |n| Duration::from_micros(n as u64 * 1_100));
    linear_with("fast", 1_000, |n| Duration::from_micros((n * n) as u64 * 9 / 10));
}

/// A linear case whose first two runs at the whole size a burst of load slowed fourfold, which
/// the fastest of one more such run at each size would fail, passes: the extra pair is not slowed.
#[test]
fn a_burst_on_the_larger_runs_does_not_fail_a_linear_case() {
    let wholes = std::cell::Cell::new(0);
    linear_with("burst", 1_000, |n| {
        let took = Duration::from_micros(n as u64 * 1_100);
        if n < 1_000 {
            return took;
        }
        wholes.set(wholes.get() + 1);
        if wholes.get() <= 2 {
            took * 4
        } else {
            took
        }
    });
    assert_eq!(wholes.get(), 3, "one more run at the whole size, after the check would fail");
}

/// The verdict, on times given rather than measured.
#[test]
fn the_verdict_fails_a_quadratic_case_and_passes_a_linear_one() {
    let whole = Duration::from_millis(1_100);
    assert!(!grows_linearly(whole / 16, whole), "a quadratic case: 16 times as long at four times the size");
    assert!(grows_linearly(whole / 4, whole), "a linear case: four times as long");
    assert!(grows_linearly(Duration::ZERO, Duration::from_millis(19)), "under the timer's noise");
}
