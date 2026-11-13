use corten::{prelude::*, LiveResponse};
use futures_util::StreamExt;
use std::{sync::Arc, time::Duration};
use tokio_rustls::{TlsAcceptor, rustls::{self, pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject}}};

#[corten::routes]
mod routes {
    #[route("/events", get = events)]
    pub struct Events { pub n: usize }
    #[route("/quiet", get = quiet)]
    pub struct Quiet;
    #[route("/", get = page)]
    pub struct Home;
}

async fn events(Params(count): Params<routes::Events>) -> LiveResponse {
    corten::live(futures_util::stream::repeat("<p id=\"event\">a fixed fragment for the transport comparison</p>".to_owned()).take(count.n))
}

async fn quiet() -> LiveResponse {
    corten::live(futures_util::stream::pending::<String>())
}

async fn page(req: Req) -> HtmlResult {
    req.page(html! { <!DOCTYPE html><html><head><title>"Transport probe"</title><Corten /></head><body><main><p>"Same page"</p></main></body></html> })
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> std::io::Result<()> {
    let cert = CertificateDer::from_pem_file("/tmp/http2-cert.pem").unwrap();
    let key = PrivateKeyDer::from_pem_file("/tmp/http2-key.pem").unwrap();
    let mut config = rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(vec![cert], key).unwrap();
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let timeout: u64 = std::env::var("TIMEOUT_MS").ok().and_then(|s| s.parse().ok()).unwrap_or(30000);
    let app = App::new(routes::router()).header_timeout(Duration::from_millis(timeout))
        .send_timeout(Duration::from_millis(timeout)).deadline(Duration::from_secs(1)).shutdown_grace(Duration::from_millis(100));
    corten::serve_wrapped(corten::listeners(8080).await?, move |tcp| {
        let acceptor = acceptor.clone();
        async move { acceptor.accept(tcp).await }
    }, app).await
}
