//! What only the browser test serves, with the app run as `SMOKE_TRUSTED_TYPES=1` (`app::for_the_smoke`):
//! a live stream whose one event is larger than a page's usual patch and is followed by nothing,
//! a page whose handler is given text with an apostrophe, quotes, `&` and `<` in it, as an
//! argument and as the value an element gives its ref, a patch drawn with this area's
//! stylesheet, which a form on a page outside the area is answered with, and a dialog and a
//! `<details>` drawn closed that a form outside each asks for again, and a screen whose scope
//! form's answer is the page at the address it asks for (`data-address`).
use corten::{LiveResponse, prelude::*};
use futures_util::{StreamExt, stream};

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

    /// A screen whose scope form says its answer is the page at the address it asks for
    /// (`data-address`, #1406): with JavaScript the address answers the scope's panel as a patch,
    /// and without it, or on a reload, the whole screen.
    #[route("/smoke/scope", get = scope_page)]
    #[derive(Default)]
    pub struct Scope {
        #[route(query)]
        pub q: super::ScopeQuery,
    }
}

/// The components the smoke's pages draw.
pub const COMPONENTS: &[corten::Component] = &[Quoted, StyledNote];

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
/// outside the area as it is on one inside.
async fn styled(req: Req) -> HtmlResult {
    req.patch(StyledNote {})
}

#[derive(Id)]
struct SmokeSheetId;

#[derive(Id)]
struct SmokeMoreId;

/// The page: the triggers outside the dialog and the `<details>`, and the two their answers
/// replace.
async fn sheet_page(req: Req) -> HtmlResult {
    req.page(html! {
        <Layout req={&req} title="Sheet" viewer={None} head="">
            <form method="get" action={url::OpenSheet} data-patch><button>"Preview"</button></form>
            <dialog id={SmokeSheetId}></dialog>
            <form method="get" action={url::OpenMore} data-patch><button>"Unfold"</button></form>
            <details id={SmokeMoreId}><summary>"More"</summary></details>
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

/// Answers any form that asks with the dialog drawn open.
async fn open_sheet(req: Req) -> HtmlResult {
    req.patch(Sheet {})
}

/// Answers with the `<details>` drawn open.
async fn open_more(req: Req) -> HtmlResult {
    req.patch(html! {
        <details id={SmokeMoreId} open>
            <summary>"More"</summary>
            <p>"Unfolded"</p>
        </details>
    })
}

/// The scope screen's parameter, in its address.
#[derive(Clone, Default, Route, Fields)]
#[route(query)]
pub struct ScopeQuery {
    pub scope: Option<String>,
}

#[derive(Id)]
struct SmokeScopeId;

/// The scope's panel with its form, one patch, so the form always shows the scope the panel does.
/// The form is marked `data-address`: once its answer is drawn, the address is the one it asked
/// for, and Back and Forward read this patch again. A button's `formaction`, and another marked
/// form's `action`, name a place on the page, which the address keeps.
#[component]
fn ScopePanel<'a>(scope: &'a str) -> impl Patch {
    let f = ScopeQuery::FIELDS;
    let here = url::Scope::default();
    html! {
        <section id={SmokeScopeId}>
            <form method="get" action={&here} data-patch data-address>
                <button name={f.scope} value="day">"Day"</button>
                <button name={f.scope} value="week">"Week"</button>
                <button name={f.scope} value="month" formaction={here.at(SmokeScopeId)}>"Month"</button>
            </form>
            <form method="get" action={here.at(SmokeScopeId)} data-patch data-address>
                <button name={f.scope} value="quarter">"Quarter"</button>
            </form>
            <p>"Scope: "<output>{scope}</output></p>
        </section>
    }
}

/// The screen: the panel, a form without the mark that draws the panel for another scope and
/// leaves the address, and the rest of the screen, which a change of scope does not draw again.
async fn scope_page(req: Req, Params(at): Params<url::Scope>) -> HtmlResult {
    let scope = at.q.scope.as_deref().unwrap_or("all");
    req.patch_or(html! { <ScopePanel scope={scope} /> }, || async {
        req.page(html! {
            <Layout req={&req} title="Scope" viewer={None} head="">
                <ScopePanel scope={scope} />
                <form method="get" action={url::Scope::default()} data-patch>
                    <button name={ScopeQuery::FIELDS.scope} value="year">"Year, in place"</button>
                </form>
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

/// One large event and then nothing: the browser must show it without more of the stream coming.
async fn large() -> LiveResponse {
    corten::live(stream::once(async { LargeList {}.to_html() }).chain(stream::pending()))
}
