//! A test's check that a case runs in about linear time, by its growth rather than the clock.

use std::time::{Duration, Instant};

/// `case` at size `n` runs in about linear time. Its time is the CPU time the test's thread spent
/// on it where Linux reports that (`/proc/thread-self/schedstat`), so the time other processes
/// held the cores is left out, and the wall clock elsewhere (and where that time does not
/// advance, as on a kernel that keeps no such count). Under a second is (the quadratic
/// version of each case that uses it takes far longer); slower, it is checked by its growth
/// instead: at `n` about 16 times as long as at `n / 16`, not 256, the fastest of the runs at each
/// size, so the load slows both alike rather than failing a bound on the clock. Sizes 16 apart
/// leave room for load that slows the larger runs more (likely because they no longer fit in the
/// caches), which CPU time still counts: 4 apart, a linear case's CPU time read up to 8.5 times as
/// long on a quiet machine and 11.8 under load; 16 apart, at most 35.6 (#883). The
/// first run is cold and also decides whether to check at all, so a check that would fail runs
/// one more pair first (one more chance at a fast run at each size, with every earlier run still
/// counted); its message names every run. The sizes alternate (whole, sixteenth, whole,
/// sixteenth), so a burst of load must last through a whole run to slow both runs at a sixteenth,
/// which would let a slow case pass. Load that slows only the smaller runs can still do that, never
/// fail a fast one.
pub(crate) fn linear(name: &str, n: usize, case: impl Fn(usize)) {
    linear_with(name, n, |n| {
        let (cpu, wall) = (on_cpu(), Instant::now());
        case(n);
        match (cpu, on_cpu()) {
            (Some(before), Some(after)) if after > before => after - before,
            _ => wall.elapsed(),
        }
    });
}

/// The time this thread has spent running, from the first field of Linux's
/// `/proc/thread-self/schedstat` (nanoseconds on a CPU, as of the scheduler's last look, so to
/// about a tick; the second is the time it waited for one). None where there is no such file.
fn on_cpu() -> Option<Duration> {
    let stat = std::fs::read_to_string("/proc/thread-self/schedstat").ok()?;
    Some(Duration::from_nanos(stat.split_whitespace().next()?.parse().ok()?))
}

/// [`linear`] with the time a case takes at a size given by `time`.
fn linear_with(name: &str, n: usize, time: impl Fn(usize) -> Duration) {
    let first = time(n);
    if first < Duration::from_secs(1) {
        return;
    }
    let mut runs = vec![(n, first)];
    for size in [n / 16, n, n / 16] {
        runs.push((size, time(size)));
    }
    if !grows_linearly(fastest(&runs, n / 16), fastest(&runs, n)) {
        for size in [n, n / 16] {
            runs.push((size, time(size)));
        }
    }
    let (sixteenth, whole) = (fastest(&runs, n / 16), fastest(&runs, n));
    assert!(grows_linearly(sixteenth, whole), "{name}: {whole:?} at {n}, {sixteenth:?} at {} (every run: {runs:?})", n / 16);
}

/// The fastest of the runs at `size`.
fn fastest(runs: &[(usize, Duration)], size: usize) -> Duration {
    runs.iter().filter(|(at, _)| *at == size).map(|(_, took)| *took).min().expect("a run at each size")
}

/// The verdict on two times, at a sixteenth of the size and at the whole: under 64 times as long
/// (about 16 is linear, 256 quadratic: a factor of four either side), with 20 ms for a size so
/// small that the clock's noise (a scheduler tick, for CPU time) is most of it.
fn grows_linearly(sixteenth: Duration, whole: Duration) -> bool {
    whole < sixteenth * 64 + Duration::from_millis(20)
}

/// The check fails a case that grows with the square of its size once it takes a second, on
/// times given rather than measured, so a busy machine cannot change the outcome.
#[test]
#[should_panic(expected = "every run")]
fn the_check_fails_a_quadratic_case() {
    linear_with("quadratic", 1_000, |n| Duration::from_micros((n * n) as u64 * 11 / 10));
}

/// It fails one whose second and third runs a burst of load slowed eightfold: one of them is at the
/// whole size, so a run at a sixteenth is left fast. With both sixteenth runs in a row, the burst
/// would slow both and the case would pass.
#[test]
#[should_panic(expected = "burst on a quadratic case")]
fn a_burst_does_not_let_a_quadratic_case_pass() {
    let runs = std::cell::Cell::new(0);
    linear_with("burst on a quadratic case", 1_000, |n| {
        runs.set(runs.get() + 1);
        let took = Duration::from_micros((n * n) as u64 * 11 / 10);
        if matches!(runs.get(), 2 | 3) {
            took * 8
        } else {
            took
        }
    });
}

/// And passes one that grows with its size in four runs, no extra pair, and one under a second
/// whatever it grows by in one.
#[test]
fn the_check_passes_a_linear_case_and_a_fast_one() {
    let runs = std::cell::Cell::new(0);
    linear_with("linear", 1_000, |n| {
        runs.set(runs.get() + 1);
        Duration::from_micros(n as u64 * 1_100)
    });
    assert_eq!(runs.get(), 4, "a passing check runs no extra pair");
    runs.set(0);
    linear_with("fast", 1_000, |n| {
        runs.set(runs.get() + 1);
        Duration::from_micros((n * n) as u64 * 9 / 10)
    });
    assert_eq!(runs.get(), 1, "a case under a second is not checked by its growth");
}

/// A linear case whose two runs at the whole size are slowed eightfold (a cold first run, then
/// load during the other) would fail on those four runs; it passes, because the extra pair is
/// not slowed.
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
            took * 8
        } else {
            took
        }
    });
    assert_eq!(wholes.get(), 3, "one more run at the whole size, after the check would fail");
}

/// The thread's CPU time counts the time it runs and leaves out the time it does not, as a busy
/// machine's other processes make it wait: a sleep, here.
#[cfg(target_os = "linux")]
#[test]
fn a_case_is_timed_by_the_cpu_time_its_thread_spent() {
    let cpu = || on_cpu().expect("Linux reports a thread's CPU time");
    let (before, started) = (cpu(), Instant::now());
    while cpu() - before < Duration::from_millis(20) {
        assert!(started.elapsed() < Duration::from_secs(10), "no CPU time counted while the thread ran");
    }
    let before = cpu();
    std::thread::sleep(Duration::from_millis(200));
    let ran = cpu() - before;
    assert!(ran < Duration::from_millis(100), "{ran:?} on a CPU over a 200 ms sleep");
}

/// The verdict, on times given rather than measured.
#[test]
fn the_verdict_fails_a_quadratic_case_and_passes_a_linear_one() {
    let whole = Duration::from_millis(1_100);
    assert!(!grows_linearly(whole / 256, whole), "a quadratic case: 256 times as long at 16 times the size");
    assert!(grows_linearly(whole / 16, whole), "a linear case: 16 times as long");
    assert!(grows_linearly(whole / 36, whole), "a linear case at the most measured under load: 35.6 times as long");
    assert!(grows_linearly(Duration::ZERO, Duration::from_millis(19)), "under the timer's noise");
}
