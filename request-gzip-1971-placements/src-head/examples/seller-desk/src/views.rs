//! The desk's views. Each component's script and stylesheet are next to it in `views/`.
use corten::{Component, prelude::*};

use crate::{
    app::{GridQuery, Item, url},
    text::Msg,
    ui::nav_bar::{NavBar, NavBrand, NavSections},
};

corten::assets::embed! {
    /// The files in `static/`, compiled into the program: `Static::STYLE_CSS` is `static/style.css`.
    pub struct Static = "static";
}

mod bulk_bar;
mod confirm_dialog;
mod inventory_grid;
mod inventory_row;
mod item_count;
mod price_cell;
mod statement_table;

pub use bulk_bar::BulkBar;
pub use confirm_dialog::ConfirmDialog;
pub use inventory_grid::{ArchiveFormId, InventoryGrid};
pub use inventory_row::{InventoryRow, RowId};
pub use item_count::ItemCount;
pub use price_cell::{PriceCell, PriceEdited};
pub use statement_table::StatementTable;

/// What the app lists in `App::components`: the scripts, the stylesheets and the row's view.
pub const COMPONENTS: &[Component] = &[InventoryGrid, InventoryRow, ItemCount, PriceCell, StatementTable];

/// An item and its stock level, as a row shows them.
pub struct Line<'a> {
    pub item: &'a Item,
    pub qty: u32,
    /// Drawn `hidden`: the page's filter (`?q=`) does not match it.
    pub hidden: bool,
}

/// The document around every page.
#[component]
pub fn Layout(req: &Req, title: &str, children: impl Render) -> impl Document {
    html! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <link rel="stylesheet" href={req.asset(Static::STYLE_CSS)}>
                <link rel="icon" type="image/svg+xml" href={req.asset(Static::FAVICON_SVG)}>
                <title>{title}</title>
                <Corten />
            </head>
            <body>
                <header class={NavBar {}}>
                    <a class={NavBrand {}} href={url::Home::default()}>"Seller desk"</a>
                    <nav class={NavSections {}} aria-label="Sections">
                        <a {..req.nav(&url::Home::default())}>"Inventory"</a>
                        <a {..req.nav(&url::Statement)}>"Statement"</a>
                    </nav>
                </header>
                <main>{children}</main>
            </body>
        </html>
    }
}

/// The page for a failed request (`App::error_page`), in the layout, so a failure keeps the app's
/// design and its way back; under `corten dev` it shows what went wrong.
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
        <Layout req={&req} title={title}>
            <h1>{title}</h1>
            <p>{text}</p>
            <p><a href={url::Home::default()}>"Back to the inventory"</a></p>
            if let Some(detail) = failure.detail() {
                <pre>{detail}</pre>
            }
        </Layout>
    })
}

pub fn desk<'a>(lines: &'a [Line<'a>], view: &'a GridQuery, t: Msg) -> impl Render + 'a {
    html! {
        <h1>"Inventory"</h1>
        <StatusLine text="" />
        <InventoryGrid lines={lines} view={view} t={t} />
    }
}

/// The status line's id: bulk actions patch it.
#[derive(Id)]
pub struct DeskStatusId;

/// What the last bulk action did; the server patches it by `id`.
#[component]
pub fn StatusLine<'a>(text: &'a str) -> impl Patch {
    html! { <p id={DeskStatusId} role="status">{text}</p> }
}

/// `1234` as `12.34`, what a price input holds.
pub fn money(cents: u32) -> String {
    format!("{}.{:02}", cents / 100, cents % 100)
}
