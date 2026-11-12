use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use topcoat::{
    Result,
    context::Cx,
    cookie::{Cookie, SameSite},
    router::{content::Json, error::service_unavailable, header, request, response::response_headers, route},
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
            // The native listener is HTTP. A trusted TLS deployment can require Secure.
            let secure = std::env::var("MARKETPLACE_PUBLIC_ORIGIN").is_ok_and(|origin| origin.starts_with("https://"));
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
pub async fn read(cx: &Cx) -> Result<Json<Vec<Alert>>> {
    response_headers(cx).append(header::CACHE_CONTROL, "no-store".parse()?);
    let sessions = SESSIONS.lock().map_err(|_| service_unavailable(60))?;
    let rows = presented(cx)
        .and_then(|hash| sessions.get(&hash))
        .filter(|s| Instant::now() < s.expires)
        .map(|s| s.rows.clone())
        .unwrap_or_default();
    Ok(Json(rows))
}

#[cfg(test)]
mod tests {
    use super::*;
    use topcoat::router::{Body, Router, request::Request, to_bytes};

    #[route(POST "/append")]
    async fn append_route(cx: &Cx) -> Result<()> {
        append(cx, Alert { item_id: "item_1".into(), email: "person@example.test".into(), target_minor: 1234 })
    }
    #[tokio::test]
    async fn native_cookie_store_is_ordered_isolated_concurrent_and_expires() {
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
}
