use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use topcoat::{
    Result,
    context::Cx,
    cookie::{Cookie, SameSite},
    router::{
        content::Json,
        error::service_unavailable,
        header, request,
        response::{IntoResponse, response_headers},
        route,
    },
    session::{Token, TokenHash},
};

const COOKIE: &str = "marketplace_session";
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct Alert {
    pub item_id: String,
    pub email: String,
    pub target_minor: i64,
}
struct Session {
    expires: Instant,
    rows: Vec<Alert>,
}
static SESSIONS: LazyLock<Mutex<HashMap<TokenHash, Session>>> = LazyLock::new(Mutex::default);

fn secure_cookie(host: Option<&str>, origin: Option<&str>) -> bool {
    let (Some(host), Some(origin)) = (host, origin) else { return false };
    let Ok(origin) = url::Url::parse(origin) else { return false };
    if origin.scheme() != "https" {
        return false;
    }
    let public = origin.origin().ascii_serialization();
    let authority = public.strip_prefix("https://").expect("HTTPS origin serialization");
    host.eq_ignore_ascii_case(authority)
        || origin.port().is_none() && host.strip_suffix(":443").is_some_and(|host| host.eq_ignore_ascii_case(authority))
}

fn presented(cx: &Cx) -> Option<TokenHash> {
    let mut found = None;
    for value in request::headers(cx).get_all(header::COOKIE) {
        for cookie in Cookie::split_parse(value.to_str().ok()?) {
            let cookie = cookie.ok()?;
            if cookie.name() == COOKIE {
                if found.is_some() {
                    return None;
                }
                found = Some(Token::decode(cookie.value()).ok()?.hash());
            }
        }
    }
    found
}
pub fn append(cx: &Cx, row: Alert) -> Result<()> {
    append_with_origin(cx, row, || std::env::var("MARKETPLACE_PUBLIC_ORIGIN").ok())
}

fn append_with_origin(cx: &Cx, row: Alert, configured_origin: impl FnOnce() -> Option<String>) -> Result<()> {
    let mut sessions = SESSIONS.lock().map_err(|_| service_unavailable(60))?;
    let now = Instant::now();
    sessions.retain(|_, session| now < session.expires);
    let hash = match presented(cx).filter(|hash| sessions.contains_key(hash)) {
        Some(hash) => hash,
        None => {
            if sessions.len() >= 4096 {
                return Err(service_unavailable(60).into());
            }
            let token = Token::random();
            let hash = token.hash();
            // The public TLS authority and the HTTP preflight share this app instance.
            let public_origin = configured_origin();
            let mut hosts = request::original_headers(cx).get_all(header::HOST).iter();
            let host = hosts.next().and_then(|value| value.to_str().ok()).filter(|_| hosts.next().is_none());
            let secure = secure_cookie(host, public_origin.as_deref());
            let cookie =
                Cookie::build((COOKIE, token.encode())).path("/").http_only(true).same_site(SameSite::Lax).secure(secure).build();
            response_headers(cx).append(header::SET_COOKIE, cookie.to_string().parse()?);
            sessions.insert(hash.clone(), Session { expires: now + Duration::from_secs(3600), rows: Vec::new() });
            hash
        }
    };
    let session = sessions.get_mut(&hash).expect("validated session");
    if session.rows.len() >= 1024 {
        return Err(service_unavailable(60).into());
    }
    session.rows.push(row);
    Ok(())
}

#[route(GET "/api/alerts")]
pub async fn read(cx: &Cx) -> Result<impl IntoResponse> {
    let sessions = SESSIONS.lock().map_err(|_| service_unavailable(60))?;
    let rows = presented(cx)
        .and_then(|hash| sessions.get(&hash))
        .filter(|s| Instant::now() < s.expires)
        .map(|s| s.rows.clone())
        .unwrap_or_default();
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(rows)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use topcoat::router::{Body, Router, request::Request, to_bytes};

    static WRITES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[test]
    fn public_cookie_security_does_not_apply_to_the_direct_listener() {
        let public = Some("https://localhost:8080");
        assert!(secure_cookie(Some("localhost:8080"), public));
        assert!(!secure_cookie(Some("127.0.0.1:8080"), public));
        assert!(!secure_cookie(Some("localhost:8081"), public));
        assert!(!secure_cookie(None, public));
        assert!(!secure_cookie(Some("localhost:8080"), Some("http://localhost:8080")));
        assert!(secure_cookie(Some("localhost"), Some("https://Localhost:443/")));
        assert!(secure_cookie(Some("localhost:443"), Some("https://localhost")));
    }

    #[route(POST "/append")]
    async fn append_route(cx: &Cx) -> Result<()> {
        append(cx, Alert { item_id: "item_1".into(), email: "person@example.test".into(), target_minor: 1234 })
    }

    #[route(POST "/public-append")]
    async fn public_append(cx: &Cx) -> Result<()> {
        append_with_origin(
            cx,
            Alert { item_id: "item_1".into(), email: "person@example.test".into(), target_minor: 1234 },
            || Some("https://Localhost:443/".into()),
        )
    }

    #[tokio::test]
    async fn public_and_direct_sessions_set_the_cookie_for_their_own_transport() {
        let _writes = WRITES.lock().await;
        let router = Router::builder().route(public_append).route(read).build();
        for (host, secure) in [("localhost", true), ("127.0.0.1", false)] {
            let response =
                router.handle(Request::post("/public-append").header(header::HOST, host).body(Body::empty()).unwrap()).await;
            assert_eq!(response.status(), 200);
            let cookie = Cookie::parse(response.headers()[header::SET_COOKIE].to_str().unwrap()).unwrap();
            assert_eq!(cookie.secure().unwrap_or(false), secure);
            let readback = router
                .handle(
                    Request::get("/api/alerts")
                        .header(header::HOST, host)
                        .header(header::COOKIE, format!("{COOKIE}={}", cookie.value()))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await;
            assert_eq!(readback.status(), 200);
            let rows = to_bytes(readback.into_body(), 8192).await.unwrap();
            assert_eq!(serde_json::from_slice::<Vec<Alert>>(&rows).unwrap().len(), 1);
        }
    }
    #[tokio::test]
    async fn native_cookie_store_is_ordered_isolated_concurrent_and_expires() {
        let _writes = WRITES.lock().await;
        let router = std::sync::Arc::new(Router::builder().route(append_route).route(read).build());
        let response = router.handle(Request::post("/append").body(Body::empty()).unwrap()).await;
        assert_eq!(response.status(), 200);
        let cookie = Cookie::parse(response.headers()[header::SET_COOKIE].to_str().unwrap()).unwrap();
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.same_site(), Some(SameSite::Lax));
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.domain(), None);
        assert!(cookie.max_age().is_none());
        let token = Token::decode(cookie.value()).unwrap();
        let credential = format!("{COOKIE}={}", cookie.value());
        let mut tasks = Vec::new();
        for _ in 0..16 {
            let router = router.clone();
            let credential = credential.clone();
            tasks.push(tokio::spawn(async move {
                let response =
                    router.handle(Request::post("/append").header(header::COOKIE, credential).body(Body::empty()).unwrap()).await;
                assert_eq!(response.status(), 200);
                assert!(!response.headers().contains_key(header::SET_COOKIE));
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        for (cookie, expected) in [(Some(credential.clone()), 17), (None, 0), (Some(format!("{COOKIE}=chosen")), 0)] {
            let mut request = Request::get("/api/alerts");
            if let Some(cookie) = cookie {
                request = request.header(header::COOKIE, cookie);
            }
            let response = router.handle(request.body(Body::empty()).unwrap()).await;
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert!(!response.headers().contains_key(header::SET_COOKIE));
            let rows: Vec<Alert> = serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap();
            assert_eq!(rows.len(), expected);
        }
        SESSIONS.lock().unwrap().get_mut(&token.hash()).unwrap().expires = Instant::now() - Duration::from_secs(1);
        let response =
            router.handle(Request::get("/api/alerts").header(header::COOKIE, credential).body(Body::empty()).unwrap()).await;
        assert_eq!(&to_bytes(response.into_body(), 1 << 20).await.unwrap()[..], b"[]");
        assert_eq!(SESSIONS.lock().unwrap()[&token.hash()].rows.len(), 17, "GET does not reset storage");
    }

    #[tokio::test]
    async fn readback_no_store_precedes_matched_profile_fallback() {
        let router = Router::builder().route(read).layer(crate::profile_layer()).build();
        let response = router.handle(Request::get("/api/alerts").body(Body::empty()).unwrap()).await;
        assert_eq!(response.status(), 200);
        let cache: Vec<_> = response.headers().get_all(header::CACHE_CONTROL).iter().collect();
        assert_eq!(cache, ["no-store"]);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(response.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert!(!response.headers().contains_key(header::SET_COOKIE));
        assert_eq!(&to_bytes(response.into_body(), 1 << 20).await.unwrap()[..], b"[]");
    }
}
