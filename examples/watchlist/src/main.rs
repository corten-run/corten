mod account;
mod alerts;
mod app;
mod home;
mod layout;
mod lists;
mod market;
mod news;
mod recent;
mod smoke;
mod socket;
#[cfg(test)]
mod testing;
mod theme;
mod visitor;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    #[cfg(feature = "http2-prototype")]
    {
        use tokio_rustls::rustls::{self, pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject}};
        let cert = CertificateDer::from_pem_file("/tmp/http2-cert.pem").unwrap();
        let key = PrivateKeyDer::from_pem_file("/tmp/http2-key.pem").unwrap();
        let mut config = rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(vec![cert], key).unwrap();
        config.alpn_protocols = if std::env::var_os("HTTP1_ONLY").is_some() {
            vec![b"http/1.1".to_vec()]
        } else {
            vec![b"h2".to_vec(), b"http/1.1".to_vec()]
        };
        let acceptor = tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(config));
        let app = app::app(market::Market::new());
        return corten::serve_wrapped(corten::listeners(8080).await?, move |tcp| {
            let acceptor = acceptor.clone();
            async move { acceptor.accept(tcp).await }
        }, app).await;
    }
    #[cfg(not(feature = "http2-prototype"))]
    corten::serve(app::app(market::Market::new())).await
}
