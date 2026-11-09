//! What only the browser test serves, with the app run as `SMOKE_TRUSTED_TYPES=1` (`app::policy`):
//! a live stream whose one event is larger than a page's usual patch and is followed by nothing.
use corten::{LiveResponse, prelude::*};
use futures_util::{StreamExt, stream};

#[corten::routes(area = Smoke)]
pub mod url {
    #[route("/smoke")]
    pub struct Smoke;

    /// One event of 640 rows (52,395 bytes on the wire), then a quiet stream until the keepalive.
    #[route("/smoke/live/large", get = large)]
    pub struct LargeLive;
}

#[derive(Id)]
struct LargeListId;

/// The rows: more than 16 KiB decoded, the size past which WebKit held a flushed brotli event back
/// until more of the stream came (#1131).
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
