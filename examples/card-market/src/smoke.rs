//! What only the browser test serves, built in with `CARD_MARKET_SMOKE=1` or the `smoke` feature
//! (`build.rs`, `app::app_with`): a count of the requests that reach the server for each URL under
//! `/smoke` and at `/mcp`, read at `/smoke/requests`, so the test counts on the server what a
//! navigation under the service worker sends; a one-time link under a `network_only` prefix, as an
//! OAuth callback or a magic link is, that redirects to a page; and that page, which the worker
//! answers as any page.
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use corten::{
    http::{Request, Response},
    prelude::*,
};

use crate::views::Layout;

#[corten::routes(area = Smoke, state = Requests)]
pub mod url {
    #[route("/smoke")]
    pub struct Smoke;

    /// How many requests reached the server for each counted URL, one `count url` a line.
    #[route("/smoke/requests", get = requests)]
    pub struct Counted;

    /// A one-time link under a `network_only` prefix: a redirect to [`Landed`], for a form posted
    /// to it too.
    #[route("/smoke/once", get = once, post = once)]
    pub struct Once;

    /// The page the link lands on, which is not network-only.
    #[route("/smoke/landed", get = landed)]
    pub struct Landed;
}

/// The requests counted so far, by [`key`].
#[derive(Clone, Default)]
pub struct Requests(Arc<Mutex<BTreeMap<String, u32>>>);

impl Middleware for Requests {
    async fn call(&self, req: Request, next: impl Next) -> Response {
        if let Some(key) = key(req.uri().path(), req.uri().query()) {
            *self.0.lock().unwrap().entry(key).or_default() += 1;
        }
        next.run(req).await
    }
}

/// The paths the test sends, and the queries it adds to them, each naming the engine it runs in.
const PATHS: [&str; 3] = ["/mcp", "/smoke/once", "/smoke/landed"];
const QUERIES: [&str; 3] = ["code", "again", "offline"];
const ENGINES: [&str; 3] = ["Chromium", "Firefox", "WebKit"];

/// What a request is counted as: its path and query when they are ones the test sends, `other`
/// (or `{path}?other`) when not, so the count holds a few dozen keys whatever reaches it; none for
/// the reading of the count itself.
fn key(path: &str, query: Option<&str>) -> Option<String> {
    if path == url::Counted::PATH {
        return None;
    }
    if !PATHS.contains(&path) {
        return Some("other".into());
    }
    Some(match query.map(|query| query.split_once('=')) {
        None => path.into(),
        Some(Some((name, engine))) if QUERIES.contains(&name) && ENGINES.contains(&engine) => format!("{path}?{name}={engine}"),
        Some(_) => format!("{path}?other"),
    })
}

async fn requests(State(seen): State<Requests>) -> String {
    let seen = seen.0.lock().unwrap();
    seen.iter().map(|(url, count)| format!("{count} {url}\n")).collect()
}

async fn once(req: Req) -> HtmlResult {
    req.redirect(&url::Landed)
}

// Test fixture text, not a message: the browser test reads "Landed", and only its image serves it.
async fn landed(req: Req) -> HtmlResult {
    req.page(html! {
        <Layout req={&req} title="Landed" head="">
            <h1>"Landed"</h1>
        </Layout>
    })
}

#[cfg(test)]
mod tests {
    use super::key;

    #[test]
    fn the_count_keeps_the_urls_the_test_sends_and_folds_the_rest() {
        assert_eq!(key("/mcp", None).as_deref(), Some("/mcp"));
        assert_eq!(key("/smoke/once", Some("code=WebKit")).as_deref(), Some("/smoke/once?code=WebKit"));
        assert_eq!(key("/smoke/once", Some("code=anything")).as_deref(), Some("/smoke/once?other"));
        assert_eq!(key("/smoke/landed", Some("a=1&b=2")).as_deref(), Some("/smoke/landed?other"));
        assert_eq!(key("/smoke/nowhere", None).as_deref(), Some("other"));
        assert_eq!(key("/smoke/requests", None), None, "reading the count is not counted");
    }
}
