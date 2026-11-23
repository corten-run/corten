//! An opt-in event after the router has finished the response, not an app middleware.

use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

use crate::http::{Method, Request, Response};

pub(crate) struct Access {
    started: Instant,
    method: Method,
    path: String,
}

/// Only apps with tower layers need a shared handoff: a layer can dispatch on another task
/// and replace the entire response, so neither a task-local nor response extensions suffice.
/// A layer that sends one request's clones to several routes leaves the last one matched.
#[derive(Clone, Default)]
pub(crate) struct Shared(Arc<Mutex<Option<Arc<str>>>>);

impl Shared {
    pub(crate) fn set(self, route: Option<Arc<str>>) {
        *self.0.lock().unwrap() = route;
    }

    fn take(&self) -> Option<Arc<str>> {
        self.0.lock().unwrap().take()
    }
}

/// The route's name is shared with the router's copy, not copied for each request.
pub(crate) fn answer(
    mut req: Request,
    shared: bool,
    matched: impl FnOnce(&Request) -> Option<Arc<str>>,
    next: impl FnOnce(Request) -> crate::router::RouterFuture,
) -> crate::router::Answering {
    // The check names the line's fields, so a subscriber that filters on one of them sees it.
    if !tracing::event_enabled!(
        target: "corten::access",
        tracing::Level::INFO,
        message,
        method,
        path,
        route,
        status,
        bytes,
        duration
    ) {
        let answering = next(req);
        return Box::pin(async move {
            let Ok(res) = answering.await;
            res
        });
    }
    let access = Access::start(&req);
    let matched = matched(&req);
    let route = shared.then(|| {
        let route = Shared::default();
        req.extensions_mut().insert(route.clone());
        route
    });
    let answering = next(req);
    Box::pin(async move {
        let Ok(res) = answering.await;
        let matched = match route {
            Some(route) => route.take(),
            None => matched,
        };
        access.write(&res, matched);
        res
    })
}

impl Access {
    pub(crate) fn start(req: &Request) -> Self {
        Self { started: Instant::now(), method: req.method().clone(), path: req.uri().path().to_owned() }
    }

    fn write(self, res: &Response, matched: Option<Arc<str>>) {
        let route = matched.as_deref();
        let duration = self.started.elapsed();
        // Hyper's HTTP/1 server sends no final informational status but `101`: it writes an empty
        // `500` in its place and closes the connection, so that is what the client gets.
        let status = match res.status() {
            status if status.is_informational() && status != http::StatusCode::SWITCHING_PROTOCOLS => 500,
            status => status.as_u16(),
        };
        macro_rules! line {
            ($bytes:expr) => {
                tracing::info!(
                    target: "corten::access",
                    method = %self.method,
                    path = self.path,
                    route,
                    status,
                    bytes = $bytes,
                    ?duration,
                    "corten: request"
                )
            };
        }
        // HTTP has no content for these statuses, even if an app layer left a body on them; the
        // `500` sent in place of another `1xx` has none either, and a `2xx` to `CONNECT` opens a
        // tunnel instead of sending its body.
        let size = if res.status().is_informational()
            || matches!(res.status(), http::StatusCode::NO_CONTENT | http::StatusCode::NOT_MODIFIED)
            || (self.method == Method::CONNECT && res.status().is_success())
        {
            Some(0)
        } else {
            http_body::Body::size_hint(res.body()).exact()
        };
        match size {
            Some(bytes) => line!(bytes),
            None => line!("stream"),
        }
    }
}
