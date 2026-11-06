//! The document around every page.
use corten::prelude::*;

use crate::{
    account::{self, Viewer},
    app::url,
    news,
    theme::*,
};

corten::assets::embed! {
    /// The files in `static/`, compiled into the program: `Static::STYLE_CSS` is `static/style.css`.
    pub struct Static = "static";
}

/// The document around every page: its title, its own `head` tags, who is looking and the page.
/// Client navigation swaps the title, the tags, the page and the sector links (marked `page`) only;
/// signing in changes the viewer, which makes the runtime load the next page in full. The header is one row on a phone: the
/// viewer is the link to their account, and a visitor has the sign-in button in its place.
#[component]
pub fn Layout<'a>(
    req: &'a Req,
    title: &'a str,
    viewer: Option<&'a Viewer>,
    head: impl Render,
    children: impl Render,
) -> impl Document {
    // The page's side padding, narrower on a phone so the header fits on one line.
    let gutter = Responsive::new(Space::_4).sm(Space::_5);
    html! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <link rel="stylesheet" href={req.asset(Static::STYLE_CSS)}>
                <link rel="icon" type="image/svg+xml" href={req.asset(Static::FAVICON_SVG)}>
                <title>{title}" | Watchlist"</title>
                {head}
                <Corten />
            </head>
            <body class={(bg_bg(), fg_ink())}>
                <header class={(bg_surface(), border_b_line())}>
                    <div
                        class={(row(Space::_3), justify_between(), flex_wrap(), max_w_page(), mx_auto(), px(gutter), py_3())}
                    >
                        <nav class={(row(Space::_1), flex_wrap())}>
                            <span class={(weight_bold(), tracking_tight())}>"Watchlist"</span>
                            <a {..req.nav(&url::Home)}>"Stocks"</a>
                            <a {..req.nav(&news::url::News::default())}>"News"</a>
                            <a {..req.nav(&url::Alerts { saved: None })}>"Alerts"</a>
                        </nav>
                        match viewer {
                            // Named for where it goes, starting with what it shows (the name).
                            Some(viewer) => <a {..req.nav(&account::url::Account)} aria-label={format!("{}: account", viewer.name)}>
                                <ViewerBadge viewer={viewer} />
                            </a>,
                            None => <form method="post" action={url::SignIn} data-patch><button>"Sign in"</button></form>,
                        }
                    </div>
                </header>
                // The news section's sectors, beside the page: a navigation sends it with the page
                // (`page`), so a link into the news fills it and a link out empties it, with no full load.
                <nav
                    page
                    id={SectorNavId}
                    aria-label="Sectors"
                    class={(row(Space::_3), flex_wrap(), max_w_page(), mx_auto(), px(gutter))}
                >
                    if req.is_current(&news::url::News::default(), true) {
                        for sector in news::Sector::ALL {
                            <a href={news::url::News { filter: news::NewsQuery::sector(sector) }}>{sector.label()}</a>
                        }
                    }
                </nav>
                <main class={(max_w_page(), mx_auto(), px(gutter), py_6())}>{children}</main>
            </body>
        </html>
    }
}

/// The sector links beside the page, which each page draws (empty outside the news).
#[derive(Id)]
pub struct SectorNavId;

/// The header's badge, inside the link to their account: who is signed in, with their picture
/// once they upload one. The upload's answer replaces it by its id, and the link around it keeps
/// its mark as the current page.
#[derive(Id)]
pub struct ViewerBadgeId;

#[component]
pub fn ViewerBadge<'a>(viewer: &'a Viewer) -> impl Patch {
    html! {
        <span id={ViewerBadgeId} class={row(Space::_2)}>
            if let Some(id) = &viewer.picture {
                <img src={url::Picture { id }} alt="" width="28" height="28" class={rounded_pill()}>
            }
            {&viewer.name}
        </span>
    }
}

#[cfg(test)]
mod tests {
    use corten::Local;

    use crate::{
        account::url::Account,
        app::url::Home,
        news::url::News,
        testing::{client, sign_in},
    };

    #[tokio::test]
    async fn the_shell_marks_the_current_link_and_shows_the_viewer() {
        let app = client();
        let guest = app.get(&News::default()).await;
        let guest = guest.text();
        assert!(guest.contains(r#"<a href="/news" data-nav aria-current="page">News</a>"#), "{guest}");
        assert!(guest.contains(r#"<a href="/" data-nav>Stocks</a>"#));
        assert!(guest.contains("<button>Sign in</button>") && !guest.contains(r#"href="/account""#), "{guest}");
        let session = sign_in(&app).await;
        let ada = app.get(&Home).cookie("session", &session).await;
        let ada = ada.text();
        assert!(
            ada.contains(r#"<a href="/account" data-nav aria-label="Ada: account"><span id="viewer-badge""#)
                && ada.contains(">Ada</span></a>"),
            "{ada}"
        );
        assert!(!ada.contains("<button>Sign in</button>"));
        let account = app.get(&Account).cookie("session", &session).await;
        let account = account.text();
        assert!(
            account
                .contains(r#"<a href="/account" data-nav aria-current="page" aria-label="Ada: account"><span id="viewer-badge""#),
            "{account}"
        );
        let lost = app.get(&Local::parse("/nope").unwrap()).cookie("session", &session).await;
        let lost = lost.text();
        assert!(lost.contains("<h1>Not found</h1>") && lost.contains(">Ada</span></a>"), "the error page too: {lost}");
    }
}
