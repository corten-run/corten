//! A download whose client reads it slowly but steadily is not cut by the header timeout, which
//! bounds only what comes before a request (#1746). hyper takes a whole body at once, long before
//! its bytes are sent, so the idle time starts once they have gone to the socket, not then. After
//! the download the connection still answers the next request, and once idle it is closed by the
//! header timeout.

use std::time::{Duration, Instant};

use corten::prelude::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// 4 MiB: at the reader's pace below, over 2.4 s, more than twice the header timeout.
const BODY: usize = 4 << 20;
const HEADER: Duration = Duration::from_secs(1);
/// What the reader takes without pausing at the end, so its last byte comes soon after the
/// server's last write.
const TAIL: usize = 256 << 10;

/// The answer's byte at `at`: not all one value, so a cut, a gap or a repeat shows.
fn byte(at: usize) -> u8 {
    (at % 251) as u8
}

/// The whole answer, built once: comparing with it is one `memcmp`, so checking one download's
/// bytes does not hold up the other readers on the test's task.
static EXPECTED: std::sync::LazyLock<Vec<u8>> = std::sync::LazyLock::new(|| (0..BODY).map(byte).collect());

#[corten::routes]
mod url {
    #[route("/big", get = big)]
    pub struct Big;
    #[route("/small", get = small)]
    pub struct Small;
}

async fn big() -> corten::Media {
    corten::Media::new("application/octet-stream", EXPECTED.clone())
}

async fn small() -> &'static str {
    "small"
}

/// A listener whose connections have a small send buffer, so most of the answer waits in hyper's
/// buffer after it has taken the body.
fn listener() -> tokio::net::TcpListener {
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_send_buffer_size(16 * 1024).unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    socket.listen(16).unwrap()
}

/// A connection with a small receive buffer, so the reader's pace is what the server sees.
async fn connect(addr: std::net::SocketAddr) -> TcpStream {
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_recv_buffer_size(16 * 1024).unwrap();
    socket.connect(addr).await.unwrap()
}

/// Sends `GET path` and reads the answer's head; returns it and the body's bytes that came with it.
async fn request(stream: &mut TcpStream, path: &str) -> (String, Vec<u8>) {
    stream.write_all(format!("GET {path} HTTP/1.1\r\nhost: localhost\r\n\r\n").as_bytes()).await.unwrap();
    let (mut got, mut buf) = (Vec::new(), [0u8; 1024]);
    loop {
        if let Some(end) = got.windows(4).position(|w| w == b"\r\n\r\n") {
            let body = got.split_off(end + 4);
            return (String::from_utf8(got).unwrap(), body);
        }
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf)).await.expect("the server answers");
        let read = read.unwrap_or_else(|e| panic!("GET {path}: the connection failed before the head: {e}"));
        assert_ne!(read, 0, "GET {path}: the connection closed before the head");
        got.extend_from_slice(&buf[..read]);
    }
}

/// Downloads `/big`, 16 KiB every 10 ms but for the last [`TAIL`], and checks it arrived whole and
/// byte-exact. Returns when its last byte arrived.
async fn download(stream: &mut TcpStream, what: &str) -> Instant {
    let started = Instant::now();
    let (head, mut body) = request(stream, "/big").await;
    assert!(head.starts_with("HTTP/1.1 200 "), "{what}: {head}");
    assert!(head.to_ascii_lowercase().contains(&format!("\r\ncontent-length: {BODY}\r\n")), "{what}: {head}");
    let (mut buf, mut ended) = (vec![0u8; 16 * 1024], String::new());
    while body.len() < BODY {
        // Never past the body, so the next answer on the connection is left for its request.
        let want = (BODY - body.len()).min(buf.len());
        match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf[..want])).await {
            Err(_) => ended = "no byte for 5 s".into(),
            Ok(Ok(0)) => ended = "closed".into(),
            Ok(Err(e)) => ended = format!("failed: {e}"),
            Ok(Ok(read)) => body.extend_from_slice(&buf[..read]),
        }
        if !ended.is_empty() {
            break;
        }
        if BODY - body.len() > TAIL {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    let (last, took) = (Instant::now(), started.elapsed());
    assert!(body.len() == BODY, "{what}: the reader got {} of {BODY} body bytes in {took:?}, {ended}", body.len());
    if body != *EXPECTED {
        let at = body.iter().zip(EXPECTED.iter()).position(|(a, b)| a != b).unwrap_or(BODY);
        panic!("{what}: the body differs from what was sent at byte {at}");
    }
    // The pace alone takes over 2.4 s, so this holds however slow the machine.
    assert!(took > 2 * HEADER, "{what}: the download outlasted the header timeout: {took:?}");
    last
}

/// Waits for the server to close `stream`, idle since `last`, its last answer's last byte: with a
/// close, which a read sees as the end (0 bytes, the server's FIN), not a reset, which a read sees
/// as an error (`ConnectionReset`), and not before about the header timeout has run. The idle time
/// starts when the last bytes reach the server's socket, a little before the client reads them,
/// and from the clock's last tick, a tenth of the timeout before and more if its thread is
/// starved: half the timeout leaves room for both and still fails a close that follows the answer.
async fn closes_idle(mut stream: TcpStream, last: Instant, what: &str) {
    let mut buf = [0u8; 64];
    let read = tokio::time::timeout(10 * HEADER, stream.read(&mut buf)).await;
    let after = last.elapsed();
    match read {
        Err(_) => panic!("{what}: still open {after:?} after the last answer"),
        Ok(Err(e)) => panic!("{what}: reset ({e}), not closed, {after:?} after the last answer"),
        Ok(Ok(0)) => {}
        Ok(Ok(read)) => panic!("{what}: {read} bytes more than the answers"),
    }
    assert!(after >= HEADER / 2, "{what}: closed {after:?} after the last answer, before the header timeout ({HEADER:?})");
}

/// The download's connection, then idle: closed by the header timeout, counted from its last byte.
async fn then_idle(addr: std::net::SocketAddr, what: &str) {
    let mut stream = connect(addr).await;
    let last = download(&mut stream, what).await;
    closes_idle(stream, last, what).await;
}

/// The download's connection, then a request at once: answered, then closed once idle.
async fn then_another(addr: std::net::SocketAddr, what: &str) {
    let mut stream = connect(addr).await;
    download(&mut stream, what).await;
    let (head, mut body) = request(&mut stream, "/small").await;
    assert!(head.starts_with("HTTP/1.1 200 "), "{what}: the next request on the connection is answered: {head}");
    while body.len() < 5 {
        let mut buf = [0u8; 64];
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf)).await.expect("the server sends");
        let read = read.unwrap();
        assert_ne!(read, 0, "{what}: closed during the next answer");
        body.extend_from_slice(&buf[..read]);
    }
    assert_eq!(body, b"small", "{what}");
    closes_idle(stream, Instant::now(), what).await;
}

/// Each `send_timeout`, with a download on one connection left idle and one followed by another
/// request, all at once. The send timeout is long enough that a busy machine's pauses between the
/// reader's reads do not trip it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slow_steady_download_outlasts_the_header_timeout_and_the_connection_then_goes_idle() {
    let case = |send: Option<Duration>| async move {
        let listener = listener();
        let addr = listener.local_addr().unwrap();
        let app = App::new(url::router()).header_timeout(HEADER).send_timeout(send);
        let server = tokio::spawn(corten::serve_on(vec![listener], app));
        let idle = format!("send timeout {send:?}, then idle");
        let another = format!("send timeout {send:?}, then another request");
        tokio::join!(then_idle(addr, &idle), then_another(addr, &another));
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
    };
    tokio::join!(case(Some(Duration::from_secs(2))), case(None));
}
