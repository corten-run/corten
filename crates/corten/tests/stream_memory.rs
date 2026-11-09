//! What a gzip stream's coder holds stays within what `compress::StreamCoder` reserves for it
//! from the stream budget (`GZIP_STREAM_BYTES`, 360 KiB), so the budget counts every open stream
//! (#1131). It counts every allocation, so it runs in a process of its own with this file's
//! allocator, and is the only test here. The level and the reservation repeat `compress.rs`'s
//! `GZIP_STREAM_LEVEL` and `GZIP_STREAM_BYTES`; a change to either changes both.
#![cfg(feature = "compress")]

use std::alloc::{GlobalAlloc, Layout, System};
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};

const LEVEL: u32 = 3;
const RESERVED: usize = 360 << 10;

static LIVE: AtomicUsize = AtomicUsize::new(0);

struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let at = System.alloc(layout);
        if !at.is_null() {
            LIVE.fetch_add(layout.size(), Ordering::Relaxed);
        }
        at
    }

    unsafe fn dealloc(&self, at: *mut u8, layout: Layout) {
        System.dealloc(at, layout);
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

#[test]
fn a_gzip_streams_context_fits_what_it_reserves() {
    // Events from a 2.7 KB redraw to past deflate's 32 KiB window, made before counting.
    let events: Vec<Vec<u8>> = [2_700, 17_000, 42_000, 200_000, 2_700]
        .iter()
        .enumerate()
        .map(|(i, &len)| (0..len).map(|n| b"<tr><td>ACME</td><td>133.62</td></tr>"[(n + i) % 37]).collect())
        .collect();
    let before = LIVE.load(Ordering::Relaxed);
    let mut coder = Box::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(LEVEL)));
    let mut most = 0;
    for event in &events {
        coder.write_all(event).unwrap();
        coder.flush().unwrap();
        // What the stream sends goes out; what stays is the coder's context.
        drop(std::mem::take(coder.get_mut()));
        most = most.max(LIVE.load(Ordering::Relaxed) - before);
    }
    // The figure design.md (Choice 32) cites:
    // `cargo test -p corten-run --features compress --test stream_memory -- --nocapture`.
    println!("a gzip stream holds {most} bytes of the {RESERVED} it reserves");
    assert!(most <= RESERVED, "a gzip stream holds {most} bytes, more than the {RESERVED} it reserves");
    // And the reservation is not far above it, or the budget turns streams away it could hold.
    assert!(most > RESERVED * 9 / 10, "a gzip stream holds {most} bytes, well under the {RESERVED} it reserves");
}
