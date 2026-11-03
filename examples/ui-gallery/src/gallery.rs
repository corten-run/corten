//! The page: a seller's draft listing for one card, built from every corten-ui component, wrapped
//! and styled as a design system would.
use corten::i18n::{DateStyle, RelativeStyle, TimeStyle};
use corten::prelude::*;
use corten_ui::{
    CheckboxGroup, Choice, ChoiceGroup, ChoiceOption, Chosen, ComboBox, Copied, CopyButton, LocalTime, MenuButton, Number,
    NumberField, Picker, PrintButton, RelativeTime, RequiredWhen, ShownFor, Tab, TabGroup, Tooltip, dialog,
};
use serde::Deserialize;
use std::time::SystemTime;

use crate::app::{CREATED, DRAFT, EXPIRES_IN, LISTED_AGO, Msg, NO_REGION, RenameForm, SellForm, url};
use crate::ui::{
    button::{Button, ButtonSize, ButtonVariant},
    card::{Card, CardContent, CardFooter, CardHeader},
    checkbox::Checkbox,
    checkboxes::Checkboxes,
    combobox::Combobox,
    control_width::{ControlWidth, Width},
    dialog::{Dialog, DialogFooter, DialogHeader, DialogSize},
    dropdown_menu::{DropdownMenu, MenuTrigger},
    field::Field,
    input::Input,
    input_group::{Adornment, InputGroup},
    radio_group::{Radio, RadioGroup},
    segmented::Segmented,
    sheet::{Sheet, SheetHeader, SheetWidth, Side},
    stepper::{Stepper, StepperUnit},
    steps::{Step, StepState, Steps, StepsLayout},
    table::{Table, TableLayout},
    tabs::Tabs,
    tip::Tip,
};

/// The card the draft sells.
pub const CARD: &str = "Ashen Drake";

/// A card's condition, as card shops grade it: the form's `condition` field reads the word each
/// option posts (`UrlValue` writes what serde reads).
#[derive(Clone, Copy, PartialEq, Debug, UrlValue, Deserialize)]
pub enum Condition {
    #[serde(rename = "nm")]
    NearMint,
    #[serde(rename = "lp")]
    LightlyPlayed,
    #[serde(rename = "mp")]
    ModeratelyPlayed,
    #[serde(rename = "hp")]
    HeavilyPlayed,
    #[serde(rename = "dmg")]
    Damaged,
}

impl Condition {
    /// Every condition, best first.
    pub const ALL: [Condition; 5] = [
        Condition::NearMint,
        Condition::LightlyPlayed,
        Condition::ModeratelyPlayed,
        Condition::HeavilyPlayed,
        Condition::Damaged,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Condition::NearMint => "Near Mint",
            Condition::LightlyPlayed => "Lightly Played",
            Condition::ModeratelyPlayed => "Moderately Played",
            Condition::HeavilyPlayed => "Heavily Played",
            Condition::Damaged => "Damaged",
        }
    }

    /// The short grade a seller types for it.
    pub const fn grades(self) -> &'static [&'static str] {
        match self {
            Condition::NearMint => &["NM"],
            Condition::LightlyPlayed => &["LP"],
            Condition::ModeratelyPlayed => &["MP"],
            Condition::HeavilyPlayed => &["HP"],
            Condition::Damaged => &["DMG"],
        }
    }
}

/// The combo box's options: each condition with its label, found by the grade shops write too
/// (typing `mp` puts Moderately Played first).
const CONDITIONS: [Choice<Condition>; 5] = {
    let mut out = [Choice::new(Condition::NearMint, ""); 5];
    let mut i = 0;
    while i < 5 {
        let c = Condition::ALL[i];
        out[i] = Choice::new(c, c.label()).terms(c.grades());
        i += 1;
    }
    out
};

/// How the listing is priced: a fixed price, or offers down to a lowest one.
#[derive(Clone, Copy, PartialEq, Debug, UrlValue, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Pricing {
    Fixed,
    Offers,
}

/// Where a seller ships.
#[derive(Clone, Copy, PartialEq, Debug, UrlValue, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Region {
    Us,
    Ca,
    Eu,
}

/// The regions, each with its label, in the order the form lists them.
const REGIONS: [(Region, &str); 3] = [(Region::Us, "United States"), (Region::Ca, "Canada"), (Region::Eu, "European Union")];

/// The market's tabs, by the `tab` query value that selects each; the first is the default.
#[derive(Clone, Copy, PartialEq, Debug, UrlValue, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MarketTab {
    Listings,
    Offers,
    Sales,
}

/// The sales period the figures on the page are for, by the `period` query value; a month by
/// default.
#[derive(Clone, Copy, PartialEq, Debug, UrlValue, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Period {
    Week,
    Month,
}

/// The month's last sales, a table wider than the card's content on a phone.
const LAST_SALES: [(&str, &str, &str, &str, &str); 3] = [
    ("Monday, October 26", "Grace Hopper", "Near mint", "Arlington, Virginia", "$12.10"),
    ("Wednesday, October 28", "Alan Turing", "Lightly played", "Wilmslow, Cheshire", "$11.80"),
    ("Friday, October 30", "Ada Lovelace", "Near mint", "Marylebone, London", "$12.40"),
];

/// The sales period's choice, which the figures in two cards follow.
#[derive(Id)]
struct PeriodId;

/// The sell form's controls, each named by its field's label.
#[derive(Id)]
struct QtyId;
#[derive(Id)]
struct PriceId;
#[derive(Id)]
struct WeightId;
#[derive(Id)]
struct ConditionId;
#[derive(Id)]
struct BookId;
#[derive(Id)]
struct ActionsId;
#[derive(Id)]
struct FloorId;

/// The `sale` query value that opens the last sale's sheet.
#[derive(Clone, Copy, PartialEq, Debug, UrlValue, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Sale {
    Last,
}

#[component(css)]
pub fn Gallery<'a>(
    tab: MarketTab,
    period: Period,
    result: &'a str,
    sale: bool,
    times: Times,
    rename: RenameDialog<'a>,
) -> impl Render {
    let Times { t, now } = times;
    let f = SellForm::FIELDS;
    let qty = Number {
        value: Some(1.0),
        min: Some(1.0),
        max: Some(10.0),
        required: true,
        ..Number::new(QtyId, f.qty, "Fewer", "More")
    };
    // A measure with decimals; the price is money, a text input read by `t.parse_money`.
    let weight = Number { value: Some(0.5), min: Some(0.1), step: 0.1, ..Number::new(WeightId, f.weight, "Lighter", "Heavier") };
    let condition = Picker {
        required: true,
        ..Picker::new(ConditionId, f.condition, "Choose a condition", "No matching condition", &CONDITIONS)
    };
    // Each control's links keep the other's choice: a tab's link the period, a period's the tab.
    let shown_tab = Some(tab).filter(|t| *t != MarketTab::Listings);
    let shown_period = Some(period).filter(|p| *p != Period::Month);
    let at = move |tab| url::Home { tab, sale: None, period: shown_period };
    let (week, month) = (
        url::Home { tab: shown_tab, sale: None, period: Some(Period::Week) },
        url::Home { tab: shown_tab, sale: None, period: None },
    );
    let period = Chosen { id: PeriodId, value: period };
    html! {
        <div class={Intro}>
            <h1>"Sell "{CARD}</h1>
            <p>
                "A draft listing, built from corten-ui's headless components: they work as plain HTML first, and the UI kit (corten ui add) styles them."
            </p>
            <Steps
                label="Listing steps"
                layout={StepsLayout::Row}
                steps={&[
                    Step { label: "Read the guide", description: None, link: Some(&url::Help), state: StepState::Done("(done)") },
                    Step { label: "Draft", description: Some("Price, quantity and condition"), link: Some(&DRAFT), state: StepState::Current },
                    Step { label: "Photos", description: Some("Waits for the draft's price"), link: None, state: StepState::Blocked("(blocked)") },
                    Step { label: "Listed", description: None, link: None, state: StepState::Todo("(not started)") },
                ]}
            />
        </div>
        <div class={Grid}>
            <section class={Card {}}>
                <header class={CardHeader {}}><h2>"List for sale"</h2></header>
                <div class={CardContent {}}>
                    <form class={Order} method="post" action={url::Sell} data-patch>
                        <div class={Row}>
                            <Field id={QtyId} label="Quantity" hint="" error="">
                                <Stepper><NumberField field={&qty} /></Stepper>
                            </Field>
                            <Field id={PriceId} label="Price (USD)" hint="" error="">
                                <input
                                    class={(Input {}, ControlWidth { width: Width::Sm })}
                                    id={PriceId}
                                    name={f.price}
                                    inputmode="decimal"
                                    value="12.50"
                                    required
                                >
                            </Field>
                            <Field id={WeightId} label="Shipping weight" hint="" error="">
                                <Stepper>
                                    <span class={StepperUnit {}}>"oz"</span>
                                    <NumberField field={&weight} />
                                </Stepper>
                            </Field>
                        </div>
                        <Field id={ConditionId} label="Condition" hint="" error="">
                            <Combobox><ComboBox field={&condition} /></Combobox>
                        </Field>
                        <Checkboxes>
                            <CheckboxGroup legend="Ships to" missing={NO_REGION}>
                                for (region, label) in REGIONS {
                                    <Checkbox label={label}>
                                        <input type="checkbox" name={f.ships} value={region} checked={region == Region::Us}>
                                    </Checkbox>
                                }
                            </CheckboxGroup>
                        </Checkboxes>
                        <RadioGroup legend="Pricing">
                            <Radio label="Fixed price">
                                <input type="radio" name={f.pricing} value={Pricing::Fixed} checked>
                            </Radio>
                            <Radio label="Accept offers"><input type="radio" name={f.pricing} value={Pricing::Offers}></Radio>
                        </RadioGroup>
                        <div class={Floor}>
                            <RequiredWhen control={f.pricing} values={&[Pricing::Offers]}>
                                <Field id={FloorId} label="Lowest offer (USD)" hint="" error="">
                                    <span class={(InputGroup {}, ControlWidth { width: Width::Sm })}>
                                        <Adornment>"$"</Adornment>
                                        <input class={Input {}} id={FloorId} name={f.floor} inputmode="decimal">
                                    </span>
                                </Field>
                            </RequiredWhen>
                        </div>
                        <div>
                            <button class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}>
                                "List for sale"
                            </button>
                        </div>
                    </form>
                    <OrderResult text={result} />
                </div>
            </section>
            <div class={Aside}>
                // Built in the markup, so the panels' views live until the group has rendered them.
                <section class={Card {}}>
                    <header class={CardHeader {}}><h2>"Market"</h2></header>
                    <div class={CardContent {}}>
                        <Tabs>
                            <TabGroup
                                id={BookId}
                                label="Market"
                                selected={tab as usize}
                                tabs={&[
                                    Tab { label: "Listings", panel: &html! { <p>"Three listings from $11.80."</p> }, link: Some(&at(None)) },
                                    Tab { label: "Offers", panel: &html! { <p>"Two offers, the best at $10.00."</p> }, link: Some(&at(Some(MarketTab::Offers))) },
                                    Tab { label: "Sales", panel: &html! { <p>"Sold 14 times this month."</p> }, link: Some(&at(Some(MarketTab::Sales))) },
                                ]}
                            />
                        </Tabs>
                        <div class={Facts}>
                            <ShownFor choice={&period} values={&[Period::Week]}>
                                <p>"Average $12.10 this week."</p>
                            </ShownFor>
                            <ShownFor choice={&period} values={&[Period::Month]}>
                                <p>"Average $11.95 this month."</p>
                            </ShownFor>
                        </div>
                    </div>
                </section>
                <section class={Card {}}>
                    <header class={CardHeader {}}><h2>"Sales"</h2></header>
                    <div class={CardContent {}}>
                        <Segmented>
                            <ChoiceGroup
                                choice={&period}
                                label="Sales period"
                                options={&[
                                    ChoiceOption { value: Period::Week, label: "Week", link: Some(&week) },
                                    ChoiceOption { value: Period::Month, label: "Month", link: Some(&month) },
                                ]}
                            />
                        </Segmented>
                        <div class={Facts}>
                            <ShownFor choice={&period} values={&[Period::Week]}><p>"Sold 3 this week."</p></ShownFor>
                            <ShownFor choice={&period} values={&[Period::Month]}><p>"Sold 14 this month."</p></ShownFor>
                        </div>
                        // A part wider than the card's content on a phone: the card's column keeps it
                        // to the card, so the table scrolls in its wrapper and the page does not.
                        <ShownFor choice={&period} values={&[Period::Month]}>
                            <Table layout={TableLayout::Scroll}>
                                <table>
                                    <caption>"This month's last sales"</caption>
                                    <thead>
                                        <tr>
                                            <th scope="col">"Sold"</th>
                                            <th scope="col">"Buyer"</th>
                                            <th scope="col">"Condition"</th>
                                            <th scope="col">"Ships to"</th>
                                            <th scope="col">"Price"</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        for (day, buyer, condition, to, price) in LAST_SALES {
                                            <tr>
                                                <td>{day}</td>
                                                <td>{buyer}</td>
                                                <td>{condition}</td>
                                                <td>{to}</td>
                                                <td>{price}</td>
                                            </tr>
                                        }
                                    </tbody>
                                </table>
                            </Table>
                        </ShownFor>
                        <div>
                            <button
                                class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }}
                                type="button"
                                command="show-modal"
                                commandfor={SalesId}
                            >
                                "All sales"
                            </button>
                        </div>
                    </div>
                </section>
                <section class={Card {}}>
                    <header class={CardHeader {}}><h2>"Activity"</h2></header>
                    <div class={CardContent {}}>
                        <div class={Facts}>
                            <p>
                                "Listed "
                                <RelativeTime when={t.relative(now - LISTED_AGO, now, RelativeStyle::Short)} />
                            </p>
                            <p>
                                "The best offer expires "
                                <RelativeTime when={t.relative(now + EXPIRES_IN, now, RelativeStyle::Long)} />
                            </p>
                            <p>
                                "Drafted "
                                <LocalTime
                                    when={t.date_time(SystemTime::UNIX_EPOCH + CREATED, DateStyle::Medium, TimeStyle::Short)}
                                />
                            </p>
                        </div>
                    </div>
                </section>
                <section class={Card {}}>
                    <header class={CardHeader {}}><h2>"Draft"</h2></header>
                    <div class={CardContent {}}>
                        <div class={Buttons}>
                            <form method="post" action={url::Save} data-patch>
                                <button class={Button { variant: ButtonVariant::Secondary, size: ButtonSize::Md }}>
                                    "Save draft"
                                </button>
                            </form>
                            <button
                                class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }}
                                type="button"
                                command="show-modal"
                                commandfor={RenameId}
                            >
                                "Rename draft"
                            </button>
                            <DropdownMenu trigger={MenuTrigger::Text}>
                                <MenuButton id={ActionsId} label="More actions">
                                    <a role="menuitem" href={url::Help}>"Help"</a>
                                    <form method="post" action={url::Archive} data-patch>
                                        <button role="menuitem">"Archive"</button>
                                    </form>
                                    <button type="button" role="menuitem" disabled>"Delete"</button>
                                    <button type="button" role="menuitem" command="show-modal" commandfor={RenameId}>
                                        "Rename…"
                                    </button>
                                    <form method="post" action={url::Watch} data-patch>
                                        <button role="menuitem">"Watch"</button>
                                    </form>
                                </MenuButton>
                            </DropdownMenu>
                        </div>
                        <MenuResult text="" />
                    </div>
                    <footer class={CardFooter {}}>
                        <a
                            class={Button { variant: ButtonVariant::Link, size: ButtonSize::Sm }}
                            href={url::Home { tab: None, sale: Some(Sale::Last), period: None }}
                            interestfor={LastSaleTipId}
                            aria-describedby={LastSaleTipId}
                        >
                            "Last sale"
                        </a>
                        <Tooltip id={LastSaleTipId} class={Tip {}}>"Opens beside the draft; Escape closes it"</Tooltip>
                        <a
                            class={Button { variant: ButtonVariant::Link, size: ButtonSize::Sm }}
                            href={url::Orders { page: None, sort: None }}
                        >
                            "Orders"
                        </a>
                    </footer>
                </section>
                <section class={Card {}}>
                    <header class={CardHeader {}}><h2>"Stock"</h2></header>
                    <div class={CardContent {}}>
                        <Sku sku="ASH-DRAKE-NM" />
                        <div>
                            <PrintButton
                                label="Print label"
                                class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }}
                            />
                            " "
                            <a
                                class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Icon }}
                                href={url::Orders { page: None, sort: None }}
                                interestfor={OrdersTipId}
                                aria-labelledby={OrdersTipId}
                            >
                                <span aria-hidden="true">"↗"</span>
                            </a>
                            <Tooltip id={OrdersTipId} class={Tip {}}>"Open the orders"</Tooltip>
                        </div>
                    </div>
                </section>
            </div>
        </div>
        {rename}
        <SalesDialog />
        if sale {
            <SaleSheet />
        }
    }
}

/// The offer's relative times: written as of `now`, in `t`'s locale.
#[derive(Clone, Copy)]
pub struct Times {
    pub t: Msg,
    pub now: SystemTime,
}

/// The listing's outcome: in the page, and on its own as the form's patch.
#[component]
pub fn OrderResult<'a>(text: &'a str) -> impl Patch {
    html! { <p id={ResultId} role="status">{text}</p> }
}

#[derive(Id)]
struct ResultId;

/// What the last menu action did.
#[component]
pub fn MenuResult<'a>(text: &'a str) -> impl Patch {
    html! { <p id={MenuResultId} role="status">{text}</p> }
}

#[derive(Id)]
struct MenuResultId;

/// The orders link's name, shown as its tooltip.
#[derive(Id)]
struct OrdersTipId;

/// What the last sale link does, shown as its tooltip.
#[derive(Id)]
struct LastSaleTipId;

/// The SKU's element, which its copy button names.
#[derive(Id)]
struct SkuId;

/// The draft's SKU, which a seller copies into their own stock sheet, with a button that copies
/// it: the SKU is on the page once, and the button shows only where the script can write the
/// clipboard. The paragraph counts the copies the button reports (`Copied`), as an app counts a
/// shared link's, and shows the count from the first.
#[component(js)]
pub fn Sku<'a>(sku: &'a str) -> impl Render {
    let (copied, copies) = refs();
    html! {
        <p on:Copied={js::counted(event, copied, copies)}>
            "SKU "
            <code id={SkuId}>{sku}</code>
            " "
            <CopyButton
                text={SkuId}
                label="Copy"
                copied="Copied"
                class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Sm }}
            />
            " "
            <span ref={copied} hidden>"Copies: "<output ref={copies} aria-label="Copies">"0"</output></span>
        </p>
    }
}

/// The last sale, beside the gallery: the address opens it (`/?sale=last`), and the link back to
/// the gallery closes it, clicked or by Escape (`dialog::modalClosedBy`), so a reload shows what
/// the user last saw.
#[component]
pub fn SaleSheet() -> impl Render {
    let close = refs();
    html! {
        <dialog
            class={Sheet { side: Side::Right(SheetWidth::Md) }}
            open
            aria-label="Last sale"
            on:connect={dialog::modalClosedBy(target, close, signal)}
        >
            <div class={SheetHeader {}}>
                <h2>"Last sale"</h2>
                <a
                    class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }}
                    ref={close}
                    href={url::Home { tab: None, sale: None, period: None }}
                >
                    "Close"
                </a>
            </div>
            <p>"A Near Mint copy sold for $12.00 on May 3."</p>
        </dialog>
    }
}

/// The sales dialog's id, which its buttons name.
#[derive(Id)]
pub struct SalesId;

/// The month's sales in a wide dialog: a header with the heading and a close button, held at the
/// top when the dialog is taller than the window.
#[component]
pub fn SalesDialog() -> impl Render {
    html! {
        <dialog class={Dialog { size: DialogSize::Lg }} id={SalesId} closedby="any" aria-labelledby={SalesTitleId}>
            <div class={DialogHeader {}}>
                <h2 id={SalesTitleId}>"This month's sales"</h2>
                <button
                    class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Sm }}
                    type="button"
                    command="close"
                    commandfor={SalesId}
                >
                    "Close"
                </button>
            </div>
            <Table layout={TableLayout::Scroll}>
                <table>
                    <thead>
                        <tr>
                            <th scope="col">"Sold"</th>
                            <th scope="col">"Buyer"</th>
                            <th scope="col">"Condition"</th>
                            <th scope="col">"Ships to"</th>
                            <th scope="col">"Price"</th>
                        </tr>
                    </thead>
                    <tbody>
                        for (day, buyer, condition, to, price) in LAST_SALES {
                            <tr>
                                <td>{day}</td>
                                <td>{buyer}</td>
                                <td>{condition}</td>
                                <td>{to}</td>
                                <td>{price}</td>
                            </tr>
                        }
                    </tbody>
                </table>
            </Table>
        </dialog>
    }
}

/// The sales dialog's heading, which names it.
#[derive(Id)]
pub struct SalesTitleId;

/// The rename dialog's id: the refused form's patch replaces the dialog by it.
#[derive(Id)]
pub struct RenameId;

/// Naming the draft, in a modal dialog. Refused, the server draws it open with the error, as the
/// form's patch or in the page a post without the runtime answers with, and `dialog::modal`
/// makes it modal again when it joins the page.
#[component(css = Gallery)]
pub fn RenameDialog<'a>(name: &'a str, errors: &'a Errors) -> impl Patch {
    let f = RenameForm::FIELDS;
    let e = errors.within(RenameId);
    html! {
        <dialog
            class={Dialog { size: DialogSize::Md }}
            id={RenameId}
            open={!errors.is_empty()}
            aria-label="Rename the draft"
            on:connect={dialog::modal(target)}
        >
            <h2>"Rename the draft"</h2>
            <form class={Rename} method="post" action={url::Rename} data-patch>
                <Field id={e.id(f.name)} label="Name" hint="" error={e.message(f.name)}>
                    <input class={Input {}} value={name} {..e.control(f.name)}>
                </Field>
                <div class={DialogFooter {}}>
                    <button
                        class={Button { variant: ButtonVariant::Ghost, size: ButtonSize::Md }}
                        type="button"
                        command="close"
                        commandfor={RenameId}
                    >
                        "Cancel"
                    </button>
                    <button class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}>"Rename"</button>
                </div>
            </form>
        </dialog>
    }
}
