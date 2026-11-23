// 1846w's probe: the base's side of probe_wait.rs (1846r2's, with the Attempt the head records).
const HEAD: bool = false;

fn coded(_: usize) -> [OnceLock<Bytes>; 3] {
    Default::default()
}

/// The base has no kept job.
#[allow(clippy::type_complexity)]
fn queue_kept(
    _: &Arc<Entry>,
    _: Arc<Attempt>,
    _: mpsc::Sender<()>,
    _: mpsc::Receiver<()>,
    _: mpsc::Sender<(Instant, Option<Instant>, Instant, &'static str)>,
) -> bool {
    false
}

/// brotli 5 as the head's encode makes it (the same writer and window).
fn encode_kept(body: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut out = Vec::with_capacity(body.len() / 3);
    {
        let mut writer = brotli::CompressorWriter::new(&mut out, 4096, 5, 22);
        writer.write_all(body).unwrap();
    }
    out
}
