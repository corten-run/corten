#![cfg(feature = "ssr")]

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{header, Request, StatusCode},
    routing::{get, post},
    Router,
};
use item_page_leptos::{app::App, marketplace_page::marketplace_post};
use leptos::prelude::LeptosOptions;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn options() -> LeptosOptions {
    LeptosOptions::builder().output_name("item_page").build()
}

static ORIGIN_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct PublicOrigin(Option<std::ffi::OsString>);

impl PublicOrigin {
    fn set(value: Option<&str>) -> Self {
        let previous = Self(std::env::var_os("MARKETPLACE_PUBLIC_ORIGIN"));
        match value {
            Some(value) => std::env::set_var("MARKETPLACE_PUBLIC_ORIGIN", value),
            None => std::env::remove_var("MARKETPLACE_PUBLIC_ORIGIN"),
        }
        previous
    }
}

impl Drop for PublicOrigin {
    fn drop(&mut self) {
        match &self.0 {
            Some(value) => std::env::set_var("MARKETPLACE_PUBLIC_ORIGIN", value),
            None => std::env::remove_var("MARKETPLACE_PUBLIC_ORIGIN"),
        }
    }
}

#[tokio::test]
async fn cross_site_post_is_rejected_before_polling_the_body() {
    let _environment = ORIGIN_ENV.lock().await;
    let _origin = PublicOrigin::set(None);
    for (origin, site) in [
        (Some("https://other.invalid"), Some("cross-site")),
        (Some("https://other.invalid"), None),
        (Some("https://other.invalid"), Some("same-origin")),
        (Some("http://market.test:8080"), Some("cross-site")),
        (None, Some("same-site")),
        (None, Some("cross-site")),
        (Some("null"), None),
        (Some("http://market.test:8081"), None),
        (Some("not an origin"), None),
        (Some("http://market.test:8080/path"), None),
        (Some("http://user@market.test:8080"), None),
        (Some("http://market.test:8080?query"), None),
        (Some("http://market.test:8080#fragment"), None),
        (Some("ftp://market.test:8080"), None),
        (None, Some("unexpected")),
    ] {
        let polls = Arc::new(AtomicUsize::new(0));
        let observed = polls.clone();
        let body = Body::from_stream(futures::stream::once(async move {
            observed.fetch_add(1, Ordering::SeqCst);
            Err::<Bytes, _>(std::io::Error::other("the rejected body must not be read"))
        }));
        let mut request = Request::post("/marketplace/en-US/item_1")
            .header(header::HOST, "market.test:8080")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded");
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        if let Some(site) = site {
            request = request.header("sec-fetch-site", site);
        }
        let response = marketplace_post(State(options()), request.body(body).unwrap()).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "origin={origin:?}, site={site:?}");
        assert_eq!(polls.load(Ordering::SeqCst), 0, "cross-site defense must precede form parsing");
    }
}

#[tokio::test]
async fn ambiguous_security_headers_are_rejected_before_polling_the_body() {
    let _environment = ORIGIN_ENV.lock().await;
    let _origin = PublicOrigin::set(None);
    for (name, value) in [
        (header::ORIGIN, "https://other.invalid"),
        (header::HeaderName::from_static("sec-fetch-site"), "cross-site"),
        (header::HOST, "other.invalid"),
    ] {
        let polls = Arc::new(AtomicUsize::new(0));
        let observed = polls.clone();
        let body = Body::from_stream(futures::stream::once(async move {
            observed.fetch_add(1, Ordering::SeqCst);
            Err::<Bytes, _>(std::io::Error::other("the rejected body must not be read"))
        }));
        let request = Request::post("/marketplace/en-US/item_1")
            .header(header::HOST, "market.test:8080")
            .header(header::ORIGIN, "http://market.test:8080")
            .header("sec-fetch-site", "same-origin")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .header(name.clone(), value)
            .body(body)
            .unwrap();
        let response = marketplace_post(State(options()), request).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "duplicate {name}");
        assert_eq!(polls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn http_deployment_rejects_https_origin_even_with_forged_scheme_headers() {
    let _environment = ORIGIN_ENV.lock().await;
    let _origin = PublicOrigin::set(None);
    for uri in ["/marketplace/en-US/item_1", "https://market.test:8080/marketplace/en-US/item_1"] {
        let polls = Arc::new(AtomicUsize::new(0));
        let observed = polls.clone();
        let body = Body::from_stream(futures::stream::once(async move {
            observed.fetch_add(1, Ordering::SeqCst);
            Err::<Bytes, _>(std::io::Error::other("the rejected body must not be read"))
        }));
        let request = Request::post(uri)
            .header(header::HOST, "market.test:8080")
            .header(header::ORIGIN, "https://market.test:8080")
            .header("forwarded", "proto=https;host=market.test:8080")
            .header("x-forwarded-proto", "https")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(body)
            .unwrap();
        let response = marketplace_post(State(options()), request).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "HTTP deployment, HTTPS Origin: {uri}");
        assert_eq!(polls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn tls_proxy_deployment_rejects_http_origin_even_with_forged_scheme_headers() {
    let _environment = ORIGIN_ENV.lock().await;
    let _origin = PublicOrigin::set(Some("https://market.test:8080"));
    let polls = Arc::new(AtomicUsize::new(0));
    let observed = polls.clone();
    let body = Body::from_stream(futures::stream::once(async move {
        observed.fetch_add(1, Ordering::SeqCst);
        Err::<Bytes, _>(std::io::Error::other("the rejected body must not be read"))
    }));
    let request = Request::post("http://market.test:8080/marketplace/en-US/item_1")
        .header(header::HOST, "market.test:8080")
        .header(header::ORIGIN, "http://market.test:8080")
        .header("forwarded", "proto=http;host=market.test:8080")
        .header("x-forwarded-proto", "http")
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body)
        .unwrap();
    let response = marketplace_post(State(options()), request).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN, "HTTPS deployment, HTTP Origin");
    assert_eq!(polls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn native_http_form_preserves_same_origin_and_headerless_posts_without_fetching_cross_site() {
    let _environment = ORIGIN_ENV.lock().await;
    let _origin = PublicOrigin::set(None);
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let fetched = Arc::new(AtomicUsize::new(0));
    let observed = fetched.clone();
    let upstream_app = Router::new().route(
        "/marketplace/records/{id}",
        get(move || {
            let observed = observed.clone();
            async move {
                observed.fetch_add(1, Ordering::SeqCst);
                ([(header::CONTENT_TYPE, "application/json")], include_str!("marketplace.json"))
            }
        }),
    );
    let upstream_task = tokio::spawn(async move { axum::serve(upstream, upstream_app).await.unwrap() });
    // This integration-test process alone owns the source's OnceLock and its environment.
    std::env::set_var("MARKETPLACE_SOURCE", "api");
    std::env::set_var("API_BASE", format!("http://{upstream_addr}"));
    leptos_axum::generate_route_list(App);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().route("/marketplace/{locale}/{id}", post(marketplace_post)).with_state(options());
    let app_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap();
    let url = format!("{base}/marketplace/en-US/item_1?seller=Al&sort=desc&offers=all");
    let form = "email=person%40example.test&target_price=12.34";

    for (with_origin, site) in [(true, Some("same-origin")), (true, None), (false, None), (false, Some("none"))] {
        let mut request = client.post(&url).header(header::CONTENT_TYPE, "application/x-www-form-urlencoded").body(form);
        if with_origin {
            request = request.header(header::ORIGIN, &base);
        }
        if let Some(site) = site {
            request = request.header("sec-fetch-site", site);
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let html = response.text().await.unwrap();
        assert!(html.contains("person@example.test"), "plain form must render its successful alert");
        assert!(html.contains("$12.34"));
        assert!(html.contains("method=\"post\""), "no-JavaScript form remains available");
    }
    assert_eq!(fetched.load(Ordering::SeqCst), 4, "each accepted POST fetches its record once");

    let response = client
        .post(&url)
        .header(header::ORIGIN, "https://other.invalid")
        .header("sec-fetch-site", "cross-site")
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(form)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(fetched.load(Ordering::SeqCst), 4, "cross-site POST must not fetch or render");

    let response = client
        .post(&url)
        .header(header::ORIGIN, &base)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(form)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE, "keep Axum's native form rejection");
    assert_eq!(fetched.load(Ordering::SeqCst), 4);

    let _tls_origin = PublicOrigin::set(Some("https://market.test:8080"));
    for (host, with_origin, site) in [
        ("market.test:8080", true, None),
        ("leptos.internal:8080", true, Some("same-origin")),
        ("leptos.internal:8080", false, None),
    ] {
        let mut request = client
            .post(&url)
            .header(header::HOST, host)
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(form);
        if with_origin {
            request = request.header(header::ORIGIN, "https://market.test:8080");
        }
        if let Some(site) = site {
            request = request.header("sec-fetch-site", site);
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "trusted TLS proxy configuration: {host}");
        let html = response.text().await.unwrap();
        assert!(html.contains("person@example.test"));
        assert!(html.contains("method=\"post\""));
    }
    assert_eq!(fetched.load(Ordering::SeqCst), 7, "TLS proxy forms still perform the normal record fetch");

    for configured in [
        "https://market.test:8080",
        "",
        "not an origin",
        "ftp://market.test:8080",
        "https://user@market.test:8080",
        "https://market.test:8080/path",
        "https://market.test:8080?query",
        "https://market.test:8080#fragment",
    ] {
        let _configured_origin = PublicOrigin::set(Some(configured));
        let response = client
            .post(&url)
            .header(header::ORIGIN, &base)
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(form)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "configured public origin must be valid and authoritative");
        assert_eq!(fetched.load(Ordering::SeqCst), 7, "rejected configuration or scheme must not fetch");
    }
    app_task.abort();
    upstream_task.abort();
    let _ = app_task.await;
    let _ = upstream_task.await;
}
