//! The smoke fixture for a server-drawn modal that a later patch replaces or removes.
use corten::{Component, LiveResponse, LiveSince, prelude::*, view::Remove};
use corten_ui::dialog;
use std::time::Duration;

use crate::app::url::{DialogDraw, DialogDrawLive};

corten::script::script!(mod dialog_draw = "dialog_draw.js");
pub(super) const HANDLERS: Component = dialog_draw::COMPONENT;

#[derive(Clone, Copy, PartialEq, UrlValue)]
#[serde(rename_all = "kebab-case")]
pub enum Case {
    Post,
    Live,
    Read,
    Nested,
    DropInner,
    Mutate,
    Remove,
    Reopen,
    ReplaceOpener,
    Link,
    NativeConnect,
}

#[derive(Id)]
struct DrawArea;
#[derive(Id)]
struct DrawOpener;
#[derive(Id)]
struct DrawOuter;
#[derive(Id)]
struct DrawInner;

pub(super) async fn page(req: Req, Params(route): Params<DialogDraw>) -> HtmlResult<Patches> {
    req.patch_or(area(route.case, false, "updated"), || async { document(&req, route.case, false) }).await
}

pub(super) async fn open(req: Req, Params(route): Params<DialogDraw>) -> HtmlResult {
    let again = (route.case == Case::Read).then(|| ReadAgain { after: Duration::ZERO }.from(DialogDraw { case: Case::Read }));
    req.patch_or(
        html! {
            {area(route.case, true, "opened")}
            {again}
        },
        || async { document(&req, route.case, true) },
    )
    .await
}

pub(super) async fn draw(req: Req, Params(route): Params<DialogDraw>) -> HtmlResult {
    match route.case {
        Case::Remove => req.patch_or(Remove(DrawArea), || async { document(&req, route.case, false) }).await,
        Case::ReplaceOpener => {
            req.patch_or(html! { {opener(route.case, "Replacement opener")} {area(route.case, false, "updated")} }, || async {
                document(&req, route.case, false)
            })
            .await
        }
        case => {
            let open = matches!(case, Case::Reopen | Case::NativeConnect);
            req.patch_or(area(case, open, "updated"), || async { document(&req, case, open) }).await
        }
    }
}

pub(super) async fn live(since: LiveSince) -> LiveResponse {
    let (_, fragment) = tokio::sync::watch::channel(area(Case::Live, false, "updated").to_html());
    corten::live_watch(fragment, since, |_| 1, String::clone)
}

fn document(req: &Req, case: Case, open: bool) -> HtmlResult {
    let route = DialogDraw { case };
    req.page(html! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <title>"Server-drawn dialogs"</title>
                <Corten />
            </head>
            <body>
                <main>
                    <h1>"Server-drawn dialogs"</h1>
                    {opener(case, "Open dialog")}
                    <form method="post" action={route.draw()} data-patch><button>"Redraw dialog"</button></form>
                    <output aria-label="Close events"></output>
                    {area(case, open, if open { "opened" } else { "initial" })}
                </main>
            </body>
        </html>
    })
}

fn opener(case: Case, label: &str) -> impl Patch + '_ {
    let route = DialogDraw { case };
    html! {
        <button id={DrawOpener} type="submit" formmethod="post" form={DrawOpenForm} formaction={route.open()}>{label}</button>
    }
}

#[derive(Id)]
struct DrawOpenForm;

#[component]
fn DrawAreaPatch(case: Case, open: bool, stage: &str) -> impl Patch {
    let route = DialogDraw { case };
    let close = refs();
    let outer = refs();
    let next = DialogDraw { case: Case::Post };
    let nested = matches!(case, Case::Nested | Case::DropInner | Case::Mutate);
    let inner = nested && (open || case != Case::DropInner);
    html! {
        <div id={DrawArea} data-stage={stage}>
            <form id={DrawOpenForm} method="post" action={route.open()} data-patch></form>
            if case == Case::Link {
                <dialog
                    id={DrawOuter}
                    open={open}
                    aria-label="Outer modal"
                    on:connect={dialog::modalClosedBy(target, close, signal)}
                    on:close={dialog_draw::closed(event, target, false)}
                >
                    <a ref={close} href={route}>"Leave"</a>
                    <a href={next} data-no-prefetch>"Next page"</a>
                    <form method="post" action={route.draw()} data-patch><button>"Change dialog"</button></form>
                </dialog>
            } else {
                <dialog
                    id={DrawOuter}
                    ref={outer}
                    open={open}
                    aria-label="Outer modal"
                    on:connect={dialog::modal(target)}
                    on:close={dialog_draw::closed(event, target, false)}
                >
                    <button type="button">"Inside outer"</button>
                    if case == Case::Live {
                        <a href={next} data-no-prefetch>"Next page"</a>
                    }
                    if case == Case::Reopen && stage == "updated" {
                        <form method="get" action={route} data-patch><button>"Close redrawn dialog"</button></form>
                    }
                    if case == Case::NativeConnect && stage == "updated" {
                        <span on:connect={dialog_draw::nativeClose(outer)}></span>
                    }
                    if inner {
                        <dialog
                            id={DrawInner}
                            open={open}
                            aria-label="Inner modal"
                            on:connect={dialog::modal(target)}
                            on:close={dialog_draw::closed(event, target, case == Case::Mutate)}
                        >
                            <form method="post" action={route.draw()} data-patch><button>"Change dialog"</button></form>
                        </dialog>
                    } else {
                        <form method="post" action={route.draw()} data-patch><button>"Change dialog"</button></form>
                    }
                </dialog>
            }
            if case == Case::Live && open {
                <corten-live src={DialogDrawLive}></corten-live>
            }
        </div>
    }
}

fn area(case: Case, open: bool, stage: &str) -> impl Patch + '_ {
    DrawAreaPatch { case, open, stage }
}
