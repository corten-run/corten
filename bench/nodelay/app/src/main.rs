//! The TCP_NODELAY measurement's app (`bench/nodelay`): `GET /burst/{gap}` is a live stream of
//! ten small events, the first at once and each later one `gap` microseconds after the one before
//! (0: the next turn of the runtime, so each is its own write), each carrying how long after the
//! first it was made. `NODELAY` chooses the sockets: unset, `corten::serve`'s own; `on` or `off`,
//! the same listeners with Nagle's algorithm turned off or left on for each accepted connection,
//! as a listener of the app's own does.
use std::time::{Duration, Instant};

use corten::{LiveResponse, prelude::*};
use futures_util::stream;

/// Events in a burst.
const EVENTS: u32 = 10;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let app = App::new(url::router());
    let nodelay = match std::env::var("NODELAY").as_deref() {
        Ok("on") => true,
        Ok("off") => false,
        _ => return corten::serve(app).await,
    };
    let listeners = corten::listeners(8080).await?.into_iter().map(|listener| Tcp { listener, nodelay }).collect();
    corten::serve_on(listeners, app).await
}

#[corten::routes]
mod url {
    #[route("/burst/{gap}", get = burst)]
    pub struct Burst<'a> {
        pub gap: &'a str,
    }
}

#[derive(Id)]
struct TickId;

/// One event: its number and when it was made, in microseconds after the first.
#[component]
fn Tick(n: u32, sent: u64) -> impl Patch {
    html! { <p id={TickId}>{n}" "{sent}</p> }
}

async fn burst(Params(at): Params<url::Burst<'_>>) -> LiveResponse {
    let gap = Duration::from_micros(at.gap.parse().unwrap_or(0));
    let ticks = stream::unfold((0, None), move |(n, first): (u32, Option<Instant>)| async move {
        if n == EVENTS {
            return None;
        }
        if n > 0 && gap.is_zero() {
            tokio::task::yield_now().await;
        } else if n > 0 {
            tokio::time::sleep(gap).await;
        }
        let now = Instant::now();
        let first = first.unwrap_or(now);
        let sent = now.duration_since(first).as_micros() as u64;
        Some((Tick { n, sent }.to_html(), (n + 1, Some(first))))
    });
    corten::live(ticks)
}

/// A TCP listener that sets `TCP_NODELAY` on each connection it accepts as it was told.
struct Tcp {
    listener: tokio::net::TcpListener,
    nodelay: bool,
}

impl corten::Listener for Tcp {
    type Io = tokio::net::TcpStream;
    type Addr = std::net::SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let (stream, addr) = corten::Listener::accept(&mut self.listener).await;
        if let Err(error) = stream.set_nodelay(self.nodelay) {
            eprintln!("nodelay: setting TCP_NODELAY failed: {error}");
        }
        (stream, addr)
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.listener.local_addr()
    }
}
