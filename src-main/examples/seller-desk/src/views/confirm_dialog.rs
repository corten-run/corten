use corten::prelude::*;

use crate::ui::{
    button::{Button, ButtonSize, ButtonVariant},
    dialog::{Dialog, DialogFooter},
};

/// A modal that asks before an action. A button opens it with `command="show-modal"` and
/// `commandfor={id}`; Cancel closes it (`method="dialog"`), all without a script. The confirm
/// button runs the parent's handler, then closes it the same way.
#[component]
pub fn ConfirmDialog<'a, I: Id, C: Render>(
    id: I,
    title: &'a str,
    confirm: &'a str,
    on_confirm: Handler<'a>,
    children: C,
) -> impl Render {
    html! {
        <dialog class={Dialog {}} id={id}>
            <h2>{title}</h2>
            {children}
            <form class={DialogFooter {}} method="dialog">
                <button class={Button { variant: ButtonVariant::Outline, size: ButtonSize::Md }} value="cancel">"Cancel"</button>
                <button
                    class={Button { variant: ButtonVariant::Destructive, size: ButtonSize::Md }}
                    value="confirm"
                    on:click={on_confirm}
                >
                    {confirm}
                </button>
            </form>
        </dialog>
    }
}
