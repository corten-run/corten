use corten::{
    prelude::*,
    script::{Keyed, NoRows, NoValue, RowsOf, view_id},
};
use corten_ui::CopyButton;

use super::deck_preview::DeckPreviewChanged;
use super::{Answer, CollectionRow, DeckAnswered, DeckLine, DeckPreview, Line, SaveNote, Shown, curve_cost, deck_list};
use crate::{
    app::{DeckInput, DeckQuery, Slot, Sort, url},
    cards::{DECK_SIZE, Kind, TOP_COST},
    text::Msg,
};

/// The deck's form: the collection's checkboxes and Add buttons belong to it (`form=`).
#[derive(Id)]
pub struct DeckFormId;

/// The hidden version a successful action replaces when the builder's script did not submit it.
#[derive(Id)]
struct DeckVersionId;

#[derive(Id)]
struct DeckGenerationId;

#[component]
pub fn DeckGeneration(bundle: DeckBuilderRefs, generation: &str) -> impl Patch {
    html! {
        <input
            ref={bundle.generation_ref()}
            id={DeckGenerationId}
            type="hidden"
            name={DeckInput::FIELDS.generation}
            value={generation}
        >
    }
}

#[component]
pub fn DeckVersion(bundle: DeckBuilderRefs, version: u64) -> impl Patch {
    let field = DeckInput::FIELDS.version;
    html! { <input ref={bundle.version_ref()} id={DeckVersionId} type="hidden" name={field} value={version}> }
}

#[derive(Id)]
pub struct DeckLinesId;

#[derive(Id)]
struct DeckEmptyId;

#[component(css = DeckBuilder)]
pub fn DeckEmpty(bundle: DeckBuilderRefs, empty: bool) -> impl Patch {
    html! { <p id={DeckEmptyId} ref={bundle.empty()} class={Empty} hidden={!empty}>"Drag cards here, or press Add."</p> }
}

/// The posted card/count pairs, redrawn together only when the fallback form conflicts.
#[component(css = DeckBuilder)]
pub fn DeckLines<'a>(bundle: DeckBuilderRefs, lines: &'a [Line<'a>]) -> impl Patch {
    html! {
        <ul id={DeckLinesId} ref={bundle.lines_ref()} class={Lines}>
            for line in lines.iter() {
                <DeckLine
                    id={&line.card.id}
                    name={&line.card.name}
                    kind={line.card.kind.as_str()}
                    cost={line.card.cost}
                    count={line.count}
                    owned={line.card.owned}
                    bundle={bundle}
                />
            }
        </ul>
        <DeckEmpty bundle={bundle} empty={lines.is_empty()} />
    }
}

#[component]
pub fn SavedLine<'a>(bundle: DeckBuilderRefs, line: &'a Line<'a>) -> impl Patch {
    html! {
        <DeckLine
            id={&line.card.id}
            name={&line.card.name}
            kind={line.card.kind.as_str()}
            cost={line.card.cost}
            count={line.count}
            owned={line.card.owned}
            bundle={bundle}
        />
    }
}

/// What a grip's keys do, which every grip names (`aria-describedby`).
#[derive(Id)]
pub struct MoveHelpId;

#[derive(Id)]
struct CollectionHeadingId;

#[derive(Id)]
struct DeckHeadingId;

/// The deck as text, which the Copy button copies.
#[derive(Id)]
struct DeckListId;

#[derive(Id)]
struct DeckTotalId;

#[component]
pub fn DeckTotal(bundle: DeckBuilderRefs, total: u32, t: Msg) -> impl Patch {
    html! { <output id={DeckTotalId} ref={bundle.total()}>{t.number(total)}</output> }
}

#[component(js = super::deck_preview::DeckPreview)]
pub fn DeckExport(bundle: DeckBuilderRefs, text: &str, preview_total: Option<u32>) -> impl Patch {
    let refresh = preview_total.is_some();
    let total = preview_total.unwrap_or_default();
    html! {
        <textarea
            ref={bundle.list()}
            id={DeckListId}
            readonly
            rows="8"
            aria-label="Deck list"
            on:connect={js::refresh(target, bundle.previews(), total, refresh)}
        >
            {text}
        </textarea>
    }
}

#[derive(Id)]
struct CostCurveId;

#[derive(Id)]
struct KindCountsId;

/// The curve's height, in the chart's units: the tallest bar's.
const BAR: u32 = 48;

#[component(css = DeckBuilder)]
pub fn CostCurve(bundle: DeckBuilderRefs, lines: &[Line<'_>], t: Msg) -> impl Patch {
    let mut curve = [0u32; TOP_COST as usize + 1];
    for line in lines {
        curve[curve_cost(line.card.cost) as usize] += line.count;
    }
    let tallest = curve.iter().copied().max().unwrap_or(0).max(4);
    html! {
        <figure class={Curve} id={CostCurveId}>
            <figcaption>"Cost curve"</figcaption>
            <svg viewBox="0 0 160 52" aria-hidden="true">
                for (cost, n) in curve.iter().enumerate() {
                    let height = n * BAR / tallest;
                    <rect
                        ref={bundle.bars()}
                        key={cost}
                        x={cost * 20 + 3}
                        y={BAR + 2 - height}
                        width="14"
                        height={height}
                        rx="2"
                    ></rect>
                }
            </svg>
            <ol>
                for (cost, n) in curve.iter().enumerate() {
                    <li>
                        <span ref={bundle.tallies()} key={cost}>{t.number(*n)}</span>
                        <small>if cost == TOP_COST as usize { {cost}"+" } else { {cost} }</small>
                    </li>
                }
            </ol>
        </figure>
    }
}

#[component(css = DeckBuilder)]
pub fn KindCounts(bundle: DeckBuilderRefs, lines: &[Line<'_>], t: Msg) -> impl Patch {
    html! {
        <dl class={Kinds} id={KindCountsId}>
            for kind in Kind::ALL {
                let count: u32 = lines.iter().filter(|line| line.card.kind == kind).map(|line| line.count).sum();
                <div data-kind={kind.as_str()}>
                    <dt>{kind.as_str()}"s"</dt>
                    <dd><output ref={bundle.kinds()} key={kind.as_str()}>{t.number(count)}</output></dd>
                </div>
            }
        </dl>
    }
}

/// The builder: the collection on one side, the deck on the other.
///
/// In the browser every change shows at once, with no round trip: a card added with its Add
/// button, Add selected, a drag from the collection onto the deck (or from the deck back out), the
/// same moves by keyboard (Space picks a card up, Left and Right move it between the two, Up and
/// Down reorder a deck line, Space drops it, Escape puts it back), a count typed in, undo and redo (the buttons or Ctrl+Z,
/// Ctrl+Shift+Z). The deck's lines, its count, the cost curve, the count by kind, the deck list
/// and each collection row's count in the deck are drawn again from the deck the page shows.
///
/// Each change is then saved: the deck's form is sent (`data-patch`) with the version it was
/// built on (the deck feed's generation and sequence number), one save at a time. The answer is the save note, which tells the builder whether the
/// server took it (the new version), refused it (the change is rolled back, with the rule's
/// words) or found it stale (another tab saved first: the builder offers to keep both changes or
/// take the other tab's deck). The page follows the saved deck's feed, so another tab's save is
/// seen even when this one is idle, and taken at once when nothing here is unsaved.
///
/// Without JavaScript the same form works: Add and Add selected post the deck with the cards
/// added, and Save posts the counts as typed. The filter is a `GET` form and the column headers
/// are links, which the server answers in the order asked. The Filter and Save buttons are drawn
/// either way, so they still work when the builder's script did not load; with the script, Filter
/// keeps the page (the rows are filtered as typed) and Save sends only a change not saved yet.
#[component(css, js)]
pub fn DeckBuilder<'a>(
    t: Msg,
    cards: Vec<Shown<'a>>,
    lines: Vec<Line<'a>>,
    generation: &'a str,
    version: u64,
    view: &'a DeckQuery,
    answer: &'a Answer,
) -> impl Render {
    let (cards_zone, deck_zone, rows, pick, grip, add, all, picked, shown, none) = refs();
    let (template, form) = refs();
    let bars: Ref<el::SVGElement, NoRows, NoValue, Keyed> = refs();
    let tallies: Ref<el::HTMLSpanElement, NoRows, NoValue, Keyed> = refs();
    let kinds: Ref<el::HTMLOutputElement, NoRows, NoValue, Keyed> = refs();
    let lines_ref: Ref<el::HTMLUListElement, RowsOf<{ view_id("DeckLine") }>> = refs();
    let lift: Ref<el::HTMLButtonElement> = refs();
    let copies: Ref<el::HTMLInputElement> = refs();
    let empty: Ref<el::HTMLParagraphElement> = refs();
    let version_ref: Ref<el::HTMLInputElement> = refs();
    let (undo, redo, status, conflict, announce, draft, keep) = refs();
    let total: Ref<el::HTMLOutputElement> = refs();
    let list: Ref<el::HTMLTextAreaElement> = refs();
    let generation_ref: Ref<el::HTMLInputElement> = refs();
    let unsure = refs();
    let previews: Ref<el::HTMLElement> = refs();
    let (f, q) = (DeckInput::FIELDS, DeckQuery::FIELDS);
    let number = t.js().number();
    let parts = js::Parts {
        cards: rows,
        lines: lines_ref,
        template,
        form,
        generation: generation_ref,
        version: version_ref,
        draft,
        total,
        bars,
        tallies,
        kinds,
        undo,
        redo,
        status,
        conflict,
        keep,
        unsure,
        list,
        previews,
        empty,
        number,
    };
    let browse = js::Browse { cards: rows, all, picked, shown, none, found: t.js().grid_shown(), number };
    let carry = js::Carry {
        cards_zone,
        deck_zone,
        lines: lines_ref,
        announce,
        several: t.js().move_several(),
        lifted: t.js().move_lifted(),
        added: t.js().move_added(),
        removed: t.js().move_removed(),
        put_back: t.js().move_put_back(),
        reordered: t.js().move_reordered(),
        over_deck: "Over the deck.",
        over_cards: "Over the collection.",
    };
    let filter = view.q.as_deref().unwrap_or("");
    let sorted = |by: Sort| view.sort == Some(by);
    let size: u32 = lines.iter().map(|l| l.count).sum();
    let text = deck_list(lines);
    html! {
        <div
            class={Builder}
            on:connect={js::start(parts, url::DeckFeed, signal)}
            on:keydown={js::keys(event, parts, carry)}
            on:document:keydown={js::shortcut(event, parts)}
            on:dragend={js::dropped(carry)}
            on:DeckAnswered={js::answered(event, parts)}
        >
            <section
                ref={cards_zone}
                class={Collection}
                tabindex="-1"
                aria-labelledby={CollectionHeadingId}
                on:dragover={js::overCards(event, carry)}
                on:dragleave={js::leave(event, target)}
                on:drop={js::dropOnCards(event, parts, carry)}
            >
                <div class={Head}>
                    <h2 id={CollectionHeadingId}>"Collection"</h2>
                    <p class={Counts}>
                        <output ref={shown} hidden></output>
                        <span>
                            {t.grid_cards(cards.len())}
                        </span>
                    </p>
                </div>
                <form class={Filter} method="get" action={url::Home::default()} role="search" on:submit={js::stay(event)}>
                    <input
                        type="search"
                        name={q.q}
                        value={filter}
                        placeholder="Filter by name, set or type"
                        aria-label="Filter the collection"
                        on:input={js::filter(target, browse)}
                    >
                    if let Some(sort) = view.sort { <input type="hidden" name={q.sort} value={sort}> }
                    <button>"Filter"</button>
                </form>
                <div class={Picks}>
                    <span><output ref={picked}>"0"</output>" selected"</span>
                    <button form={DeckFormId} name={f.add_picked} value="1" on:click={js::addPicked(event, parts, browse)}>
                        "Add selected"
                    </button>
                    <button class={Script} type="button" on:click={js::clearPicks(browse)}>"Clear"</button>
                </div>
                <div class={Scroll}>
                    <table class={Table}>
                        <thead>
                            <tr>
                                <th>
                                    <input
                                        ref={all}
                                        type="checkbox"
                                        aria-label="Select every card shown"
                                        on:change={js::pickAll(browse)}
                                    >
                                </th>
                                <th><span class={Hidden}>"Move"</span></th>
                                <th aria-sort={sorted(Sort::Name).then_some("ascending")}>
                                    <a
                                        href={url::Home { view: DeckQuery { q: view.q.clone(), sort: Some(Sort::Name) } }}
                                        on:click={js::sortByName(event, target, rows)}
                                    >
                                        "Card"
                                    </a>
                                </th>
                                <th aria-sort={sorted(Sort::Cost).then_some("ascending")}>
                                    <a
                                        href={url::Home { view: DeckQuery { q: view.q.clone(), sort: Some(Sort::Cost) } }}
                                        on:click={js::sortByCost(event, target, rows)}
                                    >
                                        "Cost"
                                    </a>
                                </th>
                                <th>"Type"</th>
                                <th aria-sort={sorted(Sort::Owned).then_some("descending")}>
                                    <a
                                        href={url::Home { view: DeckQuery { q: view.q.clone(), sort: Some(Sort::Owned) } }}
                                        on:click={js::sortByOwned(event, target, rows)}
                                    >
                                        "In deck"
                                    </a>
                                </th>
                                <th><span class={Hidden}>"Add"</span></th>
                            </tr>
                        </thead>
                        <tbody
                            ref={rows}
                            on:change={js::pick(pick.closest(), browse)}
                            on:click={js::add(event, add.closest(), parts)}
                            on:dragstart={js::lift(event, grip.closest(), parts, carry)}
                            on:keydown={js::pickUp(event, grip.closest(), parts, carry)}
                        >
                            for shown in cards.iter() {
                                <CollectionRow
                                    id={&shown.card.id}
                                    name={&shown.card.name}
                                    set={shown.card.set}
                                    kind={shown.card.kind.as_str()}
                                    rarity={shown.card.rarity.as_str()}
                                    cost={shown.card.cost}
                                    owned={shown.card.owned}
                                    in_deck={shown.in_deck}
                                    selected={false}
                                    hidden={shown.hidden}
                                    pick={pick}
                                    grip={grip}
                                    add={add}
                                />
                            }
                        </tbody>
                    </table>
                </div>
                <p ref={none} class={Empty} hidden={cards.iter().any(|s| !s.hidden)}>"No cards match the filter."</p>
            </section>
            <section
                ref={deck_zone}
                class={Deck}
                tabindex="-1"
                aria-labelledby={DeckHeadingId}
                on:dragover={js::overDeck(event, carry)}
                on:dragleave={js::leave(event, target)}
                on:drop={js::dropOnDeck(event, parts, carry)}
            >
                <div class={Head}>
                    <h2 id={DeckHeadingId}>"Deck"</h2>
                    <p class={Total}>
                        <DeckTotal bundle={DeckBuilderRefs} total={size} t={t} />
                        " / "{DECK_SIZE}" cards"
                    </p>
                    <div class={History}>
                        <button ref={undo} type="button" disabled aria-keyshortcuts="Control+Z" on:click={js::undo(parts)}>
                            "Undo"
                        </button>
                        <button ref={redo} type="button" disabled aria-keyshortcuts="Control+Shift+Z" on:click={js::redo(parts)}>
                            "Redo"
                        </button>
                    </div>
                </div>
                // One live region, always on the page: the note a save answers with replaces the
                // note inside it, and the script shows one of the spans while it has something to
                // say (`data-state`).
                <div ref={status} class={Status} role="status" data-state="">
                    <SaveNote answer={answer} />
                    <span class={Saving}>"Saving…"</span>
                    <span class={Saved}>"Saved."</span>
                    <span class={Updated}>"Updated from another tab."</span>
                    <span class={Offline}>
                        "Not saved yet: the server could not be reached. "
                        <button type="button" on:click={js::retry(parts)}>"Try again"</button>
                    </span>
                </div>
                <div ref={conflict} class={Conflict} role="alert" hidden>
                    <p>"This deck was changed in another tab while you were changing it here."</p>
                    // A save whose answer was lost and whose key the server has since forgotten
                    // may be in the other deck already: keeping both could add it twice.
                    <p ref={unsure} hidden>"Your last change may already be in it: check the deck before you change it again."</p>
                    <button ref={keep} type="button" on:click={js::merge(parts)}>"Keep both changes"</button>
                    <button type="button" on:click={js::reload(parts)}>"Use the other tab's deck"</button>
                </div>
                <CostCurve bundle={DeckBuilderRefs} lines={lines} t={t} />
                <KindCounts bundle={DeckBuilderRefs} lines={lines} t={t} />
                <form ref={form} id={DeckFormId} method="post" action={url::Save} data-patch novalidate>
                    <DeckGeneration bundle={DeckBuilderRefs} generation={generation} />
                    <DeckVersion bundle={DeckBuilderRefs} version={version} />
                    {SubmitKey::field(f.submit)}
                    <input ref={draft} type="hidden" name={f.draft} value="0">
                    <input type="hidden" name={f.q} value={filter}>
                    if let Some(sort) = view.sort { <input type="hidden" name={f.sort} value={sort}> }
                    <div
                        on:change={js::typed(copies.closest(), parts)}
                        on:dragstart={js::liftLine(event, lift.closest(), parts, carry)}
                        on:dragover={js::overLine(event, lines_ref)}
                        on:drop={js::dropLine(event, parts, carry)}
                        on:keydown={js::pickUpLine(event, lift.closest(), parts, carry)}
                    >
                        <DeckLines bundle={DeckBuilderRefs} lines={lines} />
                    </div>
                    <button on:click={js::saveNow(event, parts)}>"Save"</button>
                </form>
                <template ref={template}>
                    <DeckLine id="" name="" kind="" cost={0} count={0} owned={0} bundle={DeckBuilderRefs} />
                </template>
                <details class={Export}>
                    <summary>"Deck list"</summary>
                    <DeckExport bundle={DeckBuilderRefs} text={&text} preview_total={None} />
                    <CopyButton text={DeckListId} label="Copy" copied="Copied" class={()} />
                    <DeckPreview bundle={DeckBuilderRefs} instance="a" label="Plan A" total={size} text={&text} />
                    <DeckPreview bundle={DeckBuilderRefs} instance="b" label="Plan B" total={size} text={&text} />
                </details>
            </section>
            <p id={MoveHelpId} hidden>
                "Space picks the card up; Left and Right move it between the collection and the deck; Up and Down reorder a deck line; Space drops it; Escape puts it back."
            </p>
            <p ref={announce} class={Hidden} aria-live="assertive"></p>
        </div>
    }
}
