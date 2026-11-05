use crate::{
    html,
    prelude::*,
    script::{self, __private::scoped},
};

script::script!(mod shared = "shared.js");

crate::i18n::messages! { struct Msg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
use crate::i18n::Messages as _;

#[script::event]
#[allow(dead_code)]
struct RowToggled {
    id: String,
    selected: bool,
}

#[component(js)]
fn LineItem<'a>(name: &'a str, quantity: u32) -> impl Render {
    let (save, dialog) = refs();
    html! {
        <li>
            <input value={quantity} on:input={js::enable(save)}>
            <button ref={save} disabled>"Save"</button>
            <button on:click={js::confirm(event, dialog, name)}>"Remove"</button>
            <dialog ref={dialog}>"Sure?"</dialog>
        </li>
    }
}

/// A count a script computes, shown with a message of the page's locale: a plural one alone, and
/// a plain one in a group with a plain value.
#[component]
fn Count(t: Msg) -> impl Render {
    let out = refs();
    let counted = shared::Counted { entity: "Levels", label: t.js().selected() };
    html! {
        <p>
            <output ref={out} on:connect={shared::say(out, t.js().item_listing_count())}></output>
            <output ref={out} on:connect={shared::tally(out, counted)}></output>
        </p>
    }
}

const USD: crate::i18n::Currency = crate::i18n::Currency::new("USD");

/// A count, an amount and a date a script computes, in the page's locale.
#[component]
fn Priced(t: Msg) -> impl Render {
    use crate::i18n::{DateStyle, Offset};
    let out = refs();
    let when = t.js().date(DateStyle::Short).zone(Offset::hours(-5));
    html! { <output ref={out} on:connect={shared::priced(out, t.js().number(), t.js().money(USD), when)}></output> }
}

/// A `string[]` parameter takes a slice, an array or a `Vec` of strings, with no feature.
#[component]
fn Named<'a>(list: &'a [&'a str]) -> impl Render {
    let out = refs();
    let owned = vec![String::from("a\"b<")];
    html! {
        <p
            ref={out}
            on:connect={shared::named(out, list)}
            on:click={shared::named(out, &owned)}
            on:input={shared::named(out, ["x", "y"])}
        ></p>
    }
}

#[test]
fn a_list_of_strings_is_a_json_array() {
    let html = Named { list: &["above", "below"] }.to_html();
    assert_eq!(
        html,
        concat!(
            r#"<p data-scope="named" data-ref="out" data-on="connect:shared.named(@out,[&quot;above&quot;,&quot;below&quot;]) "#,
            r#"click:shared.named(@out,[&quot;a\&quot;b&lt;&quot;]) input:shared.named(@out,[&quot;x&quot;,&quot;y&quot;])"></p>"#
        )
    );
}

#[test]
fn a_script_gets_the_pages_formats() {
    let en = Priced { t: Msg::for_locale("en") }.to_html();
    assert_eq!(
        en,
        concat!(
            r#"<output data-scope="priced" data-ref="out" data-on="connect:shared.priced(@out,"#,
            r#"%{&quot;z&quot;:&quot;0&quot;,&quot;s&quot;:[&quot;.&quot;,&quot;,&quot;,3,3,1],&quot;t&quot;:[&quot;\u0001&quot;,&quot;-\u0001&quot;]},"#,
            r#"%{&quot;z&quot;:&quot;0&quot;,&quot;s&quot;:[&quot;.&quot;,&quot;,&quot;,3,3,1],&quot;t&quot;:[&quot;$\u0001&quot;,&quot;-$\u0001&quot;],&quot;d&quot;:2},"#,
            r#"%{&quot;z&quot;:&quot;0&quot;,&quot;f&quot;:[[&quot;M&quot;],[&quot;&quot;,&quot;/&quot;],[&quot;d&quot;],[&quot;&quot;,&quot;/&quot;],[&quot;y&quot;]],&quot;o&quot;:-18000})"></output>"#
        )
    );
}

/// A float argument is written as `Display` writes it: no fraction on a whole number, never an
/// exponent, and `null` for NaN (the app guide, Numbers in JSON, says so).
#[test]
fn a_float_argument_is_written_as_display_writes_it() {
    for (n, text) in [(2.0f64, "2"), (1e21, "1000000000000000000000"), (-0.0, "-0"), (f64::NAN, "null"), (f64::INFINITY, "null")]
    {
        let html = scoped("x", || {
            html! { <corten-live src="/live" on:corten-status={shared::log("x", n, true)}></corten-live> }.to_html()
        });
        assert!(html.contains(&format!("shared.log(&quot;x&quot;,{text},true)")), "{html}");
    }
}

#[test]
fn a_live_elements_status_event_takes_a_handler() {
    let html =
        scoped("x", || html! { <corten-live src="/live" on:corten-status={shared::log("x", 1, true)}></corten-live> }.to_html());
    assert_eq!(html, r#"<corten-live src="/live" data-on="corten-status:shared.log(&quot;x&quot;,1,true)"></corten-live>"#);
}

#[test]
fn handlers_are_calls_with_refs_keywords_and_values() {
    let html = LineItem { name: "a\"b", quantity: 2 }.to_html();
    assert_eq!(
        html,
        concat!(
            r#"<li data-scope="line-item"><input value="2" data-on="input:line_item.enable(@save)">"#,
            r#"<button data-ref="save" disabled>Save</button>"#,
            r#"<button data-on="click:line_item.confirm($e,@dialog,&quot;a\&quot;b&quot;)">Remove</button>"#,
            r#"<dialog data-ref="dialog">Sure?</dialog></li>"#,
        )
    );
    let script = LineItem.script.expect("a script");
    assert_eq!((script.name, script.file), ("line_item", "line_item.js"));
    assert_eq!(script.handlers, &["enable", "confirm"]);
}

#[component(js)]
fn RowList<'a>(rows: &'a [&'a str]) -> impl Render {
    let row = refs();
    html! {
        <table>
            <tbody on:RowToggled={js::count(event, row)}>
                for r in rows.iter() {
                    <tr ref={row} on:click={js::toggle(target, r)}><td>{r}</td></tr>
                }
            </tbody>
        </table>
    }
}

#[test]
fn a_ref_in_a_loop_is_an_array_and_typed_events_are_kebab_case() {
    let html = RowList { rows: &["x", "y"] }.to_html();
    assert!(html.starts_with(r#"<table data-scope="row-list"><tbody data-on="row-toggled:row_list.count($e,*row)">"#), "{html}");
    assert!(html.contains(r#"<tr data-ref="row" data-on="click:row_list.toggle($t,&quot;x&quot;)">"#), "{html}");
}

/// A child that takes a handler and a ref from its parent.
#[component]
fn Confirm<'a>(label: &'a str, on_confirm: Handler<'a>) -> impl Render {
    html! { <button type="button" on:click={on_confirm}>{label}</button> }
}

#[component(js)]
fn Dialog() -> impl Render {
    let (form, body) = refs();
    html! {
        <form ref={form}>
            <div ref={body}></div>
            <Confirm label="OK" on:confirm={js::submit(form, scope)} />
            <Confirm label="No" on:confirm={None::<Handler>} />
        </form>
    }
}

#[test]
fn a_parent_passes_a_handler_and_its_refs_resolve_in_its_scope() {
    let html = Dialog {}.to_html();
    assert_eq!(
        html,
        concat!(
            r#"<form data-scope="dialog" data-ref="form"><div data-ref="body"></div>"#,
            r#"<button type="button" data-on="click:dialog.submit(@form,$c)">OK</button>"#,
            r#"<button type="button">No</button></form>"#,
        )
    );
}

/// A child with refs of its own, inside a parent with refs: the parent's handler names its
/// refs with the parent's scope.
#[component(js)]
fn Field<'a>(on_change: Handler<'a>) -> impl Render {
    let input = refs();
    html! { <label><input ref={input} on:input={js::trim(target)} on:change={on_change}></label> }
}

#[component(js)]
fn Form() -> impl Render {
    let save = refs();
    html! {
        <div>
            <Field on:change={js::enable(save, scope)} />
            <button ref={save}>"Save"</button>
        </div>
    }
}

#[test]
fn a_handler_made_by_a_parent_keeps_the_parents_scope_inside_a_child() {
    let html = Form {}.to_html();
    assert_eq!(
        html,
        concat!(
            r#"<div data-scope="form"><label data-scope="field"><input data-ref="input" "#,
            r#"data-on="input:field.trim($t) change:form.enable(@form/save,$c/form)"></label>"#,
            r#"<button data-ref="save">Save</button></div>"#,
        )
    );
}

/// A component whose script keeps state, with no refs and no `scope`: still scoped, so each
/// instance keeps its own.
#[component(js)]
fn Tally() -> impl Render {
    html! { <button type="button" on:click={js::bump(target)}>"0"</button> }
}

/// A scoped child that renders a parent's handler and the markup it is given.
#[component]
fn Labeled<'a>(on_change: Handler<'a>, children: impl Render) -> impl Render {
    let input = refs();
    html! { <label><input ref={input} on:change={on_change}>{children}</label> }
}

/// A parent whose state-keeping handler a scoped child renders, as a prop and in its children.
#[component(js)]
fn Tallies() -> impl Render {
    html! {
        <div>
            <Labeled on:change={js::bump(target)}>
                <button type="button" on:click={js::bump(target)}>"0"</button>
            </Labeled>
        </div>
    }
}

/// A layout with a script of its own: its handlers are in scope in each part a page draws of it,
/// not only in the whole document (#906).
#[component(js)]
fn Framed(children: impl Render) -> impl Document {
    html! {
        <html>
            <head>
                <title>"Framed"</title>
                <Corten />
            </head>
            <body>
                <main>{children}</main>
                <div on:connect={js::ready(signal)}></div>
            </body>
        </html>
    }
}

/// The same with a ref, so its markup has a root (`data-scope`) in every part too.
#[component(js = Framed)]
fn FramedRoot(children: impl Render) -> impl Document {
    let toasts = refs();
    html! {
        <html>
            <head>
                <title>"Framed"</title>
                <Corten />
            </head>
            <body>
                <main>{children}</main>
                <div ref={toasts} on:connect={js::hold(toasts)}></div>
            </body>
        </html>
    }
}

#[test]
fn a_layouts_own_handlers_are_drawn_in_each_part_of_it() {
    let whole = Framed { children: "x" }.to_html();
    let mut full = String::new();
    Framed { children: "x" }.render_part(&mut full, crate::view::Part::Full);
    assert_eq!(full, whole);
    assert!(whole.contains(r#"<div data-on="connect:framed.ready($s)"></div>"#), "{whole}");
    let rooted = FramedRoot { children: "x" }.to_html();
    let mut rooted_full = String::new();
    FramedRoot { children: "x" }.render_part(&mut rooted_full, crate::view::Part::Full);
    assert_eq!(rooted_full, rooted);
    assert!(rooted.contains("data-scope="), "{rooted}");
}

#[test]
fn a_script_that_keeps_state_scopes_its_component_and_a_childs_element_names_its_home() {
    assert_eq!(Tally {}.to_html(), r#"<button data-scope="tally" type="button" data-on="click:tally.bump($t)">0</button>"#);
    assert_eq!(
        Tallies {}.to_html(),
        concat!(
            r#"<div data-scope="tallies"><label data-scope="labeled"><input data-ref="input" "#,
            r#"data-on="change:tallies.bump($t)/tallies"><button type="button" "#,
            r#"data-on="click:tallies.bump($t)/tallies">0</button></label></div>"#,
        )
    );
}

#[test]
fn shared_modules_and_events_are_components() {
    assert_eq!(shared::COMPONENT.script.map(|s| s.name), Some("shared"));
    let event = RowToggled.event.expect("an event");
    assert_eq!((event.class, event.name, event.fields.len()), ("RowToggled", "row-toggled", 2));
    let html = scoped("x", || html! { <p on:click={shared::log("hi", 2, true)}>"x"</p> }.to_html());
    assert_eq!(html, r#"<p data-on="click:shared.log(&quot;hi&quot;,2,true)">x</p>"#);
}

// The module docs' script, shared here.
script::script!(mod js = "../stock_grid.js");

/// A list with one handler on its container (`closest`), a group of refs, keyed cells and a
/// typed event's handler.
#[component]
fn StockGrid<'a>(rows: &'a [(&'a str, u32)]) -> impl Render {
    let (row, count, qty) = refs();
    let sel = js::Selection { rows: row, count };
    html! {
        <table>
            <tbody on:click={js::toggle(row.closest(), sel)} on:RowToggled={js::toggled(event, sel)}>
                for (id, n) in rows.iter() {
                    <tr ref={row} id={*id}><td ref={qty} key={*id}>{*n}</td></tr>
                }
            </tbody>
            <caption><output ref={count}>"0"</output></caption>
            <tfoot on:connect={js::show(qty, "a")}></tfoot>
        </table>
    }
}

#[test]
fn closest_groups_keyed_refs_and_typed_event_handlers_are_written_compactly() {
    let html = StockGrid { rows: &[("a", 1), ("b", 2)] }.to_html();
    assert_eq!(
        html,
        concat!(
            r#"<table data-scope="stock-grid"><tbody data-on="click:stock_grid.toggle(^row,{rows:*row,count:@count}) "#,
            r#"row-toggled:stock_grid.toggled($e,{rows:*row,count:@count})">"#,
            r#"<tr data-ref="row" id="a"><td data-ref="qty" data-key="a">1</td></tr>"#,
            r#"<tr data-ref="row" id="b"><td data-ref="qty" data-key="b">2</td></tr></tbody>"#,
            r#"<caption><output data-ref="count">0</output></caption>"#,
            r#"<tfoot data-on="connect:stock_grid.show(#qty,&quot;a&quot;)"></tfoot></table>"#,
        )
    );
}

/// A view, for the page test below.
#[component(view)]
fn Badge(n: u32) -> impl Render {
    html! { <b>{n}</b> }
}

/// A view with a 64-bit number property.
#[component(view)]
fn Order(id: u64) -> impl Render {
    html! { <b>{id}</b> }
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "view property id = 18446744073709551615 is beyond what a JavaScript number holds exactly")]
fn a_view_number_javascript_cannot_hold_exactly_stops_debug_builds() {
    assert_eq!(Order { id: (1 << 53) - 1 }.to_html(), "<b>9007199254740991</b>");
    Order { id: u64::MAX }.to_html();
}

#[tokio::test]
async fn a_page_loads_its_handler_modules_as_module_scripts_and_the_views_only_for_one_that_imports_them() {
    use axum::{body::Body, http::Request, routing::get, Router};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    let get_page = |app: Router| async move {
        let res = app.oneshot(Request::get("/").body(Body::empty()).unwrap()).await.unwrap();
        String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
    };
    let handlers =
        Router::new().route(
            "/",
            get(|req: crate::Req| async move {
                crate::tests::TestPage::test_page(&req, "Cart", LineItem { name: "Lamp", quantity: 2 })
            }),
        );
    let body = get_page(crate::App::new(Routes::from(handlers)).components(&[LineItem, Badge]).router()).await;
    let views = body.split_once(r#""corten/views":""#).expect("the import map maps corten/views").1.split_once('"').unwrap().0;
    assert!(views.ends_with("/views.js"), "{body}");
    // Its module does not import the views, so the page does not fetch them.
    assert!(!body.contains(&format!(r#"<link rel="modulepreload" href="{views}">"#)), "{body}");
    // The handler module is a module script of the page, and hands its exports to the runtime as it runs.
    let module = views.replace("/views.js", "/scripts/line_item.js");
    assert!(body.contains(&format!(r#"<script type="module" src="{module}"></script>"#)), "{body}");
    let app = crate::App::new(Routes::new()).components(&[LineItem, Badge]).router();
    let res = app.oneshot(Request::get(&module).body(Body::empty()).unwrap()).await.unwrap();
    let source = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    // Served without its comments, each line where it was, then the three lines that hand it over.
    let file = include_str!("line_item.js");
    assert!(file.contains("/** @param {HTMLButtonElement} save */") && file.starts_with("// @ts-check"));
    assert!(!source.contains("@param") && !source.contains("@ts-check"), "{source}");
    assert_eq!(source.lines().count(), file.lines().count() + 3, "{source}");
    assert_eq!(
        source.lines().position(|l| l.starts_with("export function confirm")),
        file.lines().position(|l| l.starts_with("export function confirm"))
    );
    assert!(
        source.ends_with(concat!(
            "import \"corten\";\n",
            "import * as __corten_self from \"./line_item.js\";\n",
            "document.dispatchEvent(new CustomEvent(\"corten:module\", { detail: { name: \"line_item\", url: import.meta.url, exports: __corten_self } }));\n"
        )),
        "{source}"
    );
    // A page whose handlers need no module has nothing to import the views.
    let plain = Router::new()
        .route("/", get(|req: crate::Req| async move { crate::tests::TestPage::test_page(&req, "Badge", Badge { n: 1 }) }));
    let body = get_page(crate::App::new(Routes::from(plain)).components(&[LineItem, Badge]).router()).await;
    assert!(!body.contains("modulepreload") && !body.contains(r#"src="/assets/"#), "{body}");
}

/// A script that imports a typed event brings it: the app lists the script alone, and a page
/// whose handlers are in it maps `corten/events` and fetches it with the script, not after it.
#[tokio::test]
async fn a_script_brings_the_events_it_imports_and_its_page_fetches_them_with_it() {
    use axum::{body::Body, http::Request, routing::get, Router};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    let get_page = |app: Router| async move {
        let res = app.oneshot(Request::get("/").body(Body::empty()).unwrap()).await.unwrap();
        String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
    };
    let grid = Router::new().route(
        "/",
        get(|req: crate::Req| async move { crate::tests::TestPage::test_page(&req, "Stock", StockGrid { rows: &[("a", 1)] }) }),
    );
    let body = get_page(crate::App::new(Routes::from(grid)).components(&[js::COMPONENT]).router()).await;
    let events = body.split_once(r#""corten/events":""#).expect("the import map maps corten/events").1.split_once('"').unwrap().0;
    assert!(events.ends_with("/events.js"), "{body}");
    assert!(body.contains(&format!(r#"<link rel="modulepreload" href="{events}">"#)), "{body}");
    let app = crate::App::new(Routes::new()).components(&[js::COMPONENT]).router();
    let res = app.oneshot(Request::get(events).body(Body::empty()).unwrap()).await.unwrap();
    let source = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(source.contains("export const RowToggled = event(\"row-toggled\");"), "{source}");
    // A page whose handlers are in a script that imports no event does not fetch them.
    let lines =
        Router::new().route(
            "/",
            get(|req: crate::Req| async move {
                crate::tests::TestPage::test_page(&req, "Cart", LineItem { name: "Lamp", quantity: 2 })
            }),
        );
    let body = get_page(crate::App::new(Routes::from(lines)).components(&[LineItem, js::COMPONENT]).router()).await;
    assert!(body.contains("/scripts/line_item.js") && !body.contains("events.js\">"), "{body}");
}

#[component(js)]
fn KeyPause() -> impl Render {
    html! { <button on:document:keydown={js::press(event, target)}>"Pause"</button> }
}

/// `corten/keys` is served only to an app with a script that imports it: the import map names it
/// then, and a page whose handlers are in that script fetches it with the script, not after it.
#[tokio::test]
async fn a_script_that_imports_corten_keys_brings_it_and_its_page_fetches_it_with_it() {
    use axum::{body::Body, http::Request, routing::get, Router};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    let fetch = |app: Router, uri: String| async move {
        let res = app.oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
        String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
    };
    let routes = || {
        Router::new()
            .route("/", get(|req: crate::Req| async move { crate::tests::TestPage::test_page(&req, "Prices", KeyPause {}) }))
            .route(
                "/cart",
                get(|req: crate::Req| async move {
                    crate::tests::TestPage::test_page(&req, "Cart", LineItem { name: "Lamp", quantity: 2 })
                }),
            )
    };
    let app = || crate::App::new(Routes::from(routes())).components(&[KeyPause, LineItem]).router();
    let body = fetch(app(), "/".into()).await;
    let keys = body.split_once(r#""corten/keys":""#).expect("the import map maps corten/keys").1.split_once('"').unwrap().0;
    assert!(keys.ends_with("/scripts/corten-keys.js"), "{body}");
    let pause = keys.replace("/corten-keys.js", "/key_pause.js");
    assert!(
        body.contains(&format!(r#"<script type="module" src="{pause}"></script><link rel="modulepreload" href="{keys}">"#)),
        "{body}"
    );
    let source = fetch(app(), keys.to_string()).await;
    assert!(source.contains("export{") && source.contains(" as shortcut}"), "{source}");
    // A page the runtime swaps in carries it too, so it is fetched with the script there as well.
    let res = app().oneshot(Request::get("/").header("corten", "nav").body(Body::empty()).unwrap()).await.unwrap();
    let swap = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(swap.contains(&format!(r#"<link rel="modulepreload" href="{keys}">"#)) && !swap.contains("<script"), "{swap}");
    // Its own page's handlers import nothing from it, so it does not fetch it.
    let cart = fetch(app(), "/cart".into()).await;
    assert!(cart.contains("/scripts/line_item.js") && !cart.contains(r#"corten-keys.js">"#), "{cart}");
    // An app with no script that imports it does not serve it or name it.
    let lines = crate::App::new(Routes::from(routes())).components(&[LineItem]).router();
    let cart = fetch(lines, "/cart".into()).await;
    assert!(!cart.contains("corten/keys"), "{cart}");
}
/// The formatter a format argument needs is a module of its own: a page whose handlers take a
/// format loads it with theirs, and a page whose handlers take none does not.
#[tokio::test]
async fn a_page_loads_the_format_module_only_when_its_handlers_take_a_format() {
    use axum::{body::Body, http::Request, routing::get, Router};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    let fetch = |app: Router, uri: String| async move {
        let res = app.oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
        String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
    };
    let routes = Router::new()
        .route(
            "/priced",
            get(|req: crate::Req| async move {
                crate::tests::TestPage::test_page(&req, "Priced", Priced { t: Msg::for_locale("en") })
            }),
        )
        .route(
            "/cart",
            get(|req: crate::Req| async move {
                crate::tests::TestPage::test_page(&req, "Cart", LineItem { name: "Lamp", quantity: 2 })
            }),
        );
    let app = || crate::App::new(Routes::from(routes.clone())).components(&[shared::COMPONENT, LineItem, Badge]).router();
    let priced = fetch(app(), "/priced".into()).await;
    let src = |name: &str| {
        priced
            .split(r#"<script type="module" src=""#)
            .skip(1)
            .map(|s| s.split('"').next().unwrap())
            .find(|s| s.ends_with(name))
            .map(str::to_string)
    };
    assert!(src("/scripts/shared.js").is_some(), "{priced}");
    let format = src("/scripts/corten-format.js").expect("the format module is a module script of the page");
    let cart = fetch(app(), "/cart".into()).await;
    assert!(cart.contains("/scripts/line_item.js") && !cart.contains("corten-format"), "{cart}");
    let source = fetch(app(), format).await;
    assert!(source.contains("formatter") && source.contains(r#"name: "corten-format""#), "{source}");
}

script::script!(mod relayed = "relay.js");
script::script!(mod chained = "chain.js");

/// A page the runtime swaps in carries what its handler modules import, as a full load's head
/// does, so the runtime fetches it with them rather than once each arrives: a module of the
/// script's directory, the views and the typed events. Not the modules themselves, which the
/// runtime imports, and nothing for a page whose modules import nothing.
#[tokio::test]
async fn a_swapped_in_page_preloads_what_its_handler_modules_import() {
    use axum::{body::Body, http::Request, routing::get, Router};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    let routes =
        Router::new()
            .route(
                "/relay",
                get(|req: crate::Req| async move {
                    crate::tests::TestPage::test_page(&req, "Relay", html! { <p on:click={relayed::relay()}>"x"</p> })
                }),
            )
            .route(
                "/stock",
                get(|req: crate::Req| async move {
                    crate::tests::TestPage::test_page(&req, "Stock", StockGrid { rows: &[("a", 1)] })
                }),
            )
            .route(
                "/cart",
                get(|req: crate::Req| async move {
                    crate::tests::TestPage::test_page(&req, "Cart", LineItem { name: "Lamp", quantity: 2 })
                }),
            )
            .route(
                "/both",
                get(|req: crate::Req| async move {
                    let view = html! {
                        <p on:click={relayed::relay()}>"x"</p>
                        <p on:click={chained::chain()}>"y"</p>
                    };
                    crate::tests::TestPage::test_page(&req, "Both", view)
                }),
            );
    let components = [shared::COMPONENT, relayed::COMPONENT, chained::COMPONENT, js::COMPONENT, LineItem, Badge];
    let fetch = |uri: &'static str, nav: bool| {
        let app = crate::App::new(Routes::from(routes.clone())).components(&components).router();
        async move {
            let mut req = Request::get(uri);
            if nav {
                req = req.header("corten", "nav");
            }
            let res = app.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
        }
    };
    let preloads = |body: &str| -> Vec<String> {
        body.split(r#"<link rel="modulepreload" href=""#).skip(1).map(|s| s.split('"').next().unwrap().to_string()).collect()
    };
    let full = fetch("/relay", false).await;
    let swap = fetch("/relay", true).await;
    let ends = |list: &[String]| list.iter().map(|s| s.rsplit('/').next().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(ends(&preloads(&full)), ["shared.js", "views.js"], "{full}");
    assert_eq!(preloads(&swap), preloads(&full), "the same URLs as the full load's head: {swap}");
    assert!(!swap.contains("<script") && !swap.contains("relay.js"), "the runtime imports the module itself: {swap}");
    // The typed events, for a module that imports them.
    let stock = fetch("/stock", true).await;
    assert_eq!(ends(&preloads(&stock)), ["events.js"], "{stock}");
    // A module that imports nothing: nothing more in the swap.
    let cart = fetch("/cart", true).await;
    assert!(!cart.contains("modulepreload"), "{cart}");
    // Two modules: one imports the other, which imports a module both name. Each import is carried
    // once, the second level included; relay.js is one of chain.js's imports, so it comes too.
    let both = fetch("/both", true).await;
    assert_eq!(ends(&preloads(&both)), ["shared.js", "relay.js", "views.js"], "{both}");
}

/// A page whose handlers call a module the app does not serve fails in a debug build (a router
/// test finds it), instead of rendering a page whose handlers would do nothing.
#[cfg(debug_assertions)]
#[tokio::test]
async fn a_page_whose_handlers_call_an_unserved_module_fails_in_debug_builds() {
    use axum::{body::Body, http::Request, routing::get, Router};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    let page = || {
        Router::new().route(
            "/",
            get(|req: crate::Req| async move {
                crate::tests::TestPage::test_page(&req, "Cart", LineItem { name: "Lamp", quantity: 2 })
            }),
        )
    };
    let res = crate::App::new(Routes::from(page())).components(&[Badge]).router();
    let res = res.oneshot(Request::get("/").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), axum::http::StatusCode::INTERNAL_SERVER_ERROR);
    let res = crate::App::new(Routes::from(page())).components(&[LineItem, Badge]).router();
    let res = res.oneshot(Request::get("/").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), axum::http::StatusCode::OK, "listed, it is served");
    let body = res.into_body().collect().await.unwrap().to_bytes();
    assert!(String::from_utf8_lossy(&body).contains("line_item.js"));
}

#[test]
fn view_ids_are_fnv1a_as_the_macros_compute_them() {
    assert_eq!((script::view_id(""), script::view_id("a")), (0xcbf2_9ce4_8422_2325, 0xaf63_dc4c_8601_ec8c));
}

#[test]
fn rendering_collects_the_modules_a_page_uses() {
    let (_, modules) = script::collect(|| (Form {}.to_html(), LineItem { name: "x", quantity: 1 }.to_html()));
    assert_eq!(modules, vec!["field", "form", "line_item"]);
}

/// The strings handlers write, as the runtime's parser expects them (`wire.json`, which
/// `scripts/wire.mjs` parses with the runtime's own parser).
#[cfg(feature = "json")]
#[test]
fn handlers_write_the_shared_wire_vectors() {
    #[derive(crate::json::ToJson)]
    struct Options {
        id: &'static str,
        tags: [&'static str; 2],
    }
    let nasty = "),{\"x\":1}\\ \u{2028} <&'> é 🦀 ,a:b";
    let pages = [
        LineItem { name: "a\"b", quantity: 2 }.to_html(),
        RowList { rows: &["x"] }.to_html(),
        Form {}.to_html(),
        Tallies {}.to_html(),
        StockGrid { rows: &[("a", 1)] }.to_html(),
        scoped("x", || {
            html! {
                <p on:click={shared::log("hi", 2, true)}></p>
                <p on:click={shared::log(nasty, -1.5, false)}></p>
                <p on:click={shared::log("", f64::NAN, true)}></p>
                <p on:connect={shared::watch(signal, Options { id: "a}", tags: ["x,y", "]"] })}></p>
                <p on:document:keydown={shared::key(event, target)}></p>
            }
            .to_html()
        }),
        Count { t: Msg::for_locale("en") }.to_html(),
        Count { t: Msg::for_locale("fr") }.to_html(),
        Priced { t: Msg::for_locale("en") }.to_html(),
        Priced { t: Msg::for_locale("fr") }.to_html(),
    ];
    let mut written = Vec::new();
    for page in &pages {
        for part in page.split(" data-on=\"").skip(1) {
            let value = &part[..part.find('"').expect("a closing quote")];
            let text = value
                .replace("&quot;", "\"")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&#39;", "'")
                .replace("&amp;", "&");
            written.push(text);
        }
    }
    let vectors: serde_json::Value = serde_json::from_str(include_str!("wire.json")).expect("wire.json is JSON");
    let mut expected: Vec<String> = vectors["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .filter(|case| case.get("from").is_none())
        .map(|case| case["attr"].as_str().expect("attr").to_string())
        .collect();
    written.sort();
    expected.sort();
    assert_eq!(written, expected, "what handlers write and wire.json differ; update both sides together");
}

#[test]
#[cfg(debug_assertions)]
#[should_panic(expected = "beyond what a JavaScript number holds exactly")]
fn an_integer_javascript_cannot_hold_exactly_stops_debug_builds() {
    let at_limit = scoped("x", || html! { <p on:click={shared::log("id", 9_007_199_254_740_991u64, true)}></p> }.to_html());
    assert!(at_limit.contains("9007199254740991"), "{at_limit}");
    scoped("x", || html! { <p on:click={shared::log("id", 9_007_199_254_740_993u64, true)}></p> }.to_html());
}
