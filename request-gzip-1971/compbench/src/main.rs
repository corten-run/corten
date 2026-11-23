//! Scratch: bytes out and time per call for the ways a complete body could be compressed for a
//! client that accepts `gzip, br`. Usage: compbench <file>... ; `ONLY=<name>` runs one coder a
//! fixed number of times (`CALLS`, default 2,000) so callgrind can count it.
use std::io::Write;
use std::time::Instant;

fn brotli_writer(data: &[u8], quality: u32, lgwin: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() / 3);
    {
        let mut writer = brotli::CompressorWriter::new(&mut out, 4096, quality, lgwin);
        writer.write_all(data).unwrap();
    }
    out
}

fn lgwin_for(len: usize) -> u32 {
    // The smallest window that holds the body (brotli's minimum is 10).
    let mut bits = 10;
    while bits < 22 && (1usize << bits) - 16 < len {
        bits += 1;
    }
    bits
}

fn gzip_miniz(data: &[u8], level: u32) -> Vec<u8> {
    let mut writer = flate2::write::GzEncoder::new(Vec::with_capacity(data.len() / 3), flate2::Compression::new(level));
    writer.write_all(data).unwrap();
    writer.finish().unwrap()
}

thread_local! {
    static MINIZ: std::cell::RefCell<flate2::Compress> = std::cell::RefCell::new(flate2::Compress::new(flate2::Compression::new(1), false));
    static LIBDEFLATE: std::cell::RefCell<libdeflater::Compressor> = std::cell::RefCell::new(libdeflater::Compressor::new(libdeflater::CompressionLvl::new(1).unwrap()));
    static ZSTD: std::cell::RefCell<zstd::bulk::Compressor<'static>> = std::cell::RefCell::new(zstd::bulk::Compressor::new(1).unwrap());
}

const GZIP_HEADER: [u8; 10] = [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff];

fn crc32(data: &[u8]) -> u32 {
    let mut crc = flate2::Crc::new();
    crc.update(data);
    crc.sum()
}

/// gzip around a raw deflate stream from a reused state (miniz_oxide).
fn gzip_miniz_reused(data: &[u8]) -> Vec<u8> {
    MINIZ.with_borrow_mut(|state| {
        state.reset();
        let mut out = Vec::with_capacity(data.len() / 2 + 64);
        out.extend_from_slice(&GZIP_HEADER);
        loop {
            let before = state.total_in() as usize;
            let status = state.compress_vec(&data[before..], &mut out, flate2::FlushCompress::Finish).unwrap();
            if status == flate2::Status::StreamEnd {
                break;
            }
            out.reserve(data.len() / 2 + 64);
        }
        out.extend_from_slice(&crc32(data).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out
    })
}

fn gzip_libdeflate(data: &[u8]) -> Vec<u8> {
    LIBDEFLATE.with_borrow_mut(|state| {
        let mut out = vec![0; state.gzip_compress_bound(data.len())];
        let n = state.gzip_compress(data, &mut out).unwrap();
        out.truncate(n);
        out
    })
}

fn zstd_reused(data: &[u8]) -> Vec<u8> {
    ZSTD.with_borrow_mut(|state| state.compress(data).unwrap())
}

thread_local! {
    static LIBDEFLATE_N: std::cell::RefCell<Vec<Option<libdeflater::Compressor>>> = std::cell::RefCell::new((0..13).map(|_| None).collect());
}

fn gzip_libdeflate_at(data: &[u8], level: i32) -> Vec<u8> {
    LIBDEFLATE_N.with_borrow_mut(|states| {
        let state = states[level as usize].get_or_insert_with(|| libdeflater::Compressor::new(libdeflater::CompressionLvl::new(level).unwrap()));
        let mut out = vec![0; state.gzip_compress_bound(data.len())];
        let n = state.gzip_compress(data, &mut out).unwrap();
        out.truncate(n);
        out.shrink_to_fit();
        out
    })
}

type Coder = (&'static str, fn(&[u8]) -> Vec<u8>);

const CODERS: &[Coder] = &[
    ("brotli1-w22 (now)", |d| brotli_writer(d, 1, 22)),
    ("brotli1-fit", |d| brotli_writer(d, 1, lgwin_for(d.len()))),
    ("brotli0-fit", |d| brotli_writer(d, 0, lgwin_for(d.len()))),
    ("brotli2-fit", |d| brotli_writer(d, 2, lgwin_for(d.len()))),
    ("brotli4-fit", |d| brotli_writer(d, 4, lgwin_for(d.len()))),
    ("gzip1-flate2 (now)", |d| gzip_miniz(d, 1)),
    ("gzip2-flate2", |d| gzip_miniz(d, 2)),
    ("gzip3-flate2", |d| gzip_miniz(d, 3)),
    ("gzip4-flate2", |d| gzip_miniz(d, 4)),
    ("gzip5-flate2", |d| gzip_miniz(d, 5)),
    ("gzip6-flate2", |d| gzip_miniz(d, 6)),
    ("gzip1-flate2-reused", gzip_miniz_reused),
    ("gzip1-libdeflate", gzip_libdeflate),
    ("gzip1-libdeflate-fit", |d| gzip_libdeflate_at(d, 1)),
    ("gzip2-libdeflate-fit", |d| gzip_libdeflate_at(d, 2)),
    ("gzip3-libdeflate-fit", |d| gzip_libdeflate_at(d, 3)),
    ("gzip4-libdeflate-fit", |d| gzip_libdeflate_at(d, 4)),
    ("gzip6-libdeflate-fit", |d| gzip_libdeflate_at(d, 6)),
    ("zstd1-reused (now)", zstd_reused),
];

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct Mallinfo2 { arena: usize, ordblks: usize, smblks: usize, hblks: usize, hblkhd: usize, usmblks: usize, fsmblks: usize, uordblks: usize, fordblks: usize, keepcost: usize }
extern "C" { fn mallinfo2() -> Mallinfo2; }

fn held() -> usize {
    let info = unsafe { mallinfo2() };
    info.uordblks + info.hblkhd
}

fn main() {
    if std::env::var("MEM").is_ok() {
        for level in [1, 6] {
            let before = held();
            let state = libdeflater::Compressor::new(libdeflater::CompressionLvl::new(level).unwrap());
            println!("libdeflate level {level} compressor holds {} bytes (glibc mallinfo2)", held() - before);
            std::mem::forget(state);
        }
        let before = held();
        let state = zstd::bulk::Compressor::new(1).unwrap();
        let mut state = state;
        let _ = state.compress(&vec![b'a'; 10_000]).unwrap();
        println!("zstd level 1 compressor after one 10 KB body holds {} bytes", held() - before);
        std::mem::forget(state);
        return;
    }
    let files: Vec<String> = std::env::args().skip(1).collect();
    if std::env::var("PREFIXES").is_ok() {
        // Bytes out for the first N bytes of each file: where libdeflate 1 stops being smaller than brotli 1.
        println!("{:<28} {:>7} {:>8} {:>8} {:>8} {:>8}  ld1/br1", "file", "bytes", "brotli1", "ld1", "flate2-1", "zstd1");
        for file in &files {
            let data = std::fs::read(file).unwrap();
            let mut sizes: Vec<usize> = [1024, 1536, 2048, 3072, 4096, 6144, 8192, 10240, 12288, 16384, 20480, 24576, 32768, 49152, 65536, 98304, 131072].into_iter().filter(|n| *n < data.len()).collect();
            sizes.push(data.len());
            let name = file.rsplit('/').next().unwrap();
            for n in sizes {
                let part = &data[..n];
                let (br, ld, fl, zs) = (brotli_writer(part, 1, 22).len(), gzip_libdeflate(part).len(), gzip_miniz(part, 1).len(), zstd_reused(part).len());
                println!("{name:<28} {n:>7} {br:>8} {ld:>8} {fl:>8} {zs:>8}  {:+.1}%", (ld as f64 / br as f64 - 1.0) * 100.0);
            }
        }
        return;
    }
    let only = std::env::var("ONLY").ok();
    let calls: usize = std::env::var("CALLS").ok().and_then(|n| n.parse().ok()).unwrap_or(2_000);
    for file in &files {
        let data = std::fs::read(file).unwrap();
        if let Some(only) = &only {
            let (_, coder) = CODERS.iter().find(|(name, _)| name.starts_with(only.as_str())).expect("a coder");
            let mut total = 0;
            for _ in 0..calls {
                total += coder(std::hint::black_box(&data)).len();
            }
            println!("{file} {only} calls={calls} bytes={}", total / calls.max(1));
            continue;
        }
        println!("== {file}: {} bytes (flate2 backend: {})", data.len(), if cfg!(feature = "zlibrs") { "zlib-rs" } else { "miniz_oxide" });
        for (name, coder) in CODERS {
            let size = coder(&data).len();
            for _ in 0..200 {
                std::hint::black_box(coder(std::hint::black_box(&data)));
            }
            let mut best = u128::MAX;
            for _ in 0..7 {
                let start = Instant::now();
                for _ in 0..2_000 {
                    std::hint::black_box(coder(std::hint::black_box(&data)));
                }
                best = best.min(start.elapsed().as_nanos() / 2_000);
            }
            println!("  {name:<22} {size:>6} bytes  {best:>8} ns/call (best of 7 x 2,000)");
        }
    }
}
