use super::*;

/// A page with a field's hint, drawn and named as `case` says, under `corten dev`.
fn hinted(case: &'static str) -> Router {
    use crate::form::HintId;
    let page = move |req: Req| async move {
        let f = SignUp::FIELDS;
        let errors = Errors::new();
        let e = &errors.within(SignUpId);
        let id = e.id(f.email);
        let body: Box<dyn Render + '_> = match case {
            "named" => Box::new(html! {
                <input id={QtyId} aria-describedby={HintId(&QtyId)}>
                <p id={HintId(&QtyId)}>"From 1 to 5."</p>
            }),
            "control" => Box::new(html! {
                <input {..e.control(f.email).hint()}>
                <p id={HintId(&id)}>"Where we send the receipt."</p>
            }),
            "empty" => Box::new(html! {
                <input id={QtyId}>
                <p id={HintId(&QtyId)}></p>
            }),
            "empty, named" => Box::new(html! {
                <input {..e.control(f.email).hint()}>
                <p id={HintId(&id)}></p>
            }),
            "markup" => Box::new(html! {
                <input id={QtyId}>
                <p id={HintId(&QtyId)}><em>"From 1 to 5."</em></p>
            }),
            "aria" => Box::new(html! {
                <input id={id} {..e.aria(f.email).hint(&HintId(&id))}>
                <p id={HintId(&id)}>"Where we send the receipt."</p>
            }),
            "white space" => Box::new(html! {
                <input id={QtyId}>
                <p id={HintId(&QtyId)}>" "</p>
            }),
            "empty element" => Box::new(html! {
                <input id={QtyId}>
                <p id={HintId(&QtyId)}><span></span></p>
            }),
            "no control" => Box::new(html! {
                <fieldset>
                    <legend>"Size"</legend>
                    <p id={HintId(&QtyId)}>"Pick one."</p>
                </fieldset>
            }),
            "rendered" => Box::new(req.rendered(html! {
                <input id={QtyId}>
                <p id={HintId(&QtyId)}>"From 1 to 5."</p>
            })),
            _ => Box::new(html! {
                <input {..e.control(f.email)}>
                <p id={HintId(&id)}>"Where we send the receipt."</p>
            }),
        };
        req.test_page("Hints", body)
    };
    // A patch that redraws a hint alone, its control on the page; a row with both, unnamed.
    let patch = move |req: Req| async move {
        let answer: HtmlResult = if case == "hint alone" {
            req.action().ok_or_else(crate::Error::not_found)?.patch(html! { <p id={HintId(&QtyId)}>"3 left."</p> })
        } else {
            req.action().ok_or_else(crate::Error::not_found)?.patch(html! {
                <div id={QtyRowId}>
                    <input id={QtyId}>
                    <p id={HintId(&QtyId)}>"From 1 to 5."</p>
                </div>
            })
        };
        answer
    };
    App::new(Routes::from(Table::new().route("/", get(page)).route("/patch", get(patch))))
        .dev(true)
        .error_page(test_error_page, ())
        .router()
}

#[derive(crate::view::Id)]
struct QtyRowId;

/// A hint with text that the control it describes does not name is never read by a screen reader:
/// a debug build's page or patch says so, also for a hint drawn ahead (`req.rendered`). A hint
/// with no text describes nothing, named or not. A page that draws no element for a hint (a radio
/// group with no id) is an error too; a patch of the hint alone, its control on the page, is not.
#[tokio::test]
async fn a_hint_with_text_that_no_control_names_is_an_error_in_a_debug_build() {
    for case in ["named", "control", "empty", "empty, named", "aria", "white space", "empty element"] {
        let (status, _, body) = call(hinted(case), "GET", None).await;
        assert_eq!(status, 200, "{case}: {body}");
    }
    // Its control is on the page already, which the patch does not hold.
    let (status, _, body) = call_with(hinted("hint alone"), "GET", "/patch", Some("action"), None).await;
    assert_eq!(status, 200, "hint alone: {body}");
    for (case, path) in [("unnamed", "/"), ("markup", "/"), ("rendered", "/"), ("no control", "/"), ("row", "/patch")] {
        let mode = (path == "/patch").then_some("action");
        let (status, _, body) = call_with(hinted(case), "GET", path, mode, None).await;
        if cfg!(debug_assertions) {
            assert_eq!(status, 500, "{case}: {body}");
            assert!(body.contains("which has text, and the element it describes does not name it"), "{case}: {body}");
        } else {
            assert_eq!(status, 200, "{case}: {body}");
        }
    }
}

/// A form's submit key with no value (`SubmitKey::template_field`) is for the copies a script
/// makes of a `<template>`: drawn outside one, a browser without JavaScript sends it empty and
/// every post is refused, so a debug build's page says so, also for one drawn ahead
/// (`req.rendered`). Inside a template, nested too or drawn ahead, it is not an error, and neither
/// is it in a patch: only the runtime asks for one, and it fills the key when the form is sent.
#[tokio::test]
async fn a_submit_key_with_no_value_outside_a_template_is_an_error_in_a_debug_build() {
    fn keys(case: &'static str) -> Router {
        let field = || crate::SubmitKey::template_field(KeyedWrite::FIELDS.submit);
        let page = move |req: Req| async move {
            let form = || html! { <form method="post">{field()}</form> };
            let row = || html! { <template><p>"row"</p></template> };
            match case {
                "template" => req.test_page("Keys", html! { <template>{form()}</template> }),
                "nested" => req.test_page("Keys", html! { <template><div><template>{form()}</template></div></template> }),
                "after" => req.test_page("Keys", html! { {row()}{form()} }),
                "rendered" => {
                    let drawn = req.rendered(form());
                    let placed = &drawn;
                    req.test_page("Keys", html! { {placed} })
                }
                "rendered-template" => {
                    let drawn = req.rendered(form());
                    let placed = &drawn;
                    req.test_page("Keys", html! { <template>{placed}</template> })
                }
                _ => req.test_page("Keys", form()),
            }
        };
        let patch = move |req: Req| async move {
            let answer: HtmlResult = req
                .action()
                .ok_or_else(crate::Error::not_found)?
                .patch(html! { <form id={MsgId} method="post">{field()}</form> });
            answer
        };
        App::new(Routes::from(Table::new().route("/", get(page)).route("/patch", get(patch))))
            .dev(true)
            .error_page(test_error_page, ())
            .router()
    }
    for case in ["template", "nested", "rendered-template"] {
        let (status, _, body) = call(keys(case), "GET", None).await;
        assert_eq!(status, 200, "{case}: {body}");
        assert!(body.contains(r#"<input type="hidden" name="submit" data-submit>"#), "{case}: {body}");
    }
    let (status, _, body) = call_with(keys("form"), "GET", "/patch", Some("action"), None).await;
    assert_eq!(status, 200, "patch: {body}");
    for case in ["form", "after", "rendered"] {
        let (status, _, body) = call(keys(case), "GET", None).await;
        if cfg!(debug_assertions) {
            assert_eq!(status, 500, "{case}: {body}");
            assert!(body.contains("so a browser without JavaScript sends it empty"), "{case}: {body}");
        } else {
            assert_eq!(status, 200, "{case}: {body}");
        }
    }
}

#[derive(crate::view::Id)]
struct SignUpId;

#[derive(crate::view::Id)]
struct LookUpFormId;

/// A form with no `Errors`, its `e` made before `html!` and borrowed by the view it returns.
#[crate::component]
fn LookUpForm() -> impl crate::Patch {
    let f = SignUp::FIELDS;
    let e = Within::none(LookUpFormId);
    html! {
        <form id={LookUpFormId}>
            <label for={e.id(f.email)}>"Email"</label>
            <input required {..e.control(f.email)}>
            {e.message(f.email)}
        </form>
    }
}

#[test]
fn a_form_with_no_errors_names_its_fields_from_its_id() {
    assert_eq!(
        LookUpForm {}.to_html(),
        r#"<form id="look-up-form"><label for="look-up-form-email">Email</label><input required id="look-up-form-email" name="email"></form>"#
    );
}

fn alert_form(errors: &Errors) -> impl crate::Patch + '_ {
    let f = SignUp::FIELDS;
    let e = errors.within(SignUpId);
    html! { <form id={SignUpId}><input name={f.email} {..e.aria(f.email)}>{e.message(f.email)}</form> }
}

fn invalid_routes() -> Table {
    Table::new().route(
        "/",
        get(|req: Req| async move {
            let mut errors = Errors::new();
            errors.add(SignUp::FIELDS.email, "Enter an email address.");
            let page = || async { req.test_page("Alert", html! { <p>"page with errors"</p> }) };
            req.invalid::<ForOne, AnyAnswer, _, _>(&errors, alert_form(&errors), page).await
        }),
    )
}

fn sheet_form(errors: &Errors) -> impl crate::Patch + '_ {
    html! { <form id={SignUpId}>{errors.form_message()}</form> }
}

fn refused_routes() -> Table {
    refused_by(crate::Refusal::Conflict, "Someone saved first.")
}

fn refused_by(why: crate::Refusal, message: &'static str) -> Table {
    Table::new().route(
        "/",
        get(move |req: Req| async move {
            let mut errors = Errors::new();
            errors.refuse(why, message);
            let page = || async { req.test_page("Sheet", html! { <p>"page with the refusal"</p> }) };
            req.invalid::<ForOne, AnyAnswer, _, _>(&errors, sheet_form(&errors), page).await
        }),
    )
}

#[tokio::test]
async fn a_stale_submit_answers_409_with_the_form_message_in_each_mode() {
    let (status, headers, body) = call(app(refused_routes(), None), "GET", Some("action")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(headers["corten-patch"], "1");
    assert_eq!(body, r#"<form id="sign-up"><p class="form-error" role="alert">Someone saved first.</p></form>"#);

    let (status, _, body) = call(app(refused_routes(), None), "GET", None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body.contains("<p>page with the refusal</p>") && body.contains("<html"), "no JavaScript: the whole page");

    #[cfg(feature = "json")]
    {
        let (status, _, body) = call_with(app(refused_routes(), None), "GET", "/", None, Some("application/json")).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            body,
            r#"{"title":"Conflict","status":409,"detail":"Someone saved first.","form":"Someone saved first.","fields":{}}"#
        );
    }
}

#[tokio::test]
async fn a_failed_service_answers_502_with_the_form_message_in_each_mode() {
    let routes = || refused_by(crate::Refusal::Upstream, "The carrier did not answer. Try again.");
    let (status, headers, body) = call(app(routes(), None), "GET", Some("action")).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(headers["corten-patch"], "1", "the form, not the error page");
    assert_eq!(
        body,
        r#"<form id="sign-up"><p class="form-error" role="alert">The carrier did not answer. Try again.</p></form>"#
    );

    let (status, _, body) = call(app(routes(), None), "GET", None).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(
        body.contains("<p>page with the refusal</p>") && body.contains("<html"),
        "no JavaScript: the whole page, not the error page: {body}"
    );

    #[cfg(feature = "json")]
    {
        let (status, headers, body) = call_with(app(routes(), None), "GET", "/", None, Some("application/json")).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(headers["content-type"], "application/problem+json");
        assert_eq!(
            body,
            r#"{"title":"Bad Gateway","status":502,"detail":"The carrier did not answer. Try again.","form":"The carrier did not answer. Try again.","fields":{}}"#
        );
    }
}

/// A price basis picked from radios drawn with none checked.
#[derive(Clone, Copy, Debug, PartialEq, crate::UrlValue)]
#[serde(rename_all = "snake_case")]
enum Basis {
    Observed,
    Manual,
}

/// Radios drawn with none checked send nothing until the user picks one, so the field is an
/// `Option` of its enum.
#[derive(crate::Fields)]
struct PricingInput {
    basis: Option<Basis>,
}

#[derive(crate::view::Id)]
struct PricingId;

#[crate::routes]
mod url_pricing {
    #[route("/pricing", get = pricing_page, post = set_pricing)]
    pub struct Pricing;
}

fn pricing_form(errors: &Errors) -> impl crate::Patch + '_ {
    let f = PricingInput::FIELDS;
    let e = errors.within(PricingId);
    html! {
        <form id={PricingId} method="post">
            <div role="radiogroup" aria-label="Price basis" {..e.aria(f.basis)}>
                <label><input type="radio" name={f.basis} value={Basis::Observed} required>"Observed"</label>
                <label><input type="radio" name={f.basis} value={Basis::Manual} required>"Manual"</label>
            </div>
            {e.message(f.basis)}
        </form>
    }
}

async fn pricing_page(req: Req) -> HtmlResult {
    req.test_page("Pricing", pricing_form(&Errors::new()))
}

async fn set_pricing(req: Req, Form(input): Form<PricingInput>) -> HtmlResult {
    let Some(basis) = input.basis else {
        let mut errors = Errors::new();
        errors.add(PricingInput::FIELDS.basis, "Choose observed or manual.");
        let page = || async { req.test_page("Pricing", pricing_form(&errors)) };
        return req.invalid(&errors, pricing_form(&errors), page).await;
    };
    req.test_page("Priced", html! { <p>{basis.to_string()}</p> })
}

/// A choice left unpicked is `None`, and the handler's message for it reaches a browser without
/// JavaScript as the whole page drawn again with the message on the group, a 422 and not the
/// error page (#1413). A word no page offers is still refused before the handler runs.
#[tokio::test]
async fn a_missing_radio_choice_redraws_the_page_with_its_message_without_javascript() {
    let app = App::new(url_pricing::router()).test();
    let f = PricingInput::FIELDS;
    let none_checked = app.post(&url_pricing::Pricing).await;
    let blank = app.post(&url_pricing::Pricing).field(f.basis.untyped(), "").await;
    for missing in [none_checked, blank] {
        assert_eq!(missing.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let page = missing.text();
        assert!(page.contains("<title>Pricing</title>"), "the page, not the error page: {page}");
        assert!(page.contains(r#"<p class="field-error" id="pricing-basis-error">Choose observed or manual.</p>"#), "{page}");
        assert!(page.contains(r#"aria-invalid="true" aria-describedby="pricing-basis-error""#), "{page}");
    }
    let picked = app.post(&url_pricing::Pricing).field(f.basis, Basis::Manual).await;
    assert_eq!(picked.status(), StatusCode::OK);
    assert!(picked.text().contains("<p>manual</p>"), "{}", picked.text());
    let forged = app.post(&url_pricing::Pricing).field(f.basis.untyped(), "guessed").await;
    assert_eq!(forged.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert!(!forged.text().contains("<title>Pricing</title>"), "the extractor's refusal: {}", forged.text());
}

/// A refusal whose form needs a read, drawn per mode: `reads` counts the form side's reads and
/// `pages` the page side's runs.
fn lazily_refused_routes(
    reads: std::sync::Arc<std::sync::atomic::AtomicU32>,
    pages: std::sync::Arc<std::sync::atomic::AtomicU32>,
) -> Table {
    Table::new().route(
        "/",
        get(move |req: Req| async move {
            let mut errors = Errors::new();
            errors.refuse(crate::Refusal::Conflict, "Someone saved first.");
            let page = || async {
                pages.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                req.test_page("Sheet", html! { <p>"page with the refusal"</p> })
            };
            // Written in the call, as an app does: the closure's type comes from `invalid_with`.
            let shown = &errors;
            req.invalid_with::<ForOne, AnyAnswer, _, _, _, _>(
                &errors,
                |form| async {
                    reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    form.draw(html! { <form id={SignUpId}>{shown.form_message()}"read now"</form> })
                },
                page,
            )
            .await
        }),
    )
}

#[tokio::test]
async fn a_refusal_whose_form_needs_a_read_reads_only_for_the_patch() {
    use std::sync::atomic::Ordering::Relaxed;
    use std::sync::{atomic::AtomicU32, Arc};
    let (reads, pages) = (Arc::new(AtomicU32::new(0)), Arc::new(AtomicU32::new(0)));
    let routes = || lazily_refused_routes(reads.clone(), pages.clone());
    let (status, headers, body) = call(app(routes(), None), "GET", Some("action")).await;
    assert_eq!((status, &headers["corten-patch"]), (StatusCode::CONFLICT, &"1".parse().unwrap()));
    assert!(
        body.starts_with(r#"<form id="sign-up">"#) && body.contains("Someone saved first.") && body.ends_with("read now</form>"),
        "{body}"
    );
    assert_eq!((reads.load(Relaxed), pages.load(Relaxed)), (1, 0), "an action draws only the patch");

    let (status, _, body) = call(app(routes(), None), "GET", None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body.contains("<p>page with the refusal</p>"), "no JavaScript: the whole page");
    assert_eq!((reads.load(Relaxed), pages.load(Relaxed)), (1, 1), "the page reads nothing for the patch");

    let (status, _, _) = call(app(routes(), None), "GET", Some("nav")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!((reads.load(Relaxed), pages.load(Relaxed)), (1, 2), "a navigation gets the page");

    #[cfg(feature = "json")]
    {
        let (status, _, body) = call_with(app(routes(), None), "GET", "/", None, Some("application/json")).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(body.contains(r#""status":409"#), "{body}");
        assert_eq!((reads.load(Relaxed), pages.load(Relaxed)), (1, 2), "a data client runs neither side");
    }
}
#[tokio::test]
async fn invalid_input_answers_422_in_each_mode() {
    let (status, headers, body) = call(app(invalid_routes(), None), "GET", Some("action")).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(headers["corten-patch"], "1");
    assert_eq!(
        body,
        r#"<form id="sign-up"><input name="email" aria-invalid="true" aria-describedby="sign-up-email-error"><p class="field-error" id="sign-up-email-error">Enter an email address.</p></form>"#
    );

    let (status, _, body) = call(app(invalid_routes(), None), "GET", None).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body.contains("<p>page with errors</p>") && body.contains("<html"), "no JavaScript: the whole page");

    #[cfg(feature = "json")]
    {
        let (status, _, body) = call_with(app(invalid_routes(), None), "GET", "/", None, Some("application/json")).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            body,
            r#"{"title":"Unprocessable Entity","status":422,"detail":"email: Enter an email address.","fields":{"email":"Enter an email address."}}"#
        );
    }
}

#[derive(Fields)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
pub(crate) struct Shipping {
    pub street_line: String,
    postal_code: Option<Vec<(u8, String)>>,
    r#type: std::collections::HashMap<String, Vec<(u8, bool)>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, crate::UrlValue)]
#[serde(rename_all = "kebab-case")]
enum Domain {
    SellerPortal,
    Catalog,
}

#[derive(Debug, PartialEq, Fields)]
struct Address {
    street: String,
    zip: Option<u32>,
}

#[derive(Debug, PartialEq, Fields)]
struct DomainLimits {
    max_concurrent: u32,
    #[serde(default)]
    adaptive: bool,
    #[fields(group)]
    contact: Address,
}

#[derive(Debug, PartialEq, Fields)]
struct Limits {
    name: String,
    #[fields(group)]
    ship_from: Address,
    #[fields(group)]
    ship_to: Address,
    #[fields(rows)]
    #[serde(default)]
    domains: std::collections::BTreeMap<Domain, DomainLimits>,
}

#[derive(crate::view::Id)]
struct LimitsFormId;

/// A group's fields are named under it and a row's under its key, so two groups of one type
/// and every row read into their own values, and each row's field has its own message.
#[test]
fn groups_and_rows_name_each_field_and_read_back_by_key() {
    let f = Limits::FIELDS;
    assert_eq!(f.name.to_string(), "name");
    assert_eq!(f.ship_to.street.to_string(), "ship_to.street");
    let portal = f.domains.at(&Domain::SellerPortal);
    assert_eq!(portal.max_concurrent.to_string(), "domains[seller-portal].max_concurrent");
    assert_eq!(portal.contact.zip.to_string(), "domains[seller-portal].contact.zip");
    let keyed = Limits2::FIELDS.lines.at(&"a b]\"c".to_string()).qty.to_string();
    assert_eq!(keyed, "lines[a%20b%5D%22c].qty");

    // Out of order, a row with its checkbox unchecked, the catalog row's zip blank.
    let body = "domains%5Bcatalog%5D.max_concurrent=4&ship_to.street=2+Elm&name=Main\
        &domains%5Bseller-portal%5D.adaptive=on&domains%5Bseller-portal%5D.contact.street=1+Oak\
        &ship_from.street=9+Ash&domains%5Bcatalog%5D.contact.street=3+Pine&ship_from.zip=55401\
        &domains%5Bseller-portal%5D.max_concurrent=2&domains%5Bcatalog%5D.contact.zip=&ship_to.zip=";
    let form: Limits = crate::form::from_bytes(body.as_bytes()).expect("reads");
    assert_eq!(form.name, "Main");
    assert_eq!(form.ship_from, Address { street: "9 Ash".into(), zip: Some(55401) });
    assert_eq!(form.ship_to, Address { street: "2 Elm".into(), zip: None });
    assert_eq!(
        form.domains[&Domain::SellerPortal],
        DomainLimits { max_concurrent: 2, adaptive: true, contact: Address { street: "1 Oak".into(), zip: None } }
    );
    assert_eq!(
        form.domains[&Domain::Catalog],
        DomainLimits { max_concurrent: 4, adaptive: false, contact: Address { street: "3 Pine".into(), zip: None } }
    );
    let keyed: Limits2 = crate::form::from_bytes(b"lines%5Ba%2520b%255D%2522c%5D.qty=3").expect("reads");
    assert_eq!(keyed.lines["a b]\"c"].qty, 3);

    // A row left out reads no row; nothing shifts.
    let one: Limits = crate::form::from_bytes(
        b"name=x&ship_from.street=a&ship_to.street=b&domains%5Bcatalog%5D.max_concurrent=1&domains%5Bcatalog%5D.contact.street=c",
    )
    .expect("reads");
    assert_eq!(one.domains.keys().collect::<Vec<_>>(), [&Domain::Catalog]);

    // Mistakes name the field as posted.
    let err = |body: &str| crate::form::from_bytes::<Limits>(body.as_bytes()).unwrap_err().to_string();
    let base = "name=x&ship_from.street=a&ship_to.street=b";
    assert_eq!(err("name=x&ship_to.street=b"), "missing field `ship_from`");
    assert_eq!(err("name=x&ship_from.zip=1&ship_to.street=b"), "ship_from: missing field `street`");
    assert!(
        err(&format!("{base}&domains%5Bcatalog%5D.max_concurrent=x&domains%5Bcatalog%5D.contact.street=c"))
            .starts_with("domains[catalog].max_concurrent: invalid"),
        "{}",
        err(&format!("{base}&domains%5Bcatalog%5D.max_concurrent=x&domains%5Bcatalog%5D.contact.street=c"))
    );
    assert!(
        err(&format!("{base}&domains%5Bnope%5D.max_concurrent=1")).starts_with("domains[nope]: key: unknown variant `nope`"),
        "{}",
        err(&format!("{base}&domains%5Bnope%5D.max_concurrent=1"))
    );

    // An error on one row marks that row's input only, with its own message id.
    let mut errors = Errors::new();
    errors.add(f.domains.at(&Domain::SellerPortal).max_concurrent, "At least 1.");
    errors.add(f.domains.at(&Domain::SellerPortal).max_concurrent, "dropped: the field has one");
    errors.add(f.domains.at(&Domain::Catalog).max_concurrent, "At most 8.");
    let e = &errors.within(LimitsFormId);
    let row = |d: Domain| {
        let field = f.domains.at(&d).max_concurrent;
        html! { <input name={field} {..e.aria(field)}>{e.message(field)} }.to_html()
    };
    assert_eq!(
        row(Domain::SellerPortal),
        r#"<input name="domains[seller-portal].max_concurrent" aria-invalid="true" aria-describedby="limits-form-domains[seller-portal].max_concurrent-error"><p class="field-error" id="limits-form-domains[seller-portal].max_concurrent-error">At least 1.</p>"#
    );
    assert!(row(Domain::Catalog).contains("At most 8."));
    assert!(!errors.has(f.domains.at(&Domain::SellerPortal).contact.street));
    assert_eq!(
        errors.to_string(),
        "domains[seller-portal].max_concurrent: At least 1.; domains[catalog].max_concurrent: At most 8."
    );
}

#[derive(Debug, Fields)]
struct Line {
    qty: u32,
}

#[derive(Debug, Fields)]
struct Limits2 {
    #[fields(rows)]
    #[serde(default)]
    lines: std::collections::BTreeMap<String, Line>,
}

#[derive(Debug, Fields)]
struct Numbered {
    #[fields(rows)]
    #[serde(default)]
    lines: std::collections::BTreeMap<u32, Line>,
}

#[derive(Debug, Fields)]
struct Counts {
    note: String,
    #[fields(map)]
    #[serde(default)]
    counts: std::collections::BTreeMap<u32, u32>,
}

/// One plain value per key (a count per SKU) is `map[key]`, read back by key, each with its own
/// error.
#[test]
fn a_map_names_each_keys_value() {
    let f = Counts::FIELDS;
    assert_eq!(f.counts.at(&7).to_string(), "counts[7]");
    let read: Counts = crate::form::from_bytes(b"counts%5B7%5D=3&note=x&counts%5B12%5D=0").expect("reads");
    assert_eq!(read.counts.into_iter().collect::<Vec<_>>(), [(7, 3), (12, 0)]);
    let err = crate::form::from_bytes::<Counts>(b"note=x&counts%5B7%5D=many").unwrap_err().to_string();
    assert!(err.starts_with("counts[7]: invalid value"), "{err}");
    let none: Counts = crate::form::from_bytes(b"note=x").expect("no keys: an empty map");
    assert!(none.counts.is_empty() && none.note == "x");

    let mut errors = Errors::new();
    errors.add(f.counts.at(&7), "Not that many.");
    let e = errors.within(LimitsFormId);
    let field = f.counts.at(&7);
    assert_eq!(
        html! { <input name={field} {..e.aria(field)}> }.to_html(),
        r#"<input name="counts[7]" aria-invalid="true" aria-describedby="limits-form-counts[7]-error">"#
    );
    assert!(!errors.has(f.counts.at(&12)));
}

#[derive(Debug, Fields)]
struct Search {
    q: String,
    go: Option<String>,
}

#[derive(Debug, Fields)]
struct Moded {
    q: String,
    #[serde(rename = "q-mode")]
    mode: String,
}

/// What a client sends is not trusted: a key sent another way than the form writes it is
/// refused, stray `x.y` keys beside a field sent as `x` are left alone, and many rows' errors
/// cost each row its own lookup.
#[test]
fn rows_read_only_their_own_keys_and_scale_with_their_count() {
    // `a` as `%61`, lowercase hex, a character the form would encode: each refused.
    for key in ["%2561", "a%252cb", "a.b"] {
        let body = format!("lines%5B{key}%5D.qty=1");
        let err = crate::form::from_bytes::<Limits2>(body.as_bytes()).unwrap_err().to_string();
        assert!(err.contains("the row's key is not"), "{key}: {err}");
    }
    let read: Limits2 = crate::form::from_bytes(b"lines%5Ba%252Cb%5D.qty=1").expect("the form's own encoding");
    assert_eq!(read.lines["a,b"].qty, 1);

    // An image button (`go.x`, `go.y`) and a stray `q.x` beside `q`: read as a plain form was.
    let search: Search = crate::form::from_bytes(b"q=cards&q.x=1&go.x=3&go.y=4").expect("reads");
    assert_eq!((search.q.as_str(), search.go), ("cards", None));
    // A key between `q` and `q.x` (`q-mode`) does not make `q.x` a group.
    let moded: Moded = crate::form::from_bytes(b"q=a&q-mode=b&q.x=1").expect("q is sent as itself");
    assert_eq!((moded.q.as_str(), moded.mode.as_str()), ("a", "b"));

    // An integer key is read only as it is written, so one row cannot be sent two ways.
    for key in ["07", "%2B7", "-0"] {
        let body = format!("lines%5B{key}%5D.qty=1");
        let err = crate::form::from_bytes::<Numbered>(body.as_bytes()).unwrap_err().to_string();
        assert!(err.contains("as the form writes it") || err.contains("the way the form writes it"), "{key}: {err}");
    }

    // Integer keys, written without allocating, and each row's errors found by its key.
    let f = Numbered::FIELDS;
    assert_eq!(f.lines.at(&7).qty.to_string(), "lines[7].qty");
    let read: Numbered = crate::form::from_bytes(b"lines%5B7%5D.qty=2&lines%5B12%5D.qty=5").expect("reads");
    assert_eq!((read.lines[&7].qty, read.lines[&12].qty), (2, 5));
    let mut errors = Errors::new();
    for row in 0..20_000u32 {
        errors.add(f.lines.at(&row).qty, "Too many.");
        errors.add(f.lines.at(&row).qty, "dropped: the row has one");
    }
    assert_eq!(errors.len(), 20_000);
    assert_eq!(errors.get(f.lines.at(&19_999).qty), Some("Too many."));
    assert!(!errors.has(f.lines.at(&20_000).qty));
    assert!(errors.iter().next().is_some_and(|(name, _)| name == "lines[0].qty"));

    // A group in a row: its own message id, and its key in the JSON clients get.
    let mut errors = Errors::new();
    let zip = Limits::FIELDS.domains.at(&Domain::SellerPortal).contact.zip;
    errors.add(zip, "Five digits.");
    let e = errors.within(LimitsFormId);
    assert_eq!(
        html! { {e.message(zip)} }.to_html(),
        r#"<p class="field-error" id="limits-form-domains[seller-portal].contact.zip-error">Five digits.</p>"#
    );
    #[cfg(feature = "json")]
    assert_eq!(serde_json::to_string(&errors).unwrap(), r#"{"domains[seller-portal].contact.zip":"Five digits."}"#);
}

#[derive(Debug, PartialEq, Fields)]
struct Serial {
    code: String,
}

#[derive(Debug, PartialEq, Fields)]
struct Part {
    qty: u32,
    #[fields(group)]
    ship_to: Address,
    #[fields(rows)]
    #[serde(default)]
    serials: std::collections::BTreeMap<u32, Serial>,
}

#[derive(Debug, PartialEq, Fields)]
struct OrderLine {
    sku: String,
    #[fields(rows)]
    #[serde(default)]
    parts: std::collections::BTreeMap<String, Part>,
    #[fields(map)]
    #[serde(default)]
    counts: std::collections::BTreeMap<u32, u32>,
}

#[derive(Debug, PartialEq, Fields)]
struct Order {
    #[fields(rows)]
    #[serde(default)]
    lines: std::collections::BTreeMap<u32, OrderLine>,
}

/// A row holds rows (and a map, and a group in an inner row): each field is named through every
/// row it is in, read back into the nested maps, and has its own message.
#[test]
fn rows_in_rows_name_each_field_through_its_rows() {
    let f = Order::FIELDS;
    let key = "a b".to_string();
    let part = f.lines.at(&7).parts.at(&key);
    assert_eq!(f.lines.at(&7).sku.to_string(), "lines[7].sku");
    assert_eq!(part.qty.to_string(), "lines[7].parts[a%20b].qty");
    assert_eq!(part.ship_to.zip.to_string(), "lines[7].parts[a%20b].ship_to.zip");
    assert_eq!(part.serials.at(&3).code.to_string(), "lines[7].parts[a%20b].serials[3].code");
    assert_eq!(f.lines.at(&7).counts.at(&2).to_string(), "lines[7].counts[2]");
    assert!(part.serials.at(&3).code == "lines[7].parts[a%20b].serials[3].code");
    assert_eq!(part.qty, f.lines.at(&7).parts.at(&key).qty);
    assert_ne!(part.qty, f.lines.at(&8).parts.at(&key).qty);
    assert_ne!(part.qty, f.lines.at(&7).parts.at(&"a".to_string()).qty);

    let body = "lines%5B7%5D.sku=X&lines%5B7%5D.parts%5Ba%2520b%5D.qty=2&lines%5B7%5D.parts%5Ba%2520b%5D.ship_to.street=Elm\
        &lines%5B7%5D.parts%5Ba%2520b%5D.serials%5B3%5D.code=S3&lines%5B7%5D.parts%5Ba%2520b%5D.serials%5B1%5D.code=S1\
        &lines%5B7%5D.parts%5Bc%5D.qty=1&lines%5B7%5D.parts%5Bc%5D.ship_to.street=Oak&lines%5B7%5D.counts%5B2%5D=5\
        &lines%5B9%5D.sku=Y";
    let order: Order = crate::form::from_bytes(body.as_bytes()).expect("reads");
    let line = &order.lines[&7];
    assert_eq!((line.sku.as_str(), line.counts[&2]), ("X", 5));
    let part = &line.parts["a b"];
    assert_eq!((part.qty, part.ship_to.street.as_str()), (2, "Elm"));
    assert_eq!(part.serials.iter().map(|(k, s)| (*k, s.code.as_str())).collect::<Vec<_>>(), [(1, "S1"), (3, "S3")]);
    assert_eq!(line.parts["c"].qty, 1);
    assert!(order.lines[&9].parts.is_empty() && order.lines[&9].counts.is_empty());
    let err = crate::form::from_bytes::<Order>(
        b"lines%5B7%5D.sku=X&lines%5B7%5D.parts%5Bc%5D.qty=x&lines%5B7%5D.parts%5Bc%5D.ship_to.street=a",
    )
    .unwrap_err()
    .to_string();
    assert!(err.starts_with("lines[7].parts[c].qty: invalid"), "{err}");
    let err = crate::form::from_bytes::<Order>(b"lines%5B7%5D.sku=X&lines%5B7%5D.parts%5Bc%5D.serials%5Bx%5D.code=a")
        .unwrap_err()
        .to_string();
    assert!(err.starts_with("lines[7].parts[c].serials[x]: key: "), "{err}");

    // A message marks that one field: not the same field of another inner or outer row.
    let deep = f.lines.at(&7).parts.at(&key).serials.at(&3).code;
    let mut errors = Errors::new();
    errors.add(deep, "Unknown serial.");
    errors.add(f.lines.at(&7).parts.at(&key).ship_to.zip, "Five digits.");
    errors.add(f.lines.at(&7).counts.at(&2), "Too many.");
    assert!(errors.has(deep) && errors.has(f.lines.at(&7).counts.at(&2)));
    assert!(!errors.has(f.lines.at(&7).parts.at(&key).serials.at(&1).code));
    assert!(!errors.has(f.lines.at(&8).parts.at(&key).serials.at(&3).code));
    assert!(!errors.has(f.lines.at(&7).parts.at(&"c".to_string()).serials.at(&3).code));
    assert!(!errors.has(f.lines.at(&7).parts.at(&key).ship_to.street));
    assert!(!errors.has(f.lines.at(&7).sku));
    assert_eq!(errors.get(deep), Some("Unknown serial."));
    assert!(errors.iter().next().is_some_and(|(name, _)| name == deep && name == "lines[7].parts[a%20b].serials[3].code"));
    let e = errors.within(LimitsFormId);
    assert_eq!(
        html! { <input name={deep} {..e.aria(deep)}> }.to_html(),
        r#"<input name="lines[7].parts[a%20b].serials[3].code" aria-invalid="true" aria-describedby="limits-form-lines[7].parts[a%20b].serials[3].code-error">"#
    );
    assert_eq!(
        errors.to_string(),
        "lines[7].parts[a%20b].serials[3].code: Unknown serial.; lines[7].parts[a%20b].ship_to.zip: Five digits.; lines[7].counts[2]: Too many."
    );
    #[cfg(feature = "json")]
    assert_eq!(
        serde_json::to_string(&errors).unwrap(),
        r#"{"lines[7].parts[a%20b].serials[3].code":"Unknown serial.","lines[7].parts[a%20b].ship_to.zip":"Five digits.","lines[7].counts[2]":"Too many."}"#
    );
}

#[derive(Debug, PartialEq, Fields)]
struct Condition {
    kind: String,
}

#[derive(Debug, PartialEq, Fields)]
struct Rule {
    #[fields(rows)]
    #[serde(default)]
    conditions: std::collections::BTreeMap<u32, Condition>,
}

#[derive(Debug, PartialEq, Fields)]
struct Rules {
    #[fields(rows)]
    #[serde(default)]
    rules: std::collections::BTreeMap<u32, Rule>,
}

/// Many rows in one row find their messages as many rows of the form do: by their own entry of
/// the index, which holds that row's messages and no other's, so adding and finding each costs
/// about the same however many rows the row holds (a client can send tens of thousands).
#[test]
fn rows_in_one_row_find_their_errors_as_the_forms_own_rows_do() {
    let f = Rules::FIELDS;
    let mut errors = Errors::new();
    for row in 0..20_000u32 {
        errors.add(f.rules.at(&1).conditions.at(&row).kind, "Unknown condition.");
        errors.add(f.rules.at(&1).conditions.at(&row).kind, "dropped: the row has one");
    }
    assert_eq!(errors.len(), 20_000);
    assert_eq!(errors.most_in_a_row(), 1, "each inner row's message in an entry of its own");
    assert_eq!(errors.get(f.rules.at(&1).conditions.at(&19_999).kind), Some("Unknown condition."));
    assert!(!errors.has(f.rules.at(&1).conditions.at(&20_000).kind));
    // The same key in another outer row, and keys swapped between the two levels, are other rows.
    assert!(!errors.has(f.rules.at(&2).conditions.at(&7).kind));
    errors.add(f.rules.at(&7).conditions.at(&1).kind, "Swapped.");
    assert_eq!(errors.get(f.rules.at(&1).conditions.at(&7).kind), Some("Unknown condition."));
    assert_eq!(errors.get(f.rules.at(&7).conditions.at(&1).kind), Some("Swapped."));

    let mut outer = Errors::new();
    for row in 0..20_000u32 {
        outer.add(Numbered::FIELDS.lines.at(&row).qty, "Too many.");
    }
    assert_eq!(outer.most_in_a_row(), 1);
}

/// What adding `ROW_ERRORS` messages to rows costs (2,000 if unset): the form's own rows, or with
/// `ROW_ERRORS_IN=inner` rows in one row. Measured with callgrind on the release build, as
/// `what_reading_a_form_costs` is.
#[test]
fn what_row_errors_cost() {
    let count: u32 = std::env::var("ROW_ERRORS").ok().and_then(|n| n.parse().ok()).unwrap_or(2_000);
    let mut errors = Errors::new();
    if std::env::var("ROW_ERRORS_IN").as_deref() == Ok("inner") {
        let f = Rules::FIELDS;
        for row in 0..count {
            errors.add(std::hint::black_box(f.rules.at(&1).conditions.at(&row).kind), "Unknown condition.");
        }
    } else {
        let f = Numbered::FIELDS;
        for row in 0..count {
            errors.add(std::hint::black_box(f.lines.at(&row).qty), "Too many.");
        }
    }
    assert_eq!(std::hint::black_box(errors).len(), count as usize);
}

/// What redrawing a refused form with `ROW_DRAWS` of its own rows costs (2,000 if unset), each
/// row's field with a message: the lookups that find it (`has`, `get`, the control's ARIA) and
/// its name drawn through its row (`Row::render`). Measured with callgrind on the release build,
/// collecting in `draw_rows` alone (`--toggle-collect='*draw_rows*'`), against main.
#[test]
fn what_redrawing_rows_costs() {
    #[inline(never)]
    fn draw_rows(errors: &Errors, count: u32) -> (usize, String) {
        let f = Numbered::FIELDS;
        let e = errors.within(LimitsFormId);
        let found = (0..count).filter(|row| errors.has(f.lines.at(row).qty) && errors.get(f.lines.at(row).qty).is_some()).count();
        let drawn = html! {
            for row in 0..count {
                let qty = f.lines.at(&row).qty;
                <input {..e.control(qty)}>
                {e.message(qty)}
            }
        };
        (found, drawn.to_html())
    }
    let count: u32 = std::env::var("ROW_DRAWS").ok().and_then(|n| n.parse().ok()).unwrap_or(2_000);
    let mut errors = Errors::new();
    for row in 0..count {
        errors.add(Numbered::FIELDS.lines.at(&row).qty, "Too many.");
    }
    let (found, drawn) = draw_rows(std::hint::black_box(&errors), std::hint::black_box(count));
    assert_eq!(found, count as usize);
    assert_eq!(drawn.matches(r#"aria-invalid="true""#).count(), count as usize);
}

/// A form's input is a `FromJson` and an agent tool's input too: rows in a row are read from JSON
/// objects in objects, and the schema describes each level.
#[cfg(feature = "json")]
#[test]
fn rows_in_rows_read_from_json_as_from_a_form() {
    let rules: Rules =
        crate::json::from_str(r#"{"rules":{"1":{"conditions":{"0":{"kind":"price"},"4":{"kind":"stock"}}},"2":{}}}"#)
            .expect("reads");
    assert_eq!(rules.rules[&1].conditions[&0].kind, "price");
    assert_eq!(rules.rules[&1].conditions[&4].kind, "stock");
    assert!(rules.rules[&2].conditions.is_empty());
    #[cfg(feature = "types")]
    {
        let schema = crate::json::schema::Generator::root_for_read::<Rules>();
        assert_eq!(
            schema["properties"]["rules"]["additionalProperties"],
            serde_json::json!({ "$ref": "#/$defs/Rule" }),
            "{schema}"
        );
        assert_eq!(
            schema["$defs"]["Rule"]["properties"]["conditions"]["additionalProperties"],
            serde_json::json!({ "$ref": "#/$defs/Condition" }),
            "{schema}"
        );
        assert_eq!(schema["$defs"]["Condition"]["properties"]["kind"], serde_json::json!({ "type": "string" }), "{schema}");
    }
}

#[test]
fn field_names_follow_serde_and_reach_markup() {
    assert_eq!((SignUp::FIELDS.email.as_str(), SignUp::FIELDS.password.as_str()), ("email", "pw"));
    let f = Shipping::FIELDS;
    assert_eq!((f.street_line.as_str(), f.postal_code.as_str(), f.r#type.as_str()), ("streetLine", "postalCode", "type"));
    let mut errors = Errors::new();
    errors.add(SignUp::FIELDS.email, "Enter an email address.");
    let f = SignUp::FIELDS;
    let e = errors.within(SignUpId);
    let html = html! { <input name={f.email} {..e.aria(f.email)}> }.to_html();
    assert_eq!(html, r#"<input name="email" aria-invalid="true" aria-describedby="sign-up-email-error">"#);
    // A hint of its own: one aria-describedby naming the hint, then the error. The hint's id is a
    // temporary, which lives as long as the spread renders.
    let field = String::from("email");
    let e = errors.within(SignUpId);
    let html = html! { <input name={f.email} {..e.aria(f.email).hint(&FieldHintId(&field))}> }.to_html();
    assert_eq!(html, r#"<input name="email" aria-invalid="true" aria-describedby="field-hint-email sign-up-email-error">"#);
}

#[derive(crate::view::Id)]
struct FieldHintId<'a>(&'a str);

/// `App::client_zone` asks the runtime for the browser's time zone, and `Option<ClientZone>` reads
/// it: a name the browser could write, otherwise `None`. Taking it without the setting is a 500 in
/// a debug build.
#[tokio::test]
async fn a_handler_reads_the_visitors_time_zone_once_the_app_asks_for_it() {
    use crate::ClientZone;
    let routes = || {
        Routes::from(
            Table::new().route("/", get(|req: Req| async move { req.test_page("Home", html! { <p>"home"</p> }) })).route(
                "/zone",
                get(|zone: Option<ClientZone>| async move { zone.map_or_else(|| "none".to_string(), |ClientZone(zone)| zone) }),
            )
            .route(
                "/zone-page",
                get(|req: Req, zone: Option<ClientZone>| async move { req.test_page("Zone", html! {
                    <p>{format!("{zone:?}")}</p>
                }) }),
            ),
        )
    };
    let get_with = |router: Router, uri: &'static str, cookie: Option<&'static str>| async move {
        let mut req = Request::get(uri);
        if let Some(cookie) = cookie {
            req = req.header("cookie", cookie);
        }
        let res = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        let status = res.status();
        (status, String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap())
    };
    let router = App::new(routes()).client_zone().router();
    // Reading the zone keeps the answer private but not out of the layout: the page around
    // `<main>` is the same, so the runtime swaps it in rather than loading it in full.
    let shell = |uri: &'static str| {
        let router = router.clone();
        async move {
            let req = Request::get(uri).header("corten", "nav").header("cookie", "corten-zone=America/Chicago");
            let res = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            (res.headers().get("corten-shell").cloned(), res.headers().get("cache-control").cloned())
        }
    };
    let (home, zoned) = (shell("/").await, shell("/zone-page").await);
    assert!(home.0.is_some() && home.0 == zoned.0, "same layout: {home:?} {zoned:?}");
    assert!(zoned.1.as_ref().is_some_and(|v| v.to_str().unwrap().contains("private")), "{zoned:?}");
    let (_, page) = get_with(router.clone(), "/", None).await;
    assert!(page.contains(r#"<meta name="corten-zone">"#), "the runtime is asked to keep it: {page}");
    assert_eq!(get_with(router.clone(), "/zone", None).await.1, "none", "before the runtime has run");
    for (cookie, zone) in [
        ("corten-zone=America/Chicago", "America/Chicago"),
        ("session=abc; corten-zone=Etc/GMT+5", "Etc/GMT+5"),
        ("corten-zone=America/Argentina/Buenos_Aires", "America/Argentina/Buenos_Aires"),
        ("corten-zone=<script>", "none"),
        ("corten-zone=../../etc/passwd", "none"),
        ("corten-zone=", "none"),
    ] {
        assert_eq!(get_with(router.clone(), "/zone", Some(cookie)).await.1, zone, "{cookie}");
    }

    let without = App::new(routes()).router();
    let (_, page) = get_with(without.clone(), "/", None).await;
    assert!(!page.contains("corten-zone"), "no cookie unless the app asks");
    let (status, body) = get_with(without, "/zone", Some("corten-zone=America/Chicago")).await;
    if cfg!(debug_assertions) {
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "a debug build names the missing App::client_zone()");
    } else {
        assert_eq!((status, body.as_str()), (StatusCode::OK, "none"), "a release build logs it and reads none");
    }
}

/// A `Public` page first asked for by a visitor whose zone is known is not given to the next one
/// in that zone: it is written in UTC, which is what the app keeps (`crate::kept`).
#[cfg(feature = "zones")]
#[tokio::test]
async fn a_kept_public_page_is_not_in_its_first_visitor_s_zone() {
    use crate::i18n::{DateStyle, TimeStyle};
    use std::time::{Duration, UNIX_EPOCH};
    crate::i18n::messages! { struct KeptZoneMsg { "en" => "src/i18n/en.json" } }
    let at = UNIX_EPOCH + Duration::from_secs(1_774_191_845);
    let page = move |req: Req| async move {
        let t: KeptZoneMsg = req.t();
        let when = t.date_time(at, DateStyle::Medium, TimeStyle::Short);
        crate::Public::new(Duration::from_secs(60), req.test_page_for("Zone", html! { <p>{when}</p> }))
    };
    let router = App::new(Routes::from(Table::new().route("/", crate::route::get(page).0))).client_zone().zoned_dates().router();
    let get_with = |cookie: Option<&'static str>| {
        let router = router.clone();
        async move {
            let mut req = Request::builder().uri("/");
            if let Some(cookie) = cookie {
                req = req.header("cookie", cookie);
            }
            let res = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            let kept = res.headers().contains_key("age");
            (kept, String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap())
        }
    };
    let utc = "<p>Mar 22, 2026, 3:04 PM UTC</p>";
    let (kept, first) = get_with(Some("corten-zone=America/Chicago")).await;
    assert!(!kept && first.contains(utc), "the first visitor's own page is in UTC: {first}");
    for cookie in [None, Some("corten-zone=Asia/Tokyo"), None] {
        let (kept, page) = get_with(cookie).await;
        assert!(kept && page == first, "{cookie:?}: the page made for the first visitor, given again: {page}");
    }
}

/// With the `zones` feature and `App::zoned_dates`, a date is written in the visitor's zone while
/// Corten renders the request's answer, which is then private; the first page, before the browser has reported its
/// zone, is in UTC and says so (`zone_unknown`); `.zone(..)` still chooses. `req.zone()` is the
/// zone with its rules.
#[cfg(feature = "zones")]
#[tokio::test]
async fn dates_are_written_in_the_visitors_zone_while_corten_renders_the_answer() {
    use crate::i18n::{DateStyle, Messages as _, TimeStyle, Utc, Zone as _};
    use std::time::{Duration, UNIX_EPOCH};
    crate::i18n::messages! { struct ZoneMsg { "en" => "src/i18n/en.json" } }
    // 2026-03-22T15:04:05Z: Chicago is on daylight time (UTC-5) since March 8.
    let at = UNIX_EPOCH + Duration::from_secs(1_774_191_845);
    let routes = move || {
        Routes::from(
            Table::new()
                .route(
                    "/",
                    get(move |req: Req| async move {
                        let t: ZoneMsg = req.t();
                        let when = t.date_time(at, DateStyle::Medium, TimeStyle::Short);
                        // Asked while the answer renders, as LocalTime asks it.
                        req.test_page(
                            "Zone",
                            html! {
                                <p>{when}</p>
                                <p>{if when.zone_unknown() { "unknown" } else { "known" }}</p>
                                <p>{when.zone(Utc)}</p>
                            },
                        )
                    }),
                )
                // Rendered ahead, in the handler, before the answer renders.
                .route(
                    "/ahead",
                    get(move |req: Req| async move {
                        let t: ZoneMsg = req.t();
                        let part = req.rendered(html! { <p>{t.date_time(at, DateStyle::Medium, TimeStyle::Short)}</p> });
                        let placed = &part;
                        req.test_page("Ahead", html! { {placed} })
                    }),
                )
                .route("/offset", get(move |req: Req| async move { req.zone().offset(at).to_string() }))
                // A calendar day: the same day in every zone (#502).
                .route(
                    "/day",
                    get(move |req: Req| async move {
                        let t: ZoneMsg = req.t();
                        let day = crate::i18n::Day::new(2026, 3, 22).unwrap();
                        req.test_page("Day", html! { <p>{t.date(day, DateStyle::Medium)}</p> })
                    }),
                )
                // Shared by its own header: a date written for one visitor would make it private.
                .route(
                    "/shared",
                    get(move |req: Req| async move {
                        let t: ZoneMsg = req.t();
                        let page =
                            req.test_page("Shared", html! { <p>{t.date_time(at, DateStyle::Medium, TimeStyle::Short)}</p> })?;
                        Ok::<_, Error>(([(http::header::CACHE_CONTROL, "public, max-age=60")], page))
                    }),
                )
                // Through Corten's handler check, which knows the answer is `Public`.
                .route(
                    "/public",
                    crate::route::get(move |req: Req| async move {
                        let t: ZoneMsg = req.t();
                        let when = t.date_time(at, DateStyle::Medium, TimeStyle::Short);
                        let offset = req.zone().offset(at);
                        let page = req.test_page_for(
                            "Shared",
                            html! {
                                <p>{when}</p>
                                <p>{if when.zone_unknown() { "unknown" } else { "known" }}</p>
                                <p>{offset}</p>
                            },
                        );
                        Public::new(std::time::Duration::from_secs(60), page)
                    })
                    .0,
                )
                .route(
                    "/public-live",
                    crate::route::get(move |req: Req| async move {
                        let t: ZoneMsg = req.t();
                        let live = crate::live(futures_util::StreamExt::map(futures_util::stream::iter([()]), move |()| {
                            let when = t.date_time(at, DateStyle::Medium, TimeStyle::Short);
                            crate::Fragment::new(format!(r#"<p id="n">{when}</p>"#))
                        }));
                        Public::new(std::time::Duration::from_secs(60), live)
                    })
                    .0,
                )
                .route(
                    "/live",
                    get(move |req: Req| async move {
                        let t: ZoneMsg = req.t();
                        // Rendered as the stream is read, after the handler returned.
                        crate::live(futures_util::StreamExt::map(futures_util::stream::iter([()]), move |()| {
                            let when = t.date_time(at, DateStyle::Medium, TimeStyle::Short);
                            crate::Fragment::new(format!(r#"<p id="n">{when}</p>"#))
                        }))
                    }),
                ),
        )
    };
    let get_with = |router: Router, uri: &'static str, cookie: Option<&'static str>| async move {
        let mut req = Request::get(uri);
        if let Some(cookie) = cookie {
            req = req.header("cookie", cookie);
        }
        let res = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        let cache = res.headers().get("cache-control").map(|v| v.to_str().unwrap().to_string()).unwrap_or_default();
        (cache, String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap())
    };
    let utc = "<p>Mar 22, 2026, 3:04 PM UTC</p>";
    let zoned = App::new(routes()).zoned_dates().router();
    let (cache, page) = get_with(zoned.clone(), "/", Some("corten-zone=America/Chicago")).await;
    assert!(page.contains(&format!("<p>Mar 22, 2026, 10:04 AM GMT-5</p><p>known</p>{utc}")), "{page}");
    assert!(cache.contains("private"), "written for this visitor: {cache}");
    let (cache, page) = get_with(zoned.clone(), "/ahead", Some("corten-zone=America/Chicago")).await;
    assert!(page.contains("<p>Mar 22, 2026, 10:04 AM GMT-5</p>") && cache.contains("private"), "rendered ahead: {cache} {page}");
    for cookie in [None, Some("corten-zone=Mars/Olympus")] {
        let (_, page) = get_with(zoned.clone(), "/", cookie).await;
        assert!(page.contains(&format!("{utc}<p>unknown</p>{utc}")), "{cookie:?}: {page}");
    }
    assert_eq!(get_with(zoned.clone(), "/offset", Some("corten-zone=America/Chicago")).await.1, "-18000");
    assert_eq!(get_with(zoned.clone(), "/offset", None).await.1, "0");
    for zone in ["corten-zone=America/Chicago", "corten-zone=Pacific/Kiritimati", "corten-zone=Pacific/Pago_Pago"] {
        let (_, page) = get_with(zoned.clone(), "/day", Some(zone)).await;
        assert!(page.contains("<p>Mar 22, 2026</p>"), "{zone}: {page}");
    }
    // A `Public` answer is the same for everyone: written as for a visitor whose zone is not
    // known (UTC, its LocalTimes written again in the browser), and it stays shared.
    let (cache, page) = get_with(zoned.clone(), "/public", Some("corten-zone=America/Chicago")).await;
    assert!(page.contains(&format!("{utc}<p>unknown</p><p>0</p>")), "{page}");
    assert!(cache.starts_with("public"), "{cache}");
    // Its live part's fragments too, as the stream is read after the handler returned.
    let (cache, live) = get_with(zoned.clone(), "/public-live", Some("corten-zone=America/Chicago")).await;
    assert!(live.contains("3:04 PM UTC") && cache.starts_with("public"), "{cache}: {live}");
    // A middleware that builds a response of its own around the answer (no extensions kept)
    // cannot lose that it is `Public`: the request's signal holds it.
    struct Rebuild;
    impl crate::Middleware for Rebuild {
        async fn call(&self, req: crate::http::Request, next: impl crate::Next) -> Response {
            let (parts, body) = next.run(req).await.into_parts();
            let mut res = Response::new(body);
            *res.status_mut() = parts.status;
            *res.headers_mut() = parts.headers;
            res
        }
    }
    let rebuilt = App::new(routes()).zoned_dates().middleware(Rebuild).router();
    for uri in ["/public", "/public-live"] {
        let (cache, page) = get_with(rebuilt.clone(), uri, Some("corten-zone=America/Chicago")).await;
        assert!(page.contains("3:04 PM UTC") && cache.starts_with("public"), "{uri}: {cache}: {page}");
    }
    // A live part's fragments are written in the zone, as its page was.
    let (_, live) = get_with(zoned, "/live", Some("corten-zone=America/Chicago")).await;
    assert!(live.contains("10:04 AM GMT-5"), "{live}");
    // A `Public` route's error page is not the same for everyone: written in the zone.
    async fn dated_error(_: Failure, req: Req) -> HtmlResult {
        let t: ZoneMsg = req.t();
        let at = UNIX_EPOCH + Duration::from_secs(1_774_191_845);
        req.test_page("Failed", html! { <p>{t.date_time(at, DateStyle::Medium, TimeStyle::Short)}</p> })
    }
    let failing = Routes::from(
        Table::new().route(
            "/public-fails",
            crate::route::get(|| async {
                Public::new(std::time::Duration::from_secs(60), Err::<&'static str, _>(Error::not_found()))
            })
            .0,
        ),
    );
    let failing = App::new(failing).zoned_dates().error_page(dated_error, ()).router();
    let (cache, page) = get_with(failing, "/public-fails", Some("corten-zone=America/Chicago")).await;
    assert!(page.contains("10:04 AM GMT-5") && cache.contains("private"), "{cache}: {page}");
    // An app that does not learn zones writes UTC and knows it is meant to.
    let (plain, page) = get_with(App::new(routes()).router(), "/", Some("corten-zone=America/Chicago")).await;
    assert!(page.contains(&format!("{utc}<p>known</p>{utc}")), "{page}");
    // Nor does one that learns them for `ClientZone` and `req.zone()` alone: the feature, which
    // another crate may turn on, does not change an app's dates; `zoned_dates` does.
    let learns = App::new(routes()).client_zone().router();
    let (cache, page) = get_with(learns.clone(), "/", Some("corten-zone=America/Chicago")).await;
    assert!(page.contains(&format!("{utc}<p>known</p>{utc}")), "{page}");
    assert_eq!(cache, plain, "answered as the app that does not learn zones");
    let (_, page) = get_with(learns.clone(), "/", None).await;
    assert!(page.contains(&format!("{utc}<p>known</p>{utc}")), "no LocalTime script before the cookie: {page}");
    let (cache, page) = get_with(learns.clone(), "/shared", Some("corten-zone=America/Chicago")).await;
    assert!(page.contains(utc) && cache.starts_with("public"), "{cache}: {page}");
    let (cache, page) = get_with(App::new(routes()).zoned_dates().router(), "/shared", Some("corten-zone=America/Chicago")).await;
    assert!(page.contains("10:04 AM GMT-5") && cache.contains("private"), "{cache}: {page}");
    assert_eq!(get_with(learns, "/offset", Some("corten-zone=America/Chicago")).await.1, "-18000");
    // Outside a request's render: UTC.
    assert_eq!(
        ZoneMsg::for_locale("en").date_time(at, DateStyle::Medium, TimeStyle::Short).to_string(),
        "Mar 22, 2026, 3:04 PM UTC"
    );
}

/// A form's date and time is read in the zone the form was drawn in, which it sends back
/// (`FormZone`), not in the zone of the request that posts it: a browser's first page is drawn in
/// UTC before the browser has reported its zone, and the post after it carries the zone. Without
/// JavaScript no zone is ever reported, and the form says it is in UTC.
#[cfg(feature = "zones")]
#[tokio::test]
async fn a_forms_date_and_time_is_read_in_the_zone_it_was_drawn_in() {
    use crate::form::{DrawZone, Entry, FormZone};
    use crate::i18n::{parse_timestamp, LocalDateTime, Utc};
    use std::time::{SystemTime, UNIX_EPOCH};
    #[derive(crate::Fields)]
    struct Repair {
        live_at: Entry<LocalDateTime>,
        zone: FormZone,
    }
    // Stored with seconds, as an instant an app keeps; listed with seconds too.
    let stored = parse_timestamp("2026-11-13T20:05:09.250Z").unwrap();
    let listed = parse_timestamp("2026-11-12T15:30:09Z").unwrap();
    let millis =
        |at: Option<SystemTime>| at.map_or("none".into(), |at| at.duration_since(UNIX_EPOCH).unwrap().as_millis().to_string());
    // The form, as an edit page draws it: the stored instant to the minute, the step the input
    // counts by from its min, and the posted text as sent when a refusal draws it again.
    let form = move |zone: &DrawZone, stored: SystemTime, typed: Option<&Entry<LocalDateTime>>| {
        let f = Repair::FIELDS;
        let shown = zone.local(stored).map(LocalDateTime::floor_minute);
        html! {
            <form method="post">
                {zone.field(f.zone)}
                <label>
                    "Goes live, " {zone.name()}
                    <input
                        type="datetime-local"
                        name={f.live_at}
                        min={zone.min(listed)}
                        value={typed.map_or(shown.map(|t| t.to_string()), |e| e.text().map(str::to_owned))}
                    >
                </label>
            </form>
        }
        .to_html()
    };
    // The post: an unchanged field keeps the stored instant; a field that does not read, or reads
    // before the listing, draws the form again in the zone it was sent in.
    let save = move |stored: SystemTime| {
        move |req: Req, Form(input): Form<Repair>| async move {
            let at = input.live_at.at_keeping(&input.zone, stored).filter(|at| *at >= listed);
            if at.is_none() {
                return form(&DrawZone::from(&input.zone), stored, Some(&input.live_at));
            }
            // What the request's own zone would have read: the mistake the form's zone prevents.
            let request = input.live_at.value().and_then(|t| t.read_in(req.zone()));
            format!("{} {}", millis(at), millis(request))
        }
    };
    // Stored in the minute the listing went up, after it.
    let early = parse_timestamp("2026-11-12T15:30:29Z").unwrap();
    let routes = Routes::from(
        Table::new()
            // The form posts to the page it is on, so it needs no action.
            .route(
                "/edit",
                get(move |req: Req| async move {
                    req.test_page("Edit", crate::view::Raw(form(&DrawZone::from(req.zone()), stored, None)))
                })
                .post(save(stored)),
            )
            .route(
                "/early",
                get(move |req: Req| async move {
                    req.test_page("Edit", crate::view::Raw(form(&DrawZone::from(req.zone()), early, None)))
                })
                .post(save(early)),
            )
            // A Public page is the same for everyone, so it is drawn in UTC.
            .route(
                "/public",
                get(move |req: Req| async move {
                    Public::new(
                        std::time::Duration::from_secs(60),
                        req.test_page_for("Edit", crate::view::Raw(form(&DrawZone::from(Utc), stored, None))),
                    )
                })
                .post(save(stored)),
            ),
    );
    let router = App::new(routes).client_zone().router();
    let send = |method: &'static str, uri: &'static str, body: &'static str, cookie: Option<&'static str>| {
        let router = router.clone();
        async move {
            let mut req = Request::builder().method(method).uri(uri).header("sec-fetch-site", "same-origin");
            if let Some(cookie) = cookie {
                req = req.header("cookie", cookie);
            }
            let req = req.header("content-type", "application/x-www-form-urlencoded").body(Body::from(body)).unwrap();
            let res = router.oneshot(req).await.unwrap();
            let (status, headers) = (res.status(), res.headers().clone());
            (status, headers, String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap())
        }
    };
    let chicago = Some("corten-zone=America/Chicago");
    let ms = |text: &str| millis(parse_timestamp(text));
    let at = millis(Some(stored));

    // A browser's first page, and every page without JavaScript: drawn in UTC, and says so; the
    // stored instant and the min to the minute.
    let (_, _, page) = send("GET", "/edit", "", None).await;
    assert!(page.contains(r#"<input type="hidden" name="zone" value="UTC">"#), "{page}");
    assert!(page.contains("Goes live, UTC"), "{page}");
    assert!(page.contains(r#"min="2026-11-12T15:30" value="2026-11-13T20:05""#), "{page}");
    // Sent unchanged from that first page by a browser that has reported Chicago since: the
    // stored instant, seconds and all, where the request's zone would have moved it six hours.
    let (status, _, read) = send("POST", "/edit", "live_at=2026-11-13T20%3A05&zone=UTC", chicago).await;
    assert_eq!((status, read), (StatusCode::OK, format!("{at} {}", ms("2026-11-14T02:05:00Z"))));
    // Changed, it is the time picked, in the zone the form was drawn in.
    let (_, _, read) = send("POST", "/edit", "live_at=2026-11-13T20%3A06&zone=UTC", chicago).await;
    assert_eq!(read, format!("{} {}", ms("2026-11-13T20:06:00Z"), ms("2026-11-14T02:06:00Z")));
    // Without JavaScript: UTC both ways.
    let (_, _, read) = send("POST", "/edit", "live_at=2026-11-13T20%3A06&zone=UTC", None).await;
    assert_eq!(read, format!("{0} {0}", ms("2026-11-13T20:06:00Z")));
    // Refused, it is drawn again in the zone it was typed in, not the request's.
    let (_, _, page) = send("POST", "/edit", "live_at=yesterday&zone=UTC", chicago).await;
    assert!(
        page.contains(r#"value="UTC""#) && page.contains("Goes live, UTC") && page.contains(r#"value="yesterday""#),
        "{page}"
    );

    // Once the browser has reported its zone, the form is drawn in it and read back in it.
    let (_, _, page) = send("GET", "/edit", "", chicago).await;
    assert!(page.contains(r#"<input type="hidden" name="zone" value="America/Chicago">"#), "{page}");
    assert!(page.contains("Goes live, America/Chicago"), "{page}");
    assert!(page.contains(r#"min="2026-11-12T09:30" value="2026-11-13T14:05""#), "{page}");
    let (_, _, read) = send("POST", "/edit", "live_at=2026-11-13T14%3A05&zone=America%2FChicago", chicago).await;
    assert_eq!(read, format!("{at} {}", ms("2026-11-13T20:05:00Z")));
    // A post without the zone came from no page of the app's.
    let (status, _, _) = send("POST", "/edit", "live_at=2026-11-13T14%3A05", chicago).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // A Public page is drawn in UTC whatever the visitor reported, stays shared, and its post is
    // read in UTC.
    let (_, headers, page) = send("GET", "/public", "", chicago).await;
    assert!(headers["cache-control"].to_str().unwrap().starts_with("public"), "{headers:?}");
    assert!(page.contains(r#"<input type="hidden" name="zone" value="UTC">"#) && page.contains("Goes live, UTC"), "{page}");
    let (_, _, read) = send("POST", "/public", "live_at=2026-11-13T20%3A06&zone=UTC", chicago).await;
    assert_eq!(read, format!("{} {}", ms("2026-11-13T20:06:00Z"), ms("2026-11-14T02:06:00Z")));

    // Stored in the same minute as the min: drawn at it, not before it, so the browser sends the
    // form unchanged, and the post keeps the stored instant.
    let (_, _, page) = send("GET", "/early", "", None).await;
    assert!(page.contains(r#"min="2026-11-12T15:30" value="2026-11-12T15:30""#), "{page}");
    let (status, _, read) = send("POST", "/early", "live_at=2026-11-12T15%3A30&zone=UTC", None).await;
    assert_eq!((status, read), (StatusCode::OK, format!("{} {}", millis(Some(early)), ms("2026-11-12T15:30:00Z"))));
    // Picked at the min's minute on a form with nothing stored there, it is before the listing,
    // and the handler's own comparison refuses it.
    let (_, _, page) = send("POST", "/edit", "live_at=2026-11-12T15%3A30&zone=UTC", None).await;
    assert!(page.contains(r#"value="2026-11-12T15:30""#) && page.contains("Goes live, UTC"), "{page}");
}

/// What a date and time field costs a request, for callgrind: `DATE_FORM_REQUESTS` (200)
/// requests through the router with `oneshot`, from a browser that reported America/Chicago.
/// `DATE_FORM_PATH=get` draws the form (the zone's hidden input and name, and the input's
/// `value`, `min` and `max` from instants); the others post it, read as `Entry<LocalDateTime>`
/// and `FormZone` with `at_keeping` and the bounds compared: `post` unchanged (the stored instant
/// kept, no time resolved), `edit` changed by a minute (resolved in the posted zone), and
/// `skipped` changed to a time the clocks skip (2027-03-14T02:30 in Chicago, resolved across the
/// gap). `DATE_FORM=text` is the same markup and post
/// with the field and the zone as text an app does not read, the cost before this field had a
/// reader. Build the lib's test binary with `cargo test --release -p corten-run --all-features
/// --lib --no-run`, run `DATE_FORM_REQUESTS=1200 valgrind --tool=callgrind <that binary> --ignored
/// --exact tests::forms::what_a_date_and_time_field_costs --test-threads=1` and again at 200: the
/// difference over 1,000 is a request's.
#[cfg(feature = "zones")]
#[tokio::test]
#[ignore]
async fn what_a_date_and_time_field_costs() {
    use crate::form::{DrawZone, Entry, FormZone};
    use crate::i18n::{parse_timestamp, LocalDateTime};
    #[derive(crate::Fields)]
    struct Repair {
        live_at: Entry<LocalDateTime>,
        zone: FormZone,
    }
    #[derive(crate::Fields)]
    struct Text {
        live_at: String,
        zone: String,
    }
    let requests: usize = std::env::var("DATE_FORM_REQUESTS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
    // The time posted, and whether the stored instant is kept; none for the page itself.
    let posted = match std::env::var("DATE_FORM_PATH").as_deref() {
        Ok("post") => Some(("2026-11-13T14%3A05", "kept")),
        Ok("edit") => Some(("2026-11-13T14%3A06", "2026-11-13T20:06:00Z")),
        Ok("skipped") => Some(("2027-03-14T02%3A30", "2027-03-14T08:30:00Z")),
        _ => None,
    };
    let text = std::env::var("DATE_FORM").is_ok_and(|f| f == "text");
    let stored = parse_timestamp("2026-11-13T20:05:09.250Z").unwrap();
    let expected = posted.map(|(_, at)| if at == "kept" { stored } else { parse_timestamp(at).unwrap() });
    let listed = parse_timestamp("2026-11-12T15:30:09Z").unwrap();
    let until = parse_timestamp("2027-12-31T00:00:00Z").unwrap();
    let typed = get(move |req: Req| async move {
        let (zone, f) = (DrawZone::from(req.zone()), Repair::FIELDS);
        req.test_page(
            "Edit",
            html! {
                <form method="post">
                    {zone.field(f.zone)}
                    <label>
                        "Goes live, " {zone.name()}
                        <input
                            type="datetime-local"
                            name={f.live_at}
                            min={zone.min(listed)}
                            max={zone.max(until)}
                            value={zone.local(stored).map(LocalDateTime::floor_minute)}
                        >
                    </label>
                </form>
            },
        )
    })
    .post(move |Form(input): Form<Repair>| async move {
        // Saved only as the instant each case expects, so a case cannot measure another path.
        let at = input.live_at.at_keeping(&input.zone, stored).filter(|at| *at >= listed && *at <= until);
        if at.is_some() && at == expected {
            "saved"
        } else {
            "refused"
        }
    });
    let plain = get(move |req: Req| async move {
        let f = Text::FIELDS;
        req.test_page(
            "Edit",
            html! {
                <form method="post">
                    <input type="hidden" name={f.zone} value="America/Chicago">
                    <label>
                        "Goes live, " {"America/Chicago"}
                        <input
                            type="datetime-local"
                            name={f.live_at}
                            min="2026-11-12T09:30"
                            max="2027-12-30T18:00"
                            value="2026-11-13T14:05"
                        >
                    </label>
                </form>
            },
        )
    })
    .post(move |Form(input): Form<Text>| async move {
        if input.live_at.is_empty() || input.zone.is_empty() {
            "refused"
        } else {
            "saved"
        }
    });
    let router = App::new(Routes::from(Table::new().route("/typed", typed).route("/text", plain))).client_zone().router();
    let uri = if text { "/text" } else { "/typed" };
    let body = posted.map(|(time, _)| format!("live_at={time}&zone=America%2FChicago"));
    for _ in 0..requests {
        let req = Request::builder()
            .method(if body.is_some() { "POST" } else { "GET" })
            .uri(uri)
            .header("sec-fetch-site", "same-origin")
            .header("cookie", "corten-zone=America/Chicago")
            .header("content-type", "application/x-www-form-urlencoded");
        let res = router.clone().oneshot(req.body(Body::from(body.clone().unwrap_or_default())).unwrap()).await.unwrap();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        assert!(body.is_none() || &bytes[..] == b"saved", "{bytes:?}");
        std::hint::black_box(bytes);
    }
}
