use super::*;

/// `style={FILL.pct(..)}` is written as `data-vars`, so a literal `style` beside it is another
/// attribute, in either order.
#[crate::component(css)]
fn MeterStyled(used: f64) -> impl Render {
    html! {
        <div class={Meter} style="color: red" style={FILL.pct(used)}></div>
        <div class={Meter} style={FILL.pct(used)} style></div>
    }
}

#[test]
fn a_literal_style_beside_custom_properties_is_another_attribute() {
    assert_eq!(
        MeterStyled { used: 7.0 }.to_html(),
        r#"<div class="meter-styled__meter" style="color: red" data-vars="--meter-styled__fill:7%"></div><div class="meter-styled__meter" data-vars="--meter-styled__fill:7%" style></div>"#
    );
}

/// The meters' page, with `TestMeter` listed, as a debug build requires of a page that renders it.
pub(super) fn meters_app() -> Router {
    App::new(Routes::from(meters())).error_page(test_error_page, ()).components(&[TestMeter]).router()
}

/// A full page's custom properties are one style block at `<Corten />`, allowed by its hash in
/// that response's CSP; a navigation's are left to the runtime, under the document's policy.
#[tokio::test]
async fn a_page_s_custom_properties_are_one_style_block_its_csp_allows_by_hash() {
    let (_, headers, body) = call(meters_app(), "GET", None).await;
    let rules = r#"[data-vars="--test-meter__fill:42.5%"]{--test-meter__fill:42.5%!important}[data-vars="--test-meter__fill:7%"]{--test-meter__fill:7%!important}"#;
    assert!(body.contains(&format!("<style>{rules}</style></head>")), "each value once, after the page's stylesheets: {body}");
    assert!(body.contains(r#"<div class="test-meter__meter" data-vars="--test-meter__fill:7%"></div><div class="test-meter__meter" data-vars="--test-meter__fill:42.5%"></div><div class="test-meter__meter"></div>"#), "a value that is not finite sets nothing: {body}");
    let csp = headers["content-security-policy"].to_str().unwrap();
    assert!(csp.contains(&format!("style-src 'self' {};", crate::security::hash_source(rules))), "{csp}");
    assert!(!csp.contains("style-src-attr") && !csp.contains("unsafe"), "{csp}");
    let (_, again, same) = call(meters_app(), "GET", None).await;
    assert_eq!(
        (&again["content-security-policy"], &same),
        (&headers["content-security-policy"], &body),
        "the same bytes, so a cache can keep it"
    );

    let (_, headers, body) = call(meters_app(), "GET", Some("nav")).await;
    assert!(body.contains(r#"data-vars="--test-meter__fill:42.5%""#) && !body.contains("<style>"), "{body}");
    let csp = headers["content-security-policy"].to_str().unwrap();
    assert!(csp.contains("style-src 'self';"), "{csp}");
    let (_, headers, _) = call(app(routes(), None), "GET", None).await;
    assert!(headers["content-security-policy"].to_str().unwrap().contains("style-src 'self';"), "a page with none is as before");
}

/// Meters rendered ahead, placed with `place`, on a page served under `corten dev` or not.
fn placed_meters(dev: bool, place: fn(crate::Rendered) -> Box<dyn crate::Render>) -> Router {
    placed_meters_listing(dev, place, &[TestMeter])
}

/// `placed_meters`, with the app listing `components`.
fn placed_meters_listing(
    dev: bool,
    place: fn(crate::Rendered) -> Box<dyn crate::Render>,
    components: &'static [crate::Component],
) -> Router {
    let page = move |req: Req| async move {
        let body = req.rendered(html! {
            <TestMeter used={42.5} />
            <TestMeter used={7.0} />
        });
        req.test_page("Meters", place(body))
    };
    App::new(Routes::from(Table::new().route("/", get(page))))
        .dev(dev)
        .error_page(test_error_page, ())
        .components(components)
        .router()
}

/// Markup rendered ahead into a `Rendered` keeps its values, so its page's style block has their
/// rules; the same markup placed with `raw` has none, which a debug build in dev mode reports.
#[tokio::test]
async fn markup_rendered_ahead_keeps_its_custom_properties_and_raw_markup_is_reported() {
    let rules = r#"[data-vars="--test-meter__fill:42.5%"]{--test-meter__fill:42.5%!important}[data-vars="--test-meter__fill:7%"]{--test-meter__fill:7%!important}"#;
    for dev in [false, true] {
        let (status, _, body) = call(placed_meters(dev, |body| Box::new(body)), "GET", None).await;
        assert_eq!(status, 200, "{body}");
        assert!(body.contains(&format!("<style>{rules}</style></head>")), "{body}");
    }
    let (status, _, body) = call(placed_meters(false, |body| Box::new(crate::raw(body.as_str().to_string()))), "GET", None).await;
    assert!(status == 200 && !body.contains("<style>"), "raw markup's values are not noted: {body}");
    let (status, _, body) = call(placed_meters(true, |body| Box::new(crate::raw(body.as_str().to_string()))), "GET", None).await;
    if cfg!(debug_assertions) {
        assert_eq!(status, 500, "{body}");
        assert!(body.contains("data-vars=&quot;--test-meter__fill:42.5%&quot; and no rule for it"), "{body}");
    } else {
        assert!(status == 200 && !body.contains("<style>"), "release runs no markup check in dev mode: {body}");
    }
    // In a debug build, a component rendered ahead counts as rendered where it is placed. A
    // release build does not note a view's components, so only a debug build reports it.
    // Outside `corten dev` too, as an app's own router test runs (#1029): the message describes the
    // app's code, so the error page's detail keeps it.
    if cfg!(debug_assertions) {
        for dev in [true, false] {
            let (status, _, body) = call(placed_meters_listing(dev, |body| Box::new(body), &[]), "GET", None).await;
            assert_eq!(status, 500, "{body}");
            assert!(body.contains("renders TestMeter, which the app does not list"), "dev {dev}: {body}");
        }
    }
}

/// What a view rendered ahead noted reaches the render it is placed in: its values beside those
/// the outer render wrote before and after it was made, its script modules and its components.
#[test]
fn a_rendered_view_brings_what_its_render_noted() {
    struct Handled;
    impl crate::Render for Handled {
        fn render(&self, out: &mut String) {
            out.push_str("<button></button>");
            crate::script::uses("stock_grid");
        }
    }
    let ((((html, inner), components), modules), block) = crate::style::capture_vars(|| {
        crate::script::collect(|| {
            crate::style::collect(|| {
                let mut out = TestMeter { used: 42.5 }.to_html();
                let inner = crate::Rendered::new(html! {
                    <TestMeter used={7.0} />
                    {Handled}
                });
                TestMeter { used: 1.0 }.render(&mut out);
                inner.render(&mut out);
                (out, inner)
            })
        })
    });
    assert!(html.ends_with("<button></button>"), "{html}");
    assert_eq!(modules, ["stock_grid"]);
    if cfg!(debug_assertions) {
        assert_eq!(components.iter().map(|c| c.name).collect::<Vec<_>>(), ["TestMeter"]);
        // Placed alone, it reports the component it rendered.
        let ((), alone) = crate::style::collect(|| inner.render(&mut String::new()));
        assert_eq!(alone.iter().map(|c| c.name).collect::<Vec<_>>(), ["TestMeter"], "replayed where it is placed");
    }
    let ((), rules) = crate::style::collect_vars(|| crate::style::replay_vars(&block));
    for value in ["42.5%", "7%", "1%"] {
        assert!(rules.contains(&format!("{{--test-meter__fill:{value}!important}}")), "{value}: {rules}");
    }
}

/// A view rendered ahead keeps a submit key the outer render drew before it was made, and says
/// whether it drew one itself where it is placed, so the answer holding either is not tagged.
#[test]
fn a_rendered_view_keeps_the_outer_render_s_submit_key_and_brings_its_own() {
    struct Draws;
    impl crate::Render for Draws {
        fn render(&self, _: &mut String) {
            crate::form::DREW_KEY.set(true);
        }
    }
    struct Plain;
    impl crate::Render for Plain {
        fn render(&self, out: &mut String) {
            out.push_str("<p></p>");
        }
    }
    crate::form::DREW_KEY.set(true);
    let plain = crate::Rendered::new(Plain);
    assert!(crate::form::DREW_KEY.get(), "the key the outer render drew is kept");
    crate::form::DREW_KEY.set(false);
    let keyed = crate::Rendered::new(Draws);
    assert!(crate::form::DREW_KEY.get(), "a key drawn while made counts where it was made");
    crate::form::DREW_KEY.set(false);
    plain.render(&mut String::new());
    assert!(!crate::form::DREW_KEY.get(), "placing a view with no key leaves the flag");
    keyed.render(&mut String::new());
    assert!(crate::form::DREW_KEY.get(), "placing a view with a key sets it");
    crate::form::DREW_KEY.set(false);
}

/// A render that panics inside another puts back what the outer one was gathering, so it keeps
/// what it noted before and goes on noting after: a handler's panic is caught and the thread
/// renders on.
#[test]
fn a_panicking_render_puts_back_what_was_gathering() {
    let panics = || panic!("a handler");
    let ((), modules) = crate::script::collect(|| {
        crate::script::uses("before");
        assert!(std::panic::catch_unwind(|| crate::script::collect::<()>(panics)).is_err());
        crate::script::uses("after");
    });
    assert_eq!(modules, ["before", "after"]);
    let ((), rules) = crate::style::collect_vars(|| {
        TestMeter { used: 1.0 }.to_html();
        assert!(std::panic::catch_unwind(|| crate::style::collect_vars::<()>(panics)).is_err());
        TestMeter { used: 2.0 }.to_html();
    });
    assert!(rules.contains("--test-meter__fill:1%!important") && rules.contains("--test-meter__fill:2%!important"), "{rules}");
    let ((), block) = crate::style::capture_vars(|| {
        TestMeter { used: 3.0 }.to_html();
        assert!(std::panic::catch_unwind(|| crate::style::capture_vars::<()>(panics)).is_err());
        TestMeter { used: 4.0 }.to_html();
    });
    let ((), rules) = crate::style::collect_vars(|| crate::style::replay_vars(&block));
    assert!(rules.contains("--test-meter__fill:3%!important") && rules.contains("--test-meter__fill:4%!important"), "{rules}");
    if cfg!(debug_assertions) {
        const OTHER: crate::Component = crate::Component { name: "Other", ..TestMeter };
        let ((), used) = crate::style::collect(|| {
            crate::style::__private::rendered(&TestMeter);
            assert!(std::panic::catch_unwind(|| crate::style::collect::<()>(panics)).is_err());
            crate::style::__private::rendered(&OTHER);
        });
        assert_eq!(used.iter().map(|c| c.name).collect::<Vec<_>>(), ["TestMeter", "Other"]);
    }
}
