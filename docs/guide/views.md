# Views

[Back to the guides](../../README.md#documentation)

`html!` reads like JSX and compiles to `push_str` calls: static markup is merged at compile
time, expressions are escaped as they are written, and the output buffer is sized from the last
render of the same call site.

| Write | Means |
|---|---|
| `"Price"` | text (source whitespace between tags is never output) |
| `{expr}` | an expression, escaped: anything that implements `Render` (strings, numbers, `Option`, other views) or else `Display`. `raw(html)` prints trusted HTML; markup a view rendered ahead goes in `req.rendered(view)` (a `corten::Rendered`) instead, which keeps the sizes and scripts its render noted. Not inside `<script>` or `<style>`, which do not read escaped text back: there it does not compile |
| `href={url}`, `href={("/items/", &id)}` | an attribute; a tuple prints its parts without building a string |
| `hidden={flag}`, `class={maybe}` | `bool` prints the bare name or nothing; `None` leaves the attribute out |
| `<input {..e.aria(field)}>` | spreads `Attrs` |
| `for`, `if`/`else`, `match`, `let` | as in Rust, with markup in the braces; patterns too (`if let Shape::Circle { r } = shape`) |
| `<Card title="x" compact>children</Card>` | a component: a struct with those fields (`compact` is `true`), children in `children` |
| `<>...</>`, `<!DOCTYPE html>`, `<input>` | fragments, the doctype, void elements without a closing tag |

`#[component]` turns a function into a props struct and a `Render` impl, so the same
component renders inside a page and on its own as a patch, and the two cannot drift. A view owns
what it captures and renders once, so it can be returned from a function.

Every prop is written where the component is used, an empty one too: `head=""` for a page that
adds no head tags, `toast={None}` for no toast. A prop left out does not compile, so the markup
always says what the component gets. Rust has no stable way to leave a struct field to a default
(default field values are unstable), and filling a left-out `impl Render` prop would fix its type
for every caller. When several answers build one component with most props the same, a function
gives the common value and each answer changes its part:
`Gallery { toast: Some(SAVED), ..listings(&req, &none) }`.

## Accessible names

A name a screen reader would drop does not compile. ARIA prohibits a name on an element with no
role, so `aria-label` or `aria-labelledby` on a `<div>` or `<span>` with no `role`, or on an `<a>`
with no `href`, is refused, and so is a written-out name on an `<a>` whose `href={..}` is an
`Option` or `bool`, which is no link when it writes nothing. Put the name in the element as text
(`<span class={VisuallyHidden {}}>"Previous shipment"</span>` beside an icon), which stays when the
`href` does not, or give the element the role it plays (`role="img"`). A `role` or a spread (which
may write one) exempts the element, as does a name that is itself an expression
(`aria-label={before.map(..)}`), which can be absent with the href. Elements inside an `<svg>`
in the same `html!` are not checked: an SVG `<a>` with no href is a group, which may be named (a
component that draws an SVG fragment without its `<svg>` says `role="group"`). The check reads
the `href`'s type where `html!` is written, so a generic `href` (a type parameter) passes it.
The rest of a page's accessibility is an audit's to find in a browser ([app](app.md#accessibility)).

## The document

A page is a whole HTML document, built from components like everything else: the app's layout
component with the page in it. `corten new` writes the layout in `src/views.rs`, and it is the
app's to change; Corten adds nothing around it.

```rust
use corten::prelude::*;

# corten::assets::embed! { pub struct Static = "src/assets/fixture"; }
// The files in `static/`, compiled into the program (`App::assets(Static)`):
// corten::assets::embed! { pub struct Static = "static"; }

#[component]
fn Layout(req: &Req, title: &str, head: impl Render, children: impl Render) -> impl Document {
    html! {
        <!DOCTYPE html>
        <html lang={req.lang()}>
            <head>
                <meta charset="utf-8">
                <link rel="stylesheet" href={req.asset(Static::STYLE_CSS)}>
                <title>{title}" | Shop"</title>
                {head}
                <Corten />
            </head>
            <body>
                <header>"Shop"</header>
                <main>{children}</main>
            </body>
        </html>
    }
}

async fn about(req: Req) -> HtmlResult {
    let head = html! { <meta name="description" content="Who we are"> };
    req.page(html! { <Layout req={&req} title="About" head={head}><h1>"About"</h1></Layout> })
}
```

`html!` that starts with `<html>` (or `<!DOCTYPE html>`) is a `Document`, and so is a component
that returns `impl Document`; `req.page`, `req.screen` and the error page take one. The
markup is checked when it compiles: one `<head>` with one `<title>` and one `<Corten />`, and
one `<main>`, not inside a `for`, `if` or `match`. Each part renders for the requests that use it:

| Part | Full load | Client navigation | Data client (`req.screen`) |
|---|---|---|---|
| `<title>`'s text | yes | yes | yes, as `"title"` |
| an expression or component in `<head>` (`{head}`): the page's own tags | yes | yes, each marked `data-corten-head` so the next page's replace them | no |
| `<Corten />`: the runtime, the import map, the page's scripts and stylesheets | yes | the area stylesheets the page needs | no |
| `<main>`'s children: the page | yes | yes | no |
| everything else: the header, the footer, the layout's own tags | yes | no: the runtime keeps what the page has (after a write that redirects, it draws again what changed: below) | no |

So the layout costs a navigation nothing, and what the layout shows that a navigation cannot
update (the signed-in user, from a `Caller` the handler took) is covered by the page key: when it
changes, the runtime loads the next page in full. Keep a layout's props to what most pages set (the title,
their head tags); a page that needs a different document uses another layout. Each layout's
`html!` document has a key of its own (from where it is written), so a link from a page in one
layout to a page in another loads it in full, with no `data-reload`. A prop that changes the
layout around `<main>` (a promo bar on some pages only) is not seen by a navigation: make that a
second layout.

A layout is a component like any other, so it can have a stylesheet and a script of its own
(`#[component(css, js)]`): its markup calls its handlers (`on:connect={js::watch(signal)}` on a
toaster in its `<body>`) and names its classes in each part above, as in the whole document, so
the toaster's handler is drawn on a full load and kept by a navigation. List it in its area's
`App::components`, as any component with a stylesheet.

The runtime fetches a same-origin link's page after the pointer rests on it for 65 ms (or a
touch starts), so the click shows it at once; it keeps the 8 newest for 10 seconds and aborts
the request of one it drops, so the server sees the client go. A page that is costly to draw (a
report that takes seconds) says so on its route, `#[route("/reports/suggested", get = suggested,
prefetch = false)]`: every `href={..}` to it, a route held as `&dyn Href` included, is written
with `data-no-prefetch`, and only a click starts its work. A route costly only for some of its
URLs (a workflow step that calls another service) names a function of the route that says which
may be fetched on a hover, `#[route("/export", get = export, prefetch = cheap)]` with
`fn cheap(at: &url::Export<'_>) -> bool { at.step != Some(Step::PullSheet) }` (named from where
the routes module is declared, as a handler is: beside `mod url`; a route outside a routes
module writes `#[route("/export", prefetch = cheap)]` and takes `&Export<'_>`), and every link
to those URLs is written with `data-no-prefetch`: in a nav and through a component's `&dyn Href`
prop too, so no link has to remember. The function sees only the URL, so a URL whose cost depends
on stored state (a visit with no step that resumes at the first step not done) answers `false`.
The runtime's prefetch says `Purpose: prefetch`, and a debug
build logs one whose page took longer than half a second, naming its URL, so a page that grew
slow is found before someone measures every screen. A prefetch the visitor clicks is the visit,
with no further request, so a server answers it as it would a click; only the browser knows
which prefetches were followed, so count visits there. An answer to a prefetch that is not a page
(a proxy's `204` or `503`) is not used: the click fetches the page itself, and a hover within
the prefetch's 10 seconds does not ask again. Corten's own redirect (to a place on a page, or to
another origin) is a page's answer: the click follows it. `data-no-prefetch` by
hand on a link or an element around links does the same for links that are not routes, and
`data-reload` loads the page in full instead of a client navigation (and is never prefetched).

Who is signed in reaches the layout the same way as everything else, as a prop the handler
passes: `viewer={viewer.as_deref()}` from the `Option<Caller<Viewer>>` it took. A layout does not
read the request itself. Rendering is synchronous and `Identify` is not (a session store, a
token check), so a layout could not look the viewer up while it renders. Reading it there would
need a second async step before each full-page render, and its own rules for a failed lookup,
for caching it per request and for the page key. In the handler the lookup runs once, only on the
routes that ask for it, and the type says which pages show a viewer. A page with more than one call site keeps the viewer in its own
function's parameters (`fn alerts_page(req: &Req, viewer: Option<&Viewer>, ..)`), as watchlist does.

A value only the layout shows and that needs a read of its own (a cart's count, an unread count)
is a layout read: declared once, `impl LayoutRead for CartCount`, registered with
`App::layout_read(CartCount(shared.clone()))`, and drawn where the layout puts
`{later::<CartCount>()}`. No handler, helper or closure that draws the layout takes it:

```rust,ignore
/// The header's cart count, for whoever is signed in: holds the app's state, as a handler's
/// `State` does.
pub struct CartCount(pub Shared);

impl LayoutRead for CartCount {
    type Value = Option<u32>;

    fn start(&self, parts: &Parts) -> Option<impl Future<Output = Option<u32>> + Send + 'static> {
        // What the read uses, taken by value: it outlives this call.
        let (state, parts) = (self.0.clone(), parts.clone());
        Some(async move {
            let Caller(viewer) = Caller::<Viewer>::find(&parts, &state).await.ok()?;
            Some(state.carts.count(&viewer).await)
        })
    }

    fn view(count: &Option<u32>) -> impl Render + '_ {
        html! { if let Some(count) = count { <span class={CartBadge}>{*count}</span> } }
    }
}

// The layout, where the count goes (outside <main>):
// <a href={url::Cart}>"Cart"{later::<CartCount>()}</a>
```

Corten starts the read as a page route is called for a `GET` of a whole document (a full load, a
reload, the page a write redirects to), after the app's and the area's middleware, and polls it with
the handler on the request's task, so a full load waits for the longer of the two, not their sum. A
page route is one whose handler returns a page (`HtmlResult`, `PageOr`, or an app's own answer type
that wraps one and says so with `const PAGE: bool = true` in its `Answer`); one that returns a file,
text or JSON starts nothing, and neither does a `HEAD` or one of Corten's own paths. (A plain axum
handler that takes `Req` starts it whatever it answers, since its answer type is not known there,
and so does a `PageOr` or `SwitchOr` that answers a file or an upgrade; the read is dropped unused.
A `Public` answer draws no read's value however it was started.) Once the handler has drawn the
page, Corten draws the read's `view` where the layout put `later`, before the app's middleware sees
the page; one read fills every place that names it. A place goes in the `<body>` around `<main>`:
`<head>` and its `<title>` are sent with each navigation, which does not start the read, so a debug
build refuses a page that draws one there. A write that draws a page rather than redirect (a refused
form without JavaScript) starts the reads its page draws once it has answered, so it waits for them.
A navigation or a `data-patch` action keeps the header the full load drew, so the read is not
started for it, nor for an API or a data client. A `Public` page is the same for everyone, so it
draws nothing there, and a `Public` page route never starts the read. An answer that draws no layout
(a redirect) drops a read still running, which stops it; one already in stays for an error page the
app's middleware makes of the answer. A read that fails or passes the request's deadline draws
nothing in its place and is logged; the page is still sent. The error page for a failure the request
is at fault for (an unknown URL, a wrong method, a refusal other than a 429, an extractor's or a
handler's `Err(Refused::forbidden())?`, a form that does not read) starts the reads not started
yet and waits for them as a page does, so a 404 shows the count every other page shows. A read it starts sees the head its extractors see (the URL, the
cookies, `Authorization`, the language and the request's caller), not what the app's middleware
added; one that has nothing to read without a session should return `None` from `start`, which
keeps an unknown URL a scanner asks for as cheap as before. For any other failure (a handler's
`Error` at any status but 404, a 5xx, a 429, which slows a client down, a cross-site write,
refused before anything runs) it starts none and waits for none: it draws a value only if its read is
in by the time the page is drawn, since what made the request fail (a database that is down) is
likely what the read needs too. A patch or a live fragment is not a page and fills no place: pass it the
value instead (`req.patch(Badge { count })`). A `later` whose `to_html()` string the page never
writes draws nothing and is no error, and the page does not wait for its read. In a debug build, a
`later` for a read the app does not start, one inside `<main>` (which a navigation would not fill),
one in a patch, one rendered as text or whose `to_html()` string is placed twice, or one on a page
whose answer type does not say it is a page, is an error naming it; one in a live fragment is
logged. A release build checks less, so test the page in a debug build: a read it does not start, a
page whose answer type is not a page, and a place in a patch or a live fragment draw nothing and are
logged once; a place inside `<main>` draws the value on a full load and nothing on a navigation, and
one in `<head>` (its `<title>` included) draws nothing, both unlogged; one rendered as text stays as
that text (logged once); and a string placed twice is filled once. A `HEAD` starts no read, so its
`Content-Length` and `ETag` are those of the page drawn without its values.

The read looks the caller up with `Caller::find`, which shares the request's one lookup with the
handler. A page that draws a value a read looked a caller up for is private, but that caller is
not part of the page's key: a navigation does not start the read, so its key must not depend on
it. A handler that takes the caller still keys the page by them. Signing in or out is a write
that redirects, which draws the layout again; a sign-out in another tab shows in this one at its
next full load.

The view is markup to display: it gets the value alone (no `Req`), so the value carries what it
shows (formatted text, a count), and it is drawn in the visitor's time zone. The page's head is
written before it is drawn, so a view that uses a component's script or a `style={..}` value
draws nothing and is logged as an error; draw such a part in the layout itself.

A page that has the value already (the cart page, which read the cart) gives it,
`req.page(..)?.give::<CartCount>(Some(lines.len() as u32))`, and Corten draws that without
waiting for the read; its `start` can return `None` for that path to skip the read.

A value both the page and the layout use (who is signed in, which the page greets by name) stays
a prop the handler passes. A read the handler itself needs and wants started early is a
`corten::Ahead`, `Ahead::start(read)` in an extractor and awaited where it is used; `Mode::of`
reads the request's mode before the handler has its `Req`. `Ahead` is `tokio::spawn` with the two
things a request needs and a bare task lacks: dropped, it stops the read (a bare task would run on
after the client left), and its panic fails the request.

A write that redirects (`req.redirect`, `req.redirect_with_notice`) needs nothing more: the
runtime fetches the page it sends the browser to whole, as a full load does (`Mode::Document`, so
the layout read starts), swaps in `<main>` and replaces each element around it that
the server now draws otherwise, in the same document. The header shows the count the write made,
with JavaScript as without, and only the navigation after a write pays the layout's reads; every
other navigation still keeps the header. When that page reads itself again
([`ReadAgain`](requests-and-forms.md#a-read-that-has-not-caught-up-yet), while the write's read
catches up), each read is whole too, until one that no longer asks: a count the layout could not
read yet is drawn when a read finds it, as the reload a browser without JavaScript makes draws it,
and a read that changes nothing, in the page or around it, leaves the page as it is. The notice
the page drew is sent back with each read, so a toaster that showed it is not emptied by the read.
Each such read costs a whole document's read and parse, and the layout's own reads, every few
seconds while the write is behind. A layout element that differs on every render (below) is
drawn again on every such read, not only once per write. Each element the server drew beside `<main>` and beside
each element around it, up to `<body>`, is compared with what the server sent for it, and one that
changed is replaced as a patch replaces it, keeping what the user typed or opened; one that did not
stays as it is, and what a script added beside them stays too. One a patch changed since (a count
inside the header) is compared with what the server drew and the patches since put there, so a
page that draws what the patch drew leaves it as it is. One a patch went into where the server's
markup has no element of its id, or that took so many appended elements that its copy would hold
well more than it does (a feed a script trims), is drawn again from the new page. A page that differs in any other
way around `<main>` loads in full, as a browser without JavaScript loads it: an element more or
fewer beside one (a banner shown now), an attribute of `<main>` or of an element around it (`lang`,
a theme on `<html>`), or the layout's own head tags (not the page's values for `style={..}`,
which are set on what is swapped in). The frame the first write's page is compared with is
read from the page as it loaded, so what a browser extension added before the runtime started (an
attribute on `<html>`, a `<style>` in `<head>`) is in it: a write's page only has to add or change
nothing there, and an attribute or head tag the server stops writing (a theme turned off) stays
until a full load, since a script's or an extension's (a theme a blocking script set before first
paint, Dark Reader's marks) looks the same. A layout that turns one off writes the off state
(`data-theme="light"`, not no attribute), so the write's page differs and loads in full. After that the
frame is the last write's page, as the server sent it. An element a script or an extension adds
beside `<main>`'s ancestors after the runtime starts stays; one an extension adds to `<body>`
before it starts is taken as the layout's, so each write's page, which lacks it, loads in full.
Until a write's page is swapped in, every navigation reads the whole page, so one the user starts
before it arrives draws what the write changed as well. A patch that lands in a layout element
after the write's page has come and before it is drawn (while the stylesheets or scripts it needs
load) is newer than the page and wins: the element keeps the patch. A layout element
whose markup differs on every render (a form with a submit key, a `<corten-live>` with its
position) is replaced on every such write, and on every read again of a write's page, keeping
what the user typed but losing what scripts did to it (a stream reconnects); keep it out of the
layout, or draw it in a component a patch updates. A layout element whose live region shows the
redirect's notice is drawn again even when its markup is the same, so the same notice twice is
shown twice (the notice's text elsewhere, a "Saved searches" link for "Saved", does not count);
a live region in it (the toaster's `role="status"`) stays and takes the new message, so it is
announced as a patch's is. Around a live region, what the server draws as it drew it before (with
the patches since, a toast's or a cart count's) stays as a script left it (the toaster's close
button it showed), and what it draws otherwise is updated in place, so a script that holds an
element there keeps holding the one on the page; an element updated in place takes the server's
attributes, so one a script set on it (`aria-expanded`, a class) goes, as it does when a patch
replaces it, while a `<details>` or `<dialog>` the user opened or closed stays so. Inside a layout
element, the elements must be the server's: one whose children a script added to or took from is
replaced whole, live region and all, so a script adds its own markup beside the layout's elements
(as the toaster's region is) or inside a live region. The page a write sends the browser to is
fetched as a document, so when it redirects again, `fetch` follows that redirect itself: a
`#id` on the second one is not kept, and one to another site loads in full.

A write that answers in place, with a patch rather than a redirect, draws what it changed itself.
The badge is a component the layout renders and a patch can carry (an `#[derive(Id)]` on it), and
the write reads the value directly, not through the extractor above (which skips the read for its
`Mode::Action` answer), and only for the patch: without JavaScript the redirect's next page is a
full load that reads it.

```rust,ignore
#[component]
fn CartBadge(count: Option<u32>) -> impl Patch {
    html! { <span id={CartBadgeId}>{count.unwrap_or(0)}</span> }
}

async fn add_to_cart(req: Req, carts: State<Carts>, viewer: Caller<Viewer>) -> HtmlResult {
    carts.add(&viewer, ..).await?;
    if req.mode == Mode::Action {
        let count = carts.count(&viewer).await;
        return req.patch(CartBadge { count: Some(count) });
    }
    req.redirect(&url::Cart)
}
```

Corten has no layout slot that fills itself: the layout is the app's component (design rule 10),
so the value reaches it as a prop, and the read stays where the handler can see it, its failure
included.

A nav link is written from one mention of its route, `<a {..req.nav(&url::News)}>"News"</a>`:
`href`, `data-nav` and `aria-current="page"` when it is the page (`req.nav_section` for a link
that stays current on the pages under it). The full load renders `aria-current`, and the runtime
moves it after each client navigation, so the header is right without rendering again. It does
the same after a patch that puts a nav link on the page, which the server marked against the
request that made the patch (a form's action), not the page. A link it makes current, or finds
current when it first sees it (on a full load, or in a row a write's page or a patch draws
again), is put in the middle of the nearest box around it that overflows sideways and scrolls
(a nav row wider than the bar), or its start at the box's when it is wider, when it is shown and
out of that box's view: at once, in the next frame, and never by scrolling the page. A link that
stays current is left where the user scrolled it, and so is one in a row in `<main>` the user
scrolled sideways (back to its start too) when a swap keeps their place (`data-keep-place`, a read
again). A tag
that writes `href`, `data-nav` or `aria-current` itself beside the spread does not compile, nor
does `data-nav` written by hand.

Each `req.nav` link is judged alone, so a section and a page under it (Seller Desk at
`/account/desk`, Money at `/account/desk/money`) are both current on Money's page. A nav whose
entries nest, or that is read from data, is written whole with `req.nav_of`: of its entries
that hold the page, only the deepest is current. Its links carry the group they were ranked in
(`data-nav-group`), so the runtime ranks the same links after a client navigation wherever the
markup puts them, so render every link it gives back: leave out an entry the user may not see
before the call. Each entry comes with its item (a label, or the row it was read from), which
`links()` hands back beside its link. An entry is a route or a `Local` path, written as the
browser asks for it (a link to another site is a plain link, never current):

```rust,ignore
let nav = req.nav_of(items.iter().map(|item| (NavTo::section(&item.href), item)));
html! { <nav>for (link, item) in nav.links() { <a {..link}>{&item.label}</a> }</nav> }
```

Structured data for search engines is a head tag too: `head={JsonLd { value: &product }}`
(feature `json`) writes a `ToJson` value in `<script type="application/ld+json">` with `<` as
`\u003c`, so a description that says `</script>` cannot end it. An expression written inside
`<script>` in `html!` does not compile, because it would be escaped as HTML.

`html!` that is one component is that component: its props are evaluated where the markup is,
so `req={&req}` borrows the handler's `req`. A prop that borrows something the function made
for the view is made inside the markup, where the view owns it:

```rust,ignore
fn job_dialog(job: &Job) -> impl Render + '_ {
    html! {
        let title = format!("{} rows", job.rows);   // owned by the view
        <Dialog title={&title}>{job.summary}</Dialog>
    }
}
```

With the `let` outside the `html!`, the view would borrow a local of a function that has
returned (E0515). `let`s and a layout component are a document, like the layout alone, and `let`s and a patch
component are a patch.

A view lent to a prop inside another view (`action={&html! { .. }}`), or to a call written in its
markup (`{keep_query(&at, &html! { .. })}`), is built and rendered inside the view around it, so it borrows what it uses instead of owning it: a step bar's action and the
panel below it read the same `name`, without `let name = name.as_ref();` first. A view given by
value (`view={html! { .. }}`) still owns what it uses, since the component may keep it, and so
does one inside a closure of its own (`.map(|row| html! { .. })`) and one lent to a prop of the
component a whole `html!` is, whose props are evaluated where the `html!` is written.

The view a handler gives `req.page(..)` owns what it uses too, like any view at the top of an
`html!`, so it can be returned from a function. A local the markup reads that something made
before the markup also borrows is passed to it as a reference: `let found = found.as_ref();`
before the `html!` (E0505 otherwise).

## Typed links and messages

The strings that usually drift between files are Rust types, checked when the app compiles.

```rust,ignore
#[derive(Route)]
#[route("/items/{id}")]
pub struct ItemRoute<'a> { pub id: &'a str, pub tab: Option<&'a str> }   // tab is a query parameter

corten::i18n::messages! {
    pub struct Msg { "en" => "locales/en.json", "fr" => "locales/fr.json" }
}

// in the app's #[corten::routes] module, each route names its handler:
// #[route("/items/{id}", get = show)] pub struct ItemRoute<'a> { .. }

#[derive(Id)]
pub struct OfferId<'a>(pub &'a str);                                          // offer-{key}

let t: Msg = req.t();
html! {
    <a href={ItemRoute { id: &item.id, tab: None }}>{item.title}</a>       // /items/a%20b
    <p>{t.item_show_all_offers(item.offers.len())}</p>
    <li id={OfferId(&offer.id)}>{offer.seller}</li>                         // a patch's target
}
req.patch(html! { {Remove(OfferId(&sold.id))} })                             // the same id
```

| What | Fails to compile when |
|---|---|
| `#[derive(Route)]` | the path names a parameter the struct lacks, text comes before a parameter in its segment, a link leaves a field out |
| `messages!` | a locale lacks a key or has an extra one, a message takes different arguments in another locale, a call names a missing key or leaves out an argument, or passes one that is not text, an integer or a value `t` formats (a float goes through `t.number`) |
| `#[derive(Href)]` | a variant holds no link or more than one (a unit variant has no URL) |
| `#[derive(UrlValue)]` | the enum has a variant with fields, a variant serde does not read (`skip_deserializing`), or a serde attribute that changes its words in a way it does not follow |
| `#[derive(Id)]` | `Remove` is given text instead of an id type; two ids in one program have the same name (each is a linker symbol, `corten__two_ids_are__offer`; name each after its feature, `ShippingOfferId`); the struct holds more than one key |
| `#[component(css)]`, `#[component(js)]` | two components in one program have the same name, so they would style one `.name__*` or serve one `scripts/name.js` (each is a linker symbol, `corten__two_components_style__offer_list`, `corten__two_scripts_are__offer_list`) |
| `#[component(view)]`, `#[event]` | two views or two typed events in one program have the same name, since `corten/views` and `corten/events` export one class of a name and the page dispatches one event of a name (`corten__two_views_are__Row`, `corten__two_events_are__RowToggled`, and `corten__two_events_named__url_changed` for two classes with one event name, `UrlChanged` and `URLChanged`) |

An id is the type's name without `Id`, in kebab case (`OfferId` is `offer-`, then the key; a
unit struct, `StatusId`, is just `status`). Use one for every element a patch replaces or
removes, and for `for`, `popovertarget` or `commandfor` across components. Its name is a linker
symbol, and so is the class prefix of a component with a stylesheet and the name of one with a
script: names are global to the app, so two features that each write a `SettingsForm` (or a
`SettingsFormId`) in one crate fail to compile, rather than the app when it starts. `cargo check`
and an editor report it too, at both sites (E0428, "the name `corten__two_ids_are__settings_form`
is defined multiple times", pointing at each `#[derive]` or `#[component]`), because each name is
also a hidden exported macro. Name them by feature (`ShippingSettingsForm`). For the same reason,
a crate that re-exports two libraries with `pub use` globs (`pub use orders::*; pub use
shipping::*;`) gets an `ambiguous_glob_reexports` warning naming that macro when the two share
such a name. Across crates (a feature's library and the app), the pair fails to link once the program uses both, in every profile (debug, release,
thin or fat LTO) on the architectures named below: each item's constant points at a static of its own beside its symbols, so a
program that lists a component, or in a debug build (every test is one) renders it or writes an
id, loads them. That holds although a linker takes a
library's object file only for a symbol it needs (as a Windows GNU link did, leaving a library's
namesake out so the program linked). A namesake the program does not use may still fail to link:
a linker takes an object file whole, so whether the unused one comes in depends on what else in
that object file the program uses, which the build profile decides (how the compiler split the
crate, or merged it under LTO; under LTO it always does) and which can differ between targets.
Rename one of the two rather than rely on it being left out. Under LTO the check is a second
symbol of the name with `.link` after it (`corten__two_ids_are__offer.link`, which the link
error names), written in assembly, which Rust supports on x86, Arm, RISC-V, LoongArch and s390x;
on other targets (PowerPC, MIPS) a release build with LTO links a pair, so build in debug there
before a release. The same holds
for a `script!` module, served by its name as a component's script is. The check is the declaration's, not the page's: two
identical declarations of one component (a module declared in both `lib.rs` and `main.rs`, a
macro that writes one component in several modules) fail too, so declare each once. A library's
ids and scripts (a crate with a script prefix, which their names in the page carry) also carry
its version, so two versions of one library in a program still link; its classes do not carry
the prefix (`.card__*`), so a library's `Card` with a stylesheet and the app's clash, and nor do
its views and typed events (one name each in `corten/views` and `corten/events`), so two versions
of a library with them (corten-ui's `Copied`) do not link.

Routes write their URL straight into the page (path parameters percent-encoded, `None` query
parameters left out). A query field is anything `Display`; an enum in an address (a tab, a sort,
what a redirect says happened) derives `UrlValue` beside `Deserialize`, which writes each
variant as the word serde reads (`#[serde(rename_all = "kebab-case")]`: `AwaitingLabel` is
`awaiting-label`), so the link and the handler cannot disagree.

A component several pages draw (a filter and sortable table that two screens share) takes where
its links and forms go from the page, typed: a prop `action: &'a dyn Href` takes any route (or a
place on a page, `route.at(Id)`), written straight into `action={action}` with no `String`. A
value that is one of several routes (an app's screens, the links a shared list makes, one per
column) is an enum whose variants each hold one, `#[derive(Href)] enum Screen<'a> {
Inventory(url::Inventory), PullSheet(url::PullSheet<'a>) }`, written as `href={screen}`, and the
page passes a function that builds it, `link: &'a dyn Fn(SortBy) -> SheetLink<'a>`. A unit
variant does not compile (it has no URL), and neither does text where a `&dyn Href` goes. When
one enum of every page's route would tie together modules that should stay apart (the pages that
draw a shared list live in separate features), the function returns a boxed link instead,
`link: &'a dyn Fn(SortBy) -> Box<dyn Href + 'a>`, and `href={link(by)}` takes the box as it is. A
part of each row the page decides (a detail one screen shows) is a function the same way,
`detail: &'a dyn Fn(&Item) -> Box<dyn Render + 'a>`, drawn as `{detail(item)}`.

Messages are split into text and arguments when the crate compiles: one
without arguments is a `&'static str`, one with arguments writes its pieces into the page,
escaped, with no lookup and no intermediate string. Editing a catalog rebuilds the crate.

A count's text is a plural message: a form per plural category, with the suffixes i18next uses
(`"items_one": "{count} item"`, `"items_other": "{count} items"`), and one method,
`t.grid_items(count)`, which picks the form by CLDR's rules for the locale and writes the count
as `t.number` does (`1,234 items`). Never pick a form with `count == 1`: French puts 0 in `one`
and a million in `many`, Polish has `few` and `many`, Japanese has `other` alone. A catalog has
exactly the forms its language's whole numbers use, and `_other`, or the build fails and names
the missing one with a number that needs it (`fr` uses `_many` for 1000000). Text for none
("No items yet") is a message of its own the view chooses, since `zero` is not a category in
most languages.

### Text: literals or the catalog

An app chooses once, by how many locales it has:

1. **One locale.** Fixed text is a literal in the view (`<h1>"Statement"</h1>`). The catalog
   holds only what a literal cannot be: a count with its plural (`grid.items_one` and
   `grid.items_other`, one message, `t.grid_items(count)`), text with arguments, and text a script fills in
   (`t.js().prices_updates()`). Numbers, money and dates still go through `t`, which writes them
   for the locale.
2. **More than one locale.** Every word a reader sees goes through the catalog, so a locale that
   lacks one does not compile. A name that is the same in every language (the store's) may stay
   a literal.

Moving from the first to the second is mechanical: each literal becomes a key. card-market is
the second kind (English and French); watchlist, seller-desk, deck-builder, ui-gallery and listings-feed are
the first.

A message with one argument takes it as the method's parameter (`t.grid_items(count)`). One with two
or more takes them by name, in a struct the catalog's module has for it (`Msg`'s is `msg`), so two
values cannot trade places and rewording the default text, which moves its arguments, moves no
call:

```rust,ignore
// "pager.summary": "{rangeStart}–{rangeEnd} of {total}"
<p>{t.pager_summary(msg::PagerSummary { range_start, range_end, total })}</p>
```

The fields are the arguments' names in snake case (`{rangeStart}` is `range_start`, a Rust
keyword a raw identifier, `r#type`), and a field left out, misspelled or renamed in the default
locale does not compile. A plural with more than its `{count}` takes `count` as a field too.
The module is one `messages!` adds beside the catalog, as visible as it, so a view names it as
it names the catalog (`use crate::text::{msg, Msg};`), and an item of the same name next to the
catalog clashes with it.

A message the page cannot name in its source, because another service answers with its key
(`{"titleKey": "queue.item.title", "titleParams": {..}}`), is `t.by_key(key, &args)`: the
message with that catalog key (dotted, as in the JSON) in the request's locale, its arguments
taken by name from `args` (pairs, a map or a JSON object). It is `None` when the catalog has no
such key or `args` lacks one of its arguments (an `Option` renders nothing when `None`), so the
page chooses what to show instead. Prefer the methods wherever the page knows the message.

Numbers, money and dates are written by `t` in the request's locale too, on the server, so a
price or a time is right on the first paint with no script:

```rust,ignore
const USD: Currency = Currency::new("USD");
html! {
    <td>{t.money(Minor(line.cents), USD)}</td>                           // $1,234.50, 1 234,50 $US
    <td>{t.money(Decimal::parse(&api.amount).unwrap_or_default(), USD)}</td> // "21.50" from an API
    <td>{t.number(listing.count)}</td>                                     // 1,234
    <td>{t.percent(Decimal::new(fee_bps, 4), 2)}</td>                      // 2.9%, 2,9 %, %2,9
    <td>{t.change(Decimal::new(stock.change_bp, 4), 2)}</td>               // +0.60%, -0.30%, 0.00%
    <td>{t.signed_money(Minor(sale.cents - cost.cents), USD)}</td>         // +$3.20, -$1.23, $0.00
    <p>{t.item_pending(t.date_time(at, DateStyle::Medium, TimeStyle::Short))}</p> // Mar 22, 2026, 12:00 PM UTC
    <p>{t.account_member_since(t.date(joined, MonthStyle::Long))}</p>     // Member since March 2025
}
```

`t.percent(ratio, digits)` takes the ratio (0.029 for 2.9%, so 290 basis points are
`Decimal::new(290, 4)`) and writes at most `digits` fraction digits, rounded half away from zero
and without trailing zeros, with the locale's sign where it puts it. `t.change(ratio, digits)` is
the same ratio as a change (a price's move today, in a column that lines up): exactly `digits`
fraction digits and a sign on a gain as on a loss (`+0.60%`, `+0,60 %`, `+%0,60`), none on what
rounds to zero (`0.00%`). `t.signed_money(amount, currency)` writes a difference between two amounts
the same way, a plus sign on a gain and none on what rounds to zero (`+$3.20`, `+3,20 $US`),
with the sign where the locale puts it, so a page never builds a sign by hand. `t.money` takes `Minor` units (cents) or a `Decimal` in the major unit, never a float and never
a bare integer (it could be either, so it does not compile), with the digits the currency is
shown with (0 for JPY, 3 for KWD), which a `Currency` carries from when it is made (at compile
time for a `const` one), so they are not looked up for each amount. A price a person types into a form is read back the same way:
`t.parse_money(&input.price, USD)` is `Some(Minor(129950))` for `$1,299.50` in en and for
`1 299,50 $US` or `1299,5` in fr (with or without the symbol, the code, the groups or the
fraction, and without the direction marks some locales write), and `None` for a sign, a group of
the wrong size, a grouped number that starts with `0` (`0,500`), another locale's decimal
separator, more fraction digits than the currency has or an amount over `u64`. Every amount
every locale writes reads back, so a form never reads money
as a float or with a parser of its own. `MonthStyle` writes the month and year without the day, in
the locale's order and words (`Mar 2026`, `März 2026`), and `DayStyle` the month and day without
the year (`Mar 2`, `2 mars`), for a chart's axis or a week's row whose year the page says once;
neither has a time, so `t.date_time` takes neither. A date is in UTC unless `.zone(Offset::hours(-5))` or a zone
of your own (`corten::i18n::Zone`, for one with daylight saving time) says otherwise, so a page
reads the same wherever it is rendered; `parse_timestamp` reads the RFC 3339 text APIs send.
For dates where the visitor is ("your listings come back on Nov 2"), the app turns on Corten's
`zones` feature (jiff and its bundled tz database) and sets `App::zoned_dates()`; the feature
alone changes no app's dates, so a library that turns it on does not change yours.
The runtime keeps the browser's zone (`America/Chicago`) in a cookie from the first page it
loads, so the form posts and pages after it carry it, and while Corten renders a request's
answer, `t.date`, `t.time` and `t.date_time` write in that zone, with its daylight saving
rules: no handler takes the zone and no component is given it. `.zone(..)` still chooses
another (a store's own zone). A page that writes a date in the visitor's zone answers privately
(`Cache-Control: private`), and the zone is not part of the page's key, so it does not make the
runtime load the next page in full; a date the layout writes is drawn in `LocalTime` for that
reason (a navigation keeps the layout's text from the first page). `req.zone()` is the zone itself (a
`corten::i18n::Visitor`, a `Zone`), for turning a picked date into the instant it means there;
`Option<ClientZone>` is its name. Both are UTC (`None`) on a browser's first page, before it
has reported its zone, and without JavaScript; draw a date the first page shows in
`corten_ui::LocalTime`, whose script writes it again in the browser's zone there, in the
server's own format, so it is right on the first page too. A date in an attribute
(`title={..}`) has no element to write again and stays in UTC on that page. A live part's
fragments, rendered as the stream is read, are in the zone too. A value that names a day rather
than an instant (a report's window, a week's start, a due date, an API's `"2026-09-02"`) is a
`corten::i18n::Day`, which `t.date(day, style)` writes as that day in every zone; it has no
`.zone(..)` and no time, so the compiler keeps it from being written as an instant. `Day` parses
`YYYY-MM-DD` (what `<input type="date">` sends), reads and writes JSON and serde as that text,
and `day.midnight_utc()` is the instant where a query needs one (an `Option`: `None` before the
earliest instant the platform has, 1601 on Windows; `t.date` writes every day). A script writes
a day with `format("2026-09-02")` and no offset. A day already kept as an
instant at UTC midnight takes `.zone(Utc)`, or it reads a day early west of UTC. A script's `t.js().date(..)` writes UTC unless
it is given an offset (`format(at, { offset })`, the browser's at that instant), and `to_string()`
or `format!` in a handler is UTC: only Corten's render knows the zone, and a `req.screen`'s data
takes `.zone(req.zone())` where it formats a date itself. A `Public` answer is the same for
everyone, so it is written as for a visitor whose zone is not known (UTC, `req.zone()` too) and
stays shared; its `LocalTime`s are written again in the browser. The zone rules are the bundled database's
(`jiff-tzdb`), updated with `cargo update -p jiff-tzdb`. A date rendered once and kept across
requests (a footer in a `OnceLock`, a fragment a cache shares) takes `.zone(..)`, as a value a
cache keeps never holds one visitor's data: rendered during a request, it would be in that
visitor's zone for everyone. `App::client_zone()` alone learns the zone for `req.zone()` and
`Option<ClientZone>` and writes dates as before.

A time relative to now ("resets in 10 hours", "updated 3 min. ago") is `t.relative(at, now,
RelativeStyle::Long)` (or `Short`, `Narrow`): in the largest unit it has a whole one of, rounded
toward zero, in the locale's plural forms. Written that way it is right only when drawn, so put it
in `corten_ui::RelativeTime`, which renders a `<time datetime>` and has the browser write it
again, in the same locale and style, each time its text would change, on one timer for the page.
A live part then sends only when its data changes, not to move a countdown, and its server does
not redraw every open page on a clock:

```rust,ignore
html! { <p>"Resets "<RelativeTime when={t.relative(window.resets_at, now, RelativeStyle::Long)} /></p> }
```

Days are the largest unit ("in 45 days"); a time further off reads better as `t.date`. The
browser counts from its own clock and writes with its own `Intl.RelativeTimeFormat`, so a browser
whose CLDR is older than the server's may word a unit slightly differently once it takes over, and
one without the locale (or with only another script of it) keeps the server's text. Without
JavaScript the text is as old as the page. With it, a page from a cache or the back/forward cache
is written again as it shows, and a page in a hidden tab is brought up to date when it is shown.

Each listed locale's separators, currency symbols and date patterns are CLDR's, checked against
Intl, and only the locales `messages!` lists are in the app. A script that writes a number, an
amount or a date takes the page's format (`t.js().money(USD)`) and writes the same text
([Scripts](scripts.md#numbers-money-and-dates-a-script-writes)).
