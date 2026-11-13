use corten::{
    extract::FromRequestParts,
    http::request::Parts,
    security::{
        Nonce,
        cookie::{self, SetCookie},
    },
};
use std::{
    collections::HashMap,
    convert::Infallible,
    sync::{Arc, Mutex},
};

pub const COOKIE: &str = "marketplace-alerts";

#[derive(Clone, Debug, serde::Serialize, corten::ToJson)]
pub struct Alert {
    pub item_id: String,
    pub email: String,
    pub target_minor: u64,
}

#[derive(Clone, Default)]
pub struct Store(Arc<Mutex<HashMap<String, Vec<Alert>>>>);

impl Store {
    pub fn read(&self, session: &Session) -> Vec<Alert> {
        let rows = self.0.lock().unwrap();
        session.id.as_ref().and_then(|id| rows.get(id)).cloned().unwrap_or_default()
    }

    pub fn append(&self, session: &Session, alert: Alert) -> Option<SetCookie> {
        let mut rows = self.0.lock().unwrap();
        if let Some(alerts) = session.id.as_ref().and_then(|id| rows.get_mut(id)) {
            alerts.push(alert);
            return None;
        }
        // Only a token generated here can create a store; never adopt a caller's chosen id.
        let id = loop {
            let id = Nonce::generate().0.to_string();
            if !rows.contains_key(&id) {
                break id;
            }
        };
        let cookie = SetCookie::new(COOKIE, &id);
        rows.insert(id, vec![alert]);
        Some(if session.plain_http { cookie.insecure() } else { cookie })
    }
}

pub struct Session {
    id: Option<String>,
    plain_http: bool,
}

impl<S: Sync> FromRequestParts<S> for Session {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Infallible> {
        let id = cookie::get(&parts.headers, COOKIE)
            .filter(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()))
            .map(str::to_owned);
        // The same-origin check has already validated the form's Origin. Plain HTTP benchmark
        // browsers (including WebKit on loopback) cannot all keep a Secure cookie.
        let plain_http = parts
            .headers
            .get("origin")
            .and_then(|origin| origin.to_str().ok())
            .is_some_and(|origin| origin.starts_with("http://"));
        Ok(Self { id, plain_http })
    }
}
