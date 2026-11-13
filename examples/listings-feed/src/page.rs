//! The seller's page: who the seller is, the form that moves some market lows, and the listings
//! the feed keeps current. The failover benchmark keeps one open in a real browser through the
//! load balancer while it kills instances.
use std::time::Duration;

use corten::prelude::*;

use crate::{
    app::{MoveInput, url},
    listing_table::{Line, ListingTable},
    text::Msg,
};

corten::assets::embed! {
    /// The files in `static/`, compiled into the program: `Static::STYLE_CSS` is `static/style.css`.
    pub struct Static = "static";
}

/// The status line's id: moving the market lows answers with it.
#[derive(Id)]
pub struct MoveStatusId;

/// What the last move did.
#[component]
pub fn MoveStatus(text: impl Render) -> impl Patch {
    html! { <p id={MoveStatusId} role="status">{text}</p> }
}

/// The document around every page: `title`, the page's own `head` tags and the page itself.
#[component]
pub fn Layout(req: &Req, title: impl Render, head: impl Render, children: impl Render) -> impl Document {
    html! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <link rel="stylesheet" href={req.asset(Static::STYLE_CSS)}>
                <title>{title}</title>
                {head}
                <Corten />
            </head>
            <body>
                <main>{children}</main>
            </body>
        </html>
    }
}

/// The page for a failed request (`App::error_page`), in the layout, so a failure keeps the app's
/// design; under `corten dev` it shows what went wrong. A seller's page is the app's only page, so
/// there is no way back to link.
pub async fn error_page(failure: Failure, req: Req) -> HtmlResult {
    let (title, text) = match failure {
        Failure::NotFound => ("Not found", "There is nothing at this address."),
        Failure::TimedOut | Failure::Offline | Failure::Unidentified { .. } => {
            ("Not available", "Check your connection and try again.")
        }
        Failure::CrossSite => ("Not allowed", "This request came from another site."),
        Failure::Refused { .. } => ("Not allowed", "You do not have access to this page."),
        Failure::WrongMethod
        | Failure::UnknownMethod
        | Failure::Rejected { .. }
        | Failure::Failed { .. }
        | Failure::Panicked { .. } => ("Something went wrong", "Please try again."),
    };
    req.page(html! {
        <Layout req={&req} title={title} head="">
            <h1>{title}</h1>
            <p>{text}</p>
            if let Some(detail) = failure.detail() {
                <pre>{detail}</pre>
            }
        </Layout>
    })
}

pub fn page<'a>(
    req: &'a Req,
    seller: &'a str,
    instance: &'a str,
    lines: &'a [Line<'a>],
    total: usize,
    behind: bool,
    t: Msg,
) -> impl Document + 'a {
    // A write the feed has not brought yet: without JavaScript nothing else would show it.
    let again = behind.then_some(ReadAgain { after: Duration::from_secs(1) }.without_javascript());
    html! {
        <Layout req={req} title={html! { "Listings for "{seller} }} head={again}>
            <header>
                <div>
                    <h1>"Listings for "{seller}</h1>
                    <p>
                        "Served by instance "<strong>{instance}</strong>". Every instance follows the same feed: "
                        "stop this one and the page resumes on another from the same cursor, missing no change."
                    </p>
                </div>
                // A write commits to Postgres with the feed's outbox row; the rows change
                // when the feed brings it, here and on every instance. Its submit key makes
                // a resend (a lost answer, a retry) commit once.
                <form method="post" action={url::Move { seller }} data-patch>
                    {SubmitKey::field(MoveInput::FIELDS.submit)}
                    <button>"Move five market lows"</button>
                </form>
            </header>
            <MoveStatus text="" />
            <ListingTable seller={seller} lines={lines} total={total} t={t} />
        </Layout>
    }
}
