//! corten-ui's components on one page: a seller's draft listing for one card.
//!
//! | Route | |
//! |---|---|
//! | `GET /?tab=offers` | the gallery, with that tab selected |
//! | `GET /?sale=last` | the gallery with the last sale's sheet open beside it |
//! | `POST /sell` | the listing form: a patch with JavaScript, the page without; refused (422) when it ships nowhere or takes offers with no lowest one |
//! | `POST /archive`, `POST /watch` | the menu's form actions: archive the draft, watch the card |
//! | `POST /save` | saving the draft, answered with a toast |
//! | `POST /rename` | the rename dialog's form: refused, the dialog drawn open; else back to the draft, whose toaster says it was renamed (`req.redirect_with_notice`) |
//! | `GET /help` | the menu's link |
//! | `GET /orders?page=2` | the seller's orders, a page of them: the kit's other components |
//! | `POST /orders/settings` | the shipping settings: back to the orders, whose toaster says they were saved |
use corten::{Component, i18n::Currency, prelude::*};
use serde::Deserialize;
use std::time::{Duration, SystemTime};

use corten_ui::{Toast, Toaster};

use crate::gallery::{
    CARD, Condition, Gallery, MarketTab, MenuResult, OrderResult, Period, Pricing, Region, RenameDialog, Sale, Times,
};
use crate::orders::{Orders, PAGES, SettingsForm};
use crate::ui::{
    button::{Button, ButtonSize, ButtonVariant},
    nav_bar::{NavActions, NavBar, NavBrand, NavSections},
    toasts::Toasts,
};

corten::i18n::messages! {
    /// The gallery's text: one locale, for the relative times.
    pub struct Msg { "en" => "locales/en.json" }
}

/// How far the best offer's expiry is ahead of each page, and the listing behind it.
pub const EXPIRES_IN: Duration = Duration::from_secs(90);
pub const LISTED_AGO: Duration = Duration::from_secs(3 * 3600 + 5 * 60);
/// When the draft was created, after the Unix epoch: 2026-03-22T15:04:05Z, written in the
/// visitor's zone.
pub const CREATED: Duration = Duration::from_secs(1_774_191_845);

corten::assets::embed! {
    /// The files in `static/`, compiled into the program: `Static::STYLE_CSS` is `static/style.css`.
    pub struct Static = "static";
}

/// Every URL the gallery serves and links to, with the handlers that serve it.
#[corten::routes]
pub mod url {
    #[route("/", get = home)]
    pub struct Home {
        pub tab: Option<crate::gallery::MarketTab>,
        pub sale: Option<crate::gallery::Sale>,
        pub period: Option<crate::gallery::Period>,
        pub sold: Option<crate::gallery::SoldBy>,
    }

    #[route("/sell", post = sell)]
    pub struct Sell;

    #[route("/help", get = help)]
    pub struct Help;

    #[route("/archive", post = archive)]
    pub struct Archive;

    #[route("/watch", post = watch)]
    pub struct Watch;

    #[route("/save", post = save)]
    pub struct Save;

    #[route("/rename", post = rename)]
    pub struct Rename;

    #[route("/orders", get = orders)]
    pub struct Orders {
        pub page: Option<usize>,
        pub sort: Option<crate::orders::OrderSort>,
    }

    #[route("/orders/settings", post = settings)]
    pub struct Settings;
}

/// The app's components: the kit's (`ui::COMPONENTS`) are listed before them, corten-ui's after.
pub const COMPONENTS: &[Component] = &[Gallery, crate::gallery::Sku, Orders];

pub fn app() -> App {
    App::new(url::router())
        .assets(Static)
        .components(crate::ui::COMPONENTS)
        .components(COMPONENTS)
        .components(corten_ui::COMPONENTS)
        .zoned_dates()
}

/// The document around every page, with the toaster: what an answer says (`toast`) or, after a
/// redirect, what the write said (`req.notice()`), which a write's redirect draws again with the
/// rest of the layout.
#[component]
fn Layout<'a>(req: &'a Req, title: &'a str, toast: Option<&'a str>, children: impl Render) -> impl Document {
    let notice = req.notice();
    let message = notice.map(|n| n as &dyn Render).or(toast.as_ref().map(|t| t as &dyn Render));
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
                    <a class={NavBrand {}} href={DRAFT}>"corten-ui"</a>
                    <nav class={NavSections {}} aria-label="Sections">
                        <a {..req.nav(&DRAFT)}>"Draft"</a>
                        <a {..req.nav(&url::Orders { page: None, sort: None })}>"Orders"</a>
                    </nav>
                    <div class={NavActions {}}>
                        <a class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }} href={url::Help}>"Help"</a>
                    </div>
                </header>
                <main>{children}</main>
                <Toasts><Toaster close="Dismiss" seconds={2} toast={Toast { message }} /></Toasts>
            </body>
        </html>
    }
}

/// The offer's relative times, as of now.
fn times(req: &Req) -> Times {
    let (t, now): (Msg, _) = (req.t(), SystemTime::now());
    Times { t, now }
}

/// The gallery in the layout.
fn gallery(req: &Req, gallery: Gallery<'_>) -> HtmlResult {
    req.page(Layout { req, title: TITLE, toast: None, children: gallery })
}

const TITLE: &str = "Sell Ashen Drake | corten-ui";

/// The draft, with no tab, period, order or sheet chosen: the bar's links and the steps' current one.
pub const DRAFT: url::Home = url::Home { tab: None, sale: None, period: None, sold: None };

/// The listings tab with nothing to report: what each answer below changes one part of
/// (`Gallery { result: &text, ..listings(&req, &none) }`), since every prop is written.
fn listings<'a>(req: &Req, none: &'a Errors) -> Gallery<'a> {
    Gallery {
        tab: MarketTab::Listings,
        period: Period::Month,
        sold: None,
        result: "",
        sale: false,
        times: times(req),
        rename: RenameDialog { name: "", errors: none },
        qty: 1.into(),
        weight: 0.5.into(),
    }
}

async fn home(req: Req, Params(q): Params<url::Home>) -> HtmlResult {
    let none = Errors::new();
    let tab = q.tab.unwrap_or(MarketTab::Listings);
    let period = q.period.unwrap_or(Period::Month);
    gallery(&req, Gallery { tab, period, sold: q.sold, sale: q.sale == Some(Sale::Last), ..listings(&req, &none) })
}

#[derive(Deserialize, Fields)]
pub struct SellForm {
    /// A count as typed: one that does not read, or is out of `QTY`, is a message, and the form
    /// is drawn again with what was sent.
    pub qty: Entry<u32>,
    /// Money as the reader typed it, read by `t.parse_money`: a refused entry is shown back as is.
    pub price: String,
    pub weight: Entry<f64>,
    /// One of the combo box's options: a word outside them is refused, as a malformed number is.
    pub condition: Condition,
    /// The regions the seller ships to: at least one (`CheckboxGroup`).
    #[serde(default)]
    pub ships: Vec<Region>,
    /// A fixed price, or offers with the lowest offer the seller accepts (`RequiredWhen`).
    pub pricing: Pricing,
    /// Money too, empty unless the listing takes offers.
    #[serde(default)]
    pub floor: String,
}

/// The listing's currency.
pub const USD: Currency = Currency::new("USD");

/// How many copies a listing may offer, and its shipping weight in ounces: the inputs' `min`, `max`
/// and `step`, and the handler's check.
pub const QTY: Bounds<u32> = Bounds::new(1, 10);
pub const WEIGHT: Bounds<f64> = Bounds::new(0.1, 16.0).step(0.1);

/// What a listing that ships nowhere is told, by the browser and by the handler.
pub const NO_REGION: &str = "Choose where you ship.";

/// Listed, or refused when it ships nowhere or takes offers with no lowest one: the browser stops
/// both before sending when its script runs, and this is the check without it.
async fn sell(req: Req, Form(form): Form<SellForm>) -> HtmlResult {
    let f = SellForm::FIELDS;
    let t: Msg = req.t();
    let mut errors = Errors::new();
    let (qty, weight) = (QTY.read(&form.qty), WEIGHT.read(&form.weight));
    if qty.is_none() {
        errors.add(f.qty, format!("List from {} to {} copies.", QTY.min(), QTY.max()));
    }
    if weight.is_none() {
        errors.add(f.weight, format!("Enter a weight from {} to {} oz, in tenths.", WEIGHT.min(), WEIGHT.max()));
    }
    let price = t.parse_money(&form.price, USD);
    if price.is_none() {
        errors.add(f.price, "Enter a price, such as 12.50.");
    }
    if form.ships.is_empty() {
        errors.add(f.ships, NO_REGION);
    }
    if form.pricing == Pricing::Offers && t.parse_money(&form.floor, USD).is_none() {
        errors.add(f.floor, "Enter the lowest offer you accept.");
    }
    if let Some((_, message)) = errors.iter().next() {
        let none = Errors::new();
        // Without the script the form is drawn again, its numbers as they were typed.
        let sent = || Gallery { result: message, qty: form.qty.clone(), weight: form.weight.clone(), ..listings(&req, &none) };
        let page = || async { gallery(&req, sent()) };
        return req.invalid(&errors, OrderResult { text: message }, page).await;
    }
    // Some here: each that does not read is refused above.
    let (qty, weight) = (qty.unwrap_or_default(), weight.unwrap_or_default());
    let condition = form.condition.label();
    // Some here: a price that does not read is refused above.
    let price = price.map(|cents| t.money(cents, USD).to_string()).unwrap_or_default();
    let text = format!("Listed {qty} {condition} {CARD} at {price} each, {weight:.1} oz to ship.");
    let none = Errors::new();
    let page = || async { gallery(&req, Gallery { result: &text, ..listings(&req, &none) }) };
    req.patch_or(OrderResult { text: &text }, page).await
}

/// Answers with a toast: the message as a patch, or in the page without JavaScript.
async fn save(req: Req) -> HtmlResult {
    const SAVED: &str = "Draft saved.";
    let none = Errors::new();
    let page = || async { req.page(Layout { req: &req, title: TITLE, toast: Some(SAVED), children: listings(&req, &none) }) };
    req.patch_or(Toast { message: Some(SAVED) }, page).await
}

#[derive(Deserialize, Fields)]
pub struct RenameForm {
    pub name: String,
}

/// A name is required: refused, the dialog comes back drawn open with the error, as a patch or in
/// the whole page.
async fn rename(req: Req, Form(form): Form<RenameForm>) -> HtmlResult {
    let name = form.name.trim();
    if !name.is_empty() {
        return req.redirect_with_notice(
            &url::Home { tab: None, sale: None, period: None, sold: None },
            format_args!("Renamed to {name}."),
        );
    }
    let mut errors = Errors::new();
    errors.add(RenameForm::FIELDS.name, "Give the draft a name.");
    let page = || async { gallery(&req, Gallery { rename: RenameDialog { name, errors: &errors }, ..listings(&req, &errors) }) };
    req.invalid(&errors, RenameDialog { name, errors: &errors }, page).await
}

async fn archive(req: Req) -> HtmlResult {
    menu_action(req, "Archived.").await
}

async fn watch(req: Req) -> HtmlResult {
    menu_action(req, "Watching.").await
}

async fn menu_action(req: Req, text: &'static str) -> HtmlResult {
    req.patch_or(MenuResult { text }, || async { req.redirect(&url::Home { tab: None, sale: None, period: None, sold: None }) })
        .await
}

/// A page of the orders: one past the last is the last.
async fn orders(req: Req, Params(q): Params<url::Orders>) -> HtmlResult {
    let page = q.page.unwrap_or(1).clamp(1, PAGES);
    // The avatar takes the address as text.
    let (t, photo) = (req.t(), req.asset(Static::FAVICON_SVG).to_string());
    req.page(html! {
        <Layout req={&req} title="Orders | corten-ui" toast={None}>
            <Orders t={t} page={page} sort={q.sort} photo={&photo} />
        </Layout>
    })
}

/// Saved, back to the orders, whose toaster says so.
async fn settings(req: Req, Form(form): Form<SettingsForm>) -> HtmlResult {
    let (from, days, labels) = (form.warehouse.label(), form.handling.clamp(1, 5), form.labels.label());
    let emails = if form.notify { "on" } else { "off" };
    let note = if form.note.trim().is_empty() { "no note" } else { "your note" };
    req.redirect_with_notice(
        &url::Orders { page: None, sort: None },
        format_args!("Saved: ships from {from} in {days} days on {labels} labels with {note}; shipping emails {emails}."),
    )
}

async fn help(req: Req) -> HtmlResult {
    req.page(html! {
        <Layout req={&req} title="Help | corten-ui" toast={None}>
            <h1>"Listing a card"</h1>
            <p>"A draft is yours until you list it. Each part of the form:"</p>
            <dl>
                <dt>"Price and lowest offer"</dt>
                <dd>
                    "In dollars and cents, as you would write them: 12.50 or $1,299.50. Take offers and buyers can offer less, down to the lowest you set."
                </dd>
                <dt>"Condition"</dt>
                <dd>"Grade the copy you are selling, from Near Mint (as it left the pack) to Damaged. Type to find one."</dd>
                <dt>"Ships to"</dt>
                <dd>"Choose at least one region. Shipping is worked out from the weight you enter."</dd>
                <dt>"Archive and Watch"</dt>
                <dd>"Archiving puts the draft away without listing it. Watching tells you when this card's market low moves."</dd>
            </dl>
            <p><a href={url::Home { tab: None, sale: None, period: None, sold: None }}>"Back to the draft"</a></p>
        </Layout>
    })
}

#[cfg(test)]
mod tests {
    use corten::{
        Local,
        http::StatusCode,
        testing::{Answer, Call, Client, FormBody},
    };

    use super::*;
    use crate::{
        gallery::{Condition, MarketTab, Pricing, Region, Sale, SoldBy},
        orders::{LabelSize, OrderSort, SettingsForm, Warehouse},
    };

    /// The gallery, with nothing in its address.
    const HOME: url::Home = url::Home { tab: None, sale: None, period: None, sold: None };

    fn client() -> Client {
        app().test()
    }

    /// The page at `to`, as text.
    async fn page(to: &url::Home) -> String {
        client().get(to).await.text().to_string()
    }

    /// The orders at `page`, sorted by `sort`.
    async fn orders(page: Option<usize>, sort: Option<OrderSort>) -> String {
        client().get(&url::Orders { page, sort }).await.text().to_string()
    }

    /// The sale form, filled in with one copy at an ounce in Lightly Played: the rest as given.
    fn listing<'c>(app: &'c Client, price: &str, ships: &[Region], pricing: Pricing, floor: &str) -> Call<'c, FormBody> {
        let f = SellForm::FIELDS;
        let call = app.post(&url::Sell).field(f.qty, 1).field(f.price, price).field(f.weight, 1.0).field(f.condition, Condition::LightlyPlayed);
        ships.iter().fold(call, |call, region| call.field(f.ships, region)).field(f.pricing, pricing).field(f.floor, floor)
    }

    /// The status and the body.
    fn read(res: &Answer) -> (StatusCode, &str) {
        (res.status(), res.text())
    }

    /// The scripts are checked against these declarations by `npm run check`.
    #[test]
    fn script_types_match_the_server() {
        corten::types::Types::new()
            .add::<crate::ui::tests::TotalsBy>()
            .components(COMPONENTS)
            .components(corten_ui::COMPONENTS)
            .sync(concat!(env!("CARGO_MANIFEST_DIR"), "/types/app.d.ts"));
    }

    #[tokio::test]
    async fn the_page_preloads_the_scripts_it_uses_and_selects_the_tab_in_the_url() {
        let page = page(&url::Home { tab: Some(MarketTab::Offers), ..HOME }).await;
        for name in ["ui.number_field", "ui.combo_box", "ui.tab_group", "ui.menu_button", "ui.toaster", "ui.dialog"] {
            assert!(page.contains(&format!("/scripts/{name}.js\">")), "{name} is preloaded: {page}");
        }
        assert!(
            page.contains(r#"id="book-tab-1" href="/?tab=offers" aria-controls="book-panel-1" aria-selected="true""#),
            "{page}"
        );
    }

    /// Without the script, a sort header's link is the page the server sorts, with `aria-sort` on
    /// its column and the other direction for the next click.
    #[tokio::test]
    async fn a_sort_header_links_to_the_page_the_server_sorts() {
        let page = page(&url::Home { sold: Some(SoldBy::PriceDown), ..HOME }).await;
        let at = |name: &str| page.find(name).unwrap_or_else(|| panic!("{name}: {page}"));
        assert!(at("Ada Lovelace") < at("Grace Hopper") && at("Grace Hopper") < at("Alan Turing"), "{page}");
        assert!(page.contains(r#"aria-sort="descending"><a class="#) && page.contains(r#"href="/?sold=price""#), "{page}");
        assert!(page.contains(r#"href="/?sold=day""#) && page.contains(r#"href="/?sold=buyer""#), "{page}");
        assert!(page.contains(r#"data-sort="1240""#), "{page}");
        // A hover does not fetch the sorted page, which a click sorting in place does not use.
        assert!(page.contains("<thead data-no-prefetch>"), "{page}");
        // With no order asked, the rows are in day order, and Sold says so and links to the other way.
        let first = self::page(&HOME).await;
        let at = first.find(r#"aria-sort="ascending""#).unwrap_or_else(|| panic!("{first}"));
        let header = &first[at..at + first[at..].find("</th>").unwrap()];
        assert!(header.contains(r#"href="/?sold=day_down""#) && header.contains("Sold"), "{header}");
        assert_eq!(first.matches("aria-sort=").count(), 1, "{first}");
    }

    #[tokio::test]
    async fn the_paragraph_listens_for_the_event_the_copy_button_dispatches() {
        // A library's event carries its prefix; the listener names the event by its type, so the
        // two cannot drift apart.
        let page = page(&HOME).await;
        assert!(page.contains(r#"data-on="ui-copied:sku.counted($e,@copied,@copies)""#), "{page}");
    }

    #[tokio::test]
    async fn the_form_answers_with_a_patch_or_the_page() {
        let app = client();
        let f = SellForm::FIELDS;
        let listed = || {
            app.post(&url::Sell)
                .field(f.qty, 2)
                .field(f.price, "12.50")
                .field(f.weight, 0.5)
                .field(f.condition, Condition::LightlyPlayed)
                .field(f.ships, Region::Us)
                .field(f.ships, Region::Eu)
                .field(f.pricing, Pricing::Fixed)
                .field(f.floor, "")
        };
        let patch = listed().mode(Mode::Action).await;
        assert_eq!(
            patch.text(),
            r#"<p id="result" role="status">Listed 2 Lightly Played Ashen Drake at $12.50 each, 0.5 oz to ship.</p>"#
        );
        let page = listed().await;
        assert!(page.text().contains("<html") && page.text().contains("Listed 2 Lightly Played Ashen Drake"));
    }

    /// What the browser stops when its script runs (no region, offers with no lowest one), the
    /// handler refuses without it.
    #[tokio::test]
    async fn a_listing_that_ships_nowhere_or_takes_offers_without_a_floor_is_refused() {
        let app = client();
        for (sent, message) in [
            (listing(&app, "1", &[], Pricing::Fixed, ""), "Choose where you ship."),
            (listing(&app, "1", &[Region::Ca], Pricing::Offers, ""), "Enter the lowest offer you accept."),
            (listing(&app, "1.2.3", &[Region::Ca], Pricing::Fixed, ""), "Enter a price, such as 12.50."),
        ] {
            let res = sent.mode(Mode::Action).await;
            assert_eq!(read(&res), (StatusCode::UNPROCESSABLE_ENTITY, &*format!(r#"<p id="result" role="status">{message}</p>"#)));
        }
        let res = listing(&app, "$1,299.50", &[Region::Ca], Pricing::Offers, "5").mode(Mode::Action).await;
        assert_eq!(res.status(), StatusCode::OK);
    }

    /// The choices are enums: a word the page does not offer (a forged post) is refused before the
    /// handler runs, as a malformed number is.
    #[tokio::test]
    async fn a_word_the_page_does_not_offer_is_refused() {
        let app = client();
        let f = SellForm::FIELDS;
        /// The fields every one of these sends as the page offers them.
        fn rest(call: Call<'_, FormBody>) -> Call<'_, FormBody> {
            let f = SellForm::FIELDS;
            call.field(f.qty, 1).field(f.price, "1").field(f.weight, 1.0).field(f.floor, "")
        }
        for (word, forged) in [
            ("mint", rest(app.post(&url::Sell)).field(f.condition.untyped(), "mint").field(f.ships, Region::Us).field(f.pricing, Pricing::Fixed)),
            ("mars", rest(app.post(&url::Sell)).field(f.condition, Condition::LightlyPlayed).field(f.ships.untyped(), "mars").field(f.pricing, Pricing::Fixed)),
            ("auction", rest(app.post(&url::Sell)).field(f.condition, Condition::LightlyPlayed).field(f.ships, Region::Us).field(f.pricing.untyped(), "auction")),
        ] {
            assert_eq!(forged.await.status(), StatusCode::UNPROCESSABLE_ENTITY, "{word}");
        }
        // An address with a tab the page does not have (an old link, a renamed tab) reads as no tab:
        // the page opens on its first, where a posted word it does not offer is refused above.
        let tab = app.get(&Local::parse("/?tab=bids").unwrap()).await;
        assert_eq!(tab.status(), StatusCode::OK, "a tab the page does not have");
    }

    #[tokio::test]
    async fn the_address_opens_the_sale_sheet_and_its_link_closes_it() {
        let open = page(&url::Home { sale: Some(Sale::Last), ..HOME }).await;
        assert!(
            open.contains(r#"<dialog data-scope="sale-sheet" class="sheet__sheet sheet__right sheet__md" open aria-label="Last sale" data-on="connect:ui.dialog.modalClosedBy($t,@close,$s)">"#),
            "{open}"
        );
        assert!(
            open.contains(r#"<a class="button__button button__ghost button__sm" data-ref="close" href="/">Close</a>"#),
            "{open}"
        );
        let home = page(&HOME).await;
        assert!(!home.contains("Last sale\""), "drawn only when the address names it: {home}");
        assert!(
            home.contains(r#"<a class="button__button button__link button__sm" href="/?sale=last" interestfor="last-sale-tip" aria-describedby="last-sale-tip">Last sale</a>"#),
            "{home}"
        );
    }

    #[tokio::test]
    async fn a_refused_rename_draws_the_dialog_open() {
        let app = client();
        let rename = |name| app.post(&url::Rename).field(RenameForm::FIELDS.name, name);
        let patch = rename(" ").mode(Mode::Action).await;
        let patch = patch.text();
        assert!(
            patch.starts_with(r#"<dialog class="dialog__dialog dialog__md" id="rename" open aria-label="Rename the draft" data-on="connect:ui.dialog.modal($t)">"#),
            "{patch}"
        );
        assert!(patch.contains("aria-invalid=\"true\"") && patch.contains("Give the draft a name."), "{patch}");
        let page = rename("").await;
        let page = page.text();
        assert!(
            page.contains("<html") && page.contains(r#"<dialog class="dialog__dialog dialog__md" id="rename" open"#),
            "{page}"
        );
        let home = self::page(&HOME).await;
        assert!(home.contains(r#"<dialog class="dialog__dialog dialog__md" id="rename" aria-label"#), "drawn closed: {home}");
    }

    /// Each page's links are typed routes: the first page's address has no number, and a number
    /// past the last reads as the last.
    #[tokio::test]
    async fn the_orders_link_to_their_pages() {
        let first = orders(None, None).await;
        assert!(first.contains(r#"<a class="#) && first.contains(r#"href="/orders?page=2" rel="next""#), "{first}");
        assert!(first.contains(r#"href="/orders" aria-current="page">1</a>"#), "{first}");
        assert!(first.contains(">AL<") && !first.contains(">BL<"), "four to a page: {first}");
        let last = orders(Some(9), None).await;
        assert!(last.contains(r#"href="/orders?page=3" aria-current="page">3</a>"#), "{last}");
        assert!(last.contains(">JB<") && !last.contains(">AL<"), "{last}");
    }

    #[tokio::test]
    async fn the_orders_sort_by_their_total() {
        let unsorted = orders(None, None).await;
        assert!(unsorted.contains(r#"href="/orders?sort=total_up""#) && !unsorted.contains("aria-sort"), "{unsorted}");
        // The kit's Field writes the label's `for` and the hint's id from the control's id.
        assert!(
            unsorted.contains(r#"<label for="handling">"#)
                && unsorted.contains(r#"id="handling-hint">From 1 to 5.</p>"#)
                && unsorted.contains(r#"aria-describedby="handling-hint""#),
            "{unsorted}"
        );
        let up = orders(None, Some(OrderSort::TotalUp)).await;
        assert!(up.contains(r#"aria-sort="ascending""#) && up.contains(r#"href="/orders?sort=total_down""#), "{up}");
        assert!(up.contains(">JB<") && up.contains(">BL<") && !up.contains(">AL<"), "the four smallest: {up}");
        assert!(up.contains(r#"href="/orders?page=2&amp;sort=total_up" rel="next""#), "a page keeps the order: {up}");
        let down = orders(None, Some(OrderSort::TotalDown)).await;
        assert!(down.contains(r#"aria-sort="descending""#) && down.contains(r#"href="/orders?sort=total_up""#), "{down}");
        assert!(down.contains(">ED<") && !down.contains(">JB<"), "the four largest: {down}");
    }

    #[tokio::test]
    async fn saved_settings_go_back_to_the_orders_with_a_notice() {
        let app = client();
        let f = SettingsForm::FIELDS;
        let res = app
            .post(&url::Settings)
            .field(f.warehouse, Warehouse::Austin)
            .field(f.labels, LabelSize::Letter)
            .field(f.handling, 3)
            .field(f.note, "")
            .await;
        assert_eq!(res.status(), StatusCode::SEE_OTHER);
        assert_eq!(res.headers()["location"], "/orders");
        let forged = app
            .post(&url::Settings)
            .field(f.warehouse.untyped(), "mars")
            .field(f.labels, LabelSize::Letter)
            .field(f.handling, 3)
            .await;
        assert_eq!(forged.status(), StatusCode::UNPROCESSABLE_ENTITY, "a warehouse the page does not offer");
    }

    #[test]
    fn a_field_shows_its_hint_and_its_error_together() {
        use crate::ui::field::Field;

        #[derive(Id)]
        struct CopiesFormId;
        #[derive(serde::Deserialize, Fields)]
        struct Copies {
            #[expect(dead_code, reason = "the test reads only the field's name")]
            copies: u32,
        }
        let f = Copies::FIELDS;
        let mut errors = Errors::new();
        errors.add(f.copies, "Too many.");
        let e = errors.within(CopiesFormId);
        // The label, the control, its hint and its error, all named from the one field.
        let html = html! {
            <form>
                <Field id={e.id(f.copies)} label="Copies" hint="From 1 to 5." error={e.message(f.copies)}>
                    <input {..e.control(f.copies).hint()}>
                </Field>
            </form>
        }
        .to_html();
        assert!(html.contains(r#"<label for="copies-form-copies">Copies</label>"#), "{html}");
        assert!(
            html.contains(r#"<input id="copies-form-copies" name="copies" aria-invalid="true" aria-describedby="copies-form-copies-hint copies-form-copies-error">"#),
            "{html}"
        );
        assert!(html.contains(r#"id="copies-form-copies-hint">From 1 to 5.</p>"#), "{html}");
        assert!(html.contains(r#"id="copies-form-copies-error""#) && html.contains("Too many."), "{html}");
    }

    #[tokio::test]
    async fn saving_answers_with_a_toast() {
        let app = client();
        let patch = app.post(&url::Save).mode(Mode::Action).await;
        assert_eq!(patch.text(), r#"<div id="ui-toast">Draft saved.</div>"#);
        let page = app.post(&url::Save).await;
        assert!(page.text().contains(r#"<div data-ref="status" role="status"><div id="ui-toast">Draft saved.</div></div>"#), "{}", page.text());
        let home = self::page(&HOME).await;
        assert!(home.contains(r#"<div id="ui-toast" hidden></div>"#), "{home}");
    }
}
