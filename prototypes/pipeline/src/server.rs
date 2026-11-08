//! Serving an endpoint over HTTP/1.1 with hyper: the endpoint gets each request as hyper read it,
//! with an empty context. Not what the prototype measures (its counts are in process); here so the
//! prototype answers a real client. Connection limits and graceful shutdown are Corten's, not
//! rebuilt here.

use std::{convert::Infallible, sync::Arc};

use hyper_util::rt::TokioIo;

use crate::{Body, Endpoint};

/// Serves `endpoint` on `listener` until the listener fails.
pub async fn serve<E: Endpoint<()>>(listener: tokio::net::TcpListener, endpoint: E) -> std::io::Result<()> {
    let endpoint = Arc::new(endpoint);
    loop {
        let (tcp, _) = listener.accept().await?;
        let endpoint = endpoint.clone();
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                let endpoint = endpoint.clone();
                async move { Ok::<_, Infallible>(endpoint.call(req.map(Body::incoming), ()).await) }
            });
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(tcp), service).await;
        });
    }
}
