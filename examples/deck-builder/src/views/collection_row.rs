use corten::prelude::*;

use super::{DeckFormId, deck_builder::MoveHelpId};
use crate::app::DeckInput;

/// A card of the collection. `view` makes `CollectionRow` in `corten/views`, whose holes the
/// builder's script reads and writes by name: `selected` (the live checkbox),
/// `hidden` (the filter), `name`, `set` and `kind` (the filter and the sort), `cost` and `owned`
/// (the sort, and a new deck line's data) and `in_deck` (how many copies the deck has, which
/// every change writes).
///
/// Its checkbox and its Add button belong to the deck's form (`form=`), so without JavaScript Add
/// posts the deck with this card added, and Add selected the deck with every checked card. The
/// grip is what a pointer drags and a keyboard picks up; the stylesheet hides it until the
/// builder owns the deck form. `grip` and `add` let the handlers on the table body find the
/// control an event came from.
#[component(view)]
pub fn CollectionRow<'a>(
    id: &'a str,
    name: &'a str,
    set: &'a str,
    kind: &'a str,
    rarity: &'a str,
    cost: u32,
    owned: u32,
    in_deck: u32,
    selected: bool,
    hidden: bool,
    grip: Ref<el::HTMLButtonElement>,
    add: Ref<el::HTMLButtonElement>,
) -> impl Render {
    let f = DeckInput::FIELDS;
    html! {
        <tr key={id} data-rarity={rarity} hidden={hidden}>
            <td>
                <input
                    type="checkbox"
                    name={f.pick}
                    value={id}
                    form={DeckFormId}
                    checked={selected}
                    aria-label={name}
                >
            </td>
            <td>
                <button
                    ref={grip}
                    type="button"
                    draggable="true"
                    aria-label={name}
                    aria-describedby={MoveHelpId}
                >
                    "⠿"
                </button>
            </td>
            <th scope="row"><span>{name}</span><small>{set}</small></th>
            <td><span>{cost}</span></td>
            <td>{kind}</td>
            <td><span>{in_deck}</span>" / "<span>{owned}</span></td>
            <td><button ref={add} form={DeckFormId} name={f.add} value={id}>"Add"</button></td>
        </tr>
    }
}
