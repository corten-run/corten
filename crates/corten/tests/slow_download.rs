//! A download whose client reads it slowly but steadily is not cut by the header timeout, which
//! bounds only what comes before a request (#1746). hyper takes a whole body at once, long before
//! its bytes are sent, so the idle time starts once they have gone to the socket, not then.

use std::time::{Duration, Instant};

use corten::prelude::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const BODY: usize = 2 << 20;

#[corten::routes]
mod url {
    #[route("/big", get = big)]
    pub struct Big;
}

async fn big() -> corten::Media {
    corten::Media::new("application/octet-stream", vec![b'x'; BODY])
}

/// A listener whose connections have a small send buffer, so most of the answer waits in hyper's
/// buffer after it has taken the body.
fn listener() -> tokio::net::TcpListener {
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_send_buffer_size(16 * 1024).unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    socket.listen(16).unwrap()
}

/// Reads the answer 16 KiB every 10 ms through a small receive buffer: over a second in all, a few
/// header timeouts. Returns the bytes read and the connection.
async fn read_slowly(addr: std::net::SocketAddr) -> (usize, tokio::net::TcpStream) {
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_recv_buffer_size(16 * 1024).unwrap();
    let mut stream = socket.connect(addr).await.unwrap();
    stream.write_all(b"GET /big HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
    let (mut got, mut buf) = (0, vec![0u8; 16 * 1024]);
    while got < BODY {
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf)).await.expect("the server sends");
        let read = read.unwrap_or(0);
        if read == 0 {
            break;
        }
        got += read;
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    (got, stream)
}

#[tokio::test]
async fn a_slow_steady_download_outlasts_the_header_timeout_and_the_connection_then_goes_idle() {
    for send in [Some(Duration::from_millis(300)), None] {
        let listener = listener();
        let addr = listener.local_addr().unwrap();
        let app = App::new(url::router()).header_timeout(Duration::from_millis(300)).send_timeout(send);
        let server = tokio::spawn(corten::serve_on(vec![listener], app));
        let started = Instant::now();
        let (got, mut stream) = read_slowly(addr).await;
        let took = started.elapsed();
        assert!(got >= BODY, "send timeout {send:?}: the reader got {got} of over {BODY} bytes in {took:?}");
        assert!(took > Duration::from_millis(900), "the download outlasted the header timeout: {took:?}");
        // Once sent, the connection is idle and the header timeout closes it.
        let mut rest = Vec::new();
        let closed = tokio::time::timeout(Duration::from_secs(3), stream.read_to_end(&mut rest)).await;
        assert!(closed.is_ok(), "send timeout {send:?}: an idle connection is closed after the header timeout");
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
    }
}
