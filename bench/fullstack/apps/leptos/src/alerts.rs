use axum::{
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use cookie::{Cookie, SameSite};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
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
static SESSIONS: LazyLock<Mutex<HashMap<String, Session>>> = LazyLock::new(Mutex::default);

fn presented(headers: &HeaderMap) -> Option<String> {
    let mut found = None;
    for value in headers.get_all(header::COOKIE) {
        for cookie in Cookie::split_parse(value.to_str().ok()?) {
            let cookie = cookie.ok()?;
            if cookie.name() == COOKIE {
                if found.is_some() {
                    return None;
                }
                found = Some(cookie.value().to_string());
            }
        }
    }
    found
}
pub fn append(headers: &HeaderMap, row: Alert) -> Result<Option<HeaderValue>, StatusCode> {
    let mut sessions = SESSIONS.lock().map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let now = Instant::now();
    sessions.retain(|_, session| now < session.expires);
    let mut issued = None;
    let token = match presented(headers).filter(|token| sessions.contains_key(token)) {
        Some(token) => token,
        None => {
            if sessions.len() >= 4096 {
                return Err(StatusCode::SERVICE_UNAVAILABLE);
            }
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes).map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
            let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
            // Only trusted deployment configuration, never forwarding headers.
            let secure = std::env::var("MARKETPLACE_PUBLIC_ORIGIN").is_ok_and(|origin| origin.starts_with("https://"));
            let cookie =
                Cookie::build((COOKIE, token.clone())).path("/").http_only(true).same_site(SameSite::Lax).secure(secure).build();
            issued = Some(cookie.to_string().parse().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?);
            sessions.insert(token.clone(), Session { expires: now + Duration::from_secs(3600), rows: Vec::new() });
            token
        }
    };
    let session = sessions.get_mut(&token).expect("validated session");
    if session.rows.len() >= 1024 {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    session.rows.push(row);
    Ok(issued)
}

pub async fn read(headers: HeaderMap) -> axum::response::Response {
    let Ok(sessions) = SESSIONS.lock() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let rows = presented(&headers)
        .and_then(|token| sessions.get(&token))
        .filter(|s| Instant::now() < s.expires)
        .map(|s| s.rows.clone())
        .unwrap_or_default();
    ([(header::CACHE_CONTROL, "no-store")], Json(rows)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cookies_concurrent_appends_isolation_expiry_and_capacity() {
        let row = Alert { item_id: "item_1".into(), email: "person@example.test".into(), target_minor: 1234 };
        let cookie = append(&HeaderMap::new(), row.clone()).unwrap().unwrap();
        let cookie = Cookie::parse(cookie.to_str().unwrap()).unwrap();
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.same_site(), Some(SameSite::Lax));
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.domain(), None);
        assert!(cookie.max_age().is_none());
        assert_eq!(cookie.value().len(), 64);
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, format!("{COOKIE}={}", cookie.value()).parse().unwrap());
        let mut threads = Vec::new();
        for _ in 0..16 {
            let headers = headers.clone();
            let row = row.clone();
            threads.push(std::thread::spawn(move || assert!(append(&headers, row).unwrap().is_none())));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        let response = read(headers.clone()).await;
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert!(!response.headers().contains_key(header::SET_COOKIE));
        let rows: Vec<Alert> =
            serde_json::from_slice(&axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap();
        assert_eq!(rows, vec![row.clone(); 17]);
        let fresh = read(HeaderMap::new()).await;
        assert_eq!(&axum::body::to_bytes(fresh.into_body(), 1 << 20).await.unwrap()[..], b"[]");
        for _ in 17..1024 {
            assert!(append(&headers, row.clone()).unwrap().is_none());
        }
        assert_eq!(append(&headers, row), Err(StatusCode::SERVICE_UNAVAILABLE));
        SESSIONS.lock().unwrap().get_mut(cookie.value()).unwrap().expires = Instant::now() - Duration::from_secs(1);
        let response = read(headers).await;
        assert_eq!(&axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap()[..], b"[]");
        assert_eq!(SESSIONS.lock().unwrap()[cookie.value()].rows.len(), 1024, "GET must not reset storage");
    }
}
