//! The seller's orders: the kit's other components on a page an app would have, a list of orders
//! with its pages, the shipping settings and the questions sellers ask.
use corten::Href;
use corten::form::HintId;
use corten::i18n::Minor;
use corten::prelude::*;

use corten_ui::MenuButton;

use crate::app::{Msg, USD, url};
use crate::ui::{
    accordion::Accordion,
    alert::{Alert, AlertEmphasis, AlertVariant},
    avatar::Avatar,
    badge::{Badge, BadgeEmphasis, BadgeTone},
    breadcrumb::{Breadcrumb, Crumb},
    button::{Button, ButtonSize, ButtonVariant},
    card::{Card, CardAction, CardCompact, CardContent, CardFooter, CardHeader, CardPanel},
    dropdown_menu::{DropdownMenu, MenuTrigger},
    field::Field,
    icon::{self, Icon},
    meter::Meter,
    pagination::{Pagination, PreviousNext},
    popover::Popover,
    progress::{Progress, ProgressSize, ProgressTone},
    segmented::{Legend, SegmentedLinks, SegmentedRadio, SegmentedRadios, SegmentedWidth},
    select::Select,
    separator::{Orientation, Separator},
    skeleton::{Skeleton, SkeletonShape},
    slider::Slider,
    stack::{Cluster, Gap, Stack, StackStart},
    stats::{Stat, StatTone, Stats, StatsSurface},
    status_dot::{LiveDot, StatusDot, StatusTone},
    steps::{Step, StepState, Steps, StepsLayout},
    switch::Switch,
    table::{CellLabel, Sort, SortHeader, Table, TableLayout, TableNumeric},
    textarea::Textarea,
    visually_hidden::VisuallyHidden,
};

/// Where an order is: each a badge of its own look.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Status {
    Paid,
    Shipped,
    Late,
    Refunded,
}

impl Status {
    const fn label(self) -> &'static str {
        match self {
            Status::Paid => "Paid",
            Status::Shipped => "Shipped",
            Status::Late => "Late",
            Status::Refunded => "Refunded",
        }
    }

    const fn look(self) -> Badge {
        let (tone, emphasis) = match self {
            Status::Paid => (BadgeTone::Success, BadgeEmphasis::Soft),
            Status::Shipped => (BadgeTone::Neutral, BadgeEmphasis::Solid),
            Status::Late => (BadgeTone::Destructive, BadgeEmphasis::Solid),
            Status::Refunded => (BadgeTone::Neutral, BadgeEmphasis::Outline),
        };
        Badge { tone, emphasis }
    }
}

/// The order the table is sorted in, by the `sort` query value; newest first when there is none.
#[derive(Clone, Copy, PartialEq, Debug, UrlValue)]
#[serde(rename_all = "snake_case")]
pub enum OrderSort {
    TotalUp,
    TotalDown,
}

/// One order: who bought what, where it is and what it came to.
pub struct Order {
    pub buyer: &'static str,
    pub initials: &'static str,
    pub card: &'static str,
    pub status: Status,
    pub cents: u64,
    /// Whether the buyer has a picture: the others show their initials.
    pub pictured: bool,
}

const fn order(buyer: &'static str, initials: &'static str, card: &'static str, status: Status, cents: u64) -> Order {
    Order { buyer, initials, card, status, cents, pictured: false }
}

/// The seller's orders, newest first. A real app reads a page of them from its store.
pub const ORDERS: [Order; 10] = [
    order("Ada Lovelace", "AL", "Ashen Drake", Status::Late, 1250),
    Order { pictured: true, ..order("Grace Hopper", "GH", "Tidecaller", Status::Paid, 840) },
    order("Alan Turing", "AT", "Ashen Drake", Status::Shipped, 1195),
    order("Edsger Dijkstra", "ED", "Glass Warden", Status::Shipped, 2400),
    order("Barbara Liskov", "BL", "Ember Sprite", Status::Refunded, 310),
    order("Donald Knuth", "DK", "Tidecaller", Status::Shipped, 875),
    order("Frances Allen", "FA", "Ashen Drake", Status::Shipped, 1210),
    order("Ken Thompson", "KT", "Stormbinder", Status::Paid, 1960),
    order("Radia Perlman", "RP", "Glass Warden", Status::Shipped, 2350),
    order("John Backus", "JB", "Ember Sprite", Status::Shipped, 295),
];

/// Orders on a page.
pub const PER_PAGE: usize = 4;

/// The pages the orders fill.
pub const PAGES: usize = ORDERS.len().div_ceil(PER_PAGE);

/// Where the seller ships from, by the word the settings form posts.
#[derive(Clone, Copy, PartialEq, Debug, UrlValue)]
#[serde(rename_all = "snake_case")]
pub enum Warehouse {
    Portland,
    Austin,
    Toronto,
}

impl Warehouse {
    const ALL: [Warehouse; 3] = [Warehouse::Portland, Warehouse::Austin, Warehouse::Toronto];

    pub const fn label(self) -> &'static str {
        match self {
            Warehouse::Portland => "Portland, OR",
            Warehouse::Austin => "Austin, TX",
            Warehouse::Toronto => "Toronto, ON",
        }
    }
}

/// The size of the shipping labels the seller prints, by the word the settings form posts.
#[derive(Clone, Copy, PartialEq, Debug, UrlValue)]
#[serde(rename_all = "snake_case")]
pub enum LabelSize {
    Thermal,
    Letter,
}

impl LabelSize {
    pub const fn label(self) -> &'static str {
        match self {
            LabelSize::Thermal => "4 x 6 in",
            LabelSize::Letter => "Letter",
        }
    }
}

#[derive(Fields)]
pub struct SettingsForm {
    pub warehouse: Warehouse,
    /// The segmented radios: one of the two sizes, sent as any radio's value.
    pub labels: LabelSize,
    /// Business days from an order to its shipping: the slider's 1 to 5.
    pub handling: u8,
    /// The switch: absent when off, as a checkbox's.
    #[serde(default)]
    pub notify: bool,
    #[serde(default)]
    pub note: String,
}

/// An order's "more actions" menu, keyed by the buyer's initials (each order's own in this sample).
#[derive(Id)]
struct OrderMenuId<'a>(&'a str);

/// The share popover's id, which its button opens.
#[derive(Id)]
struct ShareId;

/// The shipping form's controls, each named by its field's label.
#[derive(Id)]
struct WarehouseId;
#[derive(Id)]
struct HandlingId;
#[derive(Id)]
struct NoteId;

/// The next payout panel's heading, which names it.
#[derive(Id)]
struct PayoutTitle;

/// The selling limit's meter, which its field's label names.
#[derive(Id)]
struct LimitId;

/// The label run's bars: the run's labels, the current label's pages, not known yet, and the
/// morning's run, finished.
#[derive(Id)]
struct LabelsId;
#[derive(Id)]
struct LabelPagesId;
#[derive(Id)]
struct MorningLabelsId;

/// The most a seller may sell in a month, in cents, until they have 50 sales.
const LIMIT_CENTS: u64 = 15_000;

/// A payout: the day it was asked for and what happened to it, in order.
pub struct Payout {
    pub day: &'static str,
    pub steps: [Step<'static>; 3],
}

/// The seller's payouts, newest first. The card shows one, paged by the one before and the one
/// after it, as a list an API pages by cursor is. The newest was refused by the bank.
pub const PAYOUTS: [&Payout; 3] = [&MAR_21, &MAR_14, &MAR_7];

const MAR_21: Payout = Payout {
    day: "Mar 21",
    steps: [
        Step { label: "Requested", description: Some("Mar 21, 9:00 AM"), link: None, state: StepState::Done("(done)") },
        Step {
            label: "Sent to the bank",
            description: Some("Mar 21, 9:02 AM, reference PX-20431"),
            link: None,
            state: StepState::Done("(done)"),
        },
        Step {
            label: "Paid",
            description: Some("The bank refused the account number. Check it in Settings, then ask again."),
            link: None,
            state: StepState::Failed("(failed)"),
        },
    ],
};

const MAR_14: Payout = Payout {
    day: "Mar 14",
    steps: [
        Step { label: "Requested", description: Some("Mar 14, 9:00 AM"), link: None, state: StepState::Done("(done)") },
        Step {
            label: "Sent to the bank",
            description: Some("Mar 14, 9:01 AM, reference PX-20377"),
            link: None,
            state: StepState::Done("(done)"),
        },
        Step { label: "Paid", description: Some("Mar 16"), link: None, state: StepState::Done("(done)") },
    ],
};

const MAR_7: Payout = Payout {
    day: "Mar 7",
    steps: [
        Step { label: "Requested", description: Some("Mar 7, 9:00 AM"), link: None, state: StepState::Done("(done)") },
        Step {
            label: "Sent to the bank",
            description: Some("Mar 7, 9:03 AM, reference PX-20318"),
            link: None,
            state: StepState::Done("(done)"),
        },
        Step { label: "Paid", description: Some("Mar 9"), link: None, state: StepState::Done("(done)") },
    ],
};

/// The orders page: `page` counts from 1, `sort` is the table's order, `payout` is which of
/// `PAYOUTS` the payouts card shows, and `photo` is the picture of a buyer who has one.
#[component(css)]
pub fn Orders<'a>(t: Msg, page: usize, sort: Option<OrderSort>, payout: usize, photo: &'a str) -> impl Render {
    // The payouts card knows only its neighbours: a newer one unless it shows the newest, an older
    // one unless it shows the oldest. Each keeps the table's page and order, as the table's pages
    // keep the payout.
    let shown = Some(page).filter(|p| *p > 1);
    let shown_payout = PAYOUTS[payout];
    let newer = (payout > 0).then(|| url::Orders { page: shown, sort, payout: Some(payout - 1).filter(|p| *p > 0) });
    let older = (payout + 1 < PAYOUTS.len()).then(|| url::Orders { page: shown, sort, payout: Some(payout + 1) });
    let f = SettingsForm::FIELDS;
    let mut sorted: Vec<&Order> = ORDERS.iter().collect();
    match sort {
        Some(OrderSort::TotalUp) => sorted.sort_by_key(|o| o.cents),
        Some(OrderSort::TotalDown) => sorted.sort_by_key(|o| std::cmp::Reverse(o.cents)),
        None => {}
    }
    // This month's figures: what sold (refunds taken out), what is to ship and what is late.
    let sold: u64 = ORDERS.iter().filter(|o| o.status != Status::Refunded).map(|o| o.cents).sum();
    let to_ship = ORDERS.iter().filter(|o| matches!(o.status, Status::Paid | Status::Late)).count();
    let late = ORDERS.iter().filter(|o| o.status == Status::Late).count();
    let shown = sorted.into_iter().skip((page - 1) * PER_PAGE).take(PER_PAGE);
    // The total's header: sorted up on the first click, then down and up in turn.
    let by_total = match sort {
        Some(OrderSort::TotalUp) => Some(Sort::Ascending),
        Some(OrderSort::TotalDown) => Some(Sort::Descending),
        None => None,
    };
    let current = |order: Option<OrderSort>| (order == sort).then_some("page");
    html! {
        <div class={Stack { gap: Gap::Lg }}>
            <Breadcrumb
                label="Breadcrumb"
                crumbs={&[Crumb { label: "Draft listing", link: &url::Home { tab: None, sale: None, period: None, sold: None } }]}
                current="Orders"
            />
            <div class={Cluster { gap: Gap::Sm }}>
                <h1>"Orders"</h1>
                <span class={Badge { tone: BadgeTone::Success, emphasis: BadgeEmphasis::Soft }}>
                    <StatusDot tone={StatusTone::Text} />
                    "Taking orders"
                </span>
                <span class={Badge { tone: BadgeTone::Info, emphasis: BadgeEmphasis::Soft }}>
                    <LiveDot tone={StatusTone::Text} />
                    <span class={WhenLive}>"Live"</span>
                    <span class={WhenNot}>"Not live"</span>
                </span>
            </div>
            <Alert variant={AlertVariant::Warning} emphasis={AlertEmphasis::Soft}>
                <strong>"One order is past its ship-by date"</strong>
                <p>"Ada Lovelace's Ashen Drake was due to ship yesterday. Ship it today or message the buyer."</p>
                <ul>
                    <li>"Ship it today with its postage bought."</li>
                    <li>"Or message the buyer and give a new date."</li>
                </ul>
                <div class={Cluster { gap: Gap::Sm }}>
                    <button class={Button { variant: ButtonVariant::Success, size: ButtonSize::Sm }} type="button">
                        "Mark shipped"
                    </button>
                    <button class={Button { variant: ButtonVariant::Warning, size: ButtonSize::Sm }} type="button">
                        "Buy postage (test mode)"
                    </button>
                    <button class={Button { variant: ButtonVariant::Info, size: ButtonSize::Sm }} type="button">
                        "Message the buyer"
                    </button>
                </div>
            </Alert>
            <dl class={Stats { surface: StatsSurface::Cards }}>
                <Stat
                    label="Sales"
                    value={t.money(Minor(sold), USD)}
                    note="This month, refunds taken out"
                    tone={StatTone::Neutral}
                />
                <Stat label="Orders" value={ORDERS.len()} note="This month" tone={StatTone::Neutral} />
                <Stat label="To ship" value={to_ship} note="Paid, not shipped yet" tone={StatTone::Neutral} />
                <Stat label="Late" value={late} note="Past the ship-by date" tone={StatTone::Destructive} />
            </dl>
            <div class={Grid}>
                <section class={Card {}}>
                    <header class={CardHeader {}}>
                        <h2>"Recent orders"</h2>
                        <div class={CardAction {}}>
                            <Separator orientation={Orientation::Vertical} />
                            <button
                                class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }}
                                type="button"
                                popovertarget={ShareId}
                            >
                                "Share the shop"
                            </button>
                            <div class={(Popover {}, Share)} id={ShareId} popover>
                                <p><strong>"Your shop's address"</strong></p>
                                <p><code>"corten.run/shop/ashen"</code></p>
                            </div>
                        </div>
                        <p>"The last "{ORDERS.len()}" orders, newest first unless sorted."</p>
                    </header>
                    <div class={CardContent {}}>
                        <Alert variant={AlertVariant::Info} emphasis={AlertEmphasis::Outline}>
                            <p>"Orders paid before 3 pm ship the same day."</p>
                            <ul>
                                <li>
                                    "Paid later, they ship the next day,"
                                    <ul>
                                        <li>"or on Monday when that is a Sunday."</li>
                                    </ul>
                                </li>
                            </ul>
                        </Alert>
                        // Each order is a view the server renders: links, the current one marked.
                        <nav class={SegmentedLinks { width: SegmentedWidth::Fit }} aria-label="Order the orders by">
                            <a href={url::Orders { page: None, sort: None, payout: None }} aria-current={current(None)}>
                                "Newest"
                            </a>
                            <a
                                href={url::Orders { page: None, sort: Some(OrderSort::TotalUp), payout: None }}
                                aria-current={current(Some(OrderSort::TotalUp))}
                            >
                                "Lowest total"
                            </a>
                            <a
                                href={url::Orders { page: None, sort: Some(OrderSort::TotalDown), payout: None }}
                                aria-current={current(Some(OrderSort::TotalDown))}
                            >
                                "Highest total"
                            </a>
                        </nav>
                        // On a phone each order is a block of labelled cells: an order is read one at a
                        // time, and the links above sort it there.
                        <Table layout={TableLayout::Stack}>
                            <table>
                                <caption>"Page "{page}" of "{PAGES}</caption>
                                <thead>
                                    <tr>
                                        <th scope="col">"Buyer"</th>
                                        <th scope="col">"Card"</th>
                                        <th scope="col">"Status"</th>
                                        <SortHeader
                                            label="Total"
                                            sort={by_total}
                                            ascending={&url::Orders { page: None, sort: Some(OrderSort::TotalUp), payout: None }}
                                            descending={&url::Orders { page: None, sort: Some(OrderSort::TotalDown), payout: None }}
                                            first={Sort::Ascending}
                                            class={TableNumeric {}}
                                            on:sort={None::<Handler>}
                                        />
                                        <th scope="col"><span class={VisuallyHidden {}}>"Actions"</span></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    for o in shown {
                                        <tr>
                                            <td>
                                                <CellLabel>"Buyer"</CellLabel>
                                                <span class={Buyer}>
                                                    <Avatar src={o.pictured.then_some(photo)} alt="" initials={o.initials} />
                                                    {o.buyer}
                                                </span>
                                            </td>
                                            <td>
                                                <CellLabel>"Card"</CellLabel>
                                                {o.card}
                                            </td>
                                            <td>
                                                <CellLabel>"Status"</CellLabel>
                                                <span class={o.status.look()}>{o.status.label()}</span>
                                            </td>
                                            <td class={TableNumeric {}}>
                                                <CellLabel>"Total"</CellLabel>
                                                {t.money(Minor(o.cents), USD)}
                                            </td>
                                            <td>
                                                // A row's menu: an icon a screen reader skips, named by hidden text.
                                                <DropdownMenu trigger={MenuTrigger::Icon}>
                                                    <MenuButton
                                                        id={OrderMenuId(o.initials)}
                                                        label={html! {
                                                            <Icon glyph={icon::ELLIPSIS_VERTICAL} />
                                                            <span class={VisuallyHidden {}}>"More actions for "{o.buyer}"'s order"</span>
                                                        }}
                                                    >
                                                        <a role="menuitem" href={url::Help}>"Help with this order"</a>
                                                        <a
                                                            role="menuitem"
                                                            href={url::Orders { page: None, sort: None, payout: None }}
                                                        >
                                                            "Back to every order"
                                                        </a>
                                                    </MenuButton>
                                                </DropdownMenu>
                                            </td>
                                        </tr>
                                    }
                                </tbody>
                            </table>
                        </Table>
                    </div>
                    <footer class={CardFooter {}}>
                        <Pagination
                            label="Pages"
                            previous_label="Previous"
                            next_label="Next"
                            pages={PAGES}
                            current={page}
                            link={|page| url::Orders { page: Some(page).filter(|p| *p > 1), sort, payout: Some(payout).filter(|p| *p > 0) }}
                        />
                    </footer>
                </section>
                <div class={Stack { gap: Gap::Md }}>
                    <section class={(Card {}, CardCompact {})}>
                        <header class={CardHeader {}}><h2>"Selling limit"</h2></header>
                        <div class={CardContent {}}>
                            <Field
                                id={LimitId}
                                label="Sold this month"
                                hint={html! { {t.money(Minor(sold), USD)}" of "{t.money(Minor(LIMIT_CENTS), USD)}". It resets on the 1st." }}
                                error=""
                            >
                                // Lower is better: under two thirds of the limit is good, near it is a warning.
                                <meter
                                    class={Meter {}}
                                    id={LimitId}
                                    aria-describedby={HintId(&LimitId)}
                                    aria-valuetext={t.money(Minor(sold), USD)}
                                    min="0"
                                    max={LIMIT_CENTS}
                                    low={LIMIT_CENTS / 3 * 2}
                                    high={LIMIT_CENTS / 10 * 9}
                                    optimum="0"
                                    value={sold}
                                >
                                    {t.money(Minor(sold), USD)}
                                </meter>
                            </Field>
                            // A column whose children keep their own width: a link as wide as its words, a badge.
                            <div class={(Stack { gap: Gap::Xs }, StackStart {})}>
                                <a href={url::Help}>"How selling limits work"</a>
                                <span class={Badge { tone: BadgeTone::Neutral, emphasis: BadgeEmphasis::Outline }}>
                                    "Lifts at 50 sales"
                                </span>
                            </div>
                        </div>
                    </section>
                    <section class={Card {}}>
                        <header class={CardHeader {}}><h2>"Returns"</h2></header>
                        <div class={CardContent {}}>
                            // A summary inside a card: figures on the card's surface, not cards of their own.
                            <dl class={Stats { surface: StatsSurface::Plain }}>
                                <Stat label="Open" value="2" note="Waiting on the buyer" tone={StatTone::Neutral} />
                                <Stat
                                    label="Refunded"
                                    value={t.money(Minor(1250), USD)}
                                    note="This month"
                                    tone={StatTone::Neutral}
                                />
                            </dl>
                            <Alert variant={AlertVariant::Success} emphasis={AlertEmphasis::Solid}>
                                <p>"Every return this month was refunded within a day."</p>
                            </Alert>
                        </div>
                    </section>
                    <section class={Card {}}>
                        <header class={CardHeader {}}><h2>"Payout of "{shown_payout.day}</h2></header>
                        <div class={CardContent {}}>
                            // What happened to the payout, in order: each step's time or reason
                            // shown at every width, and a refused step told from a blocked one.
                            <Steps
                                label="Payout"
                                layout={StepsLayout::Timeline}
                                steps={&shown_payout.steps}
                            />
                        </div>
                        <footer class={CardFooter {}}>
                            <PreviousNext
                                label="Payouts"
                                previous_label="Newer"
                                next_label="Older"
                                previous={newer.as_ref().map(|r| r as &dyn Href)}
                                next={older.as_ref().map(|r| r as &dyn Href)}
                            />
                        </footer>
                    </section>
                    <section class={Card {}}>
                        <header class={CardHeader {}}><h2>"Printing labels"</h2></header>
                        <div class={CardContent {}}>
                            // Progress: how far the run is, and, nested under it, a step whose size is not known yet;
                            // then a run that finished, in the success tone, its words saying so.
                            <div class={Stack { gap: Gap::Md }}>
                                <Field id={LabelsId} label="Labels printed" hint="" error="">
                                    <progress
                                        class={Progress { size: ProgressSize::Md, tone: ProgressTone::Primary }}
                                        id={LabelsId}
                                        max="12"
                                        value="5"
                                    >
                                        "5 of 12"
                                    </progress>
                                </Field>
                                <Field id={LabelPagesId} label="Sending the next label" hint="" error="">
                                    <progress
                                        class={Progress { size: ProgressSize::Sm, tone: ProgressTone::Primary }}
                                        id={LabelPagesId}
                                    >
                                        "Starting"
                                    </progress>
                                </Field>
                                <Field id={MorningLabelsId} label="Morning labels" hint="All 8 printed" error="">
                                    <progress
                                        class={Progress { size: ProgressSize::Md, tone: ProgressTone::Success }}
                                        id={MorningLabelsId}
                                        max="8"
                                        value="8"
                                        aria-describedby={HintId(&MorningLabelsId)}
                                    >
                                        "8 of 8"
                                    </progress>
                                </Field>
                            </div>
                        </div>
                    </section>
                    // One block of content, so one element: a panel, which a Stack lays out.
                    <section class={(CardPanel {}, Stack { gap: Gap::Md })} aria-labelledby={PayoutTitle}>
                        <h2 class={Title} id={PayoutTitle}>"Next payout"</h2>
                        // A dot in a status's own color beside plain text, where a badge's takes its text color.
                        <p class={Schedule}>
                            <StatusDot tone={StatusTone::Success} />
                            " On schedule"
                        </p>
                        // The shape the payout's live region shows before its first value.
                        // A gap off the kit's scale: `Gap::App` sets none, so the page's `.payout` is the one.
                        <div class={(Cluster { gap: Gap::App }, Payout)} aria-busy="true">
                            <span class={VisuallyHidden {}}>"Working out your next payout."</span>
                            <Skeleton shape={SkeletonShape::Circle} />
                            <div class={Lines}>
                                <Skeleton shape={SkeletonShape::Line} />
                                <Skeleton shape={SkeletonShape::Line} />
                            </div>
                        </div>
                    </section>
                    <section class={Card {}}>
                        <header class={CardHeader {}}><h2>"Shipping"</h2></header>
                        <div class={CardContent {}}>
                            <form class={Stack { gap: Gap::Lg }} method="post" action={url::Settings}>
                                <Field id={WarehouseId} label="Ship from" hint="" error="">
                                    <select class={Select {}} id={WarehouseId} name={f.warehouse}>
                                        for warehouse in Warehouse::ALL {
                                            <option value={warehouse} selected={warehouse == Warehouse::Portland}>
                                                {warehouse.label()}
                                            </option>
                                        }
                                    </select>
                                </Field>
                                // A choice in the form's column: the field's width, each size an equal part.
                                <SegmentedRadios legend={Legend::Shown("Label size")} width={SegmentedWidth::Fill}>
                                    <SegmentedRadio label={LabelSize::Thermal.label()}>
                                        <input type="radio" name={f.labels} value={LabelSize::Thermal} checked>
                                    </SegmentedRadio>
                                    <SegmentedRadio label={LabelSize::Letter.label()}>
                                        <input type="radio" name={f.labels} value={LabelSize::Letter}>
                                        <Icon glyph={icon::PRINTER} />
                                    </SegmentedRadio>
                                </SegmentedRadios>
                                <Field id={HandlingId} label="Handling time (business days)" hint="From 1 to 5." error="">
                                    <input
                                        class={Slider {}}
                                        id={HandlingId}
                                        aria-describedby={HintId(&HandlingId)}
                                        type="range"
                                        name={f.handling}
                                        min="1"
                                        max="5"
                                        value="2"
                                    >
                                </Field>
                                <Separator orientation={Orientation::Horizontal} />
                                <Switch label="Email me when an order ships">
                                    <input type="checkbox" role="switch" name={f.notify} checked>
                                </Switch>
                                <Field id={NoteId} label="Note to buyers" hint="Printed on each packing slip." error="">
                                    <textarea
                                        class={Textarea {}}
                                        id={NoteId}
                                        aria-describedby={HintId(&NoteId)}
                                        name={f.note}
                                        rows="3"
                                    >
                                        "Thanks for your order!"
                                    </textarea>
                                </Field>
                                <p>"Changes apply to orders placed after you save."</p>
                                <div class={Cluster { gap: Gap::Sm }}>
                                    <button class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}>
                                        "Save settings"
                                    </button>
                                </div>
                            </form>
                        </div>
                    </section>
                    <section class={Card {}}>
                        <header class={CardHeader {}}><h2>"Questions"</h2></header>
                        <div class={CardContent {}}>
                            <div>
                                <details class={Accordion {}} name="faq" open>
                                    <summary>"When do payouts go out?"</summary>
                                    <p>"Every Friday, for the orders shipped by Wednesday."</p>
                                </details>
                                <details class={Accordion {}} name="faq">
                                    <summary>"What if an order ships late?"</summary>
                                    <p>"The buyer may cancel it after three days, and the sale is refunded."</p>
                                </details>
                                <details class={Accordion {}} name="faq">
                                    <summary>"Can I change the note later?"</summary>
                                    <p>"Yes: each packing slip prints the note as it is when you ship."</p>
                                </details>
                            </div>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    }
}
