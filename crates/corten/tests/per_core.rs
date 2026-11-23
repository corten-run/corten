//! `App::per_core` through what an app writes, against a real server, in a process of its own
//! (the shutdown it begins is the process's): `serve_on` with a listener for each core that share
//! a port serves each connection on a core's event loop, and one `corten::shutdown` ends live
//! streams on every core, tells the app's task, lets requests in progress finish and returns.
//! Linux only, where the setting has an effect.
#![cfg(target_os = "linux")]

use std::{collections::BTreeSet, net::SocketAddr, time::Duration};

use corten::{http::StatusCode, Abort, App, Signal};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpSocket, TcpStream},
    sync::mpsc,
};

#[corten::routes]
mod url {
    #[route("/stop", post = stop)]
    pub struct Stop;

    #[route("/live", get = stream)]
    pub struct Live;

    #[route("/slow", get = slow)]
    pub struct Slow;
}

async fn stop() -> StatusCode {
    corten::shutdown();
    StatusCode::ACCEPTED
}

/// A live stream that would never end by itself.
async fn stream() -> corten::LiveResponse {
    corten::live(futures_util::stream::pending::<String>())
}

/// A request still in progress when the shutdown begins, which answers the thread it ran on.
async fn slow() -> String {
    tokio::time::sleep(Duration::from_millis(500)).await;
    std::thread::current().name().unwrap_or("unnamed").to_string()
}

/// A listener for each core on one free port of `127.0.0.1`, as an app makes them for
/// `App::per_core`.
fn shared() -> Vec<TcpListener> {
    let cores = std::thread::available_parallelism().map_or(1, |cores| cores.get());
    let mut listeners: Vec<TcpListener> = Vec::new();
    for _ in 0..cores {
        let socket = TcpSocket::new_v4().unwrap();
        socket.set_reuseaddr(true).unwrap();
        socket.set_reuseport(true).unwrap();
        let addr = listeners.first().map_or_else(|| ([127, 0, 0, 1], 0).into(), |first| first.local_addr().unwrap());
        socket.bind(addr).unwrap();
        listeners.push(socket.listen(511).unwrap());
    }
    listeners
}

async fn send(addr: SocketAddr, request: &str) -> TcpStream {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    stream
}

async fn head(stream: &mut TcpStream) -> String {
    let mut head = [0u8; 12];
    stream.read_exact(&mut head).await.unwrap();
    String::from_utf8_lossy(&head).into_owned()
}

#[tokio::test]
async fn one_shutdown_ends_a_server_served_per_core() {
    let listeners = shared();
    let (cores, addr) = (listeners.len(), listeners[0].local_addr().unwrap());
    let (told, mut heard) = mpsc::unbounded_channel();
    let app = App::new(url::router()).per_core().task("watch", move |signal: Signal| async move {
        let _ = told.send(signal.aborted().await);
    });
    let server = tokio::spawn(corten::serve_on(listeners, app));

    let mut live = Vec::new();
    let mut slow = Vec::new();
    for _ in 0..16 {
        let mut stream = send(addr, "GET /live HTTP/1.1\r\nhost: localhost\r\n\r\n").await;
        assert_eq!(head(&mut stream).await, "HTTP/1.1 200");
        live.push(stream);
        slow.push(send(addr, "GET /slow HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n").await);
    }
    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut asked = send(addr, "POST /stop HTTP/1.1\r\nhost: localhost\r\ncontent-length: 0\r\n\r\n").await;
    assert_eq!(head(&mut asked).await, "HTTP/1.1 202", "the route that asks is answered");

    let told = tokio::time::timeout(Duration::from_secs(5), heard.recv()).await.expect("the task was not told");
    assert_eq!(told, Some(Abort::Shutdown));
    for mut live in live {
        let mut rest = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), live.read_to_end(&mut rest))
            .await
            .expect("a live stream did not end")
            .unwrap();
    }
    let mut on = BTreeSet::new();
    for mut slow in slow {
        let mut answer = String::new();
        tokio::time::timeout(Duration::from_secs(5), slow.read_to_string(&mut answer)).await.expect("a slow request").unwrap();
        let thread = answer.rsplit("\r\n\r\n").next().unwrap();
        assert!(answer.starts_with("HTTP/1.1 200") && thread.starts_with("corten-core-"), "a request in progress finishes: {answer}");
        on.insert(thread.to_string());
    }
    assert!(cores == 1 || on.len() > 1, "16 requests on {cores} cores all ran on one: {on:?}");
    tokio::time::timeout(Duration::from_secs(5), server).await.expect("serve_on did not return").unwrap().unwrap();
    assert!(TcpStream::connect(addr).await.is_err(), "a core's listener is still open");
}
