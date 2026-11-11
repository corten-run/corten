//! [`Listener`]: what [`crate::serve_on`] accepts connections from.

use std::{future::Future, io, time::Duration};

use tokio::io::{AsyncRead, AsyncWrite};

/// What [`crate::serve_on`] serves on besides the TCP sockets [`crate::listeners`] binds: a Unix
/// socket, a socket a supervisor hands over, or a listener of the app's own. A connection's
/// [`ClientIp`](crate::ClientIp) is its `Addr` when that is a `SocketAddr`. Tokio's
/// `TcpListener`, as a `Listener`, accepts each connection with Nagle's algorithm off
/// (`TCP_NODELAY`); a listener of the app's own sets what it chooses.
pub trait Listener: Send + 'static {
    /// A connection.
    type Io: AsyncRead + AsyncWrite + Unpin + Send + 'static;

    /// Where a connection comes from.
    type Addr: Send;

    /// The next connection. An error accepting one is the listener's to handle (log it and try
    /// again): `accept` returns only a connection.
    fn accept(&mut self) -> impl Future<Output = (Self::Io, Self::Addr)> + Send;

    /// The address it listens on.
    fn local_addr(&self) -> io::Result<Self::Addr>;
}

impl Listener for tokio::net::TcpListener {
    type Io = tokio::net::TcpStream;
    type Addr = std::net::SocketAddr;

    /// The next connection, with `TCP_NODELAY` set, as Go's `net/http` and nginx set it: a
    /// streamed answer's small writes (a feed's patches, a live element's fragments) then go out as
    /// they are made, where with Nagle's algorithm one written while the last is unacknowledged
    /// waited for the other end's delayed acknowledgement, about 40 ms behind nginx on Linux
    /// (`docs/design.md#choice-tcp-nodelay`). A connection the option cannot be set on is served
    /// as it is.
    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            match tokio::net::TcpListener::accept(self).await {
                Ok((stream, addr)) => {
                    let _ = stream.set_nodelay(true);
                    return (stream, addr);
                }
                Err(error) => failed(error).await,
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        tokio::net::TcpListener::local_addr(self)
    }
}

#[cfg(unix)]
impl Listener for tokio::net::UnixListener {
    type Io = tokio::net::UnixStream;
    type Addr = tokio::net::unix::SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            match tokio::net::UnixListener::accept(self).await {
                Ok(accepted) => return accepted,
                Err(error) => failed(error).await,
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        tokio::net::UnixListener::local_addr(self)
    }
}

/// An accept that failed: a connection the client gave up on before it was accepted is skipped;
/// anything else (out of file descriptors, say) is logged, and the next accept waits a second, so
/// connections closing meanwhile can free what it needs.
async fn failed(error: io::Error) {
    use io::ErrorKind::{ConnectionAborted, ConnectionRefused, ConnectionReset};
    if matches!(error.kind(), ConnectionRefused | ConnectionAborted | ConnectionReset) {
        return;
    }
    tracing::error!("corten: accepting a connection failed, trying again in a second: {error}");
    tokio::time::sleep(Duration::from_secs(1)).await;
}
