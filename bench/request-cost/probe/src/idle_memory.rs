//! Idle-only jemalloc observations on the probe's serving thread.
use std::ffi::{CStr, c_char, c_int, c_void};
use std::io::{self, Write};
use std::mem::size_of;
use std::ptr::null_mut;
use std::time::Instant;
use tokio::signal::unix::{SignalKind, signal};

type Mallctl = unsafe extern "C" fn(*const c_char, *mut c_void, *mut usize, *mut c_void, usize) -> c_int;
const IDLE_FRAME: &str = "IDLE_ALLOCATOR";

unsafe extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

fn mallctl() -> io::Result<Mallctl> {
    // SAFETY: on Linux RTLD_DEFAULT is null; the symbol name is NUL terminated. The probe
    // preloads jemalloc for idle runs, and its mallctl has the signature above.
    let symbol = unsafe { dlsym(null_mut(), c"mallctl".as_ptr()) };
    if symbol.is_null() {
        return Err(io::Error::other("jemalloc does not export mallctl"));
    }
    // SAFETY: this is the process's non-null mallctl symbol, which stays loaded.
    Ok(unsafe { std::mem::transmute::<*mut c_void, Mallctl>(symbol) })
}

fn checked(name: &CStr, code: c_int) -> io::Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::other(format!("mallctl {}: {}", name.to_string_lossy(), io::Error::from_raw_os_error(code))))
    }
}

// SAFETY: T must be the documented integer type of the named mallctl counter.
unsafe fn read<T: Default>(ctl: Mallctl, name: &CStr) -> io::Result<T> {
    let mut value = T::default();
    let mut size = size_of::<T>();
    // SAFETY: the buffer and its length are writable for the call; no new value is provided.
    let code = unsafe { ctl(name.as_ptr(), (&mut value as *mut T).cast(), &mut size, null_mut(), 0) };
    checked(name, code)?;
    Ok(value)
}

fn sample(ctl: Mallctl, mut output: impl Write) -> io::Result<()> {
    let began = Instant::now();
    let mut epoch = 1u64;
    // SAFETY: epoch takes a uint64_t input and does not require an output buffer.
    let code = unsafe { ctl(c"epoch".as_ptr(), null_mut(), null_mut(), (&mut epoch as *mut u64).cast(), size_of::<u64>()) };
    checked(c"epoch", code)?;
    // 4096 is MALLCTL_ARENAS_ALL. In jemalloc 5.3.0, allocated includes cached regions.
    // SAFETY: process/arena sizes use size_t, and thread byte counters use uint64_t.
    let (allocated, cached, thread_allocated, thread_deallocated, active) = unsafe {
        (
            read::<usize>(ctl, c"stats.allocated")?,
            read::<usize>(ctl, c"stats.arenas.4096.tcache_bytes")?,
            read::<u64>(ctl, c"thread.allocated")?,
            read::<u64>(ctl, c"thread.deallocated")?,
            read::<usize>(ctl, c"stats.active")?,
        )
    };
    let live = allocated.checked_sub(cached).ok_or_else(|| io::Error::other("jemalloc cached bytes exceed allocated bytes"))?;
    let thread_net = i128::from(thread_allocated) - i128::from(thread_deallocated);
    let nanos = began.elapsed().as_nanos();
    writeln!(output, "{IDLE_FRAME} {{\"live\":{live},\"threadNet\":{thread_net},\"active\":{active},\"nanos\":{nanos}}}")
}

pub fn start() -> io::Result<()> {
    let ctl = mallctl()?;
    let mut requests = signal(SignalKind::user_defined1())?;
    // Handle the signal on the current-thread runtime, not in the signal handler or on a worker.
    tokio::spawn(async move {
        while requests.recv().await.is_some() {
            if let Err(error) = sample(ctl, io::stdout().lock()) {
                eprintln!("idle memory: {error}");
                // Signal failure to the reader without giving the run a partial sample.
                let _ = writeln!(io::stdout().lock(), "{IDLE_FRAME} null");
                break;
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    thread_local! { static REFRESHED: Cell<bool> = const { Cell::new(false) }; }

    unsafe extern "C" fn counters(
        name: *const c_char,
        out: *mut c_void,
        size: *mut usize,
        input: *mut c_void,
        len: usize,
    ) -> c_int {
        // SAFETY: sample passes C string literals and buffers of the declared types.
        unsafe {
            let name = CStr::from_ptr(name).to_bytes();
            if name == b"epoch" && len == size_of::<u64>() && !input.is_null() && *input.cast::<u64>() == 1 {
                REFRESHED.set(true);
                return 0;
            }
            if !REFRESHED.get() || out.is_null() || size.is_null() || !input.is_null() {
                return 22;
            }
            match name {
                b"stats.allocated" if *size == size_of::<usize>() => out.cast::<usize>().write(8192),
                b"stats.arenas.4096.tcache_bytes" if *size == size_of::<usize>() => out.cast::<usize>().write(321),
                b"thread.allocated" if *size == size_of::<u64>() => out.cast::<u64>().write(470),
                b"thread.deallocated" if *size == size_of::<u64>() => out.cast::<u64>().write(479),
                b"stats.active" if *size == size_of::<usize>() => out.cast::<usize>().write(12_288),
                _ => return 22,
            }
            0
        }
    }

    #[test]
    fn sample_refreshes_and_subtracts_cached_regions_and_thread_frees() {
        let mut line = Vec::new();
        sample(counters, &mut line).unwrap();
        let line = std::str::from_utf8(&line).unwrap();
        let nanos = line
            .strip_prefix("IDLE_ALLOCATOR {\"live\":7871,\"threadNet\":-9,\"active\":12288,\"nanos\":")
            .unwrap()
            .strip_suffix("}\n")
            .unwrap();
        assert!(nanos.parse::<u128>().is_ok());
    }
}
