//! The document around every page: its head, the bar, the footer, and the page a failed request
//! gets.
use std::sync::LazyLock;

use corten::{http::StatusCode, prelude::*};

use crate::{after::StartId, cert::CertificateId, links, url};

corten::assets::embed! {
    /// The files in `static/`, compiled into the program: the stylesheet and the brand's marks.
    pub struct Static = "static";
}

pub(crate) const DESCRIPTION: &str = "Corten is a Rust web framework for apps where speed at the user's end matters: finished HTML from the server, plain JavaScript in the browser, typed across the seam between them.";

/// Where the site is served from, as `PUBLIC_ORIGIN` names it (`https://example.com`): a link
/// someone shares needs its picture's whole address, which only the deployment knows.
static ORIGIN: LazyLock<Option<String>> = LazyLock::new(|| {
    let origin = std::env::var("PUBLIC_ORIGIN").ok()?;
    let origin = origin.trim().trim_end_matches('/');
    (origin.starts_with("https://") || origin.starts_with("http://")).then(|| origin.to_string())
});

/// The site's own address, when the deployment gave one.
pub fn origin() -> Option<&'static str> {
    ORIGIN.as_deref()
}

/// Where the page's own content starts, for the link that skips the bar.
#[derive(Id)]
pub struct ContentId;

/// The document. `head` is the page's own tags, ahead of everything a browser loads, since one
/// of them may be a policy and a policy governs only what follows it. `<Corten />` is where the
/// runtime and the components' scripts and styles go.
#[component]
pub fn Layout<'a>(req: &'a Req, title: &'a str, head: impl Render, children: impl Render) -> impl Document {
    html! {
        <!DOCTYPE html>
        <html lang={req.lang()}>
            <head>
                <meta charset="utf-8">
                {head}
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta name="description" content={DESCRIPTION}>
                <meta name="theme-color" content="#1c2020">
                <link rel="stylesheet" href={req.asset(Static::STYLE_CSS)}>
                <link rel="icon" type="image/svg+xml" href={req.asset(Static::FAVICON_SVG)}>
                <link rel="apple-touch-icon" href={req.asset(Static::TOUCH_PNG)}>
                <title>{title}</title>
                <Corten />
            </head>
            <body>
                <Bar req={req} />
                <main id={ContentId}>{children}</main>
                <Foot />
            </body>
        </html>
    }
}

/// The page's own head tags: the policy that blocks its scripts when the reader asked for that,
/// and what makes it the one address to share and to index.
#[component]
pub fn Shared<'a>(req: &'a Req, title: &'a str, bare: bool) -> impl Render {
    html! {
        if bare {
            // One more policy, ahead of every script, and the browser enforces it.
            <meta http-equiv="Content-Security-Policy" content="script-src 'none'">
        }
        // A page with a struck plate in its address is the same page.
        <link rel="canonical" href={crate::page()}>
        <meta property="og:type" content="website">
        <meta property="og:site_name" content="Corten">
        <meta property="og:title" content={title}>
        <meta property="og:description" content={DESCRIPTION}>
        if let Some(origin) = origin() {
            <meta property="og:url" content={format!("{origin}/")}>
            <meta property="og:image" content={format!("{origin}{}", req.asset(Static::SOCIAL_PNG))}>
            <meta property="og:image:width" content="1280">
            <meta property="og:image:height" content="640">
            <meta property="og:image:alt" content="The Corten mark: three stacked plates, rust over charcoal.">
            <meta name="twitter:card" content="summary_large_image">
        }
    }
}

/// The bar: a steel strap across the top of every page, the lockup on it. Its first link, seen
/// only by a keyboard, skips to the page. Its links to the page load it in full (`data-reload`):
/// the strip at the bottom counts what the browser's navigation cost, and a page the runtime
/// swapped in has no navigation of its own to count.
#[component(css)]
pub(crate) fn Bar<'a>(req: &'a Req) -> impl Render {
    html! {
        <header class={Bar}>
            <a href={ContentId.fragment()} class={Skip}>"Skip to the page"</a>
            <a href={crate::page()} class={Lockup} aria-label="Corten" data-reload>
                <img src={req.asset(Static::LOCKUP_LIGHT_SVG)} alt="" width="149" height="35">
            </a>
            <nav class={Links} aria-label="Site">
                <a href={crate::page().at(CertificateId)} class={Wide} data-reload>"Measurements"</a>
                <a href={links::guides()} class={Wide}>"Guides"</a>
                <a href={links::repository()}>"GitHub"</a>
                <a href={crate::page().at(StartId)} class={Go} data-reload>"Get started"</a>
            </nav>
        </header>
    }
}

/// The footer of every page: where everything else about Corten is.
#[component(css)]
pub(crate) fn Foot() -> impl Render {
    html! {
        <footer class={Foot}>
            <nav class={Ways} aria-label="More about Corten">
                <a href={links::getting_started()}>"Getting started"</a>
                <a href={links::guides()}>"Guides"</a>
                <a href={links::examples()}>"Examples"</a>
                <a href={links::performance()}>"Measurements and method"</a>
                <a href={links::deploying()}>"Deploying"</a>
                <a href={links::changelog()}>"Changelog"</a>
                <a href={links::security()}>"Security"</a>
                <a href={links::license()}>"MIT license"</a>
                <a href={links::repository()}>"GitHub"</a>
            </nav>
            <p class={Small}>
                "\"COR-TEN\" is a U.S. Steel trademark for steel. This site is a Corten app: no web fonts, no bundler, and no framework in the browser but the runtime."
            </p>
        </footer>
    }
}

/// The page for every way a request can fail, in the same document.
pub async fn error_page(failure: Failure, req: Req) -> HtmlResult {
    let (title, text) = match &failure {
        Failure::NotFound => ("Not found", "There is nothing at this address."),
        Failure::CrossSite => ("Not allowed", "This request came from another site."),
        Failure::Refused { status } if *status == StatusCode::TOO_MANY_REQUESTS => {
            ("Too many requests", "Wait a moment and try again.")
        }
        Failure::Refused { .. } => ("Not allowed", "You do not have access to this page."),
        Failure::Unidentified { .. } | Failure::TimedOut | Failure::Offline => {
            ("Not available", "Check your connection and try again.")
        }
        Failure::Rejected { .. } => ("Not accepted", "What was sent is not what this address takes. Go back and try again."),
        Failure::WrongMethod | Failure::Failed { .. } | Failure::Panicked { .. } => {
            ("Something went wrong", "Try again in a moment.")
        }
    };
    req.page(html! {
        <Layout req={&req} title={title} head={()}>
            <Lost title={title} text={text} detail={failure.detail()} home={crate::page()} />
        </Layout>
    })
}

/// What the error page says, on the surface's rust.
#[component(css)]
pub(crate) fn Lost<'a>(title: &'a str, text: &'a str, detail: Option<&'a str>, home: url::Home<'a>) -> impl Render {
    html! {
        <section class={Lost}>
            <h1 class={Title}>{title}</h1>
            <p>{text}</p>
            if let Some(detail) = detail {
                <pre class={Detail}>{detail}</pre>
            }
            <p><a href={home} data-reload>"Back to the surface"</a></p>
        </section>
    }
}
