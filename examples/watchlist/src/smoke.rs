//! What only the browser test serves, with the app run as `SMOKE_TRUSTED_TYPES=1` (`app::for_the_smoke`):
//! a live stream whose one event is larger than a page's usual patch and is followed by nothing,
//! a page whose handler is given text with an apostrophe, quotes, `&` and `<` in it, as an
//! argument and as the value an element gives its ref, a patch drawn with this area's
//! stylesheet, which a form on a page outside the area is answered with, a write that answers with its own
//! page, and a dialog and a
//! `<details>` drawn closed that a form outside each asks for again, a screen whose data a
//! script reads (`corten/read`), a form whose fields a handler is given as its controls, and view
//! classes (`corten/views`) whose holes are in a form, past one and a form's whole text, beside
//! controls named after the members their paths read.
use corten::{
    Error, LiveResponse,
    prelude::*,
    script::{Ref, script},
};
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

    /// A page for checking nested scope roots against elements inside and outside the component.
    #[route("/smoke/scope", get = scope_page)]
    pub struct ScopePage;

    /// A whole document whose refs scope is its html element, after a doctype.
    #[route("/smoke/scoped", get = scoped_page)]
    pub struct ScopedPage;

    /// A patch whose component is listed in this area only, for a `data-patch` form on a page
    /// outside it (the test writes the form into the watchlist).
    #[route("/smoke/styled", post = styled)]
    pub struct Styled;

    /// A form whose write answers with its own page, as a form drawn again with what it refused
    /// does: the page is whole with JavaScript too, so the runtime draws what the write changed
    /// around `<main>` (#1370).
    #[route("/smoke/written", get = unwritten, post = written)]
    pub struct Written;

    /// The same form on a page that reads itself again each second (`ReadAgain`), whose write's own
    /// page does too, so a write that failed in view can be seen to stay shown while the page reads
    /// itself again, after a write whose own page drew as well (#1370).
    #[route("/smoke/written/again", get = unwritten_again, post = written_again)]
    pub struct WrittenAgain;

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

    /// Views whose holes are in a form, past one and a form's whole text, with controls outside
    /// each form, joined to it by `form=`, named `firstElementChild`, `nextElementSibling` and
    /// `textContent` (#1531).
    #[route("/smoke/views", get = views_page)]
    pub struct ViewsPage;

    #[route("/smoke/shared-refs", get = shared_refs_page)]
    pub struct SharedRefsPage;

    #[route("/smoke/shared-refs/{instance}/replace", get = replace_shared_ref_part)]
    pub struct ReplaceSharedRefPart {
        pub instance: u32,
    }
}

/// The components the smoke's pages draw.
pub const COMPONENTS: &[corten::Component] = &[
    Quoted,
    ScopeProbe,
    StyledNote,
    ShipForm,
    Reader,
    FormNested,
    PastForm,
    FormText,
    ScopedPage,
    SharedRefsPage,
    shared_ref_scope::COMPONENT,
];

#[derive(Id)]
struct ScopedReadyId;

#[component(js)]
fn ScopedPage() -> impl Document {
    let ready = refs();
    html! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <title>"Scoped document"</title>
                <Corten />
            </head>
            <body>
                <main><output id={ScopedReadyId} ref={ready} on:connect={js::ready(ready, signal)}></output></main>
            </body>
        </html>
    }
}

async fn scoped_page(req: Req) -> HtmlResult {
    req.page(ScopedPage {})
}

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

#[component(css)]
fn ScopeProbe() -> impl Render {
    html! {
        <div class={Frame}>
            <article class={List}>
                <p data-scope-probe="inside">"Inside"</p>
                <section><p data-scope-probe="section">"Inside a section"</p></section>
            </article>
            <p data-scope-probe="outside">"Outside"</p>
        </div>
    }
}

async fn scope_page(req: Req) -> HtmlResult {
    req.page(html! {
        <Layout req={&req} title="Nested CSS scopes" viewer={None} head="">
            <ScopeProbe />
            <article><section><p data-scope-probe="other">"In another article"</p></section></article>
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

async fn unwritten(req: Req) -> HtmlResult {
    written_page(&req, false, None)
}

async fn unwritten_again(req: Req) -> HtmlResult {
    written_page(&req, false, Some(ReadAgain { after: std::time::Duration::from_secs(1) }))
}

async fn written(req: Req) -> HtmlResult {
    written_page(&req, true, None)
}

async fn written_again(req: Req) -> HtmlResult {
    written_page(&req, true, Some(ReadAgain { after: std::time::Duration::from_secs(1) }))
}

/// The form, and once it is sent the write's own page, in the layout the smoke's other pages draw.
/// The write's page draws a component with a script the form's page has not loaded, so the test
/// can hold the page on its way in while the write is done, and leave it by a link to a page in
/// the same area, which a navigation swaps into this document. A page that reads itself again
/// posts to its own address, whose page reads itself again too.
fn written_page(req: &Req, written: bool, again: Option<ReadAgain>) -> HtmlResult {
    let reads_again = again.is_some();
    let inner = html! {
        if written {
            <p>"Written by the form's own page."</p>
            <Quoted />
        }
        <button>"Write"</button>
    };
    req.page(html! {
        <Layout req={req} title={if written { "Written" } else { "Write" }} viewer={None} head={again}>
            <a href={url::Quoted}>"Quoted arguments"</a>
            if reads_again {
                <form method="post" action={url::WrittenAgain} data-patch>{inner}</form>
            } else {
                <form method="post" action={url::Written} data-patch>{inner}</form>
            }
        </Layout>
    })
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

#[derive(Id)]
struct NestedFormId;

#[derive(Id)]
struct PastFormId;

#[derive(Id)]
struct TextFormId;

/// A hole two elements into a form: its class reads the form's first child.
#[component(view)]
fn FormNested<'a>(label: &'a str) -> impl Render {
    html! {
        <form id={NestedFormId}>
            <p><span>{label}</span></p>
        </form>
    }
}

/// A hole after a form: its class steps from the form to the element after it.
#[component(view)]
fn PastForm<'a>(note: &'a str) -> impl Render {
    html! {
        <div>
            <form id={PastFormId}></form>
            <p>{note}</p>
        </div>
    }
}

/// A form whose whole text is the hole, drawn empty.
#[component(view)]
fn FormText<'a>(text: &'a str) -> impl Render {
    html! { <form id={TextFormId}>{text}</form> }
}

/// The three views, and outside them a control joined to each form for every member a view's
/// path reads: each is the form's member of that name.
async fn views_page(req: Req) -> HtmlResult {
    req.page(html! {
        <Layout req={&req} title="Views" viewer={None} head="">
            <FormNested label="Nested" />
            <PastForm note="Past" />
            <FormText text="" />
            <input type="hidden" name="firstElementChild" value="kept" form={NestedFormId}>
            <input type="hidden" name="nextElementSibling" value="kept" form={NestedFormId}>
            <input type="hidden" name="textContent" value="kept" form={NestedFormId}>
            <input type="hidden" name="firstElementChild" value="kept" form={PastFormId}>
            <input type="hidden" name="nextElementSibling" value="kept" form={PastFormId}>
            <input type="hidden" name="textContent" value="kept" form={PastFormId}>
            <input type="hidden" name="firstElementChild" value="kept" form={TextFormId}>
            <input type="hidden" name="nextElementSibling" value="kept" form={TextFormId}>
            <input type="hidden" name="textContent" value="kept" form={TextFormId}>
        </Layout>
    })
}

/// One large event and then nothing: the browser must show it without more of the stream coming.
async fn large() -> LiveResponse {
    corten::live(stream::once(async { LargeList {}.to_html() }).chain(stream::pending()))
}

#[derive(Id)]
struct SharedRefPartId(u32);

script!(mod shared_ref_scope = "shared_ref_scope.js");

#[component(js)]
fn SharedRefsPage(instance: u32, replaced: bool) -> impl Render {
    let out = refs();
    let part: Ref<el::HTMLParagraphElement> = refs();
    html! {
        <section>
            <output ref={out}></output>
            <button type="button" on:click={js::show_part(part, out)}>"Read part"</button>
            <form method="get" action={url::ReplaceSharedRefPart { instance }} data-patch><button>"Replace part"</button></form>
            if instance == 2 {
                <PartBoundary on:change={shared_ref_scope::run(scope)}>
                    <SharedRefPart bundle={SharedRefsPageRefs} instance={instance} replaced={replaced} />
                </PartBoundary>
            } else {
                <SharedRefPart bundle={SharedRefsPageRefs} instance={instance} replaced={replaced} />
            }
        </section>
    }
}

#[component]
fn PartBoundary<'a>(on_change: Handler<'a>, children: impl Render) -> impl Render {
    let boundary = refs();
    html! {
        <div ref={boundary}>
            <input aria-label="Check shared handler scope" on:change={on_change}>
            {children}
        </div>
    }
}

#[component]
fn SharedRefPart(bundle: SharedRefsPageRefs, instance: u32, replaced: bool) -> impl Patch {
    let status = if replaced { "Replacement" } else { "Original" };
    html! { <p id={SharedRefPartId(instance)} ref={bundle.part()}>{status} " " {instance}</p> }
}

fn shared_refs_document(req: &Req, replaced: Option<u32>) -> HtmlResult {
    req.page(html! {
        <Layout req={req} title="Shared patch refs" viewer={None} head="">
            <SharedRefsPage instance={1} replaced={replaced == Some(1)} />
            <SharedRefsPage instance={2} replaced={replaced == Some(2)} />
        </Layout>
    })
}

async fn shared_refs_page(req: Req) -> HtmlResult {
    shared_refs_document(&req, None)
}

async fn replace_shared_ref_part(req: Req, Params(at): Params<url::ReplaceSharedRefPart>) -> HtmlResult {
    let instance = at.instance;
    req.patch_or(SharedRefPart { bundle: SharedRefsPageRefs, instance, replaced: true }, || async {
        shared_refs_document(&req, Some(instance))
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use corten::{
        Local, Mode,
        http::{HeaderName, header},
        testing::{Answer, Call},
    };

    use super::url;
    use crate::{
        alerts::{AlertInput, AlertStore},
        app::url::{Alerts, Home},
        market::Market,
        testing::VISITOR,
    };

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

    /// The browser smoke marks requests with `smoke-*` headers for its own routes to read
    /// (`smoke-note`, `smoke-start`, `smoke-styled`), and a mark may reach the app, which ignores
    /// them: every kind of request the smoke marks is answered the same, its status, each of its
    /// headers (`Vary` and `Cache-Control` among them) and its body, with those marks and one the
    /// smoke does not use (`smoke-canary`) as without. So a mark that gets past a case's route
    /// cannot change what the case sees.
    #[tokio::test]
    async fn the_smokes_request_marks_change_no_answer() {
        let plain = answers(&[]).await;
        let marks = [("smoke-note", "3"), ("smoke-start", "12.5"), ("smoke-styled", "1"), ("smoke-canary", "1")];
        let marked = answers(&marks).await;
        assert_eq!(plain.len(), marked.len());
        for (plain, marked) in plain.iter().zip(&marked) {
            let what = plain.what;
            assert_eq!(
                (plain.status, &plain.headers),
                (marked.status, &marked.headers),
                "{what}: status and headers, without and with the marks"
            );
            let from =
                plain.body.iter().zip(&marked.body).position(|(a, b)| a != b).unwrap_or(plain.body.len().min(marked.body.len()));
            let near =
                |body: &[u8]| String::from_utf8_lossy(&body[from.saturating_sub(40)..body.len().min(from + 40)]).into_owned();
            assert!(
                plain.body == marked.body,
                "{what}: the body with the marks differs from byte {from}: {:?} without, {:?} with",
                near(&plain.body),
                near(&marked.body)
            );
        }
    }

    /// One answer as the test compares it: the request, the status, the headers in the order sent
    /// and the body.
    struct Seen {
        what: &'static str,
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl Seen {
        fn of(what: &'static str, answer: &Answer) -> Seen {
            Seen {
                what,
                status: answer.status().as_u16(),
                headers: answer
                    .headers()
                    .iter()
                    .map(|(name, value)| (name.to_string(), value.to_str().unwrap().to_string()))
                    .collect(),
                body: answer.bytes().to_vec(),
            }
        }
    }

    /// What a case's route fetches a request it answers with (`accept-encoding: identity`), so the
    /// test reads the body as it is.
    const ROUTED: &str = "identity";
    /// What a browser accepts on a request it sends itself (Firefox's), which the app tags and
    /// compresses.
    const BROWSER: &str = "gzip, deflate, br, zstd";

    /// `call` with each of `marks` as a header, `coding` as its `Accept-Encoding`, and the visitor's
    /// cookie, so no answer names a new browser.
    fn marked<'c, K>(call: Call<'c, K>, marks: &[(&'static str, &str)], coding: &str) -> Call<'c, K> {
        let call = call.cookie("visitor", VISITOR).header(header::ACCEPT_ENCODING, coding);
        marks.iter().fold(call, |call, (name, value)| call.header(HeaderName::from_static(name), value))
    }

    /// The requests the smoke's cases mark, in order, on an app of their own, each sent with
    /// `marks`: the watchlist loaded; an alert written as the runtime sends it; the alerts page read
    /// whole at its receipt, as a load and as a navigation, which the page-refresh cases mark
    /// (`smoke-note`); the status line and list read in action mode; the page read whole at the
    /// receipt's replaced address (`/alerts?saved=1&shown=1`), which the replaced-address case's
    /// fetch wrapper marks (`smoke-note`); and what the write cases mark
    /// (`smoke-start`, `smoke-styled`, on every fetch of their pages): the write to `/smoke/written`
    /// and to `/smoke/written/again`, each as the runtime sends it (`Prefer: corten-draws=whole`,
    /// so its answer is the whole page), `/smoke/written` read by a navigation, and
    /// `/smoke/written/again` and `/smoke/quoted` read whole and by a navigation; a screen's data
    /// and its revalidation (`If-None-Match`); and the layout's stylesheet under `/assets/`.
    /// A runtime's whole read (`corten: page`) is sent as a document read, the nearest request the
    /// test client sends. The ones a case's route answers are fetched as it fetches them
    /// ([`ROUTED`]), the others as a browser asks ([`BROWSER`]).
    async fn answers(marks: &[(&'static str, &str)]) -> Vec<Seen> {
        // Writes that take an hour to land, so every read here comes before the write lands.
        let app = crate::app::app_with(Market::new(), AlertStore::new(Duration::from_secs(3600)))
            .area(|area| url::area(area).components(super::COMPONENTS))
            .test();
        let mut seen = Vec::new();
        let home = marked(app.get(&Home::default()), marks, ROUTED).await;
        seen.push(Seen::of("GET /", &home));
        let write = marked(app.post(&Alerts { saved: None }), marks, ROUTED)
            .field(AlertInput::FIELDS.id, "ACME")
            .field(AlertInput::FIELDS.above, "150")
            .mode(Mode::Action)
            .await;
        assert!(write.text().contains(r#"data-from="/alerts?saved=1""#), "{}", write.text());
        seen.push(Seen::of("POST /alerts (action)", &write));
        let receipt = Alerts { saved: Some(1) };
        for (what, mode) in [
            ("GET /alerts?saved=1 (load)", Mode::Document),
            ("GET /alerts?saved=1 (navigation)", Mode::Navigation),
            ("GET /alerts?saved=1 (action)", Mode::Action),
        ] {
            seen.push(Seen::of(what, &marked(app.get(&receipt), marks, ROUTED).mode(mode).await));
        }
        // The receipt's address with `shown` set, as the replaced-address case puts it in place and
        // its fetch wrapper marks the page's whole read of it (`smoke-note`).
        let replaced = Local::parse("/alerts?saved=1&shown=1").unwrap();
        let read = marked(app.get(&replaced), marks, ROUTED).mode(Mode::Document).await;
        assert_eq!(read.status(), 200, "{}", read.text());
        seen.push(Seen::of("GET /alerts?saved=1&shown=1 (whole)", &read));
        for (what, write) in [
            ("POST /smoke/written (action)", marked(app.post(&url::Written), marks, ROUTED).mode(Mode::Action).await),
            ("POST /smoke/written/again (action)", marked(app.post(&url::WrittenAgain), marks, ROUTED).mode(Mode::Action).await),
        ] {
            assert!(
                write.text().contains("</header>"),
                "{what}: the whole page, as drawn for Prefer: corten-draws=whole: {}",
                write.text()
            );
            seen.push(Seen::of(what, &write));
        }
        seen.push(Seen::of(
            "GET /smoke/written (navigation)",
            &marked(app.get(&url::Written), marks, ROUTED).mode(Mode::Navigation).await,
        ));
        for (what, mode) in
            [("GET /smoke/written/again (whole)", Mode::Document), ("GET /smoke/written/again (navigation)", Mode::Navigation)]
        {
            seen.push(Seen::of(what, &marked(app.get(&url::WrittenAgain), marks, ROUTED).mode(mode).await));
        }
        for (what, mode) in [("GET /smoke/quoted (whole)", Mode::Document), ("GET /smoke/quoted (navigation)", Mode::Navigation)]
        {
            seen.push(Seen::of(what, &marked(app.get(&url::Quoted), marks, ROUTED).mode(mode).await));
        }
        let reading = url::Reading { missing: None, moved: None };
        let data = marked(app.get(&reading), marks, BROWSER).mode(Mode::Data).await;
        let tag = data.headers()[header::ETAG].to_str().unwrap().to_string();
        seen.push(Seen::of("GET /smoke/reading (data)", &data));
        let kept = marked(app.get(&reading), marks, BROWSER).mode(Mode::Data).header(header::IF_NONE_MATCH, &tag).await;
        assert_eq!(kept.status(), 304);
        seen.push(Seen::of("GET /smoke/reading (data, If-None-Match)", &kept));
        let style = home
            .text()
            .split(r#"href="/assets/"#)
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .expect("the layout links a stylesheet");
        let style = Local::parse(&format!("/assets/{style}")).unwrap();
        let asset = marked(app.get(&style), marks, BROWSER).await;
        assert_eq!(asset.status(), 200);
        seen.push(Seen::of("GET /assets/ (stylesheet)", &asset));
        seen
    }
}
