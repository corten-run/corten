//! An opt-in event after the router has finished the response, not an app middleware.

use std::{
    borrow::Cow,
    sync::{Arc, Mutex},
    time::Instant,
};

use crate::http::{Method, Request, Response};

pub(crate) struct Access {
    started: Instant,
    method: Method,
    path: String,
}

#[derive(Clone)]
pub(crate) struct Matched(pub(crate) Cow<'static, str>);

/// Only apps with tower layers need a shared handoff: a layer can dispatch on another task
/// and replace the entire response, so neither a task-local nor response extensions suffice.
#[derive(Clone, Default)]
pub(crate) struct Shared(Arc<Mutex<Option<Cow<'static, str>>>>);

impl Shared {
    pub(crate) fn set(self, route: Option<Cow<'static, str>>) {
        *self.0.lock().unwrap() = route;
    }

    fn take(&self) -> Option<Cow<'static, str>> {
        self.0.lock().unwrap().take()
    }
}

pub(crate) fn answer(
    mut req: Request,
    shared: bool,
    next: impl FnOnce(Request) -> crate::router::RouterFuture,
) -> crate::router::Answering {
    if !tracing::event_enabled!(target: "corten::access", tracing::Level::INFO) {
        let answering = next(req);
        return Box::pin(async move {
            let Ok(mut res) = answering.await;
            res.extensions_mut().remove::<Matched>();
            res
        });
    }
    let access = Access::start(&req);
    let route = shared.then(|| {
        let route = Shared::default();
        req.extensions_mut().insert(route.clone());
        route
    });
    let answering = next(req);
    Box::pin(async move {
        let Ok(mut res) = answering.await;
        let matched = match route {
            Some(route) => route.take(),
            None => res.extensions_mut().remove::<Matched>().map(|matched| matched.0),
        };
        access.write(&res, matched);
        res
    })
}

impl Access {
    pub(crate) fn start(req: &Request) -> Self {
        Self { started: Instant::now(), method: req.method().clone(), path: req.uri().path().to_owned() }
    }

    fn write(self, res: &Response, matched: Option<Cow<'static, str>>) {
        let route = matched.as_deref();
        let duration = self.started.elapsed();
        macro_rules! line {
            ($bytes:expr) => {
                tracing::info!(
                    target: "corten::access",
                    method = %self.method,
                    path = self.path,
                    route,
                    status = res.status().as_u16(),
                    bytes = $bytes,
                    ?duration,
                    "corten: request"
                )
            };
        }
        // HTTP has no content for these statuses, even if an app layer left a body on them.
        let size = if res.status().is_informational()
            || matches!(res.status(), http::StatusCode::NO_CONTENT | http::StatusCode::NOT_MODIFIED)
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
