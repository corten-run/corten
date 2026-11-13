//! What only the browser test serves, with the app run as `SMOKE_TRUSTED_TYPES=1` (`app::for_the_smoke`):
//! a live stream whose one event is larger than a page's usual patch and is followed by nothing,
//! a page whose handler is given text with an apostrophe, quotes, `&` and `<` in it, and a patch
//! drawn with this area's stylesheet, which a form on a page outside the area is answered with.
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

    /// A handler given text and a JSON value that have an apostrophe, quotes, `&` and `<` in them.
    #[route("/smoke/quoted", get = quoted)]
    pub struct Quoted;

    /// A patch whose component is listed in this area only, for a `data-patch` form on a page
    /// outside it (the test writes the form into the watchlist).
    #[route("/smoke/styled", post = styled)]
    pub struct Styled;
}

/// The components the smoke's pages draw.
pub const COMPONENTS: &[corten::Component] = &[Quoted, StyledNote];

/// The text the handler is given, as itself and in a JSON array. `data-on` is single-quoted, so it
/// is written with `&#39;`, `&amp;` and `&lt;` and its JSON's quotes as they are.
const QUOTED: &str = r#"It's "<b>" & more"#;

#[derive(Id)]
struct QuotedId;

/// Writes what its handler was given into the page, for the test to compare.
#[component(js)]
fn Quoted() -> impl Render {
    html! { <output id={QuotedId} on:connect={js::show(target, QUOTED, [QUOTED])}></output> }
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
