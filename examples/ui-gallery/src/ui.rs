//! The UI kit, from the kit's own files (`crates/corten-cli/kit`, what `corten ui add` copies into an
//! app), so the browser test covers each component as an app gets it.
//! Each is `rustfmt::skip`: the kit is laid out at rustfmt's default width, as an app formats it,
//! not this repository's.

use corten::Component;

#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/accordion.rs"]
pub mod accordion;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/alert.rs"]
pub mod alert;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/avatar.rs"]
pub mod avatar;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/badge.rs"]
pub mod badge;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/breadcrumb.rs"]
pub mod breadcrumb;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/button.rs"]
pub mod button;
/// The kit's card. Its density is the card's own `size`: the class it was written beside a card,
/// which compiled alone or beside another look and did nothing there, is gone.
///
/// ```compile_fail,E0432
/// use ui_gallery::ui::card::CardCompact;
/// ```
///
/// ```compile_fail,E0063
/// use corten::prelude::*;
/// use ui_gallery::ui::card::Card;
///
/// let _ = html! { <section class={Card {}}></section> };
/// ```
///
/// ```
/// use corten::prelude::*;
/// use ui_gallery::ui::card::{Card, CardPanel, CardSize};
///
/// let _ = html! { <section class={Card { size: CardSize::Sm }}></section> };
/// let _ = html! { <section class={CardPanel { size: CardSize::Md }}></section> };
/// ```
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/card.rs"]
pub mod card;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/checkbox.rs"]
pub mod checkbox;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/checkboxes.rs"]
pub mod checkboxes;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/combobox.rs"]
pub mod combobox;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/control_width.rs"]
pub mod control_width;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/dialog.rs"]
pub mod dialog;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/dropdown_menu.rs"]
pub mod dropdown_menu;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/field.rs"]
pub mod field;
/// The kit's icons. A glyph's text is the only text the kit places with `raw`, so a `Glyph` takes
/// only a `&'static str`: a literal in the app's source, in any module of the app.
///
/// ```
/// use corten::prelude::*;
/// use ui_gallery::ui::icon::{self, Glyph, Icon};
///
/// const MINUS: Glyph = Glyph::new(r#"<path d="M5 12h14"/>"#);
/// let _ = html! { <Icon glyph={icon::TRASH} /> };
/// let _ = html! { <Icon glyph={MINUS} /> };
/// ```
///
/// Text a request brought is not, so it does not reach the page unescaped by way of an icon (only
/// text the app keeps for the life of the process, leaked or in a static, would, as it would
/// through `raw` itself):
///
/// ```compile_fail,E0597
/// use ui_gallery::ui::icon::Glyph;
///
/// fn from_request(body: String) -> Glyph {
///     Glyph::new(&body)
/// }
/// ```
///
/// One the set lacks does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
/// use ui_gallery::ui::icon::{self, Icon};
///
/// let _ = html! { <Icon glyph={icon::SPARKLES} /> };
/// ```
///
/// and a glyph is not a name:
///
/// ```compile_fail
/// use corten::prelude::*;
/// use ui_gallery::ui::icon::Icon;
///
/// let _ = html! { <Icon glyph="trash" /> };
/// ```
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/icon.rs"]
pub mod icon;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/input.rs"]
pub mod input;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/input_group.rs"]
pub mod input_group;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/meter.rs"]
pub mod meter;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/nav_bar.rs"]
pub mod nav_bar;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/pagination.rs"]
pub mod pagination;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/popover.rs"]
pub mod popover;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/progress.rs"]
pub mod progress;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/radio_group.rs"]
pub mod radio_group;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/segmented.rs"]
pub mod segmented;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/select.rs"]
pub mod select;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/separator.rs"]
pub mod separator;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/sheet.rs"]
pub mod sheet;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/skeleton.rs"]
pub mod skeleton;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/slider.rs"]
pub mod slider;
/// The kit's stack. `StackStart` is a whole look, the stack with its gap: written without one, as
/// the class it was beside a `Stack`, it does not compile.
///
/// ```compile_fail,E0063
/// use corten::prelude::*;
/// use ui_gallery::ui::stack::{Gap, Stack, StackStart};
///
/// let _ = html! { <div class={(Stack { gap: Gap::Xs }, StackStart {})}></div> };
/// ```
///
/// ```
/// use corten::prelude::*;
/// use ui_gallery::ui::stack::{Gap, StackStart};
///
/// let _ = html! { <div class={StackStart { gap: Gap::Xs }}></div> };
/// ```
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/stack.rs"]
pub mod stack;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/stats.rs"]
pub mod stats;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/status_dot.rs"]
pub mod status_dot;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/stepper.rs"]
pub mod stepper;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/steps.rs"]
pub mod steps;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/switch.rs"]
pub mod switch;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/table.rs"]
pub mod table;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/tabs.rs"]
pub mod tabs;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/textarea.rs"]
pub mod textarea;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/tip.rs"]
pub mod tip;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/toasts.rs"]
pub mod toasts;
#[rustfmt::skip]
#[path = "../../../crates/corten-cli/kit/visually_hidden.rs"]
pub mod visually_hidden;

corten::style::tokens!("../../crates/corten-cli/kit/tokens/ui.resolver.json");

/// The tokens, then each component with a stylesheet, as `corten ui add` lists them.
pub const COMPONENTS: &[Component] = &[
    TOKENS,
    accordion::Accordion,
    alert::Alert,
    avatar::Avatar,
    badge::Badge,
    breadcrumb::Breadcrumb,
    button::Button,
    card::Card,
    checkbox::Checkbox,
    checkboxes::Checkboxes,
    combobox::Combobox,
    control_width::ControlWidth,
    dialog::Dialog,
    dropdown_menu::DropdownMenu,
    field::Field,
    icon::Icon,
    input::Input,
    input_group::InputGroup,
    meter::Meter,
    nav_bar::NavBar,
    pagination::Pagination,
    popover::Popover,
    progress::Progress,
    radio_group::RadioGroup,
    segmented::Segmented,
    select::Select,
    separator::Separator,
    sheet::Sheet,
    skeleton::Skeleton,
    slider::Slider,
    stack::Stack,
    stats::Stats,
    status_dot::StatusDot,
    stepper::Stepper,
    steps::Steps,
    switch::Switch,
    table::Table,
    tabs::Tabs,
    textarea::Textarea,
    tip::Tip,
    toasts::Toasts,
    visually_hidden::VisuallyHidden,
];

#[cfg(test)]
pub(crate) mod tests {
    /// A page that only links the components' stylesheet: no component of its own, so the app
    /// lists only the kit's.
    async fn bare(req: corten::Req) -> corten::HtmlResult {
        use corten::{Corten, html};
        req.page(html! {
            <!DOCTYPE html>
            <html lang="en">
                <head>
                    <title>"Kit"</title>
                    <Corten />
                </head>
                <body><main></main></body>
            </html>
        })
    }

    #[corten::routes]
    mod bare_url {
        #[route("/", get = bare)]
        pub struct Bare;
    }

    /// What `docs/guide/kit.md`'s Size says an app with every component and the theme's tokens
    /// serves, its `components.css` as the server sends it: as it is, and as its own brotli (level
    /// 11) and gzip (level 9), compressed once on a first request. Each within 3 percent, so a
    /// component's small change does not fail it and the kit's growth does: it prints the numbers
    /// to put in the guide.
    #[tokio::test]
    async fn the_kit_guide_states_what_every_component_costs() {
        use corten::{App, http::header, testing::Client};
        const SAYS: &str = "every component and the theme's tokens, nothing of its own, serves ";
        // Its lines joined, so the sentence may wrap anywhere.
        let guide = include_str!("../../../docs/guide/kit.md").split_whitespace().collect::<Vec<_>>().join(" ");
        let stated = guide.split_once(SAYS).expect("the guide's Size says what the kit costs").1;
        // "59,156 bytes, 8,580 with brotli and 9,740 with gzip, what ..." to the sentence's end.
        let numbers: Vec<usize> = stated
            .split(['.', ':'])
            .next()
            .unwrap()
            .split_whitespace()
            .filter_map(|word| word.trim_end_matches(',').replace(',', "").parse().ok())
            .filter(|&n: &usize| n > 100)
            .collect();
        let [raw, brotli, gzip] = numbers[..] else { panic!("three sizes after the guide's \"{SAYS}\": {numbers:?}") };

        let app: Client = App::new(bare_url::router()).components(super::COMPONENTS).test();
        let page = app.get(&bare_url::Bare).await;
        let href = page.text().split_once(r#"<link rel="stylesheet" href=""#).expect("the stylesheet is linked").1;
        let href = corten::Local::parse(href.split_once('"').unwrap().0).unwrap();
        let first = app.get(&href).header(header::ACCEPT_ENCODING, "identity").await;
        let plain_tag = first.headers()[header::ETAG].clone();
        let sent = |coding: &'static str, tag: &'static str| {
            let (app, href) = (app.clone(), href.clone());
            // The stored form's tag is the file's with its coding's (`"0123..ef-br"`).
            let stored_tag = format!("{}-{tag}\"", plain_tag.to_str().unwrap().trim_end_matches('"'));
            async move {
                // Until the stored forms are made (once, at the highest levels, started by the first
                // request that accepts one), each answer is compressed per request at the fastest
                // level, under the weak form of the file's tag (`W/"0123..ef"`).
                for _ in 0..1200 {
                    let res = app.get(&href).header(header::ACCEPT_ENCODING, coding).await;
                    let got = res.headers().get(header::CONTENT_ENCODING).map(|v| v.to_str().unwrap().to_owned());
                    if got.as_deref() == Some(coding) && res.headers()[header::ETAG] == stored_tag.as_str() {
                        return res.bytes().len();
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                panic!("the stored {coding} form was never sent");
            }
        };
        let (now_raw, now_brotli, now_gzip) = (first.bytes().len(), sent("br", "br").await, sent("gzip", "gz").await);
        let near = |stated: usize, now: usize| stated.abs_diff(now) * 100 <= now * 3;
        assert!(
            near(raw, now_raw) && near(brotli, now_brotli) && near(gzip, now_gzip),
            "docs/guide/kit.md's Size says {raw}, {brotli} with brotli and {gzip} with gzip; the kit's components.css is now \
             {now_raw} bytes, {now_brotli} with brotli at level 11 and {now_gzip} with gzip at level 9: put these in the guide"
        );
    }

    /// Every component the kit has is here, so the browser test covers it.
    #[test]
    fn the_gallery_has_every_kit_component() {
        let kit = concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/corten-cli/kit");
        let here = include_str!("ui.rs");
        for entry in std::fs::read_dir(kit).unwrap() {
            let name = entry.unwrap().file_name().into_string().unwrap();
            if name.ends_with(".rs") && name != "ui.rs" {
                let module = name.trim_end_matches(".rs");
                assert!(here.contains(&format!("kit/{name}\"]\npub mod {module};")), "src/ui.rs lacks the kit's {name}");
            }
        }
    }

    /// An alert's role follows its variant, so a screen reader interrupts only for what needs the
    /// user now.
    #[test]
    fn an_alerts_role_follows_its_variant() {
        use super::alert::{Alert, AlertEmphasis, AlertVariant};
        use corten::view::Render;
        for (variant, role) in [
            (AlertVariant::Neutral, None),
            (AlertVariant::Info, None),
            (AlertVariant::Success, Some("status")),
            (AlertVariant::Warning, Some("alert")),
            (AlertVariant::Destructive, Some("alert")),
        ] {
            let html = Alert { variant, emphasis: AlertEmphasis::Soft, children: "" }.to_html();
            match role {
                Some(role) => assert!(html.contains(&format!(r#" role="{role}""#)), "{variant:?}: {html}"),
                None => assert!(!html.contains("role="), "{variant:?}: {html}"),
            }
        }
    }

    /// A form's own message in the alert's look is one live region, and nothing without one (#861).
    #[test]
    fn a_forms_message_is_one_alert() {
        use super::alert::{AlertEmphasis, FormAlert};
        use corten::{Errors, view::Render};
        let mut errors = Errors::new();
        assert_eq!(FormAlert { errors: &errors, emphasis: AlertEmphasis::Soft }.to_html(), "");
        errors.add_form("The policy was retired <meanwhile>.");
        let html = FormAlert { errors: &errors, emphasis: AlertEmphasis::Soft }.to_html();
        assert_eq!(html.matches("role=").count(), 1, "{html}");
        assert!(html.ends_with(r#" role="alert"><p>The policy was retired &lt;meanwhile&gt;.</p></div>"#), "{html}");
    }

    /// A dialog's failure text in the alert's look is one live region that stays rendered, and in
    /// it the destructive alert, `said`, hidden and with no role of its own (#969).
    #[test]
    fn a_dialogs_failure_text_is_one_alert() {
        use corten::{Errors, view::Render};
        let errors = Errors::new();
        let html = crate::gallery::RenameDialog { name: "", errors: &errors }.to_html();
        assert_eq!(html.matches("role=").count(), 1, "{html}");
        assert!(
            html.contains(
                r#"<div role="alert" class="alert__region"><div data-ref="said" class="alert__alert alert__destructive alert__soft" hidden><p>"#
            ),
            "{html}"
        );
    }

    /// A component's page link may be a closure named before the markup, passed by value, that
    /// borrows the page's data and gives a boxed link of that lifetime (#862).
    #[corten::component]
    fn BorrowedPages<'a>(context: &'a str) -> impl corten::view::Render {
        use super::pagination::Pagination;
        use corten::{Href, html, route::Local};
        let page_link =
            move |n: usize| -> Box<dyn Href + 'a> { Box::new(Local::parse(&format!("/list?{context}&page={n}")).unwrap()) };
        html! {
            <Pagination
                label="Pages"
                previous_label="Previous"
                next_label="Next"
                pages={3}
                current={2}
                link={page_link}
                on:link={None::<corten::script::Handler>}
            />
        }
    }

    /// A list that knows only its neighbours: a link with `rel` for each one there is, and a
    /// disabled end in the same look for one that is not (#1073).
    #[test]
    fn previous_next_links_the_neighbours_it_is_given_and_disables_the_others() {
        use super::pagination::PreviousNext;
        use corten::{Href, route::Local, script::Handler, view::Render};
        let older = Local::parse("/payouts?before=p2").unwrap();
        let html = PreviousNext {
            label: "Payouts",
            previous_label: "Newer",
            next_label: "Older",
            previous: None,
            next: Some(&older as &dyn Href),
            on_link: &None::<Handler>,
        }
        .to_html();
        assert!(html.starts_with(r#"<nav class="pagination__pagination" aria-label="Payouts"><ul>"#), "{html}");
        assert!(
            html.contains(r#"<span class="pagination__step pagination__previous" aria-disabled="true">Newer</span>"#),
            "{html}"
        );
        assert!(
            html.contains(r#"<a class="pagination__step pagination__next" href="/payouts?before=p2" rel="next">Older</a>"#),
            "{html}"
        );
        // Only the two steps: no page numbers, which such a list does not know.
        assert!(!html.contains("pagination__page"), "{html}");
        let newer = Local::parse("/payouts").unwrap();
        let html = PreviousNext {
            label: "Payouts",
            previous_label: "Newer",
            next_label: "Older",
            previous: Some(&newer as &dyn Href),
            next: None,
            on_link: &None::<Handler>,
        }
        .to_html();
        assert!(html.contains(r#"href="/payouts" rel="prev">Newer</a>"#), "{html}");
        assert!(html.contains(r#"pagination__next" aria-disabled="true">Older</span>"#), "{html}");
    }

    /// A table the pagers' pages read the order of.
    #[derive(corten::prelude::Id)]
    struct PagedId;

    /// Pagers under a table sorted in place, whose pages read its order (#1107).
    #[corten::component]
    fn OrderedPagers() -> impl corten::view::Render {
        use super::pagination::{Pagination, PreviousNext};
        use corten::{Href, html};
        use corten_ui::{ordered, sorted};
        let after = crate::app::url::Orders { page: Some(3), sort: None, payout: None };
        html! {
            <Pagination
                label="Pages"
                previous_label="Previous"
                next_label="Next"
                pages={3}
                current={3}
                link={|page| crate::app::url::Orders { page: Some(page), sort: None, payout: None }}
                on:link={ordered::link(target, [sorted(&PagedId)], signal)}
            />
            <PreviousNext
                label="Payouts"
                previous_label="Newer"
                next_label="Older"
                previous={None}
                next={Some(&after as &dyn Href)}
                on:link={ordered::link(target, [sorted(&PagedId)], signal)}
            />
        }
    }

    /// `on:link` is every link's `on:connect`, and a disabled end, which is not a link, has none.
    #[test]
    fn a_pager_puts_its_link_handler_on_every_link_it_draws() {
        use corten::view::Render;
        let html = OrderedPagers {}.to_html();
        let on = r#"data-on="connect:ui.ordered.link($t,[&quot;paged&quot;],$s)""#;
        // Pagination: Previous, pages 1 to 3, and none on its disabled Next; PreviousNext: Older.
        assert_eq!(html.matches(on).count(), 5, "{html}");
        assert!(html.contains(&format!(r#"href="/orders?page=2" rel="prev" {on}>Previous</a>"#)), "{html}");
        assert!(html.contains(&format!(r#"href="/orders?page=3" aria-current="page" {on}>"#)), "{html}");
        assert!(html.contains(r#"<span class="pagination__step pagination__next" aria-disabled="true">Next</span>"#), "{html}");
        assert!(
            html.contains(r#"<span class="pagination__step pagination__previous" aria-disabled="true">Newer</span>"#),
            "{html}"
        );
        assert!(html.contains(&format!(r#"rel="next" {on}>Older</a>"#)), "{html}");
    }

    #[test]
    fn a_named_link_closure_may_borrow_the_page() {
        use corten::view::Render;
        let html = BorrowedPages { context: "q=red" }.to_html();
        assert!(html.contains("/list?q=red&amp;page=3") && html.contains("/list?q=red&amp;page=1"), "{html}");
    }

    /// A figure is a term and its descriptions, so a screen reader reads the label with the value;
    /// a tone is a class, and an empty note draws an element the stylesheet hides.
    #[test]
    fn a_stat_is_a_term_and_its_descriptions() {
        use super::stats::{Stat, StatTone};
        use corten::view::Render;
        let html = Stat { label: "Late", value: 1, note: "Past the ship-by date", tone: StatTone::Destructive }.to_html();
        assert!(
            html.starts_with(r#"<div class="stats__stat stats__destructive"><dt>Late</dt><dd class="stats__value">1</dd>"#),
            "{html}"
        );
        assert!(html.contains(r#"<dd class="stats__note">Past the ship-by date</dd>"#), "{html}");
        let plain = Stat { label: "Orders", value: 10, note: "", tone: StatTone::Neutral }.to_html();
        assert!(plain.starts_with(r#"<div class="stats__stat"><dt>"#), "{plain}");
        // Nothing inside, so `:empty` hides it.
        assert!(plain.ends_with(r#"<dd class="stats__note"></dd></div>"#), "{plain}");
        // A summary inside a card: the look with no surface, on the app's <dl>.
        use super::stats::{Stats, StatsSurface};
        let list = corten::html! { <dl class={Stats { surface: StatsSurface::Plain }}></dl> }.to_html();
        assert_eq!(list, r#"<dl class="stats__stats stats__plain"></dl>"#);
    }

    /// `Gap::App` writes only the layout's class, in a stack and a cluster, so the app's own gap
    /// class beside it is the one; a literal gap still writes its class.
    #[test]
    fn an_app_gap_writes_no_gap_class_of_the_kit_s() {
        use super::stack::{Cluster, Gap, Stack};
        use corten::view::Render;
        let stack = corten::html! { <div class={Stack { gap: Gap::App }}></div> }.to_html();
        assert_eq!(stack, r#"<div class="stack__stack"></div>"#);
        let cluster = corten::html! { <div class={Cluster { gap: Gap::App }}></div> }.to_html();
        assert_eq!(cluster, r#"<div class="stack__cluster"></div>"#);
        let literal = corten::html! { <div class={(Stack { gap: Gap::Md }, Cluster { gap: Gap::Sm })}></div> }.to_html();
        assert_eq!(literal, r#"<div class="stack__stack stack__md stack__cluster stack__sm"></div>"#);
    }

    /// A card's and a panel's size is a class of their own, `Md` none, so a dense card is one look.
    #[test]
    fn a_card_and_a_panel_carry_their_size() {
        use super::card::{Card, CardPanel, CardSize};
        use corten::view::Render;
        let md = corten::html! { <section class={Card { size: CardSize::Md }}></section> }.to_html();
        assert_eq!(md, r#"<section class="card__card"></section>"#);
        let sm = corten::html! { <section class={Card { size: CardSize::Sm }}></section> }.to_html();
        assert_eq!(sm, r#"<section class="card__card card__sm"></section>"#);
        let panel = corten::html! { <section class={CardPanel { size: CardSize::Sm }}></section> }.to_html();
        assert_eq!(panel, r#"<section class="card__panel card__sm"></section>"#);
    }

    /// `StackStart` is the stack itself with the class that keeps its children their own width, so it
    /// is written alone, with its gap, and writes what the stack and that class did together.
    #[test]
    fn a_stack_start_is_the_stack_with_its_gap() {
        use super::stack::{Gap, StackStart};
        use corten::view::Render;
        let start = corten::html! { <div class={StackStart { gap: Gap::Xs }}></div> }.to_html();
        assert_eq!(start, r#"<div class="stack__stack stack__xs stack__start"></div>"#);
        let app = corten::html! { <div class={StackStart { gap: Gap::App }}></div> }.to_html();
        assert_eq!(app, r#"<div class="stack__stack stack__start"></div>"#);
    }

    /// A look imported under another name, beside an app type that has its name, keeps the kit's
    /// classes: they follow the component, not the name it is imported as.
    #[test]
    fn a_look_imported_under_another_name_keeps_its_classes() {
        #[allow(dead_code)]
        struct Progress {
            done: u32,
        }
        use super::progress::{Progress as KitProgress, ProgressSize, ProgressTone};
        use corten::view::Render;
        let html = corten::html! {
            <progress class={KitProgress { size: ProgressSize::Sm, tone: ProgressTone::Primary }} max="4" value="1"></progress>
        }
        .to_html();
        assert_eq!(html, r#"<progress class="progress__progress progress__sm" max="4" value="1"></progress>"#);
        // Or by its module's path, with no import of the name.
        let by_path = corten::html! {
            <progress class={super::progress::Progress { size: ProgressSize::Sm, tone: ProgressTone::Primary }}></progress>
        }
        .to_html();
        assert_eq!(by_path, r#"<progress class="progress__progress progress__sm"></progress>"#);
    }

    /// A progress bar's tone is a class beside its size, and the primary one, a task under way, is
    /// none: the bar's own rule fills it.
    #[test]
    fn a_progress_tone_is_a_class() {
        use super::progress::{Progress, ProgressSize, ProgressTone};
        use corten::view::Render;
        let bar = |size, tone| corten::html! { <progress class={Progress { size, tone }}></progress> }.to_html();
        assert_eq!(bar(ProgressSize::Md, ProgressTone::Primary), r#"<progress class="progress__progress"></progress>"#);
        assert_eq!(
            bar(ProgressSize::Md, ProgressTone::Info),
            r#"<progress class="progress__progress progress__info"></progress>"#
        );
        assert_eq!(
            bar(ProgressSize::Md, ProgressTone::Success),
            r#"<progress class="progress__progress progress__success"></progress>"#
        );
        assert_eq!(
            bar(ProgressSize::Sm, ProgressTone::Warning),
            r#"<progress class="progress__progress progress__sm progress__warning"></progress>"#
        );
        assert_eq!(
            bar(ProgressSize::Md, ProgressTone::Destructive),
            r#"<progress class="progress__progress progress__destructive"></progress>"#
        );
    }

    /// The column a table sorted in place sorts by: a Rust type the script's parameter is declared
    /// as (`types/app.d.ts`), so the call takes it and nothing else.
    #[derive(Clone, Copy, serde::Serialize, corten::prelude::ToJson)]
    pub(crate) enum TotalsBy {
        Total,
        Placed,
    }

    /// A header of a table that sorts in place, told its column by a typed call on its link.
    #[corten::component(js)]
    fn SortedTotals() -> impl corten::view::Render {
        use super::table::{Sort, SortHeader, TableNumeric};
        use crate::{app::url, orders::OrderSort};
        use corten::prelude::*;
        html! {
            <tr>
                <SortHeader
                    label="Total"
                    sort={Some(Sort::Ascending)}
                    ascending={&url::Orders { page: None, sort: Some(OrderSort::TotalUp), payout: None }}
                    descending={&url::Orders { page: None, sort: Some(OrderSort::TotalDown), payout: None }}
                    first={Sort::Ascending}
                    class={TableNumeric {}}
                    on:sort={js::sortBy(event, TotalsBy::Total)}
                />
                <SortHeader
                    label="Placed"
                    sort={None}
                    ascending={&url::Orders { page: Some(1), sort: None, payout: None }}
                    descending={&url::Orders { page: Some(2), sort: None, payout: None }}
                    first={Sort::Descending}
                    class={()}
                    on:sort={js::sortBy(event, TotalsBy::Placed)}
                />
            </tr>
        }
    }

    /// A sortable header's link takes the page's typed call, so a script that sorts in place is
    /// told the column, and the link still sorts the page without the script.
    #[test]
    fn a_sort_header_takes_a_handler_for_its_link() {
        use corten::view::Render;
        let html = SortedTotals {}.to_html();
        // On the link, not the header: the click the script takes is the link's.
        assert!(
            html.contains(r#"href="/orders?sort=total_down" data-ascending="/orders?sort=total_up" data-descending="/orders?sort=total_down" data-on="click:sorted_totals.sortBy($e,&quot;Total&quot;)">"#),
            "{html}"
        );
        // A header the server sorts writes no handler.
        let served = super::table::SortHeader {
            label: "Total",
            sort: None,
            ascending: &crate::app::url::Orders { page: None, sort: None, payout: None },
            descending: &crate::app::url::Orders { page: None, sort: None, payout: None },
            first: super::table::Sort::Ascending,
            class: (),
            on_sort: &None::<corten::prelude::Handler>,
        }
        .to_html();
        assert!(!served.contains("data-on"), "{served}");
        // A column read newest first: its first click sorts it descending, and without the
        // script its link is the descending page.
        assert!(
            html.contains(r#"href="/orders?page=2" data-ascending="/orders?page=1" data-descending="/orders?page=2" data-first="descending" data-on="click:sorted_totals.sortBy($e,&quot;Placed&quot;)""#),
            "{html}"
        );
    }

    /// The dot is drawn, not read: the status is in the text beside it. A live one is the same dot
    /// with the class that pulses it.
    #[test]
    fn a_status_dot_is_not_read() {
        use super::status_dot::{LiveDot, StatusDot, StatusTone};
        use corten::view::Render;
        let html = StatusDot { tone: StatusTone::Success }.to_html();
        assert_eq!(html, r#"<span class="status-dot__dot status-dot__success" aria-hidden="true"></span>"#);
        let live = LiveDot { tone: StatusTone::Info }.to_html();
        assert_eq!(live, r#"<span class="status-dot__dot status-dot__live status-dot__info" aria-hidden="true"></span>"#);
        let text = StatusDot { tone: StatusTone::Text }.to_html();
        assert_eq!(text, r#"<span class="status-dot__dot status-dot__text" aria-hidden="true"></span>"#);
        let live_text = LiveDot { tone: StatusTone::Text }.to_html();
        assert_eq!(live_text, r#"<span class="status-dot__dot status-dot__live status-dot__text" aria-hidden="true"></span>"#);
    }

    /// A hidden legend is still the fieldset's legend, which names the group, with the class that
    /// keeps it from being drawn; a shown one has none.
    #[test]
    fn a_segmented_radios_legend_is_shown_or_hidden() {
        use super::segmented::{Legend, SegmentedRadios, SegmentedWidth};
        use corten::view::Render;
        let hidden = SegmentedRadios { legend: Legend::Hidden("View"), width: SegmentedWidth::Fit, children: "" }.to_html();
        assert!(
            hidden.starts_with(r#"<fieldset class="segmented__radios"><legend class="segmented__hidden">View</legend>"#),
            "{hidden}"
        );
        let shown = SegmentedRadios { legend: Legend::Shown("View"), width: SegmentedWidth::Fit, children: "" }.to_html();
        assert!(shown.starts_with(r#"<fieldset class="segmented__radios"><legend>View</legend>"#), "{shown}");
    }

    /// Each form of the segmented control takes a width: `Fit` writes no class, `Fill` the one that
    /// shares the row among the choices.
    #[test]
    fn a_segmented_control_fits_its_choices_or_fills_its_box() {
        use super::segmented::{Legend, Segmented, SegmentedLinks, SegmentedRadios, SegmentedWidth};
        use corten::view::Render;
        let links = |width| corten::html! { <nav class={SegmentedLinks { width }}></nav> }.to_html();
        assert_eq!(links(SegmentedWidth::Fit), r#"<nav class="segmented__links"></nav>"#);
        assert_eq!(links(SegmentedWidth::Fill), r#"<nav class="segmented__links segmented__fill"></nav>"#);
        let around = Segmented { width: SegmentedWidth::Fill, children: "" }.to_html();
        assert_eq!(around, r#"<div class="segmented__segmented segmented__fill"></div>"#);
        let fit = Segmented { width: SegmentedWidth::Fit, children: "" }.to_html();
        assert_eq!(fit, r#"<div class="segmented__segmented"></div>"#);
        let radios = SegmentedRadios { legend: Legend::Shown("View"), width: SegmentedWidth::Fill, children: "" }.to_html();
        assert!(radios.starts_with(r#"<fieldset class="segmented__radios segmented__fill"><legend>"#), "{radios}");
    }
}
