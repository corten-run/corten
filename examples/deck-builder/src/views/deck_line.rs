use corten::prelude::*;

use super::deck_builder::{DeckBuilderRefs, MoveHelpId};
use crate::app::DeckInput;

/// A card in the deck and its copies. `view` makes `DeckLine` in `corten/views`: the builder's
/// script makes and orders these from the deck it shows (`rows(lines, DeckLine, template).replace`),
/// filled from the collection row of the same card, so every hole is data a script has, and the
/// key, the card's id, is a hole too (the hidden `card` input).
///
/// The count is a number input named `count` beside the hidden `card`, so the deck's form posts
/// each line as `card` and `count`: without JavaScript a player types a count and saves, and a
/// cleared count takes the card out. The builder's refs identify the grip for drag and keyboard
/// moves and the count input for its change handler.
#[component(view)]
pub fn DeckLine<'a>(
    id: &'a str,
    name: &'a str,
    kind: &'a str,
    cost: u32,
    count: u32,
    owned: u32,
    bundle: DeckBuilderRefs,
) -> impl Render {
    let f = DeckInput::FIELDS;
    html! {
        <li key={id} data-kind={kind}>
            <input type="hidden" name={f.card} value={id}>
            <button ref={bundle.lift()} type="button" draggable="true" aria-label={name} aria-describedby={MoveHelpId}>
                "⠿"
            </button>
            <span>{cost}</span>
            <span>{name}</span>
            <small>{kind}</small>
            <input ref={bundle.copies()} type="number" name={f.count} value={count} min="0" inputmode="numeric" aria-label={name}>
            <small>"of "<span>{owned}</span></small>
        </li>
    }
}
