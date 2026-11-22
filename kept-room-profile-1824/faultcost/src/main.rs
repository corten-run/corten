// faultcost: what making anonymous memory resident costs this host, per 4 KiB page, for
// corten-run/corten#1824's kit. Standard library only (libc's mmap, madvise and syscall by
// declaration). Linux x86_64.
//
//   faultcost <mode> <MiB>
//
// Maps <MiB> of private anonymous memory and makes it resident one way, counting only that step:
//   demand    one byte written in each 4 KiB page: a fault a page, as a kept answer's new memory
//   populate  madvise(MADV_POPULATE_WRITE) over the whole range: the same pages in one call
//   thp       2 MiB-aligned, madvise(MADV_HUGEPAGE), then one byte a 4 KiB page: a fault a huge
//             page where the kernel gives one (AnonHugePages says how much it did)
//   touched   made resident first (uncounted), then one byte a page written again: memory the
//             process has touched before, the floor any reuse could reach
// and prints one line:
//   FAULTCOST mode=<m> mib=<n> pages=<4 KiB pages> ns_per_page=<wall> kcycles_per_page=<cycles:k>
//     ucycles_per_page=<cycles:u> minflt_per_page=<minor faults> anon_huge_kb=<AnonHugePages>
// Kernel and user cycles come from perf_event_open on this thread around that step alone (not the
// mmap, the munmap or the exit); where the kernel refuses (perf_event_paranoid), they print as -.
use std::time::Instant;

const PAGE: usize = 4096;
const HUGE: usize = 2 << 20;

extern "C" {
    fn mmap(addr: *mut u8, len: usize, prot: i32, flags: i32, fd: i32, off: i64) -> *mut u8;
    fn munmap(addr: *mut u8, len: usize) -> i32;
    fn madvise(addr: *mut u8, len: usize, advice: i32) -> i32;
    fn syscall(number: i64, ...) -> i64;
    fn ioctl(fd: i32, request: u64, ...) -> i32;
    fn read(fd: i32, buf: *mut u8, count: usize) -> isize;
    fn close(fd: i32) -> i32;
}

const PROT_READ: i32 = 1;
const PROT_WRITE: i32 = 2;
const MAP_PRIVATE: i32 = 2;
const MAP_ANONYMOUS: i32 = 0x20;
const MADV_HUGEPAGE: i32 = 14;
const MADV_NOHUGEPAGE: i32 = 15;
const MADV_POPULATE_WRITE: i32 = 23;
const SYS_PERF_EVENT_OPEN: i64 = 298;
const PERF_EVENT_IOC_ENABLE: u64 = 0x2400;
const PERF_EVENT_IOC_DISABLE: u64 = 0x2401;

/// perf_event_attr as of its first version (64 bytes), which every kernel takes.
#[repr(C)]
struct Attr {
    kind: u32,
    size: u32,
    config: u64,
    sample_period: u64,
    sample_type: u64,
    read_format: u64,
    flags: u64,
    wakeup_events: u32,
    bp_type: u32,
    config1: u64,
}

/// A counter of CPU cycles on this thread, in the kernel (`kernel`) or in user mode, started
/// disabled.
fn counter(kernel: bool) -> Option<i32> {
    const DISABLED: u64 = 1;
    const EXCLUDE_USER: u64 = 1 << 4;
    const EXCLUDE_KERNEL: u64 = 1 << 5;
    const EXCLUDE_HV: u64 = 1 << 6;
    let attr = Attr {
        kind: 0,   // PERF_TYPE_HARDWARE
        size: 64,
        config: 0, // PERF_COUNT_HW_CPU_CYCLES
        sample_period: 0,
        sample_type: 0,
        read_format: 0,
        flags: DISABLED | EXCLUDE_HV | if kernel { EXCLUDE_USER } else { EXCLUDE_KERNEL },
        wakeup_events: 0,
        bp_type: 0,
        config1: 0,
    };
    // SAFETY: a valid attr for the call's lifetime; pid 0 and cpu -1 count this thread anywhere.
    let fd = unsafe { syscall(SYS_PERF_EVENT_OPEN, &attr as *const Attr, 0i32, -1i32, -1i32, 0u64) };
    (fd >= 0).then_some(fd as i32)
}

fn value(fd: Option<i32>) -> Option<u64> {
    let fd = fd?;
    let mut v = [0u8; 8];
    // SAFETY: an open counter's fd and an 8-byte buffer.
    (unsafe { read(fd, v.as_mut_ptr(), 8) } == 8).then(|| u64::from_ne_bytes(v))
}

fn minflt() -> u64 {
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    let rest = stat.rsplit_once(')').map_or("", |(_, rest)| rest);
    rest.split_whitespace().nth(7).and_then(|f| f.parse().ok()).unwrap_or(0)
}

fn anon_huge_kb() -> u64 {
    let s = std::fs::read_to_string("/proc/self/smaps_rollup").unwrap_or_default();
    s.lines().find_map(|l| l.strip_prefix("AnonHugePages:")).and_then(|v| v.trim().trim_end_matches("kB").trim().parse().ok()).unwrap_or(0)
}

fn touch(at: *mut u8, len: usize, value: u8) {
    for page in (0..len).step_by(PAGE) {
        // SAFETY: within a mapping of `len` bytes, writable.
        unsafe { at.add(page).write_volatile(value) };
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let usage = || -> ! {
        eprintln!("usage: faultcost demand|populate|thp|touched <MiB>");
        std::process::exit(2)
    };
    let mode = args.get(1).cloned().unwrap_or_else(|| usage());
    let mib: usize = args.get(2).and_then(|m| m.parse().ok()).unwrap_or_else(|| usage());
    let len = mib << 20;
    // Room to align to 2 MiB for every mode alike.
    let mapped = len + HUGE;
    // SAFETY: a new private anonymous mapping; checked below.
    let raw = unsafe { mmap(std::ptr::null_mut(), mapped, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0) };
    if raw as isize == -1 {
        eprintln!("faultcost: mmap of {mapped} bytes failed");
        std::process::exit(1);
    }
    let at = ((raw as usize + HUGE - 1) & !(HUGE - 1)) as *mut u8;
    // Only thp asks for huge pages; the others say no, so a host whose THP is "always" still
    // measures 4 KiB faults for them.
    let advice = if mode == "thp" { MADV_HUGEPAGE } else { MADV_NOHUGEPAGE };
    // SAFETY: within the mapping.
    if unsafe { madvise(at, len, advice) } != 0 {
        eprintln!("faultcost: madvise {advice} refused");
        std::process::exit(1);
    }
    if mode == "touched" {
        touch(at, len, 1);
    }
    let (k, u) = (counter(true), counter(false));
    let faults = minflt();
    let started = Instant::now();
    for fd in [k, u].into_iter().flatten() {
        // SAFETY: an open counter.
        unsafe { ioctl(fd, PERF_EVENT_IOC_ENABLE, 0) };
    }
    match mode.as_str() {
        "demand" | "thp" => touch(at, len, 1),
        "touched" => touch(at, len, 2),
        "populate" => {
            // SAFETY: within the mapping.
            if unsafe { madvise(at, len, MADV_POPULATE_WRITE) } != 0 {
                eprintln!("faultcost: MADV_POPULATE_WRITE refused (Linux 5.14 or later)");
                std::process::exit(1);
            }
        }
        _ => usage(),
    }
    for fd in [k, u].into_iter().flatten() {
        // SAFETY: an open counter.
        unsafe { ioctl(fd, PERF_EVENT_IOC_DISABLE, 0) };
    }
    let ns = started.elapsed().as_nanos() as f64;
    let faults = minflt() - faults;
    let huge = anon_huge_kb();
    let pages = (len / PAGE) as f64;
    let per = |v: Option<u64>| v.map_or("-".to_owned(), |v| format!("{:.0}", v as f64 / pages));
    println!(
        "FAULTCOST mode={mode} mib={mib} pages={} ns_per_page={:.0} kcycles_per_page={} ucycles_per_page={} minflt_per_page={:.4} anon_huge_kb={huge}",
        len / PAGE,
        ns / pages,
        per(value(k)),
        per(value(u)),
        faults as f64 / pages
    );
    for fd in [k, u].into_iter().flatten() {
        // SAFETY: an open counter, closed once.
        unsafe { close(fd) };
    }
    // SAFETY: the whole mapping, unmapped once.
    unsafe { munmap(raw, mapped) };
}