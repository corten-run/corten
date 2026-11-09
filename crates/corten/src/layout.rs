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

use axum::{
    body::Body,
    http::request::Parts,
    response::{IntoResponse, Response},
};

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
/// something other than a page (a file, text, JSON) or Corten's own paths. (A plain axum handler
/// that takes [`crate::Req`] starts it whatever it answers, since its answer type is not known
/// there; the read is dropped unused.) A [`crate::Public`]
/// page is the same for everyone, so it draws no one's value. A write that draws a page rather
/// than redirect (a refused form without JavaScript) starts the reads its page draws once it has
/// answered. The error page for a failure Corten finds the request at fault for (an unknown
/// address, a wrong method, a refusal other than a 429 by an extractor or by the handler's own
/// `Refused` (a 429 slows a client down), a request that does not parse) starts the reads not
/// started yet and waits for them as a page does, so a 404 draws the count every other page does.
/// For any other failure (a handler's [`crate::Error`] at any status but 404, a 5xx, a 429, a
/// cross-site write) it starts none and waits for none: it
/// draws a value only if its read is in already, since what made the request fail (a database
/// that is down) is likely what the read needs. An answer that draws no layout (a redirect) drops
/// the read, which cancels it. A place goes in the `<body>` around `<main>`, not in `<head>` or
/// `<title>`, which a navigation sends: a
/// debug build refuses a page that draws one there, or that renders one as text or places its
/// `to_html()` string twice. A patch is not a page: it is passed the value (a `later` in one is a
/// debug error).
///
/// ```
/// use std::future::Future;
/// use corten::{http::{header, request::Parts}, prelude::*, LayoutRead};
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
///         // Nothing to read without a session, so an unknown URL a scanner asks for costs none.
///         parts.headers.get(header::COOKIE)?;
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
/// dropped with the request. A panic in it or in its view, or a read still running at the request's
/// deadline, draws nothing where the layout put it (and is logged) rather than failing the page. The read
/// takes what it uses by value; one that borrows the request does not compile:
///
/// ```compile_fail,E0597
/// use std::future::Future;
/// use corten::{http::request::Parts, prelude::*, LayoutRead};
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
/// # use corten::{http::request::Parts, prelude::*, LayoutRead};
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
    /// nothing to read (no one is signed in). Not called for a route whose page gives the value
    /// itself and says so, `#[route("/cart", get = cart, gives(CartCount))]`
    /// ([`crate::HtmlResponse::give`]). Whatever it uses is taken by value: the read is
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

/// Where a value goes while the page is on the server: `<!--corten-later-K-N-->`, `K` the
/// page's token ([`Places::token`], 16 hex digits) and `N` its place in the page's list. Corten
/// draws the value there or removes it, by the place's offset noted as it rendered, so the same
/// text from `raw(..)` is left alone.
pub(crate) const MARK: &str = "<!--corten-later-";

/// A token for one page's marks, drawn as its first place renders: from a key drawn once per
/// process and a count, so text a page renders itself (`raw(..)`, a value from data) never reads
/// as a place, and a token seen in one page is no use in another.
fn fresh_token() -> u64 {
    use std::hash::BuildHasher;
    static KEY: std::sync::OnceLock<std::collections::hash_map::RandomState> = std::sync::OnceLock::new();
    static COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    // Never 0, which is a page that has not drawn one yet.
    KEY.get_or_init(Default::default).hash_one(COUNT.fetch_add(1, Ordering::Relaxed)) | 1
}

/// `token` as a mark writes it: 16 lowercase hex digits.
fn hex(token: u64) -> [u8; 16] {
    let mut out = [0; 16];
    crate::ascii::hex(token, &mut out);
    out
}

/// Writes place `index`'s whole mark in the page whose token is `token`.
fn write_mark(token: u64, index: usize, out: &mut String) {
    use std::fmt::Write;
    out.push_str(MARK);
    out.push_str(std::str::from_utf8(&hex(token)).expect("hex digits"));
    let _ = write!(out, "-{index}-->");
}

/// Place `index`'s whole mark in the page whose token is `token`.
pub(crate) fn mark(token: u64, index: usize) -> String {
    let mut out = String::with_capacity(MARK.len() + 24);
    write_mark(token, index, &mut out);
    out
}

/// One place the page drew for a read: which read, and where in the page its mark starts.
#[derive(Clone, Copy)]
pub(crate) struct Slot {
    pub id: TypeId,
    pub name: &'static str,
    pub at: usize,
    /// In `<head>` (the `<title>` included), which a navigation sends: never filled.
    pub head: bool,
    /// Its mark is in the page as markup (not rendered into a string the page never wrote).
    pub placed: bool,
}

/// The places a page drew for reads, in the order it drew them, and the token its marks hold (0
/// until it draws one).
#[derive(Clone, Default)]
pub(crate) struct Places {
    pub token: u64,
    pub slots: Vec<Slot>,
}

thread_local! {
    /// The places of the page being rendered; `None` outside a page.
    pub(crate) static SLOTS: std::cell::RefCell<Option<Places>> = const { std::cell::RefCell::new(None) };
}

impl<T: LayoutRead> Render for Later<T> {
    fn render(&self, out: &mut String) {
        let place = SLOTS.with_borrow_mut(|places| {
            let places = places.as_mut()?;
            if places.token == 0 {
                places.token = fresh_token();
            }
            places.slots.push(Slot {
                id: TypeId::of::<T>(),
                name: std::any::type_name::<T>(),
                at: out.len(),
                head: false,
                placed: false,
            });
            Some((places.token, places.slots.len() - 1))
        });
        match place {
            Some((token, index)) => write_mark(token, index, out),
            None => not_in_a_page(std::any::type_name::<T>()),
        }
    }
}

/// `later` rendered outside a page (a patch, a live fragment, a string of its own), or in a
/// release build of an app that starts no layout reads: nothing is drawn there. Logged once for
/// each read.
#[cold]
fn not_in_a_page(name: &'static str) {
    static LOGGED: std::sync::Mutex<Vec<&'static str>> = std::sync::Mutex::new(Vec::new());
    if !first_time(&LOGGED, name) {
        return;
    }
    tracing::warn!(
        "corten: later::<{name}>() was rendered outside req.page (a patch or a live fragment passes the value itself) or in an app that does not start it (App::layout_read), so nothing is drawn there"
    );
}

/// A page's place whose mark is not in it as markup (rendered as text, or into a string the page
/// never wrote): nothing is drawn there. Logged once for each read.
#[cold]
fn not_placed(name: &'static str) {
    static LOGGED: std::sync::Mutex<Vec<&'static str>> = std::sync::Mutex::new(Vec::new());
    if first_time(&LOGGED, name) {
        tracing::warn!(
            "corten: the page renders later::<{name}>() as text or into a string it does not write, so nothing is drawn there: render it in html!, once for each place"
        );
    }
}

/// Whether `name` is not in `logged` yet, adding it.
fn first_time(logged: &std::sync::Mutex<Vec<&'static str>>, name: &'static str) -> bool {
    let mut logged = logged.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let first = !logged.contains(&name);
    if first {
        logged.push(name);
    }
    first
}

/// Where the mark of place `index` that starts at `at` ends, when it is there.
fn mark_end(page: &str, token: u64, at: usize, index: usize) -> Option<usize> {
    // Exactly as `write_mark` writes it: the token's lowercase digits, the index's decimal ones.
    let rest = page.get(at..)?.strip_prefix(MARK)?;
    if rest.as_bytes().get(..16)? != hex(token) {
        return None;
    }
    let rest = rest[16..].strip_prefix('-')?;
    let digits = rest.find("-->")?;
    let number = &rest[..digits];
    // No sign and no leading zero: `write!` writes neither.
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) || (number.len() > 1 && number.starts_with('0')) {
        return None;
    }
    (number.parse::<usize>().ok()? == index).then_some(at + MARK.len() + 16 + 1 + digits + 3)
}

/// Each place where its mark is now: one rendered through a string of its own (a component that
/// renders part of itself with `to_html`) is not where its offset was noted, so it is found by its
/// whole mark, which only Corten writes (it holds the page's token).
pub(crate) fn locate(page: &str, places: &mut Places) {
    let token = places.token;
    for (index, slot) in places.slots.iter_mut().enumerate() {
        slot.placed = mark_end(page, token, slot.at, index).is_some();
        if !slot.placed {
            if let Some(at) = page.find(&mark(token, index)) {
                slot.at = at;
                slot.placed = true;
            }
        }
    }
}

/// `page` with each place's mark replaced by what `draw` writes for it (nothing, for a page Corten
/// does not fill). A place out of order (see [`locate`]) is found by its whole mark.
fn splice(page: &str, token: u64, slots: &[Slot], mut draw: impl FnMut(usize, &Slot, &mut String)) -> String {
    let mut out = String::with_capacity(page.len() + 64 * slots.len());
    let mut rest = 0;
    let mut moved = Vec::new();
    for (index, slot) in slots.iter().enumerate() {
        match mark_end(page, token, slot.at, index).filter(|_| slot.at >= rest) {
            Some(end) => {
                out.push_str(&page[rest..slot.at]);
                draw(index, slot, &mut out);
                rest = end;
            }
            None => moved.push(index),
        }
    }
    out.push_str(&page[rest..]);
    // A place out of order: found by its whole mark, which no other place or text has.
    for index in moved {
        let mark = mark(token, index);
        match out.find(&mark) {
            Some(at) => {
                let mut drawn = String::new();
                draw(index, &slots[index], &mut drawn);
                out.replace_range(at..at + mark.len(), &drawn);
            }
            None => not_placed(slots[index].name),
        }
    }
    out
}

/// `page` without its places: one Corten does not fill (a navigation's `<main>`, a data client,
/// a `Public` answer, a router used without [`crate::App`]).
pub(crate) fn strip(page: &mut String, places: &Places) {
    if places.slots.is_empty() {
        return;
    }
    *page = splice(page, places.token, &places.slots, |_, _, _| {});
}

/// On a [`crate::Public`] answer: the same for everyone, so no layout read's value is drawn in it.
#[derive(Clone, Copy)]
pub(crate) struct SameForAll;

/// A page with places for values, which [`StartHere::fill`] draws.
#[derive(Clone)]
pub(crate) struct Pending {
    pub places: Places,
    pub signal: crate::Signal,
}

/// A value the page gave in place of a read, by the read's value type.
type Gift = (TypeId, Box<dyn Any + Send>);

/// Values the page gave in place of a read ([`crate::HtmlResponse::give`]).
#[derive(Clone, Default)]
pub(crate) struct Given(pub Arc<Mutex<Vec<Gift>>>);

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
    /// Started, or the route answered with no page to fill: none is started after.
    Started,
    /// Never, for this request: its answer is `Public`, or it is a `HEAD` (no body).
    Refused,
    /// Never: its route's answer type is not a page (`Answer::PAGE`), JSON or a file.
    NotAPage,
}

/// On a request for a whole document in an app with layout reads. A page route
/// (`#[corten::routes]`) answering a `GET` starts them as it is called, after the app's and its
/// area's middleware, so a read sees what middleware added (as an extractor does) and runs beside
/// the handler's own reads; a `Public` or JSON route, or a `HEAD`, refuses them. They are polled
/// with the handler on the request's task and drawn by [`StartHere::fill`] into whichever page
/// answers. A plain axum handler starts them as it takes [`crate::Req`]. A write that draws a page
/// rather than redirect starts the ones it draws as it is filled, from the request's head kept for
/// it. The error page for a failure the request is at fault for starts those not started yet and waits for them
/// (`StartHere::at_error_page`); for any other failure it starts none and draws those in already.
#[derive(Clone)]
pub(crate) struct StartHere(Arc<Mutex<Here>>);

struct Here {
    shared: Arc<crate::page::Shared>,
    until: Option<tokio::time::Instant>,
    state: State,
    reads: Reads,
    /// The request's head, for reads started as the page is filled.
    kept: Option<Parts>,
    /// The error page is for a failure the request is at fault for, so it waits for its reads.
    error_waits: bool,
    /// The reads the route's `GET` page gives itself (`gives(..)`), so not started for it.
    gives: &'static [fn() -> TypeId],
    /// The values a filled page gave itself, kept for an error page made of it.
    given: Vec<Gift>,
}

/// `gives(CartCount)` on a route in a `#[corten::routes]` module: the layout reads its `GET`
/// page gives itself ([`crate::HtmlResponse::give`]), so none of them is started for it.
#[derive(Clone, Copy)]
pub(crate) struct Gives(pub(crate) &'static [fn() -> TypeId]);

/// Whether `id` is one of the reads `gives` names.
fn names(gives: &[fn() -> TypeId], id: TypeId) -> bool {
    gives.iter().any(|given| given() == id)
}

impl StartHere {
    pub(crate) fn new(shared: Arc<crate::page::Shared>, until: Option<tokio::time::Instant>) -> Self {
        StartHere(Arc::new(Mutex::new(Here {
            shared,
            until,
            state: State::Waiting,
            reads: Reads::default(),
            kept: None,
            error_waits: false,
            gives: &[],
            given: Vec::new(),
        })))
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
            here.state = if public { State::Refused } else { State::NotAPage };
            return;
        }
        let (mut parts, body) = std::mem::take(req).into_parts();
        here.at_route(&mut parts);
        *req = axum::extract::Request::from_parts(parts, body);
    }

    /// As a handler takes [`crate::Req`]: for a route `#[corten::routes]` did not make (a plain
    /// axum handler), what [`StartHere::arrive`] does for a page route.
    pub(crate) fn extracted(&self, parts: &mut Parts) {
        // The error page starts its reads as it is called (`at_error_page`), not as it takes `Req`.
        if parts.extensions.get::<crate::Signal>().is_some_and(crate::Signal::is_error_page) {
            return;
        }
        let mut here = self.lock();
        if here.state == State::Waiting {
            here.at_route(parts);
        }
    }

    /// As the error page is drawn for a failure the request is at fault for (`waits`:
    /// `Failure::request_at_fault`): starts the reads not started yet (an unknown address, a write's), with the
    /// error page's head, and has the page wait for them, no later than the request's deadline.
    /// A `HEAD` starts none, and a request whose answer was `Public` stays refused.
    pub(crate) fn at_error_page(&self, parts: &mut Parts, waits: bool) {
        let mut here = self.lock();
        if !waits || parts.method == axum::http::Method::HEAD {
            return;
        }
        here.error_waits = true;
        if here.state == State::Waiting {
            here.kept = None;
            here.start_with(parts, |_| true);
        } else if here.state == State::Started && !here.gives.is_empty() {
            // The route's page would have given these; the error page is not that page. One the
            // page did give is kept, drawn as the page drew it.
            let gives = std::mem::take(&mut here.gives);
            let given: Vec<TypeId> = here.given.iter().map(|(id, _)| *id).collect();
            here.start_with(parts, |id| names(gives, id) && !given.contains(&id));
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

    /// Waits for the reads still running, no later than the request's deadline; with `now`, polls
    /// them once and waits for none (the error page for a failure the request is not at fault for,
    /// a 5xx, a 429, a handler's own error: what made the request fail,
    /// a database that is down, is likely what the read needs, and the failure is not held up for
    /// it).
    async fn finish(&self, now: bool) {
        let until = if now { Some(tokio::time::Instant::now()) } else { self.lock().until };
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
            // The request's deadline: the page is sent without the values still running. It ends
            // on the same tick as the request's own timer, and wins only because nothing after
            // this waits before the page is answered (the page's body is in memory, so reading it
            // is ready at once, and the request's timer polls the page first): a wait added after
            // it would turn a page in time into a 503.
            Some(until) => {
                if tokio::time::timeout_at(until, all).await.is_err() {
                    let mut here = self.lock();
                    if !now {
                        for Started { index, step, .. } in &here.reads.0 {
                            if matches!(step, Step::Running(_)) {
                                let name = here.shared.layout_reads.get(*index).map_or("", |read| read.name());
                                tracing::warn!("corten: the layout read {name} passed the request's deadline, so the layout draws nothing for it");
                            }
                        }
                    }
                    // Dropped, which stops them: nothing waits for them after this, whatever the
                    // page turns out to be.
                    here.reads.0.retain(|started| !matches!(started.step, Step::Running(_)));
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
        let Some(pending) = res.extensions_mut().remove::<Pending>() else {
            // No page with places (a redirect, a page that draws none, JSON): the reads still
            // running are dropped now rather than polled while the app's middleware runs. Those in
            // already stay for an error page the middleware may still turn this into, and a route's
            // own error keeps them all for its error page.
            if !res.status().is_client_error() && !res.status().is_server_error() {
                std::future::poll_fn(|cx| {
                    let mut here = self.lock();
                    let Here { shared, reads, .. } = &mut *here;
                    // Those running are polled once first. Called from the route's future
                    // (`middleware::handle`), this is before `beside` polls the reads on the tick the
                    // route answered, so a read done on that tick is in; called after `beside`,
                    // none is running.
                    if reads.0.iter().any(|started| matches!(started.step, Step::Running(_))) {
                        reads.poll(cx, shared);
                    }
                    reads.0.retain(|started| matches!(started.step, Step::Done(_)));
                    here.kept = None;
                    if here.state == State::Waiting {
                        here.state = State::Started;
                    }
                    Poll::Ready(())
                })
                .await;
            }
            return res;
        };
        let given = res.extensions_mut().remove::<Given>();
        let given = given
            .map(|Given(given)| std::mem::take(&mut *given.lock().unwrap_or_else(PoisonError::into_inner)))
            .unwrap_or_default();
        let gifts: Vec<TypeId> = given.iter().map(|(id, _)| *id).collect();
        // A read is waited for only when a place draws it: one never written (`to_html()` dropped)
        // or in `<head>` draws nothing.
        let wanted = |id: TypeId| {
            pending.places.slots.iter().any(|slot| slot.id == id && slot.placed && !slot.head) && !gifts.contains(&id)
        };
        // An answer for everyone (`Public`) draws no one's value, whatever started the reads (a
        // plain axum handler that took `Req`).
        let for_all = res.extensions().get::<SameForAll>().is_some();
        let (shared, refused, error_waits) = {
            let mut here = self.lock();
            // A write that draws a page starts the reads it draws now. The error page started those
            // it waits for as it was called (`at_error_page`).
            let kept = here.kept.take();
            if here.state == State::Waiting && !pending.signal.is_error_page() && !for_all {
                if let Some(mut parts) = kept {
                    here.start_with(&mut parts, wanted);
                }
            }
            // An answer type of the app's own that wraps a page and does not say so: its page draws
            // nothing in a release build, and a debug build says why.
            if here.state == State::NotAPage && !pending.signal.is_error_page() && !pending.places.slots.is_empty() {
                let name = pending.places.slots[0].name;
                if !cfg!(debug_assertions) {
                    not_a_page(name);
                } else {
                    let dev = here.shared.dev;
                    drop(here);
                    // About the app's code: the error page keeps it outside dev too.
                    let message = format!(
                        "the page draws later::<{name}>(), but its route's answer type says it is not a page (Answer::PAGE), so no read is started for it: return HtmlResult, or set const PAGE: bool = true on the answer type (or forward its page's)"
                    );
                    return crate::page::unserved(dev, message).into_response();
                }
            }
            // A route that says its page gives a read (`gives(..)`) did not start it, so a page that
            // draws it without giving it draws nothing there: a debug build refuses that page.
            if !here.gives.is_empty() && !pending.signal.is_error_page() {
                let said = here.gives;
                let missing = pending
                    .places
                    .slots
                    .iter()
                    .find(|slot| slot.placed && !slot.head && names(said, slot.id) && !gifts.contains(&slot.id));
                if let Some(slot) = missing {
                    if !cfg!(debug_assertions) {
                        not_given(slot.name);
                    } else {
                        let dev = here.shared.dev;
                        drop(here);
                        let message = format!(
                            "the page draws later::<{0}>() and its route says gives({0}), so the read is not started, but the page did not give it: give it (page.give::<{0}>(..)), or take gives({0}) off the route",
                            slot.name
                        );
                        return crate::page::unserved(dev, message).into_response();
                    }
                }
            }
            let refused = for_all || matches!(here.state, State::Refused | State::NotAPage);
            let Here { shared, reads, error_waits, .. } = &mut *here;
            reads.0.retain(|started| !refused && shared.layout_reads.get(started.index).is_some_and(|read| wanted(read.id())));
            (shared.clone(), refused, *error_waits)
        };
        self.finish(pending.signal.is_error_page() && !error_waits).await;
        let (head, body) = res.into_parts();
        let page = match axum::body::to_bytes(body, usize::MAX).await {
            Ok(page) => page,
            Err(error) => {
                let error: &(dyn std::error::Error + 'static) = &error;
                tracing::error!(error, "corten: a page with layout reads could not be read to fill it");
                return crate::Error::new("corten: the page could not be read").into_response();
            }
        };
        // Not text: a layer inside the route changed the body (compressed it), so its places
        // cannot be found; sent as it is.
        let Ok(page) = std::str::from_utf8(&page) else {
            tracing::error!("corten: a page with layout reads is not text by the time it is filled (compressed inside the route?), so nothing is drawn in it");
            return Response::from_parts(head, Body::from(page));
        };
        let mut personal = false;
        // A view that drew this request's submit key makes the page one no tag stands for
        // (`cache::Unrepeatable`), as the page's own render does.
        crate::form::DREW_KEY.set(false);
        // The reads in are drawn from where they are and stay there, and the values the page gave
        // are kept beside them (`Here::given`), for an error page the app's middleware may still
        // make of this page, which draws them as this one does (#911); they live as long as the
        // request. Held to the end of the splice: a read's view is given no request, so nothing
        // it draws takes this again.
        let mut here = self.lock();
        here.reads.0.retain(|started| matches!(started.step, Step::Done(_)));
        // Each value by its read's type, and whether that read looked up who is asking. A `Public`
        // page draws none, not even one it gave (and started none, so none is in).
        let mut values: Vec<(TypeId, &(dyn Any + Send), bool)> = Vec::new();
        if !refused {
            values.extend(given.iter().map(|(id, value)| (*id, &**value, false)));
            // An error page made of a filled page: what that page gave, after the error page's own.
            values.extend(here.given.iter().map(|(id, value)| (*id, &**value, false)));
        }
        for Started { index, step, asked } in &here.reads.0 {
            if let (Step::Done(value), Some(read)) = (step, shared.layout_reads.get(*index)) {
                values.push((read.id(), &**value, asked.load(Ordering::Relaxed)));
            }
        }
        let out = splice(page, pending.places.token, &pending.places.slots, |_, slot, out| {
            // A read the app does not start draws nothing, a value the page gave included; looked
            // for first, wherever the place is, so it is logged.
            let Some(read) = shared.layout_reads.iter().find(|read| read.id() == slot.id) else {
                unregistered(slot.name);
                return;
            };
            if slot.head {
                return;
            }
            let Some((_, value, asked)) = values.iter().find(|(id, ..)| *id == slot.id) else { return };
            if draw(&**read, *value, &shared, &pending.signal, out) {
                personal |= *asked;
            }
        });
        drop(values);
        // What the page gave stays for that error page, moved, not copied; a `Public` page's stays
        // out, as its reads do.
        if !refused && !given.is_empty() {
            here.given = given;
        }
        drop(here);
        if personal {
            pending.signal.mark_personal();
        }
        let mut res = Response::from_parts(head, Body::from(out));
        if crate::form::DREW_KEY.take() {
            res.extensions_mut().insert(crate::cache::Unrepeatable);
        }
        res
    }
}

/// A release build's page from a route whose answer type does not say it is a page
/// (`Answer::PAGE`), which draws no read's value (a debug build refuses the page): logged once.
#[cold]
fn not_a_page(name: &'static str) {
    static LOGGED: std::sync::Mutex<Vec<&'static str>> = std::sync::Mutex::new(Vec::new());
    if first_time(&LOGGED, name) {
        tracing::warn!("corten: the page draws later::<{name}>(), but its route's answer type says it is not a page (Answer::PAGE), so nothing is drawn there: return HtmlResult, or set const PAGE: bool = true on the answer type");
    }
}

/// A release build's page whose route says it gives a read (`gives(..)`) and that did not (a
/// debug build refuses the page): logged once.
#[cold]
fn not_given(name: &'static str) {
    static LOGGED: std::sync::Mutex<Vec<&'static str>> = std::sync::Mutex::new(Vec::new());
    if first_time(&LOGGED, name) {
        tracing::warn!("corten: a page draws later::<{name}>() and its route says gives({name}), but the page did not give it, so nothing is drawn there: give it, or take gives({name}) off the route");
    }
}

/// A release build's page that draws a read the app does not start (a debug build refuses the
/// page): logged once.
#[cold]
fn unregistered(name: &'static str) {
    static LOGGED: std::sync::Mutex<Vec<&'static str>> = std::sync::Mutex::new(Vec::new());
    if first_time(&LOGGED, name) {
        tracing::warn!("corten: a page draws later::<{name}>(), a read the app does not start, so nothing is drawn there: add App::layout_read({name}{{..}})");
    }
}

impl Here {
    /// A `GET` starts every read now; a write keeps its head, for a page it may draw rather than
    /// redirect; a `HEAD` (no body) starts none.
    fn at_route(&mut self, parts: &mut Parts) {
        use axum::http::Method;
        match parts.method {
            Method::GET => {
                if let Some(Gives(gives)) = parts.extensions.get::<Gives>().copied() {
                    self.gives = gives;
                }
                let gives = self.gives;
                self.start_with(parts, |id| !names(gives, id));
            }
            Method::HEAD => self.state = State::Refused,
            _ => {
                if self.kept.is_none() {
                    // Without this request's `StartHere`, which holds this: the two would keep each
                    // other (and every extension of the head) alive after the request.
                    let mut kept = parts.clone();
                    kept.extensions.remove::<StartHere>();
                    self.kept = Some(kept);
                }
            }
        }
    }

    /// Starts each read `wanted` takes, with `parts` marked so a caller it looks up is noted as
    /// its own.
    fn start_with(&mut self, parts: &mut Parts, wanted: impl Fn(TypeId) -> bool) {
        self.state = State::Started;
        // Not in the head a read takes: it is polled under this lock, so a read that takes `Req`
        // must not reach it again.
        let here = parts.extensions.remove::<StartHere>();
        let shared = self.shared.clone();
        for (index, read) in shared.layout_reads.iter().enumerate() {
            if !wanted(read.id()) {
                continue;
            }
            let asked = Arc::new(AtomicBool::new(false));
            parts.extensions.insert(Asking(asked.clone()));
            // A read that panics as it starts draws nothing, as one that panics while polled does:
            // the error page starts reads outside the handler's guard, and a layout read is not
            // the page.
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| read.start(parts))) {
                Ok(Some(running)) => self.reads.0.push(Started { index, step: Step::Running(running), asked }),
                Ok(None) => {}
                Err(panic) => {
                    let message = crate::task::panic_message(&*panic);
                    tracing::error!(
                        "corten: the layout read {} panicked as it started, so the layout draws nothing for it: {message}",
                        read.name()
                    );
                }
            }
        }
        parts.extensions.remove::<Asking>();
        if let Some(here) = here {
            parts.extensions.insert(here);
        }
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
    // A view that panics draws nothing, as a read that panics does, on the error page too.
    let mut panicked = None;
    let mut drawn = || {
        if let Err(panic) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| read.draw(value, &mut view))) {
            panicked = Some(crate::task::panic_message(&*panic).to_string());
        }
    };
    #[cfg(debug_assertions)]
    let ((((), used), modules), vars) =
        crate::style::collect_vars(|| crate::script::collect(|| crate::style::collect(&mut drawn)));
    #[cfg(not(debug_assertions))]
    let (((), modules), vars) = crate::style::collect_vars(|| crate::script::collect(&mut drawn));
    if let Some(message) = panicked {
        tracing::error!("corten: the layout read {}'s view panicked, so the layout draws nothing for it: {message}", read.name());
        return false;
    }
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

#[cfg(test)]
mod tests {
    use super::{mark, mark_end, MARK};

    /// A place's mark is found only as it is written: the page's token in lowercase digits and
    /// the index in decimal ones.
    #[test]
    fn a_mark_is_read_only_as_it_is_written() {
        let token = 0x0123_4567_89ab_cdef;
        let page = format!("<p>{}</p>", mark(token, 12));
        assert_eq!(mark_end(&page, token, 3, 12), Some(page.len() - "</p>".len()));
        assert_eq!(mark_end(&page, token, 3, 1), None);
        assert_eq!(mark_end(&page, token + 1, 3, 12), None);
        for written in [
            "0123456789ABCDEF-12-->",
            "+123456789abcdef-12-->",
            "0123456789abcdef-+12-->",
            "0123456789abcdef--->",
            "0123456789abcdef-012-->",
        ] {
            let page = format!("{MARK}{written}");
            assert_eq!(mark_end(&page, token, 0, 12), None, "{written}");
        }
    }
}
