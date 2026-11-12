//! What this server knows about itself: how long it has been up, the pages it has rendered and
//! how long the last one took, the plates struck, how many pages are following along, and, where
//! the operating system says (Linux), the memory it holds and the machine it is on. A task
//! reads it once a second into a `watch` channel, and every open page's `<corten-live>` follows
//! that channel (`corten::live_watch`). Nothing here is made up for show: each number is counted.
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
    /// The last page's render, in microseconds; 0 before the first.
    pub render_micros: u64,
    pub plates: u64,
    /// Pages following the stream right now.
    pub followers: u64,
    /// The memory this process holds (its resident set), in bytes; 0 where it cannot be read.
    pub held_bytes: u64,
    pub moved: Moved,
}

/// The machine the server runs on, read once when it starts: what the operating system counts,
/// so the page states its host without anyone typing the numbers in.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Machine {
    /// The CPUs this process may use; 0 where the system does not say.
    pub cpus: usize,
    /// The memory this server may use, in bytes: the machine's, or the limit its container sets
    /// where that is less; 0 where it cannot be read.
    pub memory_bytes: u64,
    /// What whoever runs it calls it (`CORTEN_SITE_MACHINE`): a size and a price, say.
    pub named: Option<String>,
}

impl Machine {
    fn read() -> Self {
        Machine {
            cpus: std::thread::available_parallelism().map_or(0, usize::from),
            memory_bytes: memory_bytes(
                std::fs::read_to_string("/proc/meminfo").ok().as_deref(),
                std::fs::read_to_string("/sys/fs/cgroup/memory.max").ok().as_deref(),
            ),
            named: std::env::var("CORTEN_SITE_MACHINE")
                .ok()
                .map(|named| named.trim().to_string())
                .filter(|named| !named.is_empty()),
        }
    }
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
    std::fs::read_to_string("/proc/self/status").ok().and_then(|text| kib(&text, "VmRSS")).map_or(0, |kib| kib << 10)
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
    fn new(pulse: Pulse) -> Self {
        let drawn = Readout { pulse: &pulse }.to_html().into();
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
        let binary_bytes = std::env::current_exe().and_then(std::fs::metadata).map_or(0, |file| file.len());
        Works(Arc::new(Counted {
            started: Instant::now(),
            pages: AtomicU64::new(0),
            render_micros: AtomicU64::new(0),
            plates: AtomicU64::new(0),
            pulse: watch::Sender::new(Sent::new(Pulse::default())),
            binary_bytes,
            machine: Machine::read(),
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

    /// The readings as they come, for a page's stream.
    pub fn follow(&self) -> watch::Receiver<Sent> {
        self.0.pulse.subscribe()
    }

    /// The server as it is now, with what moved since `last`.
    fn read(&self, last: &Pulse) -> Pulse {
        let pages = self.0.pages.load(Ordering::Relaxed);
        let render_micros = self.0.render_micros.load(Ordering::Relaxed);
        let plates = self.0.plates.load(Ordering::Relaxed);
        let followers = self.0.pulse.receiver_count() as u64;
        Pulse {
            beat: self.0.started.elapsed().as_secs(),
            pages,
            render_micros,
            plates,
            followers,
            held_bytes: held_bytes(),
            moved: Moved {
                pages: pages != last.pages,
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
        loop {
            tokio::select! {
                biased;
                _ = signal.aborted() => return,
                _ = tick.tick() => {
                    let next = self.read(&self.0.pulse.borrow().pulse);
                    self.0.pulse.send_replace(Sent::new(next));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reading_says_what_moved() {
        let works = Works::new();
        let first = works.read(&Pulse::default());
        assert!(!first.moved.pages && !first.moved.plates);
        works.rendered(Duration::from_micros(212));
        assert_eq!(works.struck(), 1);
        let second = works.read(&first);
        assert_eq!((second.pages, second.render_micros, second.plates), (1, 212, 1));
        assert!(second.moved.pages && second.moved.render && second.moved.plates && !second.moved.followers);
    }

    #[test]
    fn the_systems_own_lines_are_read() {
        let status = "Name:\tcorten-site\nVmHWM:\t   10112 kB\nVmRSS:\t    9268 kB\nRssAnon:\t    4100 kB\n";
        assert_eq!(kib(status, "VmRSS"), Some(9268));
        assert_eq!(kib("MemTotal:         468428 kB\nMemFree:  1 kB\n", "MemTotal"), Some(468_428));
        assert_eq!(kib(status, "Vm"), None);
        assert_eq!(kib("VmRSS: lots\n", "VmRSS"), None);
        // The machine's memory, or its container's limit where that is less.
        let meminfo = "MemTotal:       12250780 kB\nMemFree: 1 kB\n";
        assert_eq!(memory_bytes(Some(meminfo), Some("max\n")), 12_250_780 << 10);
        assert_eq!(memory_bytes(Some(meminfo), Some("536870912\n")), 536_870_912);
        assert_eq!(memory_bytes(Some(meminfo), None), 12_250_780 << 10);
        assert_eq!(memory_bytes(None, Some("536870912\n")), 0);
    }

    /// The stream sends every page the readout the task drew, and a reading before the first is
    /// one too: a page that connects ahead of the first second is sent a whole fragment.
    #[test]
    fn a_reading_is_drawn_once_for_every_page() {
        let works = Works::new();
        let first = works.follow().borrow().clone();
        assert!(first.drawn.starts_with("<dl") && first.drawn.contains(r#"id="readout""#), "{}", first.drawn);
        works.rendered(Duration::from_micros(212));
        let sent = Sent::new(works.read(&first.pulse));
        assert!(sent.drawn.contains("212") && sent.pulse.pages == 1, "{}", sent.drawn);
    }

    /// Where the system has a `/proc`, a reading holds memory and the machine has some; where it
    /// has none, both are 0 and the page says nothing of either.
    #[test]
    fn a_reading_holds_what_the_system_says() {
        let works = Works::new();
        let held = works.read(&Pulse::default()).held_bytes;
        let on_linux = std::path::Path::new("/proc/self/status").exists();
        assert_eq!(held > 0, on_linux);
        assert_eq!(works.machine().memory_bytes > 0, on_linux);
        assert!(held <= works.machine().memory_bytes);
    }
}
