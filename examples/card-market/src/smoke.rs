//! What only the browser test serves, with the app run as `SMOKE_ROUTES=1` (`app::app_with`): a
//! count of the requests that reach the server for each URL under `/smoke` and at `/mcp`, read at
//! `/smoke/requests`, so the test counts on the server what a navigation under the service worker
//! sends; a one-time link under a `network_only` prefix, as an OAuth callback or a magic link is,
//! that redirects to a page; and that page, which the worker answers as any page.
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

/// The requests counted so far, by path and query.
#[derive(Clone, Default)]
pub struct Requests(Arc<Mutex<BTreeMap<String, u32>>>);

impl Middleware for Requests {
    async fn call(&self, req: Request, next: impl Next) -> Response {
        let url = req.uri().path_and_query().map_or_else(|| req.uri().path().to_string(), ToString::to_string);
        *self.0.lock().unwrap().entry(url).or_default() += 1;
        next.run(req).await
    }
}

async fn requests(State(seen): State<Requests>) -> String {
    let seen = seen.0.lock().unwrap();
    seen.iter().map(|(url, count)| format!("{count} {url}\n")).collect()
}

async fn once(req: Req) -> HtmlResult {
    req.redirect(&url::Landed)
}

async fn landed(req: Req) -> HtmlResult {
    req.page(html! {
        <Layout req={&req} title="Landed" head="">
            <h1>"Landed"</h1>
        </Layout>
    })
}
