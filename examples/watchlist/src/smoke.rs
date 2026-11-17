//! What only the browser test serves, with the app run as `SMOKE_TRUSTED_TYPES=1` (`app::for_the_smoke`):
//! a live stream whose one event is larger than a page's usual patch and is followed by nothing,
//! a page whose handler is given text with an apostrophe, quotes, `&` and `<` in it, as an
//! argument and as the value an element gives its ref, a patch drawn with this area's
//! stylesheet, which a form on a page outside the area is answered with, and a dialog and a
//! `<details>` drawn closed that a form outside each asks for again, a screen whose data a
//! script reads (`corten/read`), and a form whose fields a handler is given as its controls.
use corten::{Error, LiveResponse, prelude::*};
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
