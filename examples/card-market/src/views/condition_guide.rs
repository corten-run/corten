use corten::prelude::*;

use super::Static;
use crate::text::Msg;

/// The home page's short clip of how the market grades a card's condition, captioned in each
/// language the app has (the reader's is the default track): a native `<video>` the browser
/// plays and seeks by byte ranges from the embedded files. MP4 comes first, the format every
/// engine here plays (Playwright's WebKit on Windows never finishes loading a page whose first
/// source is this WebM); WebM is for a browser without MP4.
#[component(css)]
pub fn ConditionGuide<'a>(req: &'a Req, t: Msg) -> impl Render {
    let lang = req.lang();
    html! {
        <figure class={Guide}>
            <video class={Clip} controls preload="metadata" width="320" height="180">
                <source src={req.asset(Static::GRADING_CONDITION_MP4)} type="video/mp4">
                <source src={req.asset(Static::GRADING_CONDITION_WEBM)} type="video/webm">
                <track
                    kind="captions"
                    srclang="en"
                    label={t.home_captions_en()}
                    src={req.asset(Static::GRADING_CONDITION_EN_VTT)}
                    default={lang == "en"}
                >
                <track
                    kind="captions"
                    srclang="fr"
                    label={t.home_captions_fr()}
                    src={req.asset(Static::GRADING_CONDITION_FR_VTT)}
                    default={lang == "fr"}
                >
            </video>
            <figcaption>{t.home_grading()}</figcaption>
        </figure>
    }
}
