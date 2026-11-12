//! What this server knows about itself: how long it has been up, the pages it has rendered and
//! how long the last one took, the plates struck, how many pages are following along, and, where
//! the operating system says (Linux), the memory it holds, the machine it is on and how much of
//! that machine's CPU and memory is in use: the whole machine's, or, where the server's own
//! control group holds it to a limit (control groups v2: a container's `--memory` or `--cpus`,
//! a unit's `MemoryMax=` or `CPUQuota=`), what is in use of that limit. A limit set on a group
//! above the server's own is not looked for, nor one of the first version's groups, and the
//! counts are then the machine's, which read low with the server at such a limit. A task reads
//! it once a second into a `watch` channel, and every open page's `<corten-live>` follows that
//! channel (`corten::live_watch`). Nothing here is made up for show: each number is counted.
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use corten::{Signal, prelude::*};
use tokio::sync::watch;

use crate::steel::Readout;

/// One reading of the server, and which of its numbers moved since the reading before.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Pulse {
    /// Seconds since the server started: the stream's cursor.
    pub beat: u64,
    pub pages: u64,
    /// Pages rendered a second, over the time since the count before.
    pub pages_a_second: u64,
    /// The last page's render, in microseconds; 0 before the first.
    pub render_micros: u64,
    pub plates: u64,
    /// Pages following the stream right now.
    pub followers: u64,
    /// The most that have followed it at once since the server started.
    pub most_followers: u64,
    /// The memory this process holds (its resident set), in bytes; 0 where it cannot be read.
    pub held_bytes: u64,
    pub used: Used,
    pub moved: Moved,
}

/// How much is in use of what the server has to work with (`Machine`): what says whether it is
/// keeping up with everyone reading. All of it is absent where the system does not count.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Used {
    /// The CPU in use, as a percent: of the machine's, by everything on it, or of the limit the
    /// server's group holds it to (`Machine::cpu_limit`). `None` until two counts are half a
    /// second apart.
    pub cpu: Option<u8>,
    /// This server's part of the machine's percent. `None` under a limit, where the count is the
    /// group's own already.
    pub cpu_own: Option<u8>,
    /// The memory in use, in bytes: the machine's, or what is counted against the group's limit
    /// (`Machine::memory_limited`); 0 where it cannot be read.
    pub memory_bytes: u64,
}

/// The machine the server runs on, read once when it starts: what the operating system counts,
/// so the page states its host without anyone typing the numbers in.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Machine {
    /// The CPUs this process may use; 0 where the system does not say.
    pub cpus: usize,
    /// The memory this server may use, in bytes: the machine's, or the limit its control group
    /// sets where that is less; 0 where it cannot be read.
    pub memory_bytes: u64,
    /// What whoever runs it calls it (`CORTEN_SITE_MACHINE`): a size and a price, say.
    pub named: Option<String>,
    /// Whether that memory is the group's limit (its `memory.max`, which a container or a
    /// systemd unit sets): the memory in use is then the group's count, not the machine's.
    pub memory_limited: bool,
    /// The CPUs the group holds the server to (its `cpu.max`), where it sets a limit; as the
    /// server reads it when it starts, never more than the CPUs it may run on. The CPU in use is
    /// then the group's count as a part of this, not the machine's.
    pub cpu_limit: Option<f64>,
    /// Whether the system counts what is in use of both, found by reading each once.
    pub metered: bool,
    /// The CPUs the machine's own count is of (`/proc/stat`): more than `cpus` where the server
    /// may use only some of them.
    pub(crate) stat_cpus: usize,
    /// The machine's memory, in bytes, whatever limit holds the server; 0 where it cannot be read.
    pub(crate) whole_bytes: u64,
    /// The directory of the server's own control group, whose files say its limits and counts;
    /// `None` where the system has none to name, and nothing of a group's is then read.
    pub(crate) group: Option<String>,
}

/// A file the system keeps, as text; `None` where it keeps none.
fn system(path: &str) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

impl Machine {
    /// The machine as the system's files say it: `/proc/meminfo`, and the `memory.max` and
    /// `cpu.max` of the control group the server is in.
    pub(crate) fn counted(cpus: usize, meminfo: Option<&str>, memory_max: Option<&str>, cpu_max: Option<&str>) -> Self {
        let memory_bytes = memory_bytes(meminfo, memory_max);
        Machine {
            cpus,
            memory_bytes,
            named: None,
            memory_limited: memory_bytes < self::memory_bytes(meminfo, None),
            cpu_limit: cpu_max.and_then(quota),
            metered: false,
            stat_cpus: 0,
            whole_bytes: self::memory_bytes(meminfo, None),
            group: None,
        }
    }

    fn read() -> Self {
        Machine::in_group(
            system("/proc/self/cgroup").as_deref().and_then(group_dir),
            system("/proc/self/status").as_deref().and_then(allowed_cpus),
        )
    }

    /// The machine as a server in this control group reads it, allowed so many CPUs where the
    /// system says; one in no group reads no limit.
    fn in_group(group: Option<String>, allowed: Option<usize>) -> Self {
        let own = Machine { group, ..Machine::default() };
        let mut machine = Machine::counted(
            std::thread::available_parallelism().map_or(0, usize::from),
            system("/proc/meminfo").as_deref(),
            own.of_group("memory.max").as_deref(),
            own.of_group("cpu.max").as_deref(),
        );
        machine.group = own.group;
        machine.stat_cpus = system("/proc/stat").as_deref().map_or(0, stat_cpus);
        // A limit of more CPUs than the server may run on holds it to those it may run on.
        machine.cpu_limit = within(machine.cpu_limit, [allowed, Some(machine.stat_cpus)]);
        machine.named =
            std::env::var("CORTEN_SITE_MACHINE").ok().map(|named| named.trim().to_string()).filter(|named| !named.is_empty());
        machine.metered = machine.spent().is_some() && machine.used_bytes(0) > 0;
        machine
    }

    /// Whether the CPU in use is a part of the CPUs the server may use: of its limit, or of a
    /// machine all of whose CPUs it may run on. Kept to one CPU of eight with no limit
    /// (`--cpuset-cpus`), the machine's count is of all eight, and reads low with that one busy.
    pub fn counts_its_cpus(&self) -> bool {
        self.metered && (self.cpu_limit.is_some() || self.cpus >= self.stat_cpus)
    }

    /// Whether the server's group holds it to a limit, of memory or of CPU.
    pub fn held(&self) -> bool {
        self.memory_limited || self.cpu_limit.is_some()
    }

    /// The CPUs the machine has: those its own count is of, or where it has none, those the
    /// server may use.
    pub fn machine_cpus(&self) -> usize {
        self.stat_cpus.max(self.cpus)
    }

    /// The CPUs the server is held to: its group's limit, whatever the machine has, since the
    /// CPU in use is then counted against it; or else the count it may use (`cpus`), where that
    /// is fewer than the machine's. That count is the standard library's: the CPUs the server is
    /// kept to, or a quota this does not look for (a group above its own, or the first
    /// version's) rounded down to whole CPUs.
    pub fn held_cpus(&self) -> Option<f64> {
        self.cpu_limit.or((self.cpus < self.stat_cpus).then_some(self.cpus as f64))
    }

    /// A file of the server's own control group, as text.
    fn of_group(&self, file: &str) -> Option<String> {
        system(&format!("{}/{file}", self.group.as_deref()?))
    }

    /// The CPU time spent so far, by the count that says what is in use of this machine.
    fn spent(&self) -> Option<Spent> {
        if self.cpu_limit.is_some() {
            return self.of_group("cpu.stat").as_deref().and_then(group_micros).map(Spent::Group);
        }
        let (busy, idle) = system("/proc/stat").as_deref().and_then(machine_ticks)?;
        Some(Spent::Machine { busy, idle, own: system("/proc/self/stat").as_deref().and_then(own_ticks)? })
    }

    /// The memory in use: the control group's count where its limit is the machine's memory,
    /// else the system's. `held` is what this server holds.
    fn used_bytes(&self, held: u64) -> u64 {
        if self.memory_limited {
            group_bytes(self.of_group("memory.current").as_deref(), self.of_group("memory.stat").as_deref(), held)
        } else {
            system("/proc/meminfo").as_deref().and_then(unavailable_bytes).unwrap_or(0)
        }
    }
}

/// The directory of a process's own control group, from its `/proc/self/cgroup`: the line of
/// control groups v2 is `0::` and the group's path, which is `/` in a container, where the group
/// is the root of what the container sees. `None` on a system with only the first version's
/// groups, whose limits are not looked for; beside the first version's (a hybrid system), the
/// second's are mounted elsewhere, the directory named here does not exist, and no limit is read.
fn group_dir(cgroup: &str) -> Option<String> {
    let path = cgroup.lines().find_map(|line| line.strip_prefix("0::"))?.trim();
    (path.starts_with('/') && !path.split('/').any(|part| part == ".."))
        .then(|| format!("/sys/fs/cgroup{}", path.trim_end_matches('/')))
}

/// The CPUs `/proc/stat` has a line for: `cpu0`, `cpu1` and on, after the line of them all.
fn stat_cpus(stat: &str) -> usize {
    stat.lines()
        .filter(|line| line.strip_prefix("cpu").is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit())))
        .count()
}

/// The CPUs a process is allowed, from the `Cpus_allowed_list` of its `/proc/self/status`:
/// `0-3,8` is five. The kernel lists every CPU the machine could have, so an unrestricted
/// process on a machine of eight may read 128, which is why this is one of two counts.
fn allowed_cpus(status: &str) -> Option<usize> {
    let list = status.lines().find_map(|line| line.strip_prefix("Cpus_allowed_list:"))?.trim();
    list.split(',')
        .map(|run| {
            let (first, last) = run.split_once('-').unwrap_or((run, run));
            let (first, last) = (first.trim().parse::<usize>().ok()?, last.trim().parse::<usize>().ok()?);
            (last >= first).then(|| last - first + 1)
        })
        .sum()
}

/// A limit of CPUs, and no more than the fewest of the counts of CPUs the server could use that
/// the system gave: a quota of four on a machine of one, or with the server kept to one, is one.
fn within(limit: Option<f64>, counts: [Option<usize>; 2]) -> Option<f64> {
    let limit = limit?;
    let fewest = counts.into_iter().flatten().filter(|&count| count > 0).min();
    Some(fewest.map_or(limit, |fewest| limit.min(fewest as f64)))
}

/// The memory a server may use, from the system's count of the machine's (`/proc/meminfo`) and
/// the limit its control group sets (`memory.max`, which reads `max` where there is none): a
/// container held to 512 MB on a larger machine has 512 MB.
fn memory_bytes(meminfo: Option<&str>, limit: Option<&str>) -> u64 {
    let machine = meminfo.and_then(|text| kib(text, "MemTotal")).map_or(0, |kib| kib << 10);
    let limit = limit.and_then(|limit| limit.trim().parse::<u64>().ok());
    limit.map_or(machine, |limit| machine.min(limit))
}

/// A line of `/proc/meminfo` or `/proc/self/status`: `VmRSS:      9268 kB` is 9268.
fn kib(text: &str, key: &str) -> Option<u64> {
    let line = text.lines().find(|line| line.strip_prefix(key).is_some_and(|rest| rest.starts_with(':')))?;
    line[key.len() + 1..].trim().strip_suffix("kB")?.trim().parse().ok()
}

/// The memory this process holds now, in bytes; 0 where the system has no `/proc`.
fn held_bytes() -> u64 {
    system("/proc/self/status").and_then(|text| kib(&text, "VmRSS")).map_or(0, |kib| kib << 10)
}

/// The memory of `/proc/meminfo` that a new program could not be given, in bytes: all of it
/// less what the system counts as available, which leaves out the file cache it can drop.
fn unavailable_bytes(meminfo: &str) -> Option<u64> {
    Some(kib(meminfo, "MemTotal")?.saturating_sub(kib(meminfo, "MemAvailable")?) << 10)
}

/// The memory a control group has in use, in bytes; 0 where it cannot be read. It is the
/// group's `memory.current` less the file cache its `memory.stat` calls inactive, which the
/// system drops first when the group needs room, as `docker stats` takes it; or what the server
/// holds (`held`), where that is more. A group is charged for a page of a file only when it was
/// the first to read it, so its count can leave out pages of the program itself that the server
/// holds all the same, and the page would then say the group uses less than the server in it
/// holds. The larger of the two is the least that is in use; it can be more than is charged
/// against the limit, by the pages another group was charged for.
fn group_bytes(current: Option<&str>, stat: Option<&str>, held: u64) -> u64 {
    let Some(current) = current.and_then(|bytes| bytes.trim().parse::<u64>().ok()) else { return 0 };
    let inactive = stat.and_then(|stat| stat.lines().find_map(|line| line.strip_prefix("inactive_file ")?.trim().parse().ok()));
    current.saturating_sub(inactive.unwrap_or(0)).max(held)
}

/// A control group's `cpu.max`, `quota period` in microseconds, as the CPUs it may use: `None`
/// where the quota is `max`, which is no limit.
fn quota(max: &str) -> Option<f64> {
    let (quota, period) = max.trim().split_once(' ')?;
    let (quota, period) = (quota.parse::<f64>().ok()?, period.parse::<f64>().ok()?);
    (quota > 0.0 && period > 0.0).then(|| quota / period)
}

/// The CPU time every CPU has spent so far, from the first line of `/proc/stat`: busy and idle,
/// in the system's ticks. Waiting on a disk is idle, and the time the host gave another guest
/// (steal, the eighth number) is neither: it was never this machine's to use.
fn machine_ticks(stat: &str) -> Option<(u64, u64)> {
    let mut times = stat.lines().next()?.strip_prefix("cpu ")?.split_whitespace().map(|time| time.parse::<u64>().ok());
    let [user, nice, kernel, idle, iowait, irq, softirq] = std::array::from_fn(|_| times.next().flatten());
    Some((user? + nice? + kernel? + irq? + softirq?, idle? + iowait?))
}

/// The CPU time this process has spent so far, from `/proc/self/stat`, in the same ticks: its
/// time in user mode and in the kernel, the 12th and 13th numbers after the name, which ends at
/// the last `)` and may itself hold spaces.
fn own_ticks(stat: &str) -> Option<u64> {
    let mut after = stat[stat.rfind(')')? + 1..].split_whitespace().skip(11).map(|time| time.parse::<u64>().ok());
    Some(after.next()?? + after.next()??)
}

/// The CPU time a control group has spent so far, from its `cpu.stat`, in microseconds.
fn group_micros(stat: &str) -> Option<u64> {
    stat.lines().find_map(|line| line.strip_prefix("usage_usec ")?.trim().parse().ok())
}

/// CPU time spent so far, by one of the system's two counts. Each only grows, so two of them
/// say what was used between.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Spent {
    /// The machine's, busy and idle, and this process's part of it, in the system's ticks.
    Machine { busy: u64, idle: u64, own: u64 },
    /// A control group's, in microseconds.
    Group(u64),
}

/// What has been counted up to one moment: two of these say what happened between them.
#[derive(Clone, Copy, Debug)]
struct Counts {
    at: Instant,
    /// Pages rendered so far.
    pages: u64,
    /// `None` where the system keeps no such count.
    spent: Option<Spent>,
}

/// Counts closer together than this say too little to go by: a reading then keeps the figures
/// of the one before, and the next is measured from the older count.
const APART: Duration = Duration::from_millis(500);

/// `part` of `whole` as a percent, to the nearest and at most 100; `None` of nothing.
pub(crate) fn percent(part: u64, whole: u64) -> Option<u8> {
    (whole > 0).then(|| ((u128::from(part) * 100 + u128::from(whole) / 2) / u128::from(whole)).min(100) as u8)
}

/// The CPU in use between two counts: the machine's and this server's part of it, or, where a
/// control group holds the server to `limit` CPUs, the group's time as a part of that limit.
/// `None` where the system kept no count.
fn cpu_used(before: &Counts, now: &Counts, limit: Option<f64>) -> Option<(u8, Option<u8>)> {
    match (before.spent?, now.spent?) {
        (Spent::Group(before_micros), Spent::Group(micros)) => {
            let between = now.at.saturating_duration_since(before.at).as_micros() as f64;
            Some((percent(micros.saturating_sub(before_micros), (between * limit?) as u64)?, None))
        }
        (Spent::Machine { busy: busy_before, idle: idle_before, own: own_before }, Spent::Machine { busy, idle, own }) => {
            let own = own.saturating_sub(own_before);
            // The machine's line is sampled at the timer's tick and a process's time is exact, so
            // a short burst can be in the one and not the other: the machine was busy for at
            // least as long as this server ran.
            let busy = busy.saturating_sub(busy_before).max(own);
            let all = busy + idle.saturating_sub(idle_before);
            Some((percent(busy, all)?, percent(own, all)))
        }
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Moved {
    pub pages: bool,
    pub render: bool,
    pub plates: bool,
    pub followers: bool,
}

/// A reading as the stream sends it. The readout is the same on every page that follows, so the
/// task that takes the reading draws it once and each page's stream copies it out.
#[derive(Clone)]
pub struct Sent {
    pub pulse: Pulse,
    pub drawn: Arc<str>,
}

impl Sent {
    fn new(pulse: Pulse, machine: &Machine) -> Self {
        let drawn = Readout { pulse: &pulse, machine }.to_html().into();
        Sent { pulse, drawn }
    }
}

#[derive(Clone)]
pub struct Works(Arc<Counted>);

struct Counted {
    started: Instant,
    pages: AtomicU64,
    render_micros: AtomicU64,
    plates: AtomicU64,
    /// The most streams open at once, counted as each opens.
    most: AtomicU64,
    pulse: watch::Sender<Sent>,
    /// The size of the program serving this, in bytes; 0 when it cannot be read.
    binary_bytes: u64,
    machine: Machine,
}

impl Default for Works {
    fn default() -> Self {
        Self::new()
    }
}

impl Works {
    pub fn new() -> Self {
        Self::on(Machine::read())
    }

    /// The server's counts on `machine`.
    fn on(machine: Machine) -> Self {
        let binary_bytes = std::env::current_exe().and_then(std::fs::metadata).map_or(0, |file| file.len());
        Works(Arc::new(Counted {
            started: Instant::now(),
            pages: AtomicU64::new(0),
            render_micros: AtomicU64::new(0),
            plates: AtomicU64::new(0),
            most: AtomicU64::new(0),
            pulse: watch::Sender::new(Sent::new(Pulse::default(), &machine)),
            binary_bytes,
            machine,
        }))
    }

    /// A page was rendered, in `took`.
    pub fn rendered(&self, took: Duration) {
        self.0.pages.fetch_add(1, Ordering::Relaxed);
        self.0.render_micros.store(took.as_micros().min(u128::from(u64::MAX)) as u64, Ordering::Relaxed);
    }

    /// A plate was struck; its number, counted from 1.
    pub fn struck(&self) -> u64 {
        self.0.plates.fetch_add(1, Ordering::Relaxed) + 1
    }

    #[cfg(test)]
    pub fn pages(&self) -> u64 {
        self.0.pages.load(Ordering::Relaxed)
    }

    pub fn plates(&self) -> u64 {
        self.0.plates.load(Ordering::Relaxed)
    }

    pub fn binary_bytes(&self) -> u64 {
        self.0.binary_bytes
    }

    pub fn machine(&self) -> &Machine {
        &self.0.machine
    }

    /// The latest reading, for the page to draw before the stream takes over.
    pub fn pulse(&self) -> Pulse {
        self.0.pulse.borrow().pulse.clone()
    }

    /// The readings as they come, for a page's stream. The most open at once is counted here, as
    /// each opens, so one that opens and closes between two readings is counted too.
    pub fn follow(&self) -> watch::Receiver<Sent> {
        let following = self.0.pulse.subscribe();
        self.0.most.fetch_max(self.0.pulse.receiver_count() as u64, Ordering::Relaxed);
        following
    }

    /// What has been counted up to now.
    fn counts(&self) -> Counts {
        Counts { at: Instant::now(), pages: self.0.pages.load(Ordering::Relaxed), spent: self.0.machine.spent() }
    }

    /// The server as it is at `now`, with what moved since `last` and what was used since the
    /// count `before`. Counts too close together (`APART`) keep the last reading's rates.
    fn read(&self, last: &Pulse, before: &Counts, now: &Counts) -> Pulse {
        let render_micros = self.0.render_micros.load(Ordering::Relaxed);
        let plates = self.0.plates.load(Ordering::Relaxed);
        let followers = self.0.pulse.receiver_count() as u64;
        let between = now.at.saturating_duration_since(before.at);
        let (pages_a_second, cpu, cpu_own) = if between < APART {
            (last.pages_a_second, last.used.cpu, last.used.cpu_own)
        } else {
            let millis = between.as_millis() as u64;
            let (cpu, own) = cpu_used(before, now, self.0.machine.cpu_limit).unzip();
            ((now.pages.saturating_sub(before.pages) * 1000 + millis / 2) / millis, cpu, own.flatten())
        };
        let held_bytes = held_bytes();
        Pulse {
            beat: self.0.started.elapsed().as_secs(),
            pages: now.pages,
            pages_a_second,
            render_micros,
            plates,
            followers,
            most_followers: self.0.most.load(Ordering::Relaxed).max(followers),
            held_bytes,
            used: Used { cpu, cpu_own, memory_bytes: self.0.machine.used_bytes(held_bytes) },
            moved: Moved {
                pages: now.pages != last.pages,
                render: render_micros != last.render_micros,
                plates: plates != last.plates,
                followers: followers != last.followers,
            },
        }
    }

    /// Reads the server once a second until the app shuts down.
    pub async fn run(self, signal: Signal) {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut before = self.counts();
        loop {
            tokio::select! {
                biased;
                _ = signal.aborted() => return,
                _ = tick.tick() => {
                    let now = self.counts();
                    // Copied out first: the system's files are not read with the channel held.
                    let last = self.pulse();
                    let next = self.read(&last, &before, &now);
                    // The first tick comes at once, and one that was held up is followed by the
                    // next too soon: neither is measured from.
                    if now.at.saturating_duration_since(before.at) >= APART {
                        before = now;
                    }
                    self.0.pulse.send_replace(Sent::new(next, &self.0.machine));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What `works` has counted, as if read `millis` after `start`, with no count of CPU time.
    fn at(works: &Works, start: Instant, millis: u64) -> Counts {
        Counts { at: start + Duration::from_millis(millis), spent: None, ..works.counts() }
    }

    #[test]
    fn a_reading_says_what_moved() {
        let works = Works::new();
        let start = Instant::now();
        let none = at(&works, start, 0);
        let first = works.read(&Pulse::default(), &none, &at(&works, start, 1000));
        assert!(!first.moved.pages && !first.moved.plates);
        works.rendered(Duration::from_micros(212));
        assert_eq!(works.struck(), 1);
        let second = works.read(&first, &none, &at(&works, start, 2000));
        assert_eq!((second.pages, second.render_micros, second.plates), (1, 212, 1));
        assert!(second.moved.pages && second.moved.render && second.moved.plates && !second.moved.followers);
    }

    /// The pages a second are the pages since the count before over the time since, and the
    /// most following is counted as each stream opens, so it is kept after they have gone and
    /// has one that came and went between two readings.
    #[test]
    fn a_reading_says_how_fast_and_how_many_at_most() {
        let works = Works::new();
        let start = Instant::now();
        let none = at(&works, start, 0);
        for _ in 0..30 {
            works.rendered(Duration::from_micros(212));
        }
        let (one, two) = (works.follow(), works.follow());
        // A reading that came late divides by the time it took.
        let late = at(&works, start, 2000);
        let first = works.read(&Pulse::default(), &none, &late);
        assert_eq!((first.pages_a_second, first.followers, first.most_followers), (15, 2, 2));
        drop((one, two, works.follow()));
        let second = works.read(&first, &late, &at(&works, start, 3000));
        assert_eq!((second.pages_a_second, second.followers, second.most_followers), (0, 0, 3));
    }

    /// A count too soon after the one before says too little: the reading keeps the last one's
    /// rates, where dropping them would take the gauges off the page for a second.
    #[test]
    fn a_reading_too_soon_keeps_the_rates_of_the_one_before() {
        let works = Works::new();
        let start = Instant::now();
        let last =
            Pulse { pages_a_second: 40, used: Used { cpu: Some(55), cpu_own: Some(20), memory_bytes: 1 }, ..Pulse::default() };
        let spent = |busy, idle, own| Some(Spent::Machine { busy, idle, own });
        let before = Counts { spent: spent(1000, 5000, 300), ..at(&works, start, 0) };
        works.rendered(Duration::from_micros(212));
        let soon = works.read(&last, &before, &Counts { spent: spent(1001, 5001, 301), ..at(&works, start, 499) });
        assert_eq!((soon.pages_a_second, soon.used.cpu, soon.used.cpu_own), (40, Some(55), Some(20)));
        // The next is measured from the older count, and has the page the one too soon left out.
        let next = works.read(&soon, &before, &Counts { spent: spent(1030, 5070, 310), ..at(&works, start, 1000) });
        assert_eq!((next.pages_a_second, next.used.cpu, next.used.cpu_own), (1, Some(30), Some(10)));
    }

    #[test]
    fn the_cpu_in_use_is_what_the_system_counted_between_two_readings() {
        // A machine's own line, and a process's, whose name holds a space and a bracket.
        let stat = "cpu  4705 150 1120 16250 520 30 45 700 0 0\ncpu0 4705 150 1120 16250 520 30 45 700 0 0\nintr 1\n";
        assert_eq!(machine_ticks(stat), Some((4705 + 150 + 1120 + 30 + 45, 16250 + 520)));
        assert_eq!(machine_ticks("cpu0 1 2 3 4 5 6 7 8\n"), None);
        assert_eq!(machine_ticks("cpu  1 2 3\n"), None);
        let own = "7 (corten site) 1) S 1 7 7 0 -1 4194560 911 0 0 0 31 12 0 0 20 0 3 0 5177 1 2 3\n";
        assert_eq!(own_ticks(own), Some(31 + 12));
        assert_eq!(own_ticks("7 (corten-site) S 1 7\n"), None);
        assert_eq!(group_micros("usage_usec 81234567\nuser_usec 5\nsystem_usec 6\n"), Some(81_234_567));
        assert_eq!(group_micros("user_usec 5\n"), None);
        assert_eq!((quota("max 100000\n"), quota("100000 100000\n"), quota("50000 100000\n")), (None, Some(1.0), Some(0.5)));
        assert_eq!((percent(1, 3), percent(2, 3), percent(7, 5), percent(1, 0)), (Some(33), Some(67), Some(100), None));
        assert_eq!((percent(u64::MAX, u64::MAX), percent(u64::MAX / 2, u64::MAX)), (Some(100), Some(50)));
        assert_eq!((stat_cpus(stat), stat_cpus("cpu  1 2 3\ncpu0 1\ncpu1 2\ncpu10 3\ncpufreq 1\n")), (1, 3));

        let works = Works::new();
        let start = Instant::now();
        let (none, later) = (at(&works, start, 0), at(&works, start, 1000));
        let machine = |busy, idle, own| Some(Spent::Machine { busy, idle, own });
        // On the machine itself: 100 ticks in the second, 40 of them busy, 25 this server's.
        let before = Counts { spent: machine(1000, 5000, 300), ..none };
        let now = Counts { spent: machine(1040, 5060, 325), ..later };
        assert_eq!(cpu_used(&before, &now, None), Some((40, Some(25))));
        // A burst between two of the machine's samples: it was busy for at least what this
        // server used, so the part is never more than the whole.
        let burst = Counts { spent: machine(1000, 5100, 302), ..later };
        assert_eq!(cpu_used(&before, &burst, None), Some((2, Some(2))));
        // Under a group's limit of half a CPU: 300 ms of CPU time in the second is 60% of it, and
        // the machine around the group is not counted.
        let before = Counts { spent: Some(Spent::Group(2_000_000)), ..none };
        let now = Counts { spent: Some(Spent::Group(2_300_000)), ..later };
        assert_eq!(cpu_used(&before, &now, Some(0.5)), Some((60, None)));
        // Nothing is said where the system keeps no count, or one count is not the other's kind.
        assert_eq!(cpu_used(&none, &later, None), None);
        assert_eq!(cpu_used(&none, &later, Some(1.0)), None);
        assert_eq!(cpu_used(&before, &burst, Some(0.5)), None);
        assert_eq!(cpu_used(&before, &now, None), None);
    }

    #[test]
    fn the_systems_own_lines_are_read() {
        let status = "Name:\tcorten-site\nVmHWM:\t   10112 kB\nVmRSS:\t    9268 kB\nRssAnon:\t    4100 kB\n";
        assert_eq!(kib(status, "VmRSS"), Some(9268));
        assert_eq!(kib("MemTotal:         468428 kB\nMemFree:  1 kB\n", "MemTotal"), Some(468_428));
        assert_eq!(kib(status, "Vm"), None);
        assert_eq!(kib("VmRSS: lots\n", "VmRSS"), None);
        // The machine's memory, or its group's limit where that is less.
        let meminfo = "MemTotal:       12250780 kB\nMemFree: 1 kB\n";
        assert_eq!(memory_bytes(Some(meminfo), Some("max\n")), 12_250_780 << 10);
        assert_eq!(memory_bytes(Some(meminfo), Some("536870912\n")), 536_870_912);
        assert_eq!(memory_bytes(Some(meminfo), None), 12_250_780 << 10);
        assert_eq!(memory_bytes(None, Some("536870912\n")), 0);
        // What is in use is what a new program could not have.
        let meminfo = "MemTotal:         468428 kB\nMemFree:  9000 kB\nMemAvailable:     268428 kB\n";
        assert_eq!(unavailable_bytes(meminfo), Some(200_000 << 10));
        assert_eq!(unavailable_bytes("MemTotal:         468428 kB\n"), None);
        // A group's count, less the file cache it would drop first, and never said to be less
        // than what the server itself holds.
        let stat = "anon 9000000\nfile 8000000\ninactive_file 6000000\nactive_file 2000000\n";
        assert_eq!(group_bytes(Some("20000000\n"), Some(stat), 5_775_360), 14_000_000);
        assert_eq!(group_bytes(Some("20000000\n"), None, 5_775_360), 20_000_000);
        assert_eq!(group_bytes(Some("7503232\n"), Some(stat), 5_775_360), 5_775_360);
        assert_eq!((group_bytes(Some("max\n"), Some(stat), 5_775_360), group_bytes(None, Some(stat), 5_775_360)), (0, 0));
    }

    /// The server's own group is found from the system's line for it, and nowhere else.
    #[test]
    fn the_servers_own_group_is_the_one_read() {
        // In a container the group is the root of what it sees; under systemd it is the unit's.
        assert_eq!(group_dir("0::/\n").as_deref(), Some("/sys/fs/cgroup"));
        assert_eq!(
            group_dir("0::/system.slice/corten-site.service\n").as_deref(),
            Some("/sys/fs/cgroup/system.slice/corten-site.service")
        );
        // The first version's groups have no such line; beside the second's, its line is the one named.
        assert_eq!(group_dir("12:memory:/docker/abc\n11:cpu,cpuacct:/docker/abc\n"), None);
        assert_eq!(
            group_dir("1:name=systemd:/user.slice\n0::/user.slice/x.scope\n").as_deref(),
            Some("/sys/fs/cgroup/user.slice/x.scope")
        );
        assert_eq!((group_dir("0::/../../etc\n"), group_dir("0::\n"), group_dir("")), (None, None, None));
        // Kept to fewer CPUs than the machine's count is of, and by no limit, that count is not of
        // what the server may use; under a limit, or on all of them, it is.
        let meminfo = Some("MemTotal:       12250780 kB\nMemAvailable:   8000000 kB\n");
        let on =
            |cpus, stat_cpus, cpu_max| Machine { metered: true, stat_cpus, ..Machine::counted(cpus, meminfo, None, cpu_max) };
        assert!(on(8, 8, None).counts_its_cpus() && on(1, 1, None).counts_its_cpus());
        assert!(!on(1, 8, None).counts_its_cpus());
        assert!(on(1, 8, Some("100000 100000\n")).counts_its_cpus());
        assert!(!Machine { metered: false, ..on(8, 8, None) }.counts_its_cpus());
        // A limit is of no more CPUs than the server may run on, by either count the system gave.
        assert_eq!(allowed_cpus("Name:\tx\nCpus_allowed:\tff\nCpus_allowed_list:\t0-3,8\n"), Some(5));
        assert_eq!(
            (allowed_cpus("Cpus_allowed_list:\t0\n"), allowed_cpus("Cpus_allowed_list:\t\n"), allowed_cpus("")),
            (Some(1), None, None)
        );
        assert_eq!(allowed_cpus("Cpus_allowed_list:\t3-1\n"), None);
        assert_eq!(within(Some(2.0), [Some(1), Some(8)]), Some(1.0));
        assert_eq!(within(Some(4.0), [Some(128), Some(1)]), Some(1.0));
        assert_eq!(within(Some(0.5), [Some(1), Some(8)]), Some(0.5));
        assert_eq!((within(Some(1.5), [None, Some(0)]), within(None, [Some(1), Some(1)])), (Some(1.5), None));
    }

    /// The limits and the counts are the files of the group the server is in: a directory laid
    /// out as the system lays a group out is the one read, and with no group nothing of one is.
    #[test]
    fn a_groups_own_files_are_what_is_read() {
        let dir = std::env::temp_dir().join(format!("corten-site-group-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a directory to lay the group out in");
        let files = [
            ("memory.max", "268435456\n"),
            ("cpu.max", "50000 100000\n"),
            ("cpu.stat", "usage_usec 2300000\nuser_usec 2000000\n"),
            ("memory.current", "20000000\n"),
            ("memory.stat", "anon 9000000\ninactive_file 6000000\n"),
        ];
        for (file, text) in files {
            std::fs::write(dir.join(file), text).expect("a file of the group's");
        }
        let machine = Machine::in_group(Some(dir.to_string_lossy().into_owned()), None);
        let (spent, used) = (machine.spent(), machine.used_bytes(0));
        std::fs::remove_dir_all(&dir).expect("the directory removed");
        assert_eq!((machine.cpu_limit, spent), (Some(0.5), Some(Spent::Group(2_300_000))), "{machine:?}");
        // The memory's limit is one where the system says how much the machine has, and it is more.
        if std::path::Path::new("/proc/meminfo").exists() {
            assert!(machine.memory_limited && machine.metered, "{machine:?}");
            assert_eq!((machine.memory_bytes, used), (268_435_456, 14_000_000));
        }
        let none = Machine::in_group(None, None);
        assert_eq!((none.cpu_limit, none.memory_limited, none.of_group("cpu.max")), (None, false, None));
    }

    /// A group's limit of more CPUs than the machine has, or than the server is allowed, is read
    /// as no more than either.
    #[test]
    fn a_limit_is_read_as_no_more_than_the_cpus_there_are() {
        let dir = std::env::temp_dir().join(format!("corten-site-wide-group-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a directory to lay the group out in");
        std::fs::write(dir.join("cpu.max"), "409600000 100000\n").expect("a file of the group's");
        let group = || Some(dir.to_string_lossy().into_owned());
        let (machine, allowed_one) = (Machine::in_group(group(), None), Machine::in_group(group(), Some(1)));
        std::fs::remove_dir_all(&dir).expect("the directory removed");
        assert_eq!(allowed_one.cpu_limit, Some(1.0), "{allowed_one:?}");
        let limit = machine.cpu_limit.expect("the limit the group sets");
        // Only a system that counts its CPUs has a count to hold the limit to.
        if machine.stat_cpus > 0 {
            assert!(limit <= machine.stat_cpus as f64 && limit < 4096.0, "{machine:?}");
        } else {
            assert_eq!(limit, 4096.0);
        }
    }

    /// Which count says what is in use follows from the limits the group sets: neither, the
    /// memory's alone, the CPU's alone, or both, and a limit above the machine's memory is none.
    #[test]
    fn a_groups_limits_decide_whose_count_is_read() {
        let meminfo = Some("MemTotal:       12250780 kB\nMemAvailable:   8000000 kB\n");
        let limits = |memory_max, cpu_max| {
            let machine = Machine::counted(8, meminfo, memory_max, cpu_max);
            (machine.memory_bytes, machine.memory_limited, machine.cpu_limit)
        };
        let whole = 12_250_780 << 10;
        assert_eq!(limits(None, None), (whole, false, None));
        assert_eq!(limits(Some("max\n"), Some("max 100000\n")), (whole, false, None));
        assert_eq!(limits(Some("536870912\n"), Some("max 100000\n")), (536_870_912, true, None));
        assert_eq!(limits(Some("max\n"), Some("150000 100000\n")), (whole, false, Some(1.5)));
        assert_eq!(limits(Some("536870912\n"), Some("100000 100000\n")), (536_870_912, true, Some(1.0)));
        assert_eq!(limits(Some("99999999999999\n"), None), (whole, false, None));
        // The limit that is set is the one a reading is taken against.
        let held = Works::on(Machine::counted(8, meminfo, Some("536870912\n"), Some("50000 100000\n")));
        let start = Instant::now();
        let before = Counts { spent: Some(Spent::Group(2_000_000)), ..at(&held, start, 0) };
        let now = Counts { spent: Some(Spent::Group(2_300_000)), ..at(&held, start, 1000) };
        let read = held.read(&Pulse::default(), &before, &now);
        assert_eq!((read.used.cpu, read.used.cpu_own), (Some(60), None));
    }

    /// The stream sends every page the readout the task drew, and a reading before the first is
    /// one too: a page that connects ahead of the first second is sent a whole fragment.
    #[test]
    fn a_reading_is_drawn_once_for_every_page() {
        let works = Works::new();
        let first = works.follow().borrow().clone();
        assert!(first.drawn.starts_with("<dl") && first.drawn.contains(r#"id="readout""#), "{}", first.drawn);
        let start = Instant::now();
        let none = at(&works, start, 0);
        works.rendered(Duration::from_micros(212));
        let sent = Sent::new(works.read(&first.pulse, &none, &at(&works, start, 1000)), works.machine());
        assert!(sent.drawn.contains("212") && sent.pulse.pages == 1, "{}", sent.drawn);
    }

    /// Where the system has a `/proc`, a reading holds memory, the machine has some and says how
    /// much of it and of its CPU is in use; where it has none, all are absent and the page says
    /// nothing of them.
    #[test]
    fn a_reading_holds_what_the_system_says() {
        let works = Works::new();
        let before = works.counts();
        // Long enough for the system's ticks to say something of.
        std::thread::sleep(Duration::from_millis(600));
        let read = works.read(&Pulse::default(), &before, &works.counts());
        let on_linux = std::path::Path::new("/proc/self/status").exists();
        let machine = works.machine();
        assert_eq!(read.held_bytes > 0, on_linux);
        assert_eq!((machine.memory_bytes > 0, machine.metered), (on_linux, on_linux), "{machine:?}");
        assert!(read.held_bytes <= machine.memory_bytes);
        assert_eq!((read.used.memory_bytes > 0, read.used.cpu.is_some()), (on_linux, on_linux), "{:?}", read.used);
        assert!(read.held_bytes <= read.used.memory_bytes || !on_linux, "{read:?}");
        assert!(read.used.memory_bytes <= machine.memory_bytes, "{:?}", read.used);
        // The machine's own count has this server's part, which is never more than the whole; a
        // group's count is the server's already.
        assert_eq!(read.used.cpu_own.is_some(), on_linux && machine.cpu_limit.is_none(), "{:?}", read.used);
        assert!(read.used.cpu_own <= read.used.cpu, "{:?}", read.used);
        let drawn = Sent::new(read, machine).drawn;
        assert_eq!(drawn.contains("<meter"), on_linux, "{drawn}");
    }
}
