//! [`LayoutRead`]: a value only the layout shows (a cart's count), read beside the page's own
//! reads and drawn into the layout after the handler, so no handler or helper passes it on.

use std::{
    any::{Any, TypeId},
    future::Future,
    marker::PhantomData,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, PoisonError,
    },
    task::{Context, Poll},
};

use axum::{body::Body, http::request::Parts, response::Response};

use crate::view::Render;

/// A value only the app's layout shows, read once per full load: the cart's count in the header,
/// a count of unread messages. Registered once, [`crate::App::layout_read`]; the layout draws it
/// where it goes with [`later`] (`{later::<CartCount>()}`), and no handler, helper or closure
/// that draws the layout takes it.
///
/// Corten starts the read as a page route is called for a `GET` of a whole document (a first
/// load, a reload, the page a write redirects to), after the app's and the area's middleware, so it
/// runs beside the handler's own reads, and draws its [`LayoutRead::view`] where the layout put
/// [`later`] once the handler has answered, before the app's middleware sees the page. A client
/// navigation or a form the runtime submits keeps the layout the page has, so the read is not
/// started for it; neither is it for a `HEAD`, an API, a data client, a route that answers
/// something other than a page (a file, text, JSON) or Corten's own paths. A [`crate::Public`]
/// page is the same for everyone, so it draws no one's value. A write that draws a page rather
/// than redirect (a refused form without JavaScript) starts the reads its page draws once it has
/// answered, and so does the error page of an unknown URL. An answer that draws no layout (a
/// redirect) drops the read, which cancels it.
///
/// ```
/// use std::future::Future;
/// use corten::{axum::http::request::Parts, prelude::*, LayoutRead};
///
/// #[derive(Clone, Hash)]
/// struct Viewer(u64);
///
/// impl Identify<Carts> for Viewer {
///     async fn identify(_parts: &Parts, _carts: &Carts) -> Result<Self, Refused> {
///         Ok(Viewer(7)) // a real app reads its session store here
///     }
/// }
///
/// #[derive(Clone)]
/// struct Carts;
/// impl Carts {
///     async fn count(&self, _viewer: &Viewer) -> u32 { 3 }
/// }
///
/// /// The header's cart count, for whoever is signed in.
/// struct CartCount(Carts);
///
/// impl LayoutRead for CartCount {
///     type Value = Option<u32>;
///
///     fn start(&self, parts: &Parts) -> Option<impl Future<Output = Option<u32>> + Send + 'static> {
///         // What the read needs, taken now: it outlives this call.
///         let (carts, parts) = (self.0.clone(), parts.clone());
///         Some(async move {
///             let Caller(viewer) = Caller::<Viewer>::find(&parts, &carts).await.ok()?;
///             Some(carts.count(&viewer).await)
///         })
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
/// the handler. A caller only a layout read looked up makes the page private, but is not part of
/// its key: a client navigation does not start the read, so the key it gets must not depend on it.
/// A sign-in or sign-out redirects, which draws the layout again.
///
/// The view is markup to display (a count, a name, a badge), not a form or anything a script
/// runs: the page's head was written before it was drawn, so a view that uses a component's script
/// or a `style={..}` value draws nothing and is logged as an error; draw that part in the layout
/// and give the view the text. It is drawn in the request's time zone.
///
/// It is polled with the handler, on the request's task (no task of its own to spawn), and
/// dropped with the request. A panic in it, or a read still running at the request's deadline,
/// draws nothing where the layout put it (and is logged) rather than failing the page. The read
/// takes what it uses by value; one that borrows the request does not compile:
///
/// ```compile_fail,E0597
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

    /// The value drawn where the layout put [`later`]: markup to display, which uses no
    /// component's script and no `style={..}` value.
    fn view(value: &Self::Value) -> impl Render + '_;
}

/// Where the layout draws a [`LayoutRead`]'s value: `{later::<CartCount>()}`, outside `<main>`
/// (a client navigation keeps the layout around it). It draws nothing when the read was not
/// started (its [`LayoutRead::start`] said `None`, or the answer is [`crate::Public`]) and the
/// page gave no value.
pub fn later<T: LayoutRead>() -> Later<T> {
    Later(PhantomData)
}

/// [`later`]'s place in the layout.
pub struct Later<T>(PhantomData<fn() -> T>);

/// Where a value goes while the page is on the server: `<!--corten-later-N-->`, `N` its place
/// in the page's list. Corten draws the value there or removes it, by the place's offset noted as
/// it rendered, so the same text from `raw(..)` is left alone.
pub(crate) const MARK: &str = "<!--corten-later-";

/// One place the page drew for a read: which read, and where in the page its mark starts.
#[derive(Clone, Copy)]
pub(crate) struct Slot {
    pub id: TypeId,
    pub name: &'static str,
    pub at: usize,
}

thread_local! {
    /// The reads the page being rendered draws, in the order it drew them; `None` outside a page.
    pub(crate) static SLOTS: std::cell::RefCell<Option<Vec<Slot>>> = const { std::cell::RefCell::new(None) };
}

impl<T: LayoutRead> Render for Later<T> {
    fn render(&self, out: &mut String) {
        let index = SLOTS.with_borrow_mut(|slots| {
            let slots = slots.as_mut()?;
            slots.push(Slot { id: TypeId::of::<T>(), name: std::any::type_name::<T>(), at: out.len() });
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
    static LOGGED: AtomicBool = AtomicBool::new(false);
    if LOGGED.swap(true, Ordering::Relaxed) {
        return;
    }
    tracing::warn!(
        "corten: later::<{name}>() was rendered outside req.page or in an app that does not start it (App::layout_read), so nothing is drawn there"
    );
}

/// Where the mark of place `index` that starts at `at` ends, when it is there.
fn mark_end(page: &str, at: usize, index: usize) -> Option<usize> {
    let rest = page.get(at..)?.strip_prefix(MARK)?;
    let digits = rest.find("-->")?;
    (rest[..digits].parse::<usize>().ok()? == index).then_some(at + MARK.len() + digits + 3)
}

/// `page` with each place's mark replaced by what `draw` writes for it (nothing, for a page Corten
/// does not fill). A place whose mark is not where it was noted (a view that renders into a string
/// of its own) is logged and left out.
fn splice(page: &str, slots: &[Slot], mut draw: impl FnMut(usize, &Slot, &mut String)) -> String {
    let mut out = String::with_capacity(page.len() + 64 * slots.len());
    let mut rest = 0;
    for (index, slot) in slots.iter().enumerate() {
        match mark_end(page, slot.at, index).filter(|_| slot.at >= rest) {
            Some(end) => {
                out.push_str(&page[rest..slot.at]);
                draw(index, slot, &mut out);
                rest = end;
            }
            None => tracing::error!(
                "corten: later::<{}>() was not where the page drew it (rendered into a string of its own?), so nothing is drawn there",
                slot.name
            ),
        }
    }
    out.push_str(&page[rest..]);
    out
}

/// `page` without its places: one Corten does not fill (a navigation's `<main>`, a data client,
/// a `Public` answer, a router used without [`crate::App`]).
pub(crate) fn strip(page: &mut String, slots: &[Slot]) {
    if slots.is_empty() {
        return;
    }
    *page = splice(page, slots, |_, _, _| {});
}

/// A page with places for values, which [`StartHere::fill`] draws.
#[derive(Clone)]
pub(crate) struct Pending {
    pub slots: Vec<Slot>,
    pub signal: crate::Signal,
}

/// Values the page gave in place of a read ([`crate::HtmlResponse::give`]).
#[derive(Clone, Default)]
pub(crate) struct Given(pub Arc<Mutex<Vec<(TypeId, Box<dyn Any + Send>)>>>);

/// On a request's head while a layout read starts: a caller the read looks up
/// ([`crate::Caller::find`], [`crate::ClientIp`]) is noted here instead of in the page's key,
/// since a client navigation does not start the read, and makes the answer private only when the
/// read's value is drawn.
#[derive(Clone)]
pub(crate) struct Asking(Arc<AtomicBool>);

impl Asking {
    pub(crate) fn mark(&self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// A registered read with its types erased.
pub(crate) trait Erased: Send + Sync {
    fn id(&self) -> TypeId;
    fn name(&self) -> &'static str;
    fn start(&self, parts: &Parts) -> Option<Running>;
    fn draw(&self, value: &(dyn Any + Send), out: &mut String);
}

pub(crate) struct Read<T>(pub T);

impl<T: LayoutRead> Erased for Read<T> {
    fn id(&self) -> TypeId {
        TypeId::of::<T>()
    }

    fn name(&self) -> &'static str {
        std::any::type_name::<T>()
    }

    fn start(&self, parts: &Parts) -> Option<Running> {
        let read = self.0.start(parts)?;
        Some(Box::pin(async move { Box::new(read.await) as Box<dyn Any + Send> }))
    }

    fn draw(&self, value: &(dyn Any + Send), out: &mut String) {
        if let Some(value) = value.downcast_ref::<T::Value>() {
            T::view(value).render(out);
        }
    }
}

/// A read in progress, polled with the request: dropped with it, which stops it.
pub(crate) type Running = Pin<Box<dyn Future<Output = Box<dyn Any + Send>> + Send>>;

/// One read for one request: running, done, or failed (it panicked).
enum Step {
    Running(Running),
    Done(Box<dyn Any + Send>),
    Failed,
}

/// A read started for one request: its index in the app's list, where it is, and whether it
/// looked up who is asking.
struct Started {
    index: usize,
    step: Step,
    asked: Arc<AtomicBool>,
}

/// The reads started for one request.
#[derive(Default)]
struct Reads(Vec<Started>);

impl Reads {
    /// Polls each running read once; true when none is left running.
    fn poll(&mut self, cx: &mut Context<'_>, shared: &crate::page::Shared) -> bool {
        let mut done = true;
        for Started { index, step, .. } in &mut self.0 {
            let Step::Running(read) = step else { continue };
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| read.as_mut().poll(cx))) {
                Ok(Poll::Pending) => done = false,
                Ok(Poll::Ready(value)) => *step = Step::Done(value),
                Err(panic) => {
                    let name = shared.layout_reads.get(*index).map_or("", |read| read.name());
                    let message = crate::task::panic_message(&*panic);
                    tracing::error!("corten: the layout read {name} panicked, so the layout draws nothing for it: {message}");
                    *step = Step::Failed;
                }
            }
        }
        done
    }
}

/// Whether the request's reads have started.
#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    /// Not yet: the route has not been called, is a write's, or is not one `#[corten::routes]` made.
    Waiting,
    Started,
    /// Never, for this request: its answer is `Public` or JSON, or it is a `HEAD` (no body).
    Refused,
}

/// On a request for a whole document in an app with layout reads. A page route
/// (`#[corten::routes]`) answering a `GET` starts them as it is called, after the app's and its
/// area's middleware, so a read sees what middleware added (as an extractor does) and runs beside
/// the handler's own reads; a `Public` or JSON route, or a `HEAD`, refuses them. They are polled
/// with the handler on the request's task and drawn by [`StartHere::fill`] into whichever page
/// answers. A page no route started them for (a write's that draws a page rather than redirect, the
/// error page of an unknown URL, a route added as a plain axum handler) starts the ones it draws as
/// it is filled, from the request's head kept for it.
#[derive(Clone)]
pub(crate) struct StartHere(Arc<Mutex<Here>>);

struct Here {
    shared: Arc<crate::page::Shared>,
    until: Option<tokio::time::Instant>,
    state: State,
    reads: Reads,
    /// The request's head, for reads started as the page is filled.
    kept: Option<Parts>,
}

impl StartHere {
    pub(crate) fn new(shared: Arc<crate::page::Shared>, until: Option<tokio::time::Instant>) -> Self {
        StartHere(Arc::new(Mutex::new(Here { shared, until, state: State::Waiting, reads: Reads::default(), kept: None })))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Here> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// As a route is called: a page's `GET` starts each of the app's reads, a write keeps the
    /// request's head for a page it may draw, and a `HEAD`, a JSON answer or a `Public` one (the
    /// same for everyone, so never one visitor's count) starts none.
    pub(crate) fn arrive(&self, req: &mut axum::extract::Request, page: bool, public: bool) {
        let mut here = self.lock();
        if here.state != State::Waiting {
            return;
        }
        if !page || public {
            here.state = State::Refused;
            return;
        }
        let (mut parts, body) = std::mem::take(req).into_parts();
        here.at_route(&mut parts);
        *req = axum::extract::Request::from_parts(parts, body);
    }

    /// As a handler takes [`crate::Req`]: for a route `#[corten::routes]` did not make (a plain
    /// axum handler), what [`StartHere::arrive`] does for a page route.
    pub(crate) fn extracted(&self, parts: &mut Parts) {
        let mut here = self.lock();
        if here.state == State::Waiting {
            here.at_route(parts);
        }
    }

    /// As the error page is called with `parts`: the reads it draws start from them when it is
    /// filled, if no route started them (an unknown URL), and a `Public` or JSON route's failure,
    /// which is one visitor's page, draws them too.
    pub(crate) fn for_error_page(&self, parts: &Parts) {
        let mut here = self.lock();
        if parts.method == axum::http::Method::HEAD {
            return;
        }
        if here.state == State::Refused {
            here.state = State::Waiting;
        }
        if here.state == State::Waiting && here.kept.is_none() {
            here.kept = Some(parts.clone());
        }
    }

    /// `page`, with the reads polled beside it once they have started.
    pub(crate) async fn beside<F: Future>(&self, page: F) -> F::Output {
        let mut page = std::pin::pin!(page);
        std::future::poll_fn(|cx| {
            // The page first: it starts the reads when the route is called.
            let polled = page.as_mut().poll(cx);
            let mut here = self.lock();
            let Here { shared, reads, .. } = &mut *here;
            reads.poll(cx, shared);
            polled
        })
        .await
    }

    /// Waits for the reads still running, no later than the request's deadline.
    async fn finish(&self) {
        let until = self.lock().until;
        let all = std::future::poll_fn(|cx| {
            let mut here = self.lock();
            let Here { shared, reads, .. } = &mut *here;
            if reads.poll(cx, shared) {
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        });
        match until {
            Some(until) => {
                if tokio::time::timeout_at(until, all).await.is_err() {
                    let here = self.lock();
                    for Started { index, step, .. } in &here.reads.0 {
                        if matches!(step, Step::Running(_)) {
                            let name = here.shared.layout_reads.get(*index).map_or("", |read| read.name());
                            tracing::warn!("corten: the layout read {name} passed the request's deadline, so the layout draws nothing for it");
                        }
                    }
                }
            }
            None => all.await,
        }
    }

    /// `res` with each value drawn where its page put [`later`]. Waits for a read no later than the
    /// request's deadline; one the page gave a value for, or that no place draws, is dropped
    /// instead, which stops it. A read that looked up who is asking makes the answer private when
    /// its value is drawn. A response that is not a page with places is returned as it is.
    pub(crate) async fn fill(&self, mut res: Response) -> Response {
        let Some(pending) = res.extensions_mut().remove::<Pending>() else { return res };
        let given = res.extensions_mut().remove::<Given>();
        let given = given
            .map(|Given(given)| std::mem::take(&mut *given.lock().unwrap_or_else(PoisonError::into_inner)))
            .unwrap_or_default();
        let gifts: Vec<TypeId> = given.iter().map(|(id, _)| *id).collect();
        let wanted = |id: TypeId| pending.slots.iter().any(|slot| slot.id == id) && !gifts.contains(&id);
        let (shared, refused) = {
            let mut here = self.lock();
            if here.state == State::Waiting {
                if let Some(mut parts) = here.kept.take() {
                    here.start_with(&mut parts, wanted);
                }
            }
            let refused = here.state == State::Refused;
            let Here { shared, reads, .. } = &mut *here;
            reads.0.retain(|started| !refused && shared.layout_reads.get(started.index).is_some_and(|read| wanted(read.id())));
            (shared.clone(), refused)
        };
        self.finish().await;
        let reads = std::mem::take(&mut self.lock().reads.0);
        // Each value by its read's type, and whether that read looked up who is asking. A `Public`
        // page draws none, not even one it gave.
        let mut values: Vec<(TypeId, Box<dyn Any + Send>, bool)> = Vec::new();
        if !refused {
            values.extend(given.into_iter().map(|(id, value)| (id, value, false)));
        }
        for Started { index, step, asked } in reads {
            if let (Step::Done(value), Some(read)) = (step, shared.layout_reads.get(index)) {
                values.push((read.id(), value, asked.load(Ordering::Relaxed)));
            }
        }
        let (head, body) = res.into_parts();
        let Ok(page) = axum::body::to_bytes(body, usize::MAX).await else {
            return Response::from_parts(head, Body::empty());
        };
        let page = std::str::from_utf8(&page).unwrap_or_default();
        let mut personal = false;
        let out = splice(page, &pending.slots, |_, slot, out| {
            let Some((_, value, asked)) = values.iter().find(|(id, ..)| *id == slot.id) else { return };
            match shared.layout_reads.iter().find(|read| read.id() == slot.id) {
                Some(read) => {
                    if draw(&**read, &**value, &shared, &pending.signal, out) {
                        personal |= *asked;
                    }
                }
                None => unregistered(slot.name),
            }
        });
        if personal {
            pending.signal.mark_personal();
        }
        Response::from_parts(head, Body::from(out))
    }
}

/// A release build's page that draws a read the app does not start (a debug build refuses the
/// page): logged once.
#[cold]
fn unregistered(name: &str) {
    static LOGGED: AtomicBool = AtomicBool::new(false);
    if !LOGGED.swap(true, Ordering::Relaxed) {
        tracing::warn!("corten: a page draws later::<{name}>(), a read the app does not start, so nothing is drawn there: add App::layout_read({name}{{..}})");
    }
}

impl Here {
    /// A `GET` starts every read now; a write keeps its head, for a page it may draw rather than
    /// redirect; a `HEAD` (no body) starts none.
    fn at_route(&mut self, parts: &mut Parts) {
        use axum::http::Method;
        match parts.method {
            Method::GET => self.start_with(parts, |_| true),
            Method::HEAD => self.state = State::Refused,
            _ => {
                if self.kept.is_none() {
                    self.kept = Some(parts.clone());
                }
            }
        }
    }

    /// Starts each read `wanted` takes, with `parts` marked so a caller it looks up is noted as
    /// its own.
    fn start_with(&mut self, parts: &mut Parts, wanted: impl Fn(TypeId) -> bool) {
        self.state = State::Started;
        let shared = self.shared.clone();
        for (index, read) in shared.layout_reads.iter().enumerate() {
            if !wanted(read.id()) {
                continue;
            }
            let asked = Arc::new(AtomicBool::new(false));
            parts.extensions.insert(Asking(asked.clone()));
            if let Some(running) = read.start(parts) {
                self.reads.0.push(Started { index, step: Step::Running(running), asked });
            }
        }
        parts.extensions.remove::<Asking>();
    }
}

/// Draws `read`'s view of `value` into `out`, in the request's zone; true when it was drawn. A
/// view is markup alone: one that uses a component's script or a `style={..}` value, which the
/// page's head was written without, draws nothing and is logged as an error, as is one (in a debug
/// build) that renders a component `App::components` does not list for every page.
fn draw(
    read: &dyn Erased,
    value: &(dyn Any + Send),
    shared: &crate::page::Shared,
    signal: &crate::Signal,
    out: &mut String,
) -> bool {
    #[cfg(feature = "zones")]
    let _zone = shared.zoned_dates.then(|| crate::i18n::ZoneScope::enter(crate::i18n::Scope::of(signal.zone(), signal)));
    #[cfg(not(feature = "zones"))]
    let _ = signal;
    let mut view = String::new();
    #[cfg(debug_assertions)]
    let ((((), used), modules), vars) =
        crate::style::collect_vars(|| crate::script::collect(|| crate::style::collect(|| read.draw(value, &mut view))));
    #[cfg(not(debug_assertions))]
    let (((), modules), vars) = crate::style::collect_vars(|| crate::script::collect(|| read.draw(value, &mut view)));
    let what = if !modules.is_empty() {
        Some("a component's script")
    } else if !vars.is_empty() {
        Some("a style={..} value")
    } else {
        None
    };
    #[cfg(debug_assertions)]
    let what = what.or_else(|| {
        used.iter()
            .any(|c| !shared.components.contains(c.name) || shared.section_of.contains_key(c.name))
            .then_some("a component App::components does not list for every page")
    });
    match what {
        None => {
            out.push_str(&view);
            true
        }
        Some(what) => {
            let message = format!(
                "corten: the layout read {}'s view uses {what}, which the page's head was written without, so nothing is drawn for it: draw that part in the layout and give the view the text",
                read.name()
            );
            if !shared.dev {
                eprintln!("{message}");
            }
            tracing::error!("{message}");
            false
        }
    }
}
