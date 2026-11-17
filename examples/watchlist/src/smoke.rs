//! What only the browser test serves, with the app run as `SMOKE_TRUSTED_TYPES=1` (`app::for_the_smoke`):
//! a live stream whose one event is larger than a page's usual patch and is followed by nothing,
//! a page whose handler is given text with an apostrophe, quotes, `&` and `<` in it, as an
//! argument and as the value an element gives its ref, a patch drawn with this area's
//! stylesheet, which a form on a page outside the area is answered with, and a dialog and a
//! `<details>` drawn closed that a form outside each asks for again, a screen whose data a
//! script reads (`corten/read`), a screen whose scope form's answer is the page at the address
//! it asks for (`data-address`), with an editor beside a filter of that kind, and a form whose
//! fields a handler is given as its controls.
use corten::{
    Error, LiveResponse,
    http::{IntoResponse, Request, Response, StatusCode, header},
    prelude::*,
};
use futures_util::{StreamExt, stream};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::layout::Layout;

#[corten::routes(area = Smoke)]
pub mod url {
    #[route("/smoke")]
    pub struct Smoke;

    /// One event of 640 rows (it decodes to 52,395 bytes), then a quiet stream until the keepalive.
    #[route("/smoke/live/large", get = large)]
    pub struct LargeLive;

    /// A handler given text and a JSON value that have an apostrophe, quotes, `&` and `<` in them,
    /// and elements with the text or a `bool` each gives its ref.
    #[route("/smoke/quoted", get = quoted)]
    pub struct Quoted;

    /// A patch whose component is listed in this area only, for a `data-patch` form on a page
    /// outside it (the test writes the form into the watchlist).
    #[route("/smoke/styled", post = styled)]
    pub struct Styled;

    /// A page with a dialog drawn empty and closed and a `data-patch` form outside it that asks
    /// for it (#1371).
    #[route("/smoke/sheet", get = sheet_page)]
    pub struct SheetPage;

    /// The dialog drawn open, as the answer to a form that asks for it.
    #[route("/smoke/sheet/open", get = open_sheet)]
    pub struct OpenSheet;

    /// The page's `<details>` drawn open, as the answer to a form that asks for it.
    #[route("/smoke/sheet/more", get = open_more)]
    pub struct OpenMore;

    /// A form whose fields a component without a script draws, and a handler given them as its
    /// controls; two calls name a field their form does not have as they take it.
    #[route("/smoke/fields", get = fields_page)]
    pub struct FieldsPage;

    /// A screen whose data (`Reading`) its page's script reads with `read()`; `missing` answers
    /// 404 instead, and `moved` a redirect, as middleware might send.
    #[route("/smoke/reading", get = reading, data = Reading)]
    pub struct Reading {
        pub missing: Option<bool>,
        pub moved: Option<bool>,
    }

    /// A screen whose scope form says its answer is the page at the address it asks for
    /// (`data-address`, #1406): with JavaScript the address answers the scope's panel as a patch,
    /// and without it, or on a reload, the whole screen. Its Save button posts the form here.
    #[route("/smoke/scope", get = scope_page, post = scope_save)]
    #[derive(Default)]
    pub struct Scope {
        #[route(query)]
        pub q: super::ScopeQuery,
    }

    /// The scope's panel at another address than the screen's: a marked form sent there puts
    /// that address in history, and Back from it reads the screen's page, not a patch.
    #[route("/smoke/scope-elsewhere", get = scope_elsewhere)]
    #[derive(Default)]
    pub struct ScopeElsewhere {
        #[route(query)]
        pub q: super::ScopeQuery,
    }

    /// A scope the server sends on to another with a 303 ([`super::MovedBy303`]), for whichever
    /// request asks: a marked form sent here puts the address it went to in history, as the
    /// browser does without JavaScript.
    #[route("/smoke/scope-moved", get = scope_moved)]
    pub struct ScopeMoved;

    /// A marked form that is the part its patch draws, with controls named after members of an
    /// element that Back reads of the part.
    #[route("/smoke/scope-form", get = scope_form)]
    #[derive(Default)]
    pub struct ScopeForm {
        #[route(query)]
        pub q: super::ScopeQuery,
    }

    /// A screen with an editor beside a scope filter, each a marked form: the editor's Save posts
    /// its title here, and its answer draws the editor alone, outside the filter's part.
    #[route("/smoke/scope-edit", get = scope_edit, post = scope_edit_save)]
    #[derive(Default)]
    pub struct ScopeEdit {
        #[route(query)]
        pub q: super::ScopeQuery,
    }
}

/// The components the smoke's pages draw.
pub const COMPONENTS: &[corten::Component] = &[Quoted, StyledNote, ShipForm, Reader];

/// The text the handler is given, as itself and in a JSON array. `data-on` is single-quoted, so it
/// is written with `&#39;`, `&amp;` and `&lt;` and its JSON's quotes as they are.
const QUOTED: &str = r#"It's "<b>" & more"#;

#[derive(Id)]
struct QuotedId;

/// Writes what its handler was given into the page, for the test to compare: the arguments, and
/// each item with the text and the `bool` it gives its refs (`ref={said.with(..)}`), which
/// reach the script as a string and a boolean.
#[component(js)]
fn Quoted() -> impl Render {
    let (said, held) = refs();
    html! {
        <div>
            <output id={QuotedId} on:connect={js::show(target, QUOTED, [QUOTED], said, held)}></output>
            <ul>
                <li ref={said.with(QUOTED)}>{QUOTED}</li>
                <li ref={said.with("plain")}>"plain"</li>
            </ul>
            <ul>
                <li ref={held.with(true)}>"on"</li>
                <li ref={held.with(false)}>"off"</li>
            </ul>
        </div>
    }
}

async fn quoted(req: Req) -> HtmlResult {
    req.page(html! {
        <Layout req={&req} title="Quoted arguments" viewer={None} head="">
            <Quoted />
        </Layout>
    })
}

#[derive(Id)]
struct StyledNoteId;

/// A note styled by this area's stylesheet (`sections/smoke.css`), which no page outside the
/// area links.
#[component(css)]
fn StyledNote() -> impl Patch {
    html! { <p id={StyledNoteId} class={Note}>"Saved"</p> }
}

/// Answers with the note: the patch brings the area's stylesheet, so the note is styled on a page
/// outside the area as it is on one inside. Without JavaScript the form goes back to the
/// watchlist, where the test writes it.
async fn styled(req: Req) -> HtmlResult {
    req.patch_or(StyledNote {}, || async { req.redirect(&crate::app::url::Home::default()) }).await
}

#[derive(Id)]
struct SmokeSheetId;

#[derive(Id)]
struct SmokeMoreId;

/// The page: the triggers outside the dialog and the `<details>`, and the two their answers
/// replace.
async fn sheet_page(req: Req) -> HtmlResult {
    sheet(&req, false, false)
}

/// The sheet's page with the dialog (`sheet_open`) or the `<details>` (`more_open`) drawn
/// open, as a form that asks for one is answered without JavaScript.
fn sheet(req: &Req, sheet_open: bool, more_open: bool) -> HtmlResult {
    req.page(html! {
        <Layout req={req} title="Sheet" viewer={None} head="">
            <form method="get" action={url::OpenSheet} data-patch><button>"Preview"</button></form>
            if sheet_open {
                <Sheet />
            } else {
                <dialog id={SmokeSheetId}></dialog>
            }
            <form method="get" action={url::OpenMore} data-patch><button>"Unfold"</button></form>
            if more_open {
                <More />
            } else {
                <details id={SmokeMoreId}><summary>"More"</summary></details>
            }
        </Layout>
    })
}

/// The dialog drawn open, with a form inside it that asks for it again and a button that closes
/// it.
#[component]
fn Sheet() -> impl Patch {
    html! {
        <dialog id={SmokeSheetId} open>
            <p>"Preview"</p>
            <form method="get" action={url::OpenSheet} data-patch><button>"Again"</button></form>
            <button type="button" command="close" commandfor={SmokeSheetId}>"Close"</button>
        </dialog>
    }
}

/// The `<details>` drawn open.
#[component]
fn More() -> impl Patch {
    html! {
        <details id={SmokeMoreId} open>
            <summary>"More"</summary>
            <p>"Unfolded"</p>
        </details>
    }
}

/// Answers any form that asks with the dialog drawn open; without JavaScript, the sheet's page
/// with it open.
async fn open_sheet(req: Req) -> HtmlResult {
    req.patch_or(Sheet {}, || async { sheet(&req, true, false) }).await
}

/// Answers with the `<details>` drawn open; without JavaScript, the sheet's page with it open.
async fn open_more(req: Req) -> HtmlResult {
    req.patch_or(More {}, || async { sheet(&req, false, true) }).await
}

/// The scope screen's parameter, in its address.
#[derive(Clone, Default, Route, Fields)]
#[route(query)]
pub struct ScopeQuery {
    pub scope: Option<String>,
}

#[derive(Id)]
struct SmokeScopeId;

#[derive(Id)]
struct SmokeScopeFormId;

#[derive(Id)]
struct SmokeQuarterFormId;

/// The scope's panel with its form, one patch, so the form always shows the scope the panel does.
/// The form is marked `data-address`: once its answer is drawn, the address is the one it asked
/// for, and Back and Forward read this patch again. A button's `formaction`, and another marked
/// form's `action`, name a place on the page, which the address keeps; another button's is
/// another route's. A form that carries the scope (`keep_query`) is drawn by the patch too, so it
/// sends the scope on screen, not the one the page was drawn with. The marked forms have ids, so a
/// GET sent while Save is on its way is sent from the form Save's answer draws. The first scope's
/// panel has a field the others do not, but those whose name ends in draft, and a scope that starts
/// with long a panel taller than the rest of the screen.
#[component]
fn ScopePanel<'a>(scope: &'a str) -> impl Patch {
    let f = ScopeQuery::FIELDS;
    let here = url::Scope::default();
    let at = url::Scope { q: ScopeQuery { scope: (scope != "all").then(|| scope.to_string()) } };
    html! {
        <section id={SmokeScopeId}>
            <form id={SmokeScopeFormId} method="get" action={&here} data-patch data-address>
                <button name={f.scope} value="day">"Day"</button>
                <button name={f.scope} value="week">"Week"</button>
                <button name={f.scope} value="month" formaction={here.at(SmokeScopeId)}>"Month"</button>
                <button name={f.scope} value="far" formaction={url::ScopeElsewhere::default()}>"Elsewhere"</button>
                <button name={f.scope} value="moved" formaction={url::ScopeMoved.at(SmokeScopeId)}>"Moved"</button>
                <button name={f.scope} value="saved" formmethod="post">"Save"</button>
            </form>
            <form id={SmokeQuarterFormId} method="get" action={here.at(SmokeScopeId)} data-patch data-address>
                <button name={f.scope} value="quarter">"Quarter"</button>
            </form>
            <form method="get" action={&here}>
                {corten::form::keep_query(&at, &html! { <button>"Read this scope again"</button> })}
            </form>
            <p>"Scope: "<output>{scope}</output></p>
            if scope == "all" || scope.ends_with("draft") {
                <label>"Panel note "<input name="panel_note"></label>
            }
            if scope.starts_with("long") {
                <ul>
                    for i in 0..200 {
                        <li>"Line "{i}" of a long scope."</li>
                    }
                </ul>
            }
        </section>
    }
}

/// The screen: the panel, a form without the mark that draws the panel for another scope and
/// leaves the address, a note the user may type in and not send, and the rest of the screen, which
/// a change of scope does not draw again.
async fn scope_page(req: Req, Params(at): Params<url::Scope>) -> HtmlResult {
    let scope = at.q.scope.as_deref().unwrap_or("all");
    let (here, elsewhere) = (url::Scope::default(), url::ScopeElsewhere::default());
    let (here_link, elsewhere_link) = (req.nav(&here), req.nav(&elsewhere));
    req.patch_or(html! { <ScopePanel scope={scope} /> }, || async {
        req.page(html! {
            <Layout req={&req} title="Scope" viewer={None} head="">
                <ScopePanel scope={scope} />
                <form method="get" action={url::Scope::default()} data-patch>
                    <button name={ScopeQuery::FIELDS.scope} value="year">"Year, in place"</button>
                </form>
                <label>"Note "<input name="note"></label>
                <nav>
                    <a {..here_link}>"Scope"</a>
                    <a {..elsewhere_link}>"Elsewhere"</a>
                </nav>
                <ol>
                    for i in 0..120 {
                        <li>"Row "{i}" of the rest of the screen, which a change of scope does not draw again."</li>
                    }
                </ol>
            </Layout>
        })
    })
    .await
}

/// The form posted (its Save button): the panel for the scope it saved, or without JavaScript the
/// screen at that scope's address.
async fn scope_save(req: Req) -> HtmlResult {
    let saved = url::Scope { q: ScopeQuery { scope: Some("saved".into()) } };
    req.patch_or(html! { <ScopePanel scope="saved" /> }, || async { req.redirect(&saved) }).await
}

/// The scope's panel at another address, or its page there.
async fn scope_elsewhere(req: Req, Params(at): Params<url::ScopeElsewhere>) -> HtmlResult {
    let scope = at.q.scope.as_deref().unwrap_or("all");
    req.patch_or(html! { <ScopePanel scope={scope} /> }, || async {
        req.page(html! {
            <Layout req={&req} title="Elsewhere" viewer={None} head="">
                <ScopePanel scope={scope} />
            </Layout>
        })
    })
    .await
}

#[derive(Id)]
struct ScopePartId;

#[derive(Id)]
struct ScopeDraftId;

/// A marked form that is a part of its own, its patch the form alone. Its controls named
/// `contains`, `matches`, `getAttribute` and `hasAttribute` are the form's members of those names,
/// which Back's draw reads of the part it drew. The draft field has an id and no name, so it is
/// not sent.
#[component]
fn ScopePart<'a>(scope: &'a str) -> impl Patch {
    html! {
        <form id={ScopePartId} method="get" action={url::ScopeForm::default()} data-patch data-address>
            <button type="button" name="contains">"Contains"</button>
            <button type="button" name="matches">"Matches"</button>
            <button type="button" name="getAttribute">"Get attribute"</button>
            <button type="button" name="hasAttribute">"Has attribute"</button>
            <label>"Draft "<input id={ScopeDraftId}></label>
            <button name={ScopeQuery::FIELDS.scope} value="week">"Week"</button>
            <p>"Scope: "<output>{scope}</output></p>
        </form>
    }
}

/// The form's page, or its patch.
async fn scope_form(req: Req, Params(at): Params<url::ScopeForm>) -> HtmlResult {
    let scope = at.q.scope.as_deref().unwrap_or("all");
    req.patch_or(html! { <ScopePart scope={scope} /> }, || async {
        req.page(html! {
            <Layout req={&req} title="Scope form" viewer={None} head="">
                <ScopePart scope={scope} />
            </Layout>
        })
    })
    .await
}

/// The editor's revision, counted by each title it saves: one count for the app, which the
/// browser test's engines run against one after another.
static REVISION: AtomicU64 = AtomicU64::new(0);

#[derive(Id)]
struct ScopeEditorId;

#[derive(Id)]
struct ScopeFilterId;

/// The title the editor posts.
#[derive(Fields)]
struct TitleForm {
    title: String,
}

/// The editor: a marked form whose Save posts its title, the revision saved, and what the last
/// Save said. Its answer is the editor alone, a part outside the filter's.
#[component]
fn ScopeEditor<'a>(revision: u64, said: &'a str) -> impl Patch {
    html! {
        <section id={ScopeEditorId}>
            <form method="get" action={url::ScopeEdit::default()} data-patch data-address>
                <label>"Title "<input name={TitleForm::FIELDS.title}></label>
                <button formmethod="post">"Save title"</button>
            </form>
            <p>"Revision "<output>{revision}</output></p>
            <p role="status">{said}</p>
        </section>
    }
}

/// The filter: a marked form whose answer is its part, the scope it shows.
#[component]
fn ScopeFilter<'a>(scope: &'a str) -> impl Patch {
    html! {
        <section id={ScopeFilterId}>
            <form method="get" action={url::ScopeEdit::default()} data-patch data-address>
                <button name={ScopeQuery::FIELDS.scope} value="b">"Scope B"</button>
            </form>
            <p>"Scope: "<output>{scope}</output></p>
        </section>
    }
}

/// The screen with the editor and the filter.
fn scope_edit_page(req: &Req, scope: &str, said: &str, status: StatusCode) -> HtmlResult {
    let revision = REVISION.load(Ordering::Relaxed);
    req.page_with_status(
        status,
        html! {
            <Layout req={req} title="Scope and editor" viewer={None} head="">
                <ScopeEditor revision={revision} said={said} />
                <ScopeFilter scope={scope} />
            </Layout>
        },
    )
}

/// The filter's part for its scope, or the screen.
async fn scope_edit(req: Req, Params(at): Params<url::ScopeEdit>) -> HtmlResult {
    let scope = at.q.scope.as_deref().unwrap_or("all");
    req.patch_or(html! { <ScopeFilter scope={scope} /> }, || async { scope_edit_page(&req, scope, "", StatusCode::OK) }).await
}

/// The editor's Save: a title left empty is refused with a 422, and `stale` with a 409, as a
/// version check refuses a write made against what another saved since; any other is saved and
/// counted. With JavaScript the answer is the editor; without it, the screen, or after a save a
/// redirect to it.
async fn scope_edit_save(req: Req, Form(form): Form<TitleForm>) -> HtmlResult {
    let (status, said) = match form.title.trim() {
        "" => (StatusCode::UNPROCESSABLE_ENTITY, "Title is required."),
        "stale" => (StatusCode::CONFLICT, "Someone saved first."),
        _ => {
            REVISION.fetch_add(1, Ordering::Relaxed);
            (StatusCode::OK, "Saved.")
        }
    };
    match req.mode {
        Mode::Action => req.patch_with_status(status, html! { <ScopeEditor revision={REVISION.load(Ordering::Relaxed)} said={said} /> }),
        _ if status.is_success() => req.redirect(&url::ScopeEdit::default()),
        _ => scope_edit_page(&req, "all", said, status),
    }
}

/// The day's scope, by Corten's redirect, which [`MovedBy303`] answers in its place.
async fn scope_moved(req: Req) -> HtmlResult {
    req.redirect(&day_scope())
}

/// The scope a moved one is sent to.
fn day_scope() -> url::Scope {
    url::Scope { q: ScopeQuery { scope: Some("day".into()) } }
}

/// Answers every request for [`url::ScopeMoved`] with a 303 to the day's scope, as a proxy or a
/// layer outside Corten might, where Corten's own redirect answers the runtime with
/// `corten-location`: the runtime's `fetch` follows it, and its `Location` names no `#id`, so a
/// marked form's address keeps the one its `formaction` has, as the browser's own load does.
pub struct MovedBy303;

impl Middleware for MovedBy303 {
    async fn call(&self, req: Request, next: impl Next) -> Response {
        if req.uri().path() != url::ScopeMoved.to_string() {
            return next.run(req).await;
        }
        (StatusCode::SEE_OTHER, [(header::LOCATION, day_scope().to_string())]).into_response()
    }
}

/// A shipment's package: drawn by `PackageFields`, which knows nothing of the script that fills it.
#[derive(Fields)]
#[allow(dead_code)]
struct Shipment {
    service: String,
    weight: String,
    note: String,
    #[serde(default)]
    gift: bool,
    size: String,
    /// Drawn by no form: a group of it is empty.
    #[serde(default)]
    extras: Vec<String>,
    #[fields(rows)]
    #[serde(default)]
    parcels: std::collections::BTreeMap<u32, Parcel>,
}

#[derive(Fields)]
#[allow(dead_code)]
struct Parcel {
    weight: String,
}

/// The package's fields, as a component shared by forms with and without a script draws them: no
/// refs to thread through.
#[component]
fn PackageFields() -> impl Render {
    let f = Shipment::FIELDS;
    html! {
        <input name={f.weight} value="1">
        <textarea name={f.note}></textarea>
        <label><input type="checkbox" name={f.gift}>" Gift"</label>
        <label><input type="radio" name={f.size} value="small" checked>" Small"</label>
        <label><input type="radio" name={f.size} value="large">" Large"</label>
        <input name={f.parcels.at(&1).weight} value="1">
    }
}

#[derive(Id)]
struct ShipFormId;

#[derive(Id)]
struct LabelFormId;

#[derive(Id)]
struct JoinedId;

/// Fills the package when the service changes, given the fields as their controls. The two
/// buttons call a handler that takes an input with a field their form does not have as one: the
/// note, a textarea, and the weight, in a form without it. The rest say which form a field is
/// found in for an `on:` on the form itself, on a list inside it, on a button outside it that
/// `form=` joins to it, and on a label in another form whose control `form=` joins to this one;
/// and count a group no control has, and one whose name is the select's.
#[component(js)]
fn ShipForm() -> impl Render {
    let f = Shipment::FIELDS;
    let out = refs();
    let parcel = f.parcels.at(&1).weight;
    html! {
        <div>
            <form id={ShipFormId} on:dblclick={js::mark(f.weight, target)}>
                <select name={f.service} on:change={js::fill(f.service, f.weight, f.note, f.gift, f.size, parcel, out)}>
                    <option value="ground">"Ground"</option>
                    <option value="air">"Air"</option>
                </select>
                <PackageFields />
                <output ref={out}></output>
                <button type="button" on:click={js::weigh(f.note)}>"Weigh the note"</button>
                <ul on:click={js::mark(f.weight, target)}>
                    <li>"Mark from the list"</li>
                </ul>
                <button type="button" on:click={js::count(f.extras, target)}>"Count extras"</button>
                <button type="button" on:click={js::count(f.service, target)}>"Count services"</button>
            </form>
            <form><button type="button" on:click={js::weigh(f.weight)}>"Weigh elsewhere"</button></form>
            <button type="button" form={ShipFormId} on:click={js::mark(f.weight, target)}>"Mark from outside"</button>
            <form id={LabelFormId}>
                <input name={f.weight} value="5">
                <label for={JoinedId} on:click={js::mark(f.weight, target)}>"Mark from the label"</label>
            </form>
            <input id={JoinedId} type="checkbox" form={ShipFormId}>
        </div>
    }
}

async fn fields_page(req: Req) -> HtmlResult {
    req.page(html! {
        <Layout req={&req} title="Fields" viewer={None} head="">
            <ShipForm />
        </Layout>
    })
}

#[derive(Id)]
struct LargeListId;

/// The rows: more than 16 KiB decoded, the size past which Playwright's WebKit on Windows held a
/// flushed brotli event back until more of the stream came (#1131).
#[component]
fn LargeList() -> impl Render {
    html! {
        <ul id={LargeListId}>
            for i in 0..640 {
                <li>"Row "{i}" of the large event, padded so the event decodes past sixteen KiB."</li>
            }
        </ul>
    }
}

/// What `/smoke/reading` shows and its script reads: a name and enough rows that the answer is
/// larger than its headers, so the browser test can tell a 304 from a 200 by what it carried.
#[derive(ToJson)]
pub struct Reading {
    pub name: String,
    pub rows: Vec<String>,
}

#[derive(Id)]
struct ReaderId;

/// Reads `/smoke/reading`'s data when its button is pressed and writes what it got.
#[component(js)]
fn Reader() -> impl Render {
    let out = refs();
    html! {
        <div>
            <button type="button" on:click={js::show(out, url::Reading { missing: None, moved: None }, signal)}>"Read"</button>
            <output id={ReaderId} ref={out}></output>
        </div>
    }
}

async fn reading(req: Req, Params(at): Params<url::Reading>) -> HtmlResult<corten::Screen<Reading>> {
    if at.missing == Some(true) {
        return Err(Error::not_found());
    }
    let data =
        Reading { name: "Reading".into(), rows: (0..40).map(|i| format!("Row {i} of the screen a script reads")).collect() };
    let mut res = req.screen(&data, html! { <Layout req={&req} title="Reading" viewer={None} head=""><Reader /></Layout> })?;
    if at.moved == Some(true) {
        // A response replaced through `DerefMut` is not checked against the route's data, so a
        // script's read() must not follow it.
        *res = corten::http::IntoResponse::into_response(
            req.redirect::<corten::ForOne>(&url::Reading { missing: None, moved: None })?,
        );
    }
    Ok(res)
}

/// One large event and then nothing: the browser must show it without more of the stream coming.
async fn large() -> LiveResponse {
    corten::live(stream::once(async { LargeList {}.to_html() }).chain(stream::pending()))
}

#[cfg(test)]
mod tests {
    use corten::Mode;

    use super::url;
    use crate::market::Market;

    /// The smoke's patches answer a browser without JavaScript with a page or a redirect, never the
    /// bare fragment (which a debug build refuses with a 500): the styled note's form goes back to
    /// the watchlist, and Preview and Unfold draw the sheet's page with the dialog or the
    /// `<details>` open. The runtime's request still gets the patch.
    #[tokio::test]
    async fn the_smokes_patches_answer_a_plain_request_with_a_page_or_a_redirect() {
        let app = crate::app::app(Market::new()).area(|area| url::area(area).components(super::COMPONENTS)).test();
        let plain = app.post(&url::Styled).await;
        assert_eq!(plain.status(), 303, "{}", plain.text());
        assert_eq!(plain.headers()["location"], "/");
        let patch = app.post(&url::Styled).mode(Mode::Action).await;
        assert_eq!(patch.status(), 200, "{}", patch.text());
        assert!(patch.headers().contains_key("corten-patch") && patch.text().contains(">Saved</p>"), "{}", patch.text());
        let (sheet, more) = (app.get(&url::OpenSheet).await, app.get(&url::OpenMore).await);
        for (to, open) in [(sheet, "<p>Preview</p>"), (more, "<p>Unfolded</p>")] {
            assert_eq!(to.status(), 200, "{}", to.text());
            assert!(!to.headers().contains_key("corten-patch"), "a page: {}", to.text());
            assert!(to.text().contains(" open>") && to.text().contains(open), "drawn open: {}", to.text());
        }
    }
}
