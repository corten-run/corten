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
/// The kit's icons. A glyph is one of the module's constants, the only text the kit places with
/// `raw`:
///
/// ```
/// use corten::prelude::*;
/// use ui_gallery::ui::icon::{self, Icon};
///
/// let _ = html! { <Icon glyph={icon::TRASH} /> };
/// ```
///
/// Text from anywhere else is not a glyph, so it never reaches the page unescaped:
///
/// ```compile_fail
/// let _ = ui_gallery::ui::icon::Glyph("<img src=x onerror=alert(1)>");
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
        use super::alert::{Alert, AlertVariant};
        use corten::view::Render;
        for (variant, role) in [
            (AlertVariant::Neutral, None),
            (AlertVariant::Info, None),
            (AlertVariant::Success, Some("status")),
            (AlertVariant::Warning, Some("alert")),
            (AlertVariant::Destructive, Some("alert")),
        ] {
            let html = Alert { variant, children: "" }.to_html();
            match role {
                Some(role) => assert!(html.contains(&format!(r#" role="{role}""#)), "{variant:?}: {html}"),
                None => assert!(!html.contains("role="), "{variant:?}: {html}"),
            }
        }
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

    /// A look imported under another name, beside an app type that has its name, keeps the kit's
    /// classes: they follow the component, not the name it is imported as.
    #[test]
    fn a_look_imported_under_another_name_keeps_its_classes() {
        #[allow(dead_code)]
        struct Progress {
            done: u32,
        }
        use super::progress::{Progress as KitProgress, ProgressSize};
        use corten::view::Render;
        let html =
            corten::html! { <progress class={KitProgress { size: ProgressSize::Sm }} max="4" value="1"></progress> }.to_html();
        assert_eq!(html, r#"<progress class="progress__progress progress__sm" max="4" value="1"></progress>"#);
        // Or by its module's path, with no import of the name.
        let by_path =
            corten::html! { <progress class={super::progress::Progress { size: ProgressSize::Sm }}></progress> }.to_html();
        assert_eq!(by_path, r#"<progress class="progress__progress progress__sm"></progress>"#);
    }

    /// The column a table sorted in place sorts by: a Rust type the script's parameter is declared
    /// as (`types/app.d.ts`), so the call takes it and nothing else.
    #[derive(Clone, Copy, serde::Serialize, schemars::JsonSchema, corten::prelude::ToJson)]
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
                    link={&url::Orders { page: None, sort: Some(OrderSort::TotalDown) }}
                    class={TableNumeric {}}
                    on:sort={js::sortBy(event, TotalsBy::Total)}
                />
                <SortHeader
                    label="Placed"
                    sort={None}
                    link={&url::Orders { page: None, sort: None }}
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
            html.contains(r#"href="/orders?sort=total_down" data-on="click:sorted_totals.sortBy($e,&quot;Total&quot;)">"#),
            "{html}"
        );
        // A header the server sorts writes no handler.
        let served = super::table::SortHeader {
            label: "Total",
            sort: None,
            link: &crate::app::url::Orders { page: None, sort: None },
            class: (),
            on_sort: &None::<corten::prelude::Handler>,
        }
        .to_html();
        assert!(!served.contains("data-on"), "{served}");
    }

    /// The dot is drawn, not read: the status is in the text beside it.
    #[test]
    fn a_status_dot_is_not_read() {
        use super::status_dot::{StatusDot, StatusTone};
        use corten::view::Render;
        let html = StatusDot { tone: StatusTone::Success }.to_html();
        assert_eq!(html, r#"<span class="status-dot__dot status-dot__success" aria-hidden="true"></span>"#);
    }

    /// A hidden legend is still the fieldset's legend, which names the group, with the class that
    /// keeps it from being drawn; a shown one has none.
    #[test]
    fn a_segmented_radios_legend_is_shown_or_hidden() {
        use super::segmented::{Legend, SegmentedRadios};
        use corten::view::Render;
        let hidden = SegmentedRadios { legend: Legend::Hidden("View"), children: "" }.to_html();
        assert!(
            hidden.starts_with(r#"<fieldset class="segmented__radios"><legend class="segmented__hidden">View</legend>"#),
            "{hidden}"
        );
        let shown = SegmentedRadios { legend: Legend::Shown("View"), children: "" }.to_html();
        assert!(shown.starts_with(r#"<fieldset class="segmented__radios"><legend>View</legend>"#), "{shown}");
    }
}
