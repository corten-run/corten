//! [`LayoutRead`]: a value only the layout shows (a cart's count), read beside the page's own
//! reads and drawn into the layout after the handler, so no handler or helper passes it on.

use std::{
    any::{Any, TypeId},
    future::Future,
    marker::PhantomData,
    sync::{Arc, Mutex, PoisonError},
};

use axum::{body::Body, http::request::Parts, response::Response};

use crate::view::Render;

/// A value only the app's layout shows, read once per full load: the cart's count in the header,
/// a count of unread messages. Registered once, [`crate::App::layout_read`]; the layout draws it
/// where it goes with [`later`] (`{later::<CartCount>()}`), and no handler, helper or closure
/// that draws the layout takes it.
///
/// Corten starts the read as a request for a whole document arrives (a first load, a reload, the
/// page a write redirects to), so it runs beside the handler's own reads, and draws its
/// [`LayoutRead::view`] where the layout put [`later`] once the handler has answered. A client
/// navigation or a form the runtime submits keeps the layout the page has, so the read is not
/// started for it; neither is it for an API or a data client. An answer that draws no layout (a
/// redirect) drops the read, which cancels it.
///
/// ```
/// use std::future::Future;
/// use corten::{axum::http::request::Parts, prelude::*, LayoutRead};
///
/// #[derive(Clone)]
/// struct Carts;
/// impl Carts {
///     async fn count(&self, _session: Option<String>) -> Option<u32> { Some(3) }
/// }
///
/// /// The header's cart count.
/// struct CartCount(Carts);
///
/// impl LayoutRead for CartCount {
///     type Value = Option<u32>;
///
///     fn start(&self, parts: &Parts) -> Option<impl Future<Output = Option<u32>> + Send + 'static> {
///         // What the read needs, taken now: it runs on a task of its own.
///         let session = parts.headers.get("cookie").and_then(|v| v.to_str().ok()).map(str::to_string);
///         let carts = self.0.clone();
///         Some(async move { carts.count(session).await })
///     }
///
///     fn view(count: &Option<u32>) -> impl Render + '_ {
///         html! { if let Some(count) = count { <span>{*count}</span> } }
///     }
/// }
///
/// // In the layout, where the count goes: <a href={url::Cart}>"Cart"{later::<CartCount>()}</a>
/// # let _ = later::<CartCount>();
/// # let _app = |routes: Routes| App::new(routes).layout_read(CartCount(Carts));
/// ```
///
/// A read that needs who is asking takes the request's head (`let parts = parts.clone();`) and
/// looks the caller up with [`crate::Caller::find`], which shares the request's one lookup with
/// the handler; the page is then private and keyed by the caller, as it is when the handler reads
/// one.
///
/// It runs on a task of its own, so a panic in it or a read past the request's deadline draws
/// nothing where the layout put it (and is logged) rather than failing the page. The read takes
/// what it uses by value; one that borrows the request does not compile:
///
/// ```compile_fail
/// use std::future::Future;
/// use corten::{axum::http::request::Parts, prelude::*, LayoutRead};
///
/// struct PathLength;
///
/// impl LayoutRead for PathLength {
///     type Value = usize;
///
///     fn start(&self, parts: &Parts) -> Option<impl Future<Output = usize> + Send + 'static> {
///         let path = parts.uri.path();
///         Some(async move { path.len() })
///     }
///
///     fn view(length: &usize) -> impl Render + '_ {
///         html! { {*length} }
///     }
/// }
/// ```
///
/// A page gives a value of the read's own type, or does not compile:
///
/// ```compile_fail,E0308
/// # use std::future::Future;
/// # use corten::{axum::http::request::Parts, prelude::*, LayoutRead};
/// # struct CartCount;
/// # impl LayoutRead for CartCount {
/// #     type Value = Option<u32>;
/// #     fn start(&self, _: &Parts) -> Option<impl Future<Output = Option<u32>> + Send + 'static> { Some(async { None }) }
/// #     fn view(count: &Option<u32>) -> impl Render + '_ { html! { if let Some(count) = count { {*count} } } }
/// # }
/// fn cart(page: corten::HtmlResponse) -> corten::HtmlResponse {
///     page.give::<CartCount>("three")
/// }
/// ```
pub trait LayoutRead: Send + Sync + 'static {
    /// What the read gives the view.
    type Value: Send + 'static;

    /// Starts the read for a request whose answer draws the layout, or `None` where there is
    /// nothing to read (no one is signed in, or the page gives the value itself,
    /// [`crate::HtmlResponse::give`]). Whatever it uses is taken by value: the read is
    /// `Send + 'static`.
    fn start(&self, parts: &Parts) -> Option<impl Future<Output = Self::Value> + Send + 'static>;

    /// The value drawn where the layout put [`later`]: markup, and components the app lists.
    fn view(value: &Self::Value) -> impl Render + '_;
}

/// Where the layout draws a [`LayoutRead`]'s value: `{later::<CartCount>()}`, outside `<main>`
/// (a client navigation keeps the layout around it). It draws nothing when the read was not
/// started (its [`LayoutRead::start`] said `None`) and the page gave no value.
pub fn later<T: LayoutRead>() -> Later<T> {
    Later(PhantomData)
}

/// [`later`]'s place in the layout.
pub struct Later<T>(PhantomData<fn() -> T>);

/// Where a value goes: `<!--corten-later-N-->`, `N` its place in the page's list. A comment, so
/// a page that is never filled (a router used without [`crate::App`]) shows nothing there.
pub(crate) const MARK: &str = "<!--corten-later-";

thread_local! {
    /// The reads the page being rendered draws, in the order it drew them; `None` outside a page.
    pub(crate) static SLOTS: std::cell::RefCell<Option<Vec<(TypeId, &'static str)>>> = const { std::cell::RefCell::new(None) };
}

impl<T: LayoutRead> Render for Later<T> {
    fn render(&self, out: &mut String) {
        let index = SLOTS.with_borrow_mut(|slots| {
            let slots = slots.as_mut()?;
            slots.push((TypeId::of::<T>(), std::any::type_name::<T>()));
            Some(slots.len() - 1)
        });
        match index {
            Some(index) => {
                use std::fmt::Write;
                let _ = write!(out, "{MARK}{index}-->");
            }
            None => not_in_a_page(std::any::type_name::<T>()),
        }
    }
}

/// `later` rendered outside a page (into a string of its own), or in a release build of an app
/// that starts no layout reads: nothing is drawn there.
#[cold]
fn not_in_a_page(name: &str) {
    tracing::warn!(
        "corten: later::<{name}>() was rendered outside req.page or in an app that does not start it (App::layout_read), so nothing is drawn there"
    );
}

/// A page with places for values, which [`fill`] draws.
#[derive(Clone)]
pub(crate) struct Pending {
    pub slots: Vec<(TypeId, &'static str)>,
    /// The page's key without its callers, for a whole document (which writes its key in
    /// `<head>`): a read that looks up who is asking changes it.
    pub key: Option<u64>,
    pub signal: crate::Signal,
}

/// Values the page gave in place of a read ([`crate::HtmlResponse::give`]).
#[derive(Clone, Default)]
pub(crate) struct Given(pub Arc<Mutex<Vec<(TypeId, Box<dyn Any + Send>)>>>);

/// A registered read with its types erased.
pub(crate) trait Erased: Send + Sync {
    fn id(&self) -> TypeId;
    fn start(&self, parts: &Parts) -> Option<Started>;
    fn draw(&self, value: &(dyn Any + Send), out: &mut String);
}

pub(crate) struct Read<T>(pub T);

impl<T: LayoutRead> Erased for Read<T> {
    fn id(&self) -> TypeId {
        TypeId::of::<T>()
    }

    fn start(&self, parts: &Parts) -> Option<Started> {
        use tracing::Instrument as _;
        let read = self.0.start(parts)?;
        Some(Started(tokio::spawn(async move { Box::new(read.await) as Box<dyn Any + Send> }.in_current_span())))
    }

    fn draw(&self, value: &(dyn Any + Send), out: &mut String) {
        if let Some(value) = value.downcast_ref::<T::Value>() {
            T::view(value).render(out);
        }
    }
}

/// A read on its task, cancelled if dropped before it gave its value.
pub(crate) struct Started(tokio::task::JoinHandle<Box<dyn Any + Send>>);

impl Drop for Started {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// The reads started for one request, by their index in the app's list.
#[derive(Default)]
pub(crate) struct Reads(Vec<(usize, Started)>);

/// On a request for a whole document in an app with layout reads: they start after the app's
/// middleware, as the route is called (so a read sees what middleware added, as an extractor
/// does), and are drawn by [`fill`] into whichever page answers.
#[derive(Clone)]
pub(crate) struct StartHere(Arc<Mutex<(Option<Arc<crate::page::Shared>>, Reads)>>);

impl StartHere {
    pub(crate) fn new(shared: Arc<crate::page::Shared>) -> Self {
        StartHere(Arc::new(Mutex::new((Some(shared), Reads::default()))))
    }

    /// Starts each of the app's reads for `req`, once.
    pub(crate) fn start(&self, req: &mut axum::extract::Request) {
        let mut kept = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(shared) = kept.0.take() else { return };
        let (parts, body) = std::mem::take(req).into_parts();
        kept.1 .0 =
            shared.layout_reads.iter().enumerate().filter_map(|(index, read)| Some((index, read.start(&parts)?))).collect();
        *req = axum::extract::Request::from_parts(parts, body);
    }

    /// The reads started, for [`fill`].
    pub(crate) fn take(&self) -> Reads {
        std::mem::take(&mut self.0.lock().unwrap_or_else(PoisonError::into_inner).1)
    }
}

/// `res` with each value drawn where its page put [`later`], and its key updated for a read
/// that looked up who is asking. Waits for a read no later than `until`.
pub(crate) async fn fill(
    mut res: Response,
    reads: Reads,
    shared: &crate::page::Shared,
    until: Option<tokio::time::Instant>,
) -> Response {
    let Some(pending) = res.extensions_mut().remove::<Pending>() else { return res };
    let given = res.extensions_mut().remove::<Given>();
    let mut reads = reads.0;
    // Each type's value, read once however many places draw it.
    let mut values: Vec<(TypeId, Option<Box<dyn Any + Send>>)> = Vec::new();
    for &(id, name) in &pending.slots {
        if values.iter().any(|(read, _)| *read == id) {
            continue;
        }
        let gift = given.as_ref().and_then(|Given(given)| {
            let mut given = given.lock().unwrap_or_else(PoisonError::into_inner);
            let at = given.iter().position(|(given, _)| *given == id)?;
            Some(given.swap_remove(at).1)
        });
        let index = shared.layout_reads.iter().position(|read| read.id() == id);
        let started = index.and_then(|index| reads.iter().position(|(i, _)| *i == index)).map(|at| reads.swap_remove(at).1);
        let value = match (gift, started) {
            // The page had it: the read, if started, is dropped, which cancels it.
            (Some(gift), _) => Some(gift),
            (None, Some(mut started)) => {
                let joined = match until {
                    Some(until) => tokio::time::timeout_at(until, &mut started.0).await.ok(),
                    None => Some((&mut started.0).await),
                };
                match joined {
                    Some(Ok(value)) => Some(value),
                    Some(Err(error)) => {
                        tracing::error!("corten: the layout read {} failed, so the layout draws nothing for it: {error}", name);
                        None
                    }
                    None => {
                        tracing::warn!(
                            "corten: the layout read {} passed the request's deadline, so the layout draws nothing for it",
                            name
                        );
                        None
                    }
                }
            }
            (None, None) => None,
        };
        values.push((id, value));
    }
    // The rest were started for a layout this page does not draw.
    drop(reads);
    let (mut head, body) = res.into_parts();
    let Ok(page) = axum::body::to_bytes(body, usize::MAX).await else {
        return Response::from_parts(head, Body::empty());
    };
    let mut out = String::with_capacity(page.len() + 64 * pending.slots.len());
    let page = std::str::from_utf8(&page).unwrap_or_default();
    let mut rest = 0;
    while let Some(found) = page[rest..].find(MARK) {
        let at = rest + found;
        let after = &page[at + MARK.len()..];
        let Some(end) = after.find("-->") else { break };
        out.push_str(&page[rest..at]);
        rest = at + MARK.len() + end + 3;
        let Some(&(id, _)) = after[..end].parse::<usize>().ok().and_then(|index| pending.slots.get(index)) else { continue };
        let value = values.iter().find(|(read, _)| *read == id).and_then(|(_, value)| value.as_deref());
        let read = shared.layout_reads.iter().find(|read| read.id() == id);
        if let (Some(value), Some(read)) = (value, read) {
            read.draw(value, &mut out);
        }
    }
    out.push_str(&page[rest..]);
    if let Some(base) = pending.key {
        const KEY: &str = r#"<meta name="corten-shell" content=""#;
        let key = base ^ pending.signal.callers().rotate_left(1);
        if let Some(at) = out.find(KEY).map(|at| at + KEY.len()).filter(|&at| out.get(at..at + 16).is_some()) {
            let hex = format!("{key:016x}");
            out.replace_range(at..at + 16, &hex);
            head.headers.insert(crate::page::SHELL_HEADER, crate::page::key_header(key));
        }
    }
    Response::from_parts(head, Body::from(out))
}
