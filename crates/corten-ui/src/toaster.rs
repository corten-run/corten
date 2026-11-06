use corten::prelude::*;

/// The toast's id, `ui-toast`: an action's patch replaces the [`Toast`] by it.
#[derive(Id)]
pub struct ToastId;

/// What an action says when it is done ("Saved.", "3 items archived."), inside a [`Toaster`].
/// An action answers with it as a patch, `req.patch(Toast { message: Some(text), failed: false })`,
/// which replaces the toaster's message; no message, `Toast { message: None::<&str>, failed: false }`,
/// renders it `hidden` and empty. A message is text, or a view with text in it: the toaster shows
/// its close button while the message has text.
///
/// `failed` says the action did not do what was asked ("The card was sold before you saved."):
/// the message is marked `data-failed`, as the toaster's own `failed` text is, so the kit draws
/// it as a failure, and it stays until closed, the next submit or another page, not `seconds`
/// (with no message it says nothing). Such an answer is a refusal, so it goes with one:
/// `errors.refuse(Refusal::Conflict, text)` and `req.invalid(&errors, toast, page)`, which answers
/// 409 (a data client gets the Problem Details document, and the runtime sends no submit waiting
/// behind it), and the page an answer without JavaScript draws, the layout's `Toaster` given the
/// same `Toast`, says it too.
///
/// ```
/// use corten::prelude::*;
/// use corten_ui::Toast;
///
/// let sold = Toast { message: Some("The card was sold before you saved."), failed: true };
/// assert_eq!(sold.to_html(), r#"<div id="ui-toast" data-failed>The card was sold before you saved.</div>"#);
/// assert_eq!(Toast { message: Some("Saved."), failed: false }.to_html(), r#"<div id="ui-toast">Saved.</div>"#);
/// ```
#[component]
pub fn Toast<M: Render>(message: Option<M>, failed: bool) -> impl Patch {
    html! {
        <div id={ToastId} hidden={message.is_none()} data-failed={failed && message.is_some()}>
            if let Some(message) = message { {message} }
        </div>
    }
}

/// A toast: a short message after an action, announced politely and gone after `seconds`.
///
/// The toaster's live region (`role="status"`) stays on the page and is never hidden, while
/// patches replace the [`Toast`] inside it, so each new message is announced (a region inserted,
/// or shown, together with its message often is not). Render the toaster once in the page's
/// layout, where an answer without JavaScript can fill it too, and where a redirect's notice
/// lands (`Toast { message: req.notice(), failed: false }`: a write's redirect draws the layout again, and when
/// the page did not draw the notice the runtime's `corten:notice` event fills it). One message
/// shows at a time: a new one replaces it.
///
/// Its script (`toaster.js`) shows the close button while there is a message, and hides the
/// message after `seconds` (`0`: until closed), waiting while the pointer is over the toaster,
/// focus is in it or the page is hidden, so a slow reader keeps it (WCAG 2.2.1). Without
/// JavaScript the message is part of the page the post answers with, and there is no button.
///
/// `failed` is what it says when a `data-patch` submit gets no answer the runtime can draw (the
/// network failed, the connection closed, a proxy's 5xx page: `corten:error`), so a write that
/// did not go through is never silent ("That did not go through, and may not have been saved.
/// Check and try again."). One text serves every cause: the write may or may not have reached the
/// server, and the form keeps what the user typed, so it asks them to check and send it again. It
/// stays until closed, the next submit (not a dialog's own `method="dialog"` form) or another
/// page; the page changing only its own address (a tab, a link to a place on it, reading itself
/// again) keeps it. A screen that says it its own way (beside the form, retried by its script, or
/// by `detail.status`) calls `preventDefault()` on the `corten:error` in its handler, anywhere on
/// the page, and the toaster says nothing; an app that says every failure its own way gives an
/// empty `failed` (`""`), and the toaster says nothing for any. Without JavaScript the browser
/// shows its own error page.
///
/// The toaster is not in the top layer: an open modal `<dialog>` covers it, so a form in a
/// dialog answers inside the dialog, and says there that a submit failed (calling
/// `preventDefault()` on its `corten:error`). A refusal the user must act on (a field's error)
/// belongs next to what was refused, not in a toast.
///
/// Parts: a `div` (place it with `position: fixed`; it has no box of its own) around
/// `[role=status]`, which holds the message (`#ui-toast`, the box to style, `[hidden]` when there
/// is none, `[data-failed]` when it is the `failed` text or a failed [`Toast`], to draw as a failure; a message
/// closed or gone keeps its mark, so match `[data-failed]:not([hidden])`),
/// the close `button` after it (outside the live region, so it is not announced), and a
/// `template` holding `failed`, which draws nothing.
///
/// ```
/// use corten::prelude::*;
/// use corten_ui::{Toast, Toaster};
///
/// let failed = "That did not go through, and may not have been saved. Check and try again.";
/// let html = Toaster { close: "Dismiss", seconds: 5, toast: Toast { message: Some("Saved."), failed: false }, failed }.to_html();
/// assert!(html.contains(r#"<div data-ref="status" role="status"><div id="ui-toast">Saved.</div></div>"#), "{html}");
/// assert_eq!(Toast { message: None::<&str>, failed: false }.to_html(), r#"<div id="ui-toast" hidden></div>"#);
/// ```
#[component(js)]
pub fn Toaster<C: Render, M: Render, F: Render>(close: C, seconds: u32, toast: Toast<M>, failed: F) -> impl Render {
    let (status, button, said) = refs();
    html! {
        <div on:connect={js::connect(scope, status, button, said, seconds, signal)}>
            <div ref={status} role="status">{toast}</div>
            <button ref={button} type="button" hidden on:click={js::dismiss(status, button)}>{close}</button>
            <template ref={said}>{failed}</template>
        </div>
    }
}
