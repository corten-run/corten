use super::caller::admin_url;
use super::*;

#[test]
fn a_nav_link_writes_its_route_once_and_says_when_it_is_the_page() {
    use crate::{page::Nav, view::Attrs};
    #[derive(crate::Route)]
    #[route("/sell")]
    struct Sell;
    #[derive(crate::Route)]
    #[route("/items/{id}")]
    struct Item<'a> {
        id: &'a str,
        tab: Option<&'a str>,
    }
    fn attrs<R: crate::Route>(nav: Nav<'_, R>) -> String {
        let mut out = String::new();
        nav.render_attrs(&mut out);
        out
    }
    assert_eq!(attrs(Nav { path: "/sell", to: &Sell, section: false }), r#" href="/sell" data-nav aria-current="page""#);
    assert_eq!(attrs(Nav { path: "/sell/listings", to: &Sell, section: false }), r#" href="/sell" data-nav"#);
    assert_eq!(
        attrs(Nav { path: "/sell/listings", to: &Sell, section: true }),
        r#" href="/sell" data-nav="section" aria-current="page""#
    );
    // A sibling that starts with the same text is not under the section.
    assert_eq!(attrs(Nav { path: "/seller", to: &Sell, section: true }), r#" href="/sell" data-nav="section""#);
    // A section written with a trailing slash holds the pages under it, and itself.
    #[derive(crate::Route)]
    #[route("/shop/")]
    struct Shop;
    assert_eq!(
        attrs(Nav { path: "/shop/boots", to: &Shop, section: true }),
        r#" href="/shop/" data-nav="section" aria-current="page""#
    );
    assert_eq!(
        attrs(Nav { path: "/shop/", to: &Shop, section: true }),
        r#" href="/shop/" data-nav="section" aria-current="page""#
    );
    // The path is percent-encoded, and the query is left out of the comparison.
    let item = Item { id: "a b", tab: Some("x&y") };
    assert_eq!(
        attrs(Nav { path: "/items/a%20b", to: &item, section: false }),
        r#" href="/items/a%20b?tab=x%26y" data-nav aria-current="page""#
    );
    // A route written by hand may write a path that escaping for the attribute changes; it is
    // compared unescaped.
    struct Terms;
    impl crate::Route for Terms {
        type Data = crate::route::NoData;
        const PATH: &'static str = "/terms&privacy";
        fn write_href(&self, out: &mut String, html: bool) {
            out.push_str(if html { "/terms&amp;privacy" } else { "/terms&privacy" });
        }
    }
    assert_eq!(
        attrs(Nav { path: "/terms&privacy", to: &Terms, section: false }),
        r#" href="/terms&amp;privacy" data-nav aria-current="page""#
    );
}

/// A whole nav's links: of the entries that hold the page, only the deepest is current, as the
/// runtime judges a `<nav>` after a client navigation (#341).
#[test]
fn a_nav_marks_the_deepest_entry_that_holds_the_page() {
    use crate::{
        page::{nav_links, NavTo},
        view::Attrs,
        Local,
    };
    #[derive(crate::Route)]
    #[route("/")]
    struct Home;
    #[derive(crate::Route)]
    #[route("/account/desk")]
    struct Desk;
    #[derive(crate::Route)]
    #[route("/account/desk/money")]
    struct Money;
    let help = Local::parse("/help?topic=a&b").unwrap();
    let written = |nav: crate::page::NavLinks<()>| {
        nav.links()
            .map(|(link, ())| {
                let mut out = String::new();
                link.render_attrs(&mut out);
                out
            })
            .collect::<Vec<_>>()
    };
    let group = |links: &[String]| {
        let groups: Vec<_> =
            links.iter().map(|link| link.split(r#" data-nav-group=""#).nth(1).unwrap()[..8].to_string()).collect();
        assert!(groups.iter().all(|g| *g == groups[0] && g.bytes().all(|b| b.is_ascii_hexdigit())), "{groups:?}");
        groups[0].clone()
    };
    let marked = |path: &str| {
        let links = written(nav_links(
            path,
            [NavTo::page(&Home), NavTo::section(&Desk), NavTo::section(&Money), NavTo::page(&help)].map(|e| (e, ())),
        ));
        let g = format!(r#" data-nav-group="{}""#, group(&links));
        links.into_iter().map(|link| link.replace(&g, "")).collect::<Vec<_>>()
    };
    assert_eq!(
        marked("/account/desk/repricing"),
        [
            r#" href="/" data-nav"#,
            r#" href="/account/desk" data-nav="section" aria-current="page""#,
            r#" href="/account/desk/money" data-nav="section""#,
            r#" href="/help?topic=a&amp;b" data-nav"#,
        ]
    );
    let money = marked("/account/desk/money/payouts");
    assert!(!money[1].contains("aria-current") && money[2].ends_with(r#" aria-current="page""#), "{money:?}");
    assert!(marked("/")
        .iter()
        .filter(|link| link.contains("aria-current"))
        .eq([&r#" href="/" data-nav aria-current="page""#.to_string()]));
    assert!(marked("/help").last().unwrap().ends_with(r#" aria-current="page""#), "an entry from data takes part");
    assert!(marked("/elsewhere").iter().all(|link| !link.contains("aria-current")));

    // The group names the entries: the same nav twice is one group, another nav is another.
    let of = |path: &str, entries: [NavTo; 2]| written(nav_links(path, entries.map(|e| (e, ()))));
    let desk = of("/", [NavTo::section(&Desk), NavTo::page(&Money)]);
    assert_eq!(group(&desk), group(&of("/account", [NavTo::section(&Desk), NavTo::page(&Money)])));
    assert_ne!(group(&desk), group(&of("/", [NavTo::page(&Desk), NavTo::page(&Money)])));
    assert_ne!(group(&desk), group(&of("/", [NavTo::section(&Money), NavTo::page(&Desk)])));

    // Each link comes with its entry's item.
    let labels: Vec<_> =
        nav_links("/", [(NavTo::page(&Home), "Home"), (NavTo::section(&Desk), "Desk")]).links().map(|(_, l)| *l).collect();
    assert_eq!(labels, ["Home", "Desk"]);

    // A path from data is written as the browser asks for it, so the server compares what it is
    // sent: `"` and `|` are percent-encoded in the path (not in the query).
    let odd = Local::parse(r#"/a"b|c?q="|""#).unwrap();
    let links = written(nav_links("/a%22b%7Cc", [(NavTo::page(&odd), ())]));
    assert!(links[0].starts_with(r#" href="/a%22b%7Cc?q=&quot;|&quot;" data-nav data-nav-group=""#), "{links:?}");
    assert!(links[0].ends_with(r#" aria-current="page""#), "{links:?}");

    // A route that says `prefetch = false` keeps saying so in a nav, as in `href={..}`.
    #[derive(crate::Route)]
    #[route("/reports/suggested", prefetch = false)]
    struct Suggested;
    let links = written(nav_links("/", [(NavTo::page(&Suggested), ()), (NavTo::page(&Home), ())]));
    assert!(links[0].ends_with(" data-no-prefetch") && !links[1].contains("data-no-prefetch"), "{links:?}");
    let mut one = String::new();
    crate::page::Nav { path: "/reports/suggested", to: &Suggested, section: false }.render_attrs(&mut one);
    assert_eq!(one, r#" href="/reports/suggested" data-nav aria-current="page" data-no-prefetch"#);

    // One costly only for some URLs says which, in a nav as in `href={..}`.
    #[derive(crate::Route)]
    #[route("/export", prefetch = cheap_step)]
    struct Export<'a> {
        step: Option<&'a str>,
    }
    fn cheap_step(at: &Export<'_>) -> bool {
        at.step != Some("pull-sheet")
    }
    let (pull, print) = (Export { step: Some("pull-sheet") }, Export { step: Some("print") });
    let links = written(nav_links("/", [(NavTo::page(&pull), ()), (NavTo::page(&print), ())]));
    assert!(links[0].ends_with(" data-no-prefetch") && !links[1].contains("data-no-prefetch"), "{links:?}");
    let held = &pull;
    assert_eq!(html! { <a href={held}>"Pull"</a> }.to_html(), r#"<a href="/export?step=pull-sheet" data-no-prefetch>Pull</a>"#);

    // In a routes module, named from where the module is, as a handler is: a function body
    // included (this test's).
    assert!(!crate::Route::may_prefetch(&url_steps::Steps { step: Some("pack") }));
    assert!(crate::Route::may_prefetch(&url_steps::Steps { step: None }));
    async fn local() -> &'static str {
        "local"
    }
    fn not_slow(at: &url_local::Local<'_>) -> bool {
        at.speed != Some("slow")
    }
    #[crate::routes]
    mod url_local {
        #[route("/local", get = local, prefetch = not_slow)]
        pub struct Local<'a> {
            pub speed: Option<&'a str>,
        }
    }
    assert!(!crate::Route::may_prefetch(&url_local::Local { speed: Some("slow") }));

    // A route held by reference says the same: an enum of links holding one, and `&&route`.
    #[derive(crate::Href)]
    enum Link<'a> {
        Pull(&'a Export<'a>),
        Report(&'a Suggested),
    }
    let (link, report) = (Link::Pull(&pull), Link::Report(&Suggested));
    assert_eq!(html! { <a href={link}>"Pull"</a> }.to_html(), r#"<a href="/export?step=pull-sheet" data-no-prefetch>Pull</a>"#);
    assert!(html! { <a href={report}>"R"</a> }.to_html().contains("data-no-prefetch"));
    let twice = &&pull;
    let to: &dyn crate::Href = &twice;
    assert!(!to.prefetch());

    // A link to a place on the page says what its route says, written or held as a `dyn Href`.
    let at = crate::Route::at(&pull, QtyId);
    let written = html! { <a href={at}>"Pull"</a> }.to_html();
    assert!(written.contains("/export?step=pull-sheet#") && written.ends_with(" data-no-prefetch>Pull</a>"), "{written}");
    let to: &dyn crate::Href = &crate::Route::at(&pull, QtyId);
    assert!(!to.prefetch());
    assert!(<dyn crate::Href>::prefetch(&crate::Route::at(&print, QtyId)));
}

async fn steps() -> &'static str {
    "steps"
}

/// For a routes module's route: every step but packing may be fetched on a hover.
fn not_pack(at: &url_steps::Steps<'_>) -> bool {
    at.step != Some("pack")
}

#[crate::routes]
mod url_steps {
    #[route("/steps", get = steps, prefetch = not_pack)]
    pub struct Steps<'a> {
        pub step: Option<&'a str>,
    }
}

#[test]
fn current_links_match_the_page_or_its_section() {
    use crate::page::is_current_for_tests as is_current;
    assert!(is_current("/sell", "/sell", false));
    assert!(is_current("/sell", "/sell?tab=2", false));
    assert!(!is_current("/sell/listings", "/sell", false));
    assert!(is_current("/sell/listings", "/sell", true));
    assert!(is_current("/sell/listings", "/sell/", true));
    assert!(!is_current("/seller", "/sell", true));
}

/// Which routes outside an API can match a path under it, so only those APIs check per request.
#[test]
fn a_route_reaches_an_api_through_a_parameter_before_it() {
    use crate::api::reaches;
    for route in ["/{*rest}", "/{id}", "/api/{id}", "/api/{*rest}"] {
        assert!(reaches(route, "/api/items"), "{route}");
    }
    for route in ["/page", "/api/ping", "/v2/items/{id}", "/apis/{id}", "/api/items/{id}", "/api/items"] {
        assert!(!reaches(route, "/api/items"), "{route}");
    }
    assert!(!reaches("/{*rest}", "/"), "nothing is outside the root");
}

/// Routes that can match at or under `/api/items` with nonempty parameter values.
const CAN_UNDER_API_ITEMS: [&str; 7] =
    ["/{*rest}", "/api/{id}", "/api/{*rest}", "/{a}/{b}", "/{a}/items/{id}", "/a{x}/{b}", "/ap{*rest}"];

/// Each prefix, a route written outside it, and whether the route can match a path at or under
/// the prefix, as matchit 0.9.2 matches.
fn can_match_under_cases() -> Vec<(&'static str, &'static str, bool)> {
    let mut cases = Vec::new();
    let mut add = |prefix: &'static str, can: bool, routes: &[&'static str]| {
        cases.extend(routes.iter().map(|&route| (prefix, route, can)));
    };
    add("/api/items", true, &CAN_UNDER_API_ITEMS);
    // A parameter always needs one byte, even before a `/`.
    add("/api/items", true, &["/api/item{x}"]);
    add("/api/items", false, &["/api{x}/items", "/api{x}/{b}", "/api/items{x}/{b}"]);
    add("/api/items", false, &["/{id}", "/page", "/api/ping", "/{a}/other", "/apis/{id}", "/x{a}/{b}", "/api/items/{id}"]);
    // A value that ends the route is never empty: `/api{x}` is never `/api`.
    add("/api/items", false, &["/b{*rest}", "/api{x}", "/api/items{x}"]);
    // Corten's own `/corten/` holds only paths with a segment after it.
    add("/corten/", true, &["/{a}/{b}", "/{*rest}", "/{a}/", "/cor{x}/{b}"]);
    add("/corten/", false, &["/{slug}", "/cor{x}", "/corten{x}", "/corten{x}/{b}", "/x/{a}", "/corten/{file}"]);
    // Beside an inner area at `/shop/desk`, and beside one at `/shop`.
    add("/shop/desk", true, &["/shop/{id}", "/{a}/{b}", "/shop/{id}/more"]);
    add("/shop/desk", false, &["/{slug}", "/shop{x}/desk", "/shop/x{id}", "/{a}/x/{b}", "/shops/{id}"]);
    add("/shop", true, &["/{slug}"]);
    // Text after a parameter, which the router does not hold: one byte or more before it.
    add("/api/a.json", true, &["/api/{x}.json"]);
    add("/api/.json", false, &["/api/{x}.json"]);
    // The root holds every route, so none is outside it.
    add("/", false, &["/{*rest}"]);
    cases
}

/// Counted by segment, a route can match under a prefix only where each of its segments can
/// match the prefix's, as matchit 0.9.2 matches: a parameter at least one byte of one segment
/// after the text before it, a catch-all the rest.
#[test]
fn a_route_can_match_under_a_prefix_only_segment_by_segment() {
    for (prefix, route, can) in can_match_under_cases() {
        assert_eq!(crate::api::can_match_under(route, prefix), can, "{route} under {prefix}");
    }
}

/// matchit's insertion error still names the existing route when the app stops at startup.
#[test]
#[should_panic(
    expected = "corten: the route \"/prefix{id}\" cannot be routed beside the app's others: Insertion failed due to conflict with previously registered route: /{id}suffix"
)]
fn a_router_conflict_names_both_routes() {
    let _router = crate::Router::from(
        Table::new().route("/{id}suffix", get(|| async { "suffix" })).route("/prefix{id}", get(|| async { "prefix" })),
    );
}

/// matchit 0.9.2's order-dependent false conflict, as an app reaches it: a hand-written `Route`
/// with text before a parameter, given to the hidden `Routes::__route` (derived routes cannot put
/// text there). `/{z}/b` after `/a{x}/{y}` stops the app; the two in the other order start and
/// each answers its own paths (docs/design.md#choice-matchit).
#[tokio::test]
async fn a_prefixed_hand_written_route_conflicts_in_one_order_only() {
    struct Prefixed;
    impl crate::Route for Prefixed {
        type Data = crate::route::NoData;
        const PATH: &'static str = "/a{x}/{y}";
        fn write_href(&self, out: &mut String, _: bool) {
            out.push_str("/ax/c");
        }
    }
    struct Leading;
    impl crate::Route for Leading {
        type Data = crate::route::NoData;
        const PATH: &'static str = "/{z}/b";
        fn write_href(&self, out: &mut String, _: bool) {
            out.push_str("/q/b");
        }
    }
    let prefixed = || crate::Methods::reads(get(|| async { "prefixed" }));
    let leading = || crate::Methods::reads(get(|| async { "leading" }));
    let refused = std::panic::catch_unwind(|| {
        App::new(Routes::new().__route::<Prefixed>(prefixed()).__route::<Leading>(leading())).router()
    });
    let message = refused.err().and_then(|panic| panic.downcast::<String>().ok()).expect("the later route is refused");
    assert!(
        message.contains("the route \"/{z}/b\" cannot be routed beside the app's others")
            && message.contains("conflict with previously registered route: /a{x}/{y}"),
        "{message}"
    );
    let router = App::new(Routes::new().__route::<Leading>(leading()).__route::<Prefixed>(prefixed())).router();
    for (path, body) in [("/ax/c", "prefixed"), ("/ax/b", "prefixed"), ("/q/b", "leading")] {
        assert_eq!(call_with(router.clone(), "GET", path, None, None).await.2, body, "{path}");
    }
}

/// Never a false no: with each route alone in a router of the matchit this build resolves, every
/// path at or under a prefix that it matches is one `can_match_under` says it can reach. A route
/// must be accepted; a changed insertion rule must not silently remove a case.
#[test]
fn can_match_under_never_says_no_where_matchit_matches() {
    use crate::api::{can_match_under, under};
    let cases = can_match_under_cases();
    let mut prefixes: Vec<&str> = cases.iter().map(|&(prefix, _, _)| prefix).collect();
    let mut routes: Vec<&str> = cases.iter().map(|&(_, route, _)| route).collect();
    for list in [&mut prefixes, &mut routes] {
        list.sort_unstable();
        list.dedup();
    }
    let (mut held, mut matched) = (Vec::new(), std::collections::BTreeSet::new());
    for route in routes {
        let mut router = matchit::Router::new();
        router.insert(route, ()).unwrap();
        held.push(route);
        for &prefix in &prefixes {
            // A route written inside the prefix is the prefix's own, never asked about.
            if under(prefix.strip_suffix('/').filter(|inner| !inner.is_empty()).unwrap_or(prefix), route) {
                continue;
            }
            let base = prefix.trim_end_matches('/');
            for tail in ["", "/", "//", "/a", "/a/", "/a//", "/a/b", "//b", "/a.json", "/.json"] {
                let path = format!("{base}{tail}");
                // As the router's scopes hold them: Corten's own prefixes by their start.
                let at = if prefix.ends_with('/') { path.starts_with(prefix) } else { under(prefix, &path) };
                if at && router.at(&path).is_ok() {
                    assert!(can_match_under(route, prefix), "{route} matches {path}, under {prefix}");
                    matched.insert((route, prefix));
                }
            }
        }
    }
    // The paths tried reach every route that can match with no empty value, so the check is not empty.
    for route in CAN_UNDER_API_ITEMS.into_iter().filter(|route| held.contains(route)) {
        assert!(matched.contains(&(route, "/api/items")), "no path tried under /api/items matches {route}");
    }
}

/// Query parameters a route carries as a set (`#[route(query)]`).
#[derive(Clone, Debug, Default, PartialEq, serde::Deserialize, crate::Route)]
#[route(query)]
pub struct ParamsPaging {
    pub page: Option<u32>,
}

/// A set with each kind of parameter a route has: renamed, a list with no `#[serde(default)]`,
/// a prefix and a set of its own. It derives no `Deserialize`: `Params` reads it by its keys.
#[derive(Clone, Debug, Default, PartialEq, crate::Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct SetProbe {
    pub sort_by: Option<String>,
    pub tags: Vec<String>,
    #[route(prefix = "dimension.")]
    pub dims: Vec<(String, String)>,
    #[route(query)]
    pub paging: ParamsPaging,
}

#[derive(crate::Route)]
#[route("/probe")]
pub struct SetRoute {
    pub q: Option<String>,
    #[route(query)]
    pub set: SetProbe,
}

/// A set's fields with defaults of their own: a parameter the query leaves out is the field's.
#[derive(Debug, PartialEq, crate::Route)]
#[route(query)]
pub struct DefaultedSet {
    #[serde(default = "first_page")]
    pub page: u32,
    #[serde(default)]
    pub size: u32,
    #[route(prefix = "f.")]
    pub facets: std::collections::BTreeMap<String, String>,
}

fn first_page() -> u32 {
    1
}

/// A set with a type parameter.
#[derive(Debug, PartialEq, crate::Route)]
#[route(query)]
pub struct PickSet<T: std::fmt::Display> {
    pub pick: Option<T>,
}

#[derive(crate::Route)]
#[route("/defaulted")]
pub struct DefaultedRoute {
    #[route(query)]
    pub set: DefaultedSet,
    #[route(query)]
    pub pick: PickSet<u32>,
}

/// A set only links use: its field needs only `Display`.
#[derive(crate::Route)]
#[route(query)]
pub struct ShownSet {
    pub tab: Option<Shown>,
}

#[derive(crate::Route)]
#[route("/shown-set")]
struct ShownSetLink {
    #[route(query)]
    set: ShownSet,
}

/// A set over any other set, whose names it carries without naming a hidden trait.
#[derive(crate::Route)]
#[route(query)]
pub struct AroundSet<S: crate::route::QueryParams> {
    pub page: Option<u32>,
    #[route(query)]
    pub set: S,
}

#[derive(crate::Route)]
#[route("/around")]
struct AroundLink {
    #[route(query)]
    around: AroundSet<ShownSet>,
}

#[derive(crate::Route)]
#[route("/around-read")]
struct AroundRead {
    #[route(query)]
    around: AroundSet<PickSet<u32>>,
}

#[test]
fn a_query_set_reads_back_what_its_links_write() {
    use crate::route::FromUrl;
    let set = SetProbe {
        sort_by: Some("price".into()),
        tags: vec!["a".into(), "b&c".into()],
        dims: vec![("form".into(), "graded".into()), ("grade".into(), "PSA 8".into())],
        paging: ParamsPaging { page: Some(3) },
    };
    let href = SetRoute { q: Some("x".into()), set: set.clone() }.href();
    assert_eq!(href, "/probe?q=x&sortBy=price&tags=a&tags=b%26c&dimension.form=graded&dimension.grade=PSA%208&page=3");
    let read = <SetRoute as FromUrl>::__read((), href.split_once('?').unwrap().1).unwrap();
    assert_eq!((read.q.as_deref(), &read.set), (Some("x"), &set), "the prefix field is read back, not left empty");
    let read = <SetRoute as FromUrl>::__read((), "").unwrap();
    assert_eq!(read.set, SetProbe::default(), "a missing list is empty, as on a route");
    for query in ["page=x", "sortBy=a&sortBy=b"] {
        assert!(<SetRoute as FromUrl>::__read((), query).is_err(), "{query}");
    }
    let read = <DefaultedRoute as FromUrl>::__read((), "size=5&f.kind=graded&pick=7").unwrap();
    let facets = std::collections::BTreeMap::from([("kind".to_string(), "graded".to_string())]);
    assert_eq!((&read.set, &read.pick), (&DefaultedSet { page: 1, size: 5, facets }, &PickSet { pick: Some(7) }));
    let empty = <DefaultedRoute as FromUrl>::__read((), "").unwrap().set;
    assert_eq!(empty, DefaultedSet { page: 1, size: 0, facets: Default::default() });
    let link = ShownSetLink { set: ShownSet { tab: Some(Shown("a b".into())) } };
    assert_eq!(link.href(), "/shown-set?tab=a%20b");
    let around = AroundLink { around: AroundSet { page: Some(2), set: ShownSet { tab: Some(Shown("b".into())) } } };
    assert_eq!(around.href(), "/around?page=2&tab=b", "a generic set's nested set is written");
    let read = <AroundRead as FromUrl>::__read((), "page=2&pick=7").unwrap();
    assert_eq!((read.around.page, &read.around.set), (Some(2), &PickSet { pick: Some(7) }), "and read back");
}

/// A set whose value is a rule over what was sent (`FromQuery`): a listing only when every one
/// sent agrees, and whether any option has a value.
#[derive(Debug, Default, PartialEq)]
pub struct Chosen {
    pub listing: Option<String>,
    pub options: Vec<(String, String)>,
}

impl Chosen {
    /// Any option has a value: a rule across keys.
    fn filtered(&self) -> bool {
        self.options.iter().any(|(_, v)| !v.is_empty())
    }
}

#[derive(crate::Route)]
#[route(query)]
pub struct ChosenLink<'a> {
    pub listing: Option<&'a str>,
    #[route(prefix = "dimension.")]
    pub options: &'a [(String, String)],
}

#[derive(crate::Route)]
#[route(query)]
pub struct ChosenRead {
    pub listing: Vec<String>,
    #[route(prefix = "dimension.")]
    pub options: Vec<(String, String)>,
}

impl crate::route::FromQuery for Chosen {
    type Link<'a> = ChosenLink<'a>;
    type Read = ChosenRead;

    fn link(&self) -> ChosenLink<'_> {
        ChosenLink { listing: self.listing.as_deref(), options: &self.options }
    }

    fn from_query(read: ChosenRead) -> Result<Self, crate::form::FormError> {
        let mut listings = read.listing.into_iter().filter(|l| !l.is_empty());
        let first = listings.next();
        if first.as_deref() == Some("refuse") {
            return Err(serde::de::Error::custom("listing: refused"));
        }
        let listing = if listings.all(|l| Some(&l) == first.as_ref()) { first } else { None };
        Ok(Chosen { listing, options: read.options })
    }
}

#[derive(crate::Route)]
#[route("/chosen")]
pub struct ChosenRoute {
    pub q: Option<String>,
    #[route(query)]
    pub chosen: Chosen,
}

#[test]
fn a_query_set_can_be_a_rule_over_what_was_sent() {
    use crate::route::FromUrl;
    let chosen = Chosen { listing: Some("l 1".into()), options: vec![("form".into(), "graded".into())] };
    let href = ChosenRoute { q: Some("x".into()), chosen }.href();
    assert_eq!(href, "/chosen?q=x&listing=l%201&dimension.form=graded");
    let read = <ChosenRoute as FromUrl>::__read((), href.split_once('?').unwrap().1).unwrap();
    assert_eq!(
        (read.q.as_deref(), &read.chosen),
        (Some("x"), &Chosen { listing: Some("l 1".into()), options: vec![("form".into(), "graded".into())] }),
        "a link reads back as itself"
    );
    assert!(read.chosen.filtered());
    let read = <ChosenRoute as FromUrl>::__read((), "listing=l1&listing=l1&zz=1").unwrap();
    assert_eq!(read.chosen.listing.as_deref(), Some("l1"), "a value sent twice is the set's to judge");
    let read = <ChosenRoute as FromUrl>::__read((), "listing=l1&listing=l2&dimension.form=").unwrap();
    assert_eq!((read.chosen.listing.as_deref(), read.chosen.filtered()), (None, false), "two listings are no choice");
    let err = <ChosenRoute as FromUrl>::__read((), "listing=refuse").err().expect("the set's failure refuses the page");
    assert!(err.to_string().contains("refused"), "{err}");
    assert!(<ChosenRoute as FromUrl>::__read((), "q=a&q=b").is_err(), "the route's own parameters are read as before");
}

/// A route reads past a query key it does not name, so a page part's route reads the address
/// `rows::sort` gave its `ReadAgain::from`, which may carry a key only the page's route has (#885).
#[test]
fn a_route_reads_past_a_query_key_it_does_not_name() {
    use crate::route::FromUrl;
    #[derive(crate::Route)]
    #[route("/part")]
    struct PartRoute {
        after: Option<String>,
    }
    let read = <PartRoute as FromUrl>::__read((), "sold=price&after=r2").expect("an unnamed key is no error");
    assert_eq!(read.after.as_deref(), Some("r2"));
}

/// A `FromQuery` set whose `Read` names its fields in another order than its `Link`, both
/// including a derived set: the names, not their order, must match.
#[derive(Debug, PartialEq)]
pub struct Reordered {
    pub listing: Option<String>,
    pub page: Option<u32>,
}

#[derive(crate::Route)]
#[route(query)]
pub struct ReorderedLink<'a> {
    pub listing: Option<&'a str>,
    #[route(query)]
    pub paging: ParamsPaging,
}

#[derive(crate::Route)]
#[route(query)]
pub struct ReorderedRead {
    #[route(query)]
    pub paging: ParamsPaging,
    pub listing: Vec<String>,
}

impl crate::route::FromQuery for Reordered {
    type Link<'a> = ReorderedLink<'a>;
    type Read = ReorderedRead;

    fn link(&self) -> ReorderedLink<'_> {
        ReorderedLink { listing: self.listing.as_deref(), paging: ParamsPaging { page: self.page } }
    }

    fn from_query(read: ReorderedRead) -> Result<Self, crate::form::FormError> {
        Ok(Reordered { listing: read.listing.into_iter().next(), page: read.paging.page })
    }
}

#[derive(crate::Route)]
#[route("/reordered")]
pub struct ReorderedRoute {
    #[route(query)]
    pub set: Reordered,
}

#[test]
fn a_query_set_that_is_a_rule_matches_names_not_their_order() {
    use crate::route::FromUrl;
    let set = Reordered { listing: Some("l1".into()), page: Some(3) };
    let href = ReorderedRoute { set }.href();
    assert_eq!(href, "/reordered?listing=l1&page=3");
    let read = <ReorderedRoute as FromUrl>::__read((), href.split_once('?').unwrap().1).unwrap();
    assert_eq!(read.set, Reordered { listing: Some("l1".into()), page: Some(3) });
}

/// Search words read from `q`, or from the older `search` an address shared before the rename
/// has (`#[route(read_only)]`); links write only `q` (#577).
#[derive(Debug, PartialEq)]
pub struct Terms(pub Option<String>);

#[derive(crate::Route)]
#[route(query)]
pub struct TermsLink<'a> {
    pub q: Option<&'a str>,
}

#[derive(crate::Route)]
#[route(query)]
pub struct TermsRead {
    pub q: Vec<String>,
    #[route(read_only)]
    pub search: Vec<String>,
}

impl crate::route::FromQuery for Terms {
    type Link<'a> = TermsLink<'a>;
    type Read = TermsRead;

    fn link(&self) -> TermsLink<'_> {
        TermsLink { q: self.0.as_deref() }
    }

    fn from_query(read: TermsRead) -> Result<Self, crate::form::FormError> {
        Ok(Terms(read.q.into_iter().chain(read.search).find(|t| !t.is_empty())))
    }
}

#[derive(crate::Route)]
#[route("/search")]
pub struct SearchRoute {
    #[route(query)]
    pub terms: Terms,
    pub page: Option<u32>,
}

#[test]
fn an_older_name_is_read_and_never_written() {
    use crate::route::FromUrl;
    assert_eq!(SearchRoute { terms: Terms(Some("pika".into())), page: None }.href(), "/search?q=pika");
    for (query, words) in [("search=pika", Some("pika")), ("q=mew&search=pika", Some("mew")), ("page=2", None)] {
        let read = <SearchRoute as FromUrl>::__read((), query).unwrap();
        assert_eq!(read.terms, Terms(words.map(str::to_owned)), "{query}");
    }
    // The route counts the older name with its own, though no link writes it.
    use crate::route::__private::{Key, ReadKeys};
    assert!(<Terms as ReadKeys>::__KEYS.iter().any(|k| matches!(k, Key::ReadOnly("search"))));
}

/// A `FromQuery` set inside a derived one, beside the outer set's own names.
#[derive(crate::Route)]
#[route(query)]
pub struct ChosenOuter {
    pub sort: Option<String>,
    #[route(query)]
    pub chosen: Chosen,
}

#[derive(crate::Route)]
#[route("/chosen-outer")]
pub struct ChosenOuterRoute {
    #[route(query)]
    pub outer: ChosenOuter,
}

#[test]
fn a_query_set_that_is_a_rule_reads_inside_another() {
    use crate::route::FromUrl;
    let read = <ChosenOuterRoute as FromUrl>::__read((), "sort=price&listing=l1&dimension.form=graded").unwrap();
    assert_eq!(read.outer.sort.as_deref(), Some("price"));
    assert_eq!(read.outer.chosen, Chosen { listing: Some("l1".into()), options: vec![("form".into(), "graded".into())] });
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, crate::UrlValue)]
#[serde(rename_all = "snake_case")]
pub enum Filter {
    #[default]
    All,
    Due,
}

#[derive(Debug, PartialEq, serde::Deserialize, crate::Route)]
#[route(query)]
pub struct FilterSet {
    pub state: Option<Filter>,
}

#[derive(crate::Route)]
#[route("/filtered")]
pub struct Filtered {
    pub sort: Option<Filter>,
    #[serde(default)]
    pub shown: Filter,
    #[route(query)]
    pub set: FilterSet,
}

#[test]
fn a_query_word_the_app_no_longer_has_reads_as_missing() {
    use crate::route::FromUrl;
    let read = <Filtered as FromUrl>::__read((), "sort=due_now&shown=gone&state=old").unwrap();
    assert_eq!((read.sort, read.shown, read.set.state), (None, Filter::All, None));
    let read = <Filtered as FromUrl>::__read((), "sort=due&shown=due&state=due").unwrap();
    assert_eq!((read.sort, read.shown, read.set.state), (Some(Filter::Due), Filter::Due, Some(Filter::Due)));
    assert!(<Filtered as FromUrl>::__read((), "sort=due&sort=all").is_err(), "sent twice is still refused");
}

#[derive(crate::Route)]
#[route("/faceted")]
pub struct Faceted {
    #[route(prefix = "f.")]
    pub facets: std::collections::BTreeMap<Filter, Filter>,
    #[route(prefix = "n.")]
    pub counts: Vec<(Filter, u32)>,
}

#[test]
fn a_prefixed_entry_the_app_no_longer_has_is_left_out() {
    use crate::route::FromUrl;
    let read = <Faceted as FromUrl>::__read((), "f.due=all&f.gone=due&f.all=gone&n.due=2&n.old=3").unwrap();
    assert_eq!(read.facets, std::collections::BTreeMap::from([(Filter::Due, Filter::All)]));
    assert_eq!(read.counts, vec![(Filter::Due, 2)]);
    let err = <Faceted as FromUrl>::__read((), "n.due=two").err().expect("a value that is not a word is refused");
    assert!(err.to_string().contains("n.due: "), "the error names the parameter: {err}");
}

/// Every kind of parameter a route has, which its handler reads back as the link wrote it.
#[crate::routes]
mod params_url {
    #[route("/flags/{on}.txt", get = params_flag)]
    pub struct Flag {
        pub on: bool,
    }

    #[route("/shops/{shop}/items/{id}", get = params_item)]
    #[serde(rename_all = "camelCase")]
    pub struct Item<'a> {
        pub shop: &'a str,
        pub id: u32,
        pub sort_by: Option<&'a str>,
        pub tags: &'a [&'a str],
        #[serde(default)]
        pub mine: bool,
        #[route(query)]
        pub paging: super::ParamsPaging,
        #[route(prefix = "dim.")]
        pub dims: &'a std::collections::BTreeMap<String, String>,
    }

    #[route("/files/{*rest}", get = params_file)]
    pub struct File<'a> {
        pub rest: std::borrow::Cow<'a, str>,
    }

    /// A parameter followed by text in its segment: a sitemap's pages.
    #[route("/sitemap/{kind}/{page}.xml", get = params_sitemap)]
    pub struct SitemapPage<'a> {
        pub kind: &'a str,
        pub page: u32,
        pub gz: Option<bool>,
    }
}

paths! { Feeds = "/feeds" }

/// A route of an area with the same, added by hand (no `Params` in its handler).
#[derive(crate::Route)]
#[route("/feeds/{name}.rss")]
struct Rss<'a> {
    name: &'a str,
}

/// A value a link prints but nothing reads back: neither `Clone`, `Send` nor `Deserialize`.
pub struct Shown(std::rc::Rc<str>);

impl std::fmt::Display for Shown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// A route used only for links still needs only `Display` of its fields.
#[derive(crate::Route)]
#[route("/shown/{value}")]
#[serde(deny_unknown_fields)]
struct LinkOnly<'a> {
    value: &'a Shown,
    #[serde(alias = "t")]
    tab: Option<&'a Shown>,
}

/// The same fields with no serde key: its hidden owned twin is written, and asks nothing of
/// `Shown` until a handler reads the route's `Params`.
#[derive(crate::Route)]
#[route("/shown-twin/{value}")]
struct LinkTwin<'a> {
    value: &'a Shown,
    tab: Option<&'a Shown>,
}

/// The same with text after the parameter: still only `Display` for a link.
#[derive(crate::Route)]
#[route("/shown-file/{value}.xml")]
struct LinkFile<'a> {
    value: &'a Shown,
}

async fn params_item(item: crate::Params<params_url::Item<'_>>) -> String {
    let (shop, id, sort, tags, mine, page, dims) =
        (&item.shop, item.id, &item.sort_by, &item.tags, item.mine, item.paging.page, &item.dims);
    format!("{shop}|{id}|{sort:?}|{tags:?}|{mine}|{page:?}|{dims:?}")
}

async fn params_file(file: crate::Params<params_url::File<'_>>) -> String {
    file.rest.clone()
}

/// Routes whose path starts with a parameter, where a value starting with `/` could make the
/// href `//host/..`.
#[crate::routes]
pub(super) mod leading_url {
    #[route("/{*rest}", get = leading_rest)]
    pub struct Rest<'a> {
        pub rest: &'a str,
    }
}

async fn leading_rest(rest: crate::Params<leading_url::Rest<'_>>) -> String {
    rest.rest.clone()
}

/// Whether an unstaged route can match a path of Corten's own exactly, as the startup check asks it.
#[test]
fn a_route_matches_a_path_segment_by_segment() {
    let can = crate::route::routes_path;
    assert!(can("/.well-known/{a}/{b}", "/.well-known/oauth-protected-resource/mcp"));
    assert!(!can("/.well-known/{a}/{b}/{c}", "/.well-known/oauth-protected-resource/mcp"));
    assert!(can("/.well-known/{*rest}", "/.well-known/oauth-protected-resource/mcp"));
    assert!(!can("/.well-known/{file}", "/.well-known/oauth-protected-resource/mcp"));
    assert!(can("/{file}.webmanifest", "/manifest.webmanifest"));
    assert!(!can("/{file}.json", "/manifest.webmanifest"));
    assert!(!can("/manifest.webmanifest/{x}", "/manifest.webmanifest"));
    assert!(can("/sw.js", "/sw.js") && !can("/sw.js", "/sw.json"));
}

#[derive(crate::Route)]
#[route("/{user}/posts")]
struct UserPosts<'a> {
    user: &'a str,
}

#[tokio::test]
async fn a_path_that_starts_with_a_parameter_stays_on_this_site_and_reads_back() {
    let router = App::new(leading_url::router()).router();
    for (value, href) in [
        ("/evil.example/x", "/%2Fevil.example/x"),
        ("//evil.example", "/%2F/evil.example"),
        ("docs/a b.txt", "/docs/a%20b.txt"),
        ("a//b", "/a//b"),
    ] {
        let link = leading_url::Rest { rest: value };
        assert_eq!(link.href(), href, "{value:?}");
        assert_eq!(link.to_html(), href, "{value:?}");
        assert!(crate::Local::parse(&link.href()).is_some(), "{value:?} is a path on this site");
        let (status, _, body) = call_with(router.clone(), "GET", &link.href(), None, None).await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, value), "{href} reads back as the value");
    }
    // A `/` in a first `{name}` stays in its segment. An empty one would write `//posts`, which a
    // `/{slug}` route would read as the slug `/posts` once kept on the site, so it is refused as
    // it is written (route.rs, `a_value_a_path_cannot_carry_is_never_written_as_it_is`).
    assert_eq!(UserPosts { user: "/x" }.href(), "/%2Fx/posts");
    assert_eq!(UserPosts { user: "ann" }.href(), "/ann/posts");
    // A hand-written Route is OnSite too, so redirect_with_notice and resend_to check what it
    // writes, as a browser reads it: `\` is `/` to it, and it drops a tab.
    struct Evil(&'static str);
    impl crate::Route for Evil {
        type Data = crate::route::NoData;
        const PATH: &'static str = "/evil";
        fn write_href(&self, out: &mut String, _: bool) {
            out.push_str(self.0);
        }
    }
    for to in ["//evil.example/x", "/\\evil.example/x", "/\t/evil.example/x", "https://evil.example/x", "http:evil.example"] {
        let off = Table::new()
            .route("/", get(move |req: Req| async move { req.redirect_with_notice(&Evil(to), "Saved.") }))
            .route("/", crate::router::put(move |req: Req| async move { req.resend_to::<()>(&Evil(to)) }));
        let router = App::new(Routes::from(off)).router();
        for method in ["GET", "PUT"] {
            let (status, headers, _) = call_with(router.clone(), method, "/", None, None).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{method} {to:?}: {headers:?}");
            assert!(!headers.contains_key("location"), "{method} {to:?}");
        }
    }
}

async fn params_sitemap(page: crate::Params<params_url::SitemapPage<'_>>) -> String {
    format!("{}|{}|{:?}", page.kind, page.page, page.gz)
}

#[tokio::test]
async fn a_parameter_followed_by_text_is_read_without_it() {
    use crate::route::Route as _;
    assert_eq!(<params_url::SitemapPage<'_> as crate::Route>::PATH, "/sitemap/{kind}/{page}", "axum matches the segment");
    let link = params_url::SitemapPage { kind: "items", page: 3, gz: None };
    assert_eq!(link.href(), "/sitemap/items/3.xml");
    let router = App::new(params_url::router()).router();
    let (status, _, body) = call_with(router.clone(), "GET", &link.href(), None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "items|3|None"));
    let (_, _, body) = call_with(router.clone(), "GET", "/sitemap/items/12.xml?gz=true", None, None).await;
    assert_eq!(body, "items|12|Some(true)", "with a query");
    // The text is the route's: without it, or with nothing before it, no route matches.
    for path in ["/sitemap/items/3", "/sitemap/items/3.json", "/sitemap/items/.xml", "/sitemap/items/3.xml.bak"] {
        for method in ["GET", "DELETE"] {
            let (status, _, _) = call_with(router.clone(), method, path, None, None).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
        }
    }
    let (status, _, _) = call_with(router.clone(), "OPTIONS", "/sitemap/items/3.xml", None, None).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "a path the route serves, by another method");
    let (status, _, _) = call_with(router.clone(), "DELETE", "/sitemap/items/3.xml", None, None).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "matched, by a method no route here has");
    // A value that is not the parameter's type is refused as any path parameter is.
    let (status, _, body) = call_with(router.clone(), "GET", "/sitemap/items/x.xml", None, Some("text/plain")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.starts_with("Invalid URL: Cannot parse `x` to a `u32`"), "{body}");
    // A number as a path reads one, not as a number input sends it: `3.0` is no page's link.
    let (status, _, _) = call_with(router.clone(), "GET", "/sitemap/items/3.0.xml", None, Some("text/plain")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "3.0");

    // A route added to an area by hand is checked the same, with no `Params` to do it.
    let rss = crate::Methods::reads(get(|| async { "rss" }));
    let area = App::new(Routes::new()).area::<Feeds>(|feeds| feeds.route::<Rss>(rss));
    let router = area.router();
    let (status, _, body) = call_with(router.clone(), "GET", &Rss { name: "news" }.href(), None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "rss"));
    let (status, _, _) = call_with(router, "GET", "/feeds/news.atom", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // And one of an API, whose failures are JSON.
    let json = crate::Methods::reads(get(|| async { "json" }));
    let router = App::new(Routes::new()).api::<ApiRoot>(|api| api.route::<ApiFile>(json)).router();
    let (status, _, body) = call_with(router.clone(), "GET", &ApiFile { name: "rates" }.href(), None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "json"));
    let (status, headers, _) = call_with(router, "GET", "/api/files/rates.csv", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(headers[header::CONTENT_TYPE], "application/problem+json", "an API's 404");
}

#[derive(crate::Route)]
#[route("/api/files/{name}.json")]
struct ApiFile<'a> {
    name: &'a str,
}

#[derive(crate::Route)]
#[route("/feeds/{name}.atom")]
struct Atom<'a> {
    name: &'a str,
}

/// Two routes that differ only in the text after a parameter, in different places (the app's
/// routes and an area): axum would match them as one path, so the app does not start.
#[test]
#[should_panic(expected = "differ only in the text after a parameter")]
fn routes_that_differ_only_in_the_text_after_a_parameter_do_not_start() {
    let rss = crate::Methods::reads(get(|| async { "rss" }));
    let atom = crate::Methods::reads(crate::router::post(|| async { "atom" }));
    let _ = App::new(Routes::new().__route::<Rss>(rss)).area::<Feeds>(|feeds| feeds.route::<Atom>(atom)).router();
}

async fn params_flag(at: crate::Params<params_url::Flag>) -> String {
    at.on.to_string()
}

/// A value before text reads as a path parameter does: a `bool` is `true` or `false`, not a
/// checkbox's `on`.
#[tokio::test]
async fn a_value_before_text_reads_as_a_path_parameter() {
    let router = App::new(params_url::router()).router();
    let (status, _, body) = call_with(router.clone(), "GET", "/flags/true.txt", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "true"));
    let (status, _, _) = call_with(router, "GET", "/flags/on.txt", None, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[derive(crate::Route)]
#[route("/feeds/{kind}.json")]
struct FeedJson<'a> {
    kind: &'a str,
}

#[derive(crate::Route)]
#[route("/api/files/{name}.csv")]
struct ApiCsv<'a> {
    name: &'a str,
}

/// Two routes of one API that differ only in the text after a parameter.
#[test]
#[should_panic(expected = "differ only in the text after a parameter")]
fn routes_of_an_api_that_differ_only_in_the_text_after_a_parameter_do_not_start() {
    let json = crate::Methods::reads(get(|| async { "json" }));
    let csv = crate::Methods::reads(crate::router::post(|| async { "csv" }));
    let _ = App::new(Routes::new()).api::<ApiRoot>(|api| api.route::<ApiFile>(json).route::<ApiCsv>(csv));
}

/// A page and an API route that differ only in the text after a parameter.
#[test]
#[should_panic(expected = "differ only in the text after a parameter")]
fn a_page_and_an_api_route_that_differ_only_in_the_text_after_a_parameter_do_not_start() {
    let json = crate::Methods::reads(get(|| async { "json" }));
    let csv = crate::Methods::reads(crate::router::post(|| async { "csv" }));
    let _ = App::new(Routes::new().__route::<ApiCsv>(csv)).api::<ApiRoot>(|api| api.route::<ApiFile>(json)).router();
}

/// The same in one area, with other parameter names: refused by Corten before the router (which
/// would merge the two methods into one path, or refuse the names with a message about neither).
#[test]
#[should_panic(expected = "differ only in the text after a parameter")]
fn routes_of_an_area_that_differ_only_in_the_text_after_a_parameter_do_not_start() {
    let rss = crate::Methods::reads(get(|| async { "rss" }));
    let json = crate::Methods::reads(crate::router::post(|| async { "json" }));
    let _ = App::new(Routes::new()).area::<Feeds>(|feeds| feeds.route::<Rss>(rss).route::<FeedJson>(json));
}

#[derive(crate::Route)]
#[route("/feeds/{*rest}")]
struct FeedsRest<'a> {
    rest: &'a str,
}

/// A route with text after a parameter where another, in another module or an area, has its
/// catch-all: the router cannot hold the two, and Corten names both as written (axum would name
/// `/feeds/{name}`), in either order.
#[test]
#[should_panic(expected = "have a parameter where the other has its catch-all")]
fn a_route_with_text_beside_a_catch_all_does_not_start() {
    let rest = crate::Methods::reads(get(|| async { "rest" }));
    let rss = crate::Methods::reads(get(|| async { "rss" }));
    let _ = App::new(Routes::new().__route::<FeedsRest>(rest)).area::<Feeds>(|feeds| feeds.route::<Rss>(rss)).router();
}

#[test]
#[should_panic(expected = "have a parameter where the other has its catch-all")]
fn a_catch_all_beside_a_route_with_text_in_an_area_does_not_start() {
    let rest = crate::Methods::reads(get(|| async { "rest" }));
    let rss = crate::Methods::reads(get(|| async { "rss" }));
    let _ = App::new(Routes::new()).area::<Feeds>(|feeds| feeds.route::<Rss>(rss).route::<FeedsRest>(rest));
}

#[derive(crate::Route)]
#[route("/api/files/{*rest}")]
struct ApiFilesRest<'a> {
    rest: &'a str,
}

#[test]
#[should_panic(expected = "have a parameter where the other has its catch-all")]
fn a_route_with_text_beside_a_catch_all_in_an_api_does_not_start() {
    let json = crate::Methods::reads(get(|| async { "json" }));
    let rest = crate::Methods::reads(get(|| async { "rest" }));
    let _ = App::new(Routes::new()).api::<ApiRoot>(|api| api.route::<ApiFile>(json).route::<ApiFilesRest>(rest));
}

#[tokio::test]
async fn a_handler_reads_its_routes_parameters_as_the_link_wrote_them() {
    let router = App::new(params_url::router()).router();
    let dims = std::collections::BTreeMap::from([
        ("form".to_string(), "graded".to_string()),
        ("grade".to_string(), "PSA 8".to_string()),
    ]);
    let link = params_url::Item {
        shop: "a b/c",
        id: 7,
        sort_by: Some("price"),
        tags: &["x", "y&z"],
        mine: true,
        paging: ParamsPaging { page: Some(2) },
        dims: &dims,
    };
    assert_eq!(
        link.href(),
        "/shops/a%20b%2Fc/items/7?sortBy=price&tags=x&tags=y%26z&mine=true&page=2&dim.form=graded&dim.grade=PSA%208"
    );
    let (status, _, body) = call_with(router.clone(), "GET", &link.href(), None, None).await;
    assert_eq!(
        (status, &body[..]),
        (StatusCode::OK, r#"a b/c|7|Some("price")|["x", "y&z"]|true|Some(2)|{"form": "graded", "grade": "PSA 8"}"#)
    );
    let empty = std::collections::BTreeMap::new();
    let plain = params_url::Item {
        shop: "s",
        id: 1,
        sort_by: None,
        tags: &[],
        mine: false,
        paging: ParamsPaging::default(),
        dims: &empty,
    };
    let (status, _, body) = call_with(router.clone(), "GET", "/shops/s/items/1", None, None).await;
    assert_eq!((status, &body[..]), (StatusCode::OK, "s|1|None|[]|false|None|{}"), "{}", plain.href());
    let (_, _, body) = call_with(router.clone(), "GET", "/shops/s/items/1?sortBy=&other=1", None, None).await;
    assert_eq!(body, "s|1|None|[]|false|None|{}", "a blank value is none, and a parameter the route does not have is ignored");
    for uri in
        ["/shops/s/items/seven", "/shops/s/items/1?mine=maybe", "/shops/s/items/1?page=x", "/shops/s/items/1?sortBy=a&sortBy=b"]
    {
        let (status, _, _) = call_with(router.clone(), "GET", uri, None, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
    }
    let shown = Shown("x y".into());
    assert_eq!(LinkOnly { value: &shown, tab: Some(&shown) }.href(), "/shown/x%20y?tab=x%20y");
    assert_eq!(LinkTwin { value: &shown, tab: None }.href(), "/shown-twin/x%20y");
    assert_eq!(LinkFile { value: &shown }.href(), "/shown-file/x%20y.xml");
    let file = params_url::File { rest: "docs/a b.txt".into() };
    let (_, _, body) = call_with(router, "GET", &file.href(), None, None).await;
    assert_eq!(body, "docs/a b.txt", "{}", file.href());
}

#[crate::routes]
pub(super) mod serves_url {
    #[route("/check", get = serves_check)]
    pub struct Check;

    #[route("/items/{id}", get = serves_item)]
    pub struct Item {
        pub id: u32,
    }

    #[route("/files/{*rest}", get = serves_files)]
    pub struct Files {
        pub rest: String,
    }

    #[route("/cart/add", post = serves_check)]
    pub struct AddToCart;

    #[route("/cart/{id}", get = serves_cart_line)]
    pub struct CartLine {
        pub id: u32,
    }

    #[route("/both", post = serves_check, get = serves_check)]
    pub struct Both;

    #[route("/go", get = serves_go)]
    pub struct Go;
}

/// Every GET is a page here, but an API, Corten's own paths and its health checks are not.
#[crate::routes]
mod serves_catch_url {
    #[route("/{*page}", get = serves_any)]
    pub struct Page {
        pub page: String,
    }
}

#[tokio::test]
async fn a_catch_all_page_does_not_serve_an_api_or_cortens_own_paths() {
    let pwa = crate::pwa::Pwa::new(crate::pwa::Manifest::new("A", "A"));
    let router = App::new(serves_catch_url::router())
        .api::<ApiRoot>(|api| api.route::<ApiRates>(crate::Methods::reads(get(|| async { "rates" }))))
        .pwa(pwa)
        .router();
    for (p, want) in [
        ("/about/team", "local served"),
        ("/api/rates", "local elsewhere"),
        ("/api", "local elsewhere"),
        ("/health/live", "local elsewhere"),
        ("/corten/anything", "local elsewhere"),
        ("/manifest.webmanifest", "local elsewhere"),
        ("/service-worker.js", "local elsewhere"),
        ("/apis", "local served"),
    ] {
        let uri = format!("/check?p={}", form_urlencoded::byte_serialize(p.as_bytes()).collect::<String>());
        let (status, _, body) = call_with(router.clone(), "GET", &uri, None, None).await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, want), "{p:?}");
    }
}

/// Paths where matching by hand is easy to get wrong: an empty segment, a POST-only route the
/// router picks over a catch-all page, and a path routed by both the app and an area.
#[crate::routes]
mod serves_router_url {
    #[route("/check", get = serves_check)]
    pub struct Check;

    #[route("/items/{id}/edit", get = serves_edit)]
    pub struct Edit {
        pub id: String,
    }

    #[route("/x/{a}/y", post = serves_write)]
    pub struct Write {
        pub a: String,
    }

    #[route("/shop/cart", get = serves_page)]
    pub struct CartPage;

    #[route("/sitemap/{page}.xml", get = serves_sitemap)]
    pub struct Sitemap {
        pub page: u32,
    }

    #[route("/{*page}", get = serves_router_page)]
    pub struct Page {
        pub page: String,
    }
}

#[crate::routes(area = Shop)]
mod serves_shop_url {
    #[route("/shop")]
    pub struct Shop;

    #[route("/shop/cart", post = serves_page)]
    pub struct Cart;
}

#[derive(crate::Route)]
#[route("/shop/list")]
struct ShopList;

async fn serves_page() -> &'static str {
    "page"
}

// The routes above with a parameter in their path, each read by a handler that takes its `Params`.
async fn serves_edit(_: crate::Params<serves_router_url::Edit>) -> &'static str {
    serves_page().await
}

async fn serves_write(_: crate::Params<serves_router_url::Write>) -> &'static str {
    serves_page().await
}

async fn serves_sitemap(_: crate::Params<serves_router_url::Sitemap>) -> &'static str {
    serves_page().await
}

async fn serves_router_page(_: crate::Params<serves_router_url::Page>) -> &'static str {
    serves_page().await
}

async fn serves_item(_: crate::Params<serves_url::Item>, req: Req, uri: http::Uri) -> String {
    serves_check(req, uri).await
}

async fn serves_files(_: crate::Params<serves_url::Files>, req: Req, uri: http::Uri) -> String {
    serves_check(req, uri).await
}

async fn serves_cart_line(_: crate::Params<serves_url::CartLine>, req: Req, uri: http::Uri) -> String {
    serves_check(req, uri).await
}

async fn serves_any(_: crate::Params<serves_catch_url::Page>, req: Req, uri: http::Uri) -> String {
    serves_check(req, uri).await
}

/// `req.serves` says a path is served exactly when a GET to it reaches a page.
#[tokio::test]
async fn serves_agrees_with_the_router() {
    let router = App::new(serves_router_url::router())
        .area(|shop| serves_shop_url::area(shop).route::<ShopList>(crate::route::post(serves_page).get(serves_page)))
        .router();
    for (p, want) in [
        ("/items/7/edit", true),
        ("/items//edit", true),
        ("/items/7/", true),
        ("/x/1/y", false),
        // The POST-only parameter does not match an empty value, so the catch-all page does.
        ("/x//y", true),
        ("/x/1/z", true),
        ("/shop/cart", true),
        ("/shop/list", true),
        ("/about", true),
        ("/health/live", false),
        // The sitemap's route takes every path of its shape; one without its text is a 404.
        ("/sitemap/3.xml", true),
        ("/sitemap/about", false),
        ("/sitemap/.xml", false),
        ("/sitemap/3.xml/x", true),
    ] {
        let (status, _, body) = call_with(router.clone(), "GET", p, None, None).await;
        let routed = status == StatusCode::OK && body == "page";
        let uri = format!("/check?p={}", form_urlencoded::byte_serialize(p.as_bytes()).collect::<String>());
        let (_, _, says) = call_with(router.clone(), "GET", &uri, None, None).await;
        assert_eq!((routed, says == "local served"), (want, want), "{p:?}: {status} {body:?}, serves says {says:?}");
    }
}

/// A redirect to the return address in `?p=`, or to `/check` when it is not on this site.
async fn serves_go(req: Req, uri: http::Uri) -> HtmlResult {
    let p = form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()).find(|(k, _)| k == "p").map(|(_, v)| v.into_owned());
    match p.as_deref().and_then(crate::Local::parse) {
        Some(local) => req.redirect(&local),
        None => req.redirect(&serves_url::Check),
    }
}

/// Whether the app serves the path in `?p=`: "local served", "local elsewhere" or "not local".
async fn serves_check(req: Req, uri: http::Uri) -> String {
    let p = form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()).find(|(k, _)| k == "p").map(|(_, v)| v.into_owned());
    match p.as_deref().and_then(crate::route::Local::parse) {
        Some(local) if req.serves(&local) => "local served".into(),
        Some(_) => "local elsewhere".into(),
        None => "not local".into(),
    }
}

/// A return address the app serves is one of its pages, its areas' included; an API route, a
/// static file or Corten's own routes are not; and nothing that leads off the site is a `Local`.
#[tokio::test]
async fn an_app_says_whether_it_serves_a_return_address() {
    let router = App::new(serves_url::router())
        .area::<admin_url::Admin>(admin_url::area)
        .api::<ApiRoot>(|api| api.route::<ApiRates>(crate::Methods::reads(get(|| async { "rates" }))))
        .router();
    for (p, want) in [
        ("/check", "local served"),
        ("/check?x=1#top", "local served"),
        ("/items/7", "local served"),
        ("/items/anything", "local served"),
        ("/files/a/b/c.txt", "local served"),
        ("/admin", "local served"),
        ("/admin/users/3", "local served"),
        ("/items", "local elsewhere"),
        ("/items/", "local elsewhere"),
        ("/items/7/edit", "local elsewhere"),
        ("/files/", "local elsewhere"),
        ("/check/", "local elsewhere"),
        ("/api/rates", "local elsewhere"),
        ("/health/live", "local elsewhere"),
        ("/admin/users", "local elsewhere"),
        ("/market/cart", "local elsewhere"),
        ("/cart/add", "local elsewhere"),
        ("/cart/7", "local served"),
        ("/cart/%61dd", "not local"),
        ("/both", "local served"),
        ("/items/..", "not local"),
        ("/check/../admin", "not local"),
        ("//evil.example/check", "not local"),
        ("/\\evil.example", "not local"),
        ("/\t/evil.example", "not local"),
        ("https://evil.example/check", "not local"),
        ("check", "not local"),
    ] {
        let uri = format!("/check?p={}", form_urlencoded::byte_serialize(p.as_bytes()).collect::<String>());
        let (status, _, body) = call_with(router.clone(), "GET", &uri, None, None).await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, want), "{p:?}");
    }
    for (p, location) in [("/items/7?tab=reviews", "/items/7?tab=reviews"), ("//evil.example", "/check")] {
        let uri = format!("/go?p={}", form_urlencoded::byte_serialize(p.as_bytes()).collect::<String>());
        let (status, headers, _) = call_with(router.clone(), "GET", &uri, None, None).await;
        assert_eq!((status, headers["location"].to_str().unwrap()), (StatusCode::SEE_OTHER, location), "{p:?}");
    }
}

#[derive(Default, crate::Route)]
#[route(query)]
#[serde(rename_all = "camelCase")]
pub struct KeptPaging {
    pub sort_by: Option<String>,
    pub page_no: Option<u32>,
}

#[derive(crate::Route)]
#[route("/kept")]
pub struct Kept {
    pub q: Option<String>,
    pub tags: Vec<String>,
    #[route(prefix = "dim.")]
    pub dims: std::collections::BTreeMap<String, String>,
    #[route(query)]
    pub paging: KeptPaging,
}

#[test]
fn keep_query_keeps_every_key_the_controls_do_not_name() {
    use crate::form::keep_query;
    let at = Kept {
        q: Some("a \"b\" <c>".into()),
        tags: vec!["x".into(), "y".into()],
        dims: [("color".to_string(), "red".to_string()), ("size".to_string(), "9".to_string())].into(),
        paging: KeptPaging { sort_by: Some("price".into()), page_no: Some(3) },
    };
    // A set's field, a prefixed entry and a list, each named by a control: none is kept.
    let html = keep_query(
        &at,
        html! {
            <select name="sortBy"><option>"price"</option></select>
            <input name="dim.color" value="blue">
            for tag in ["x", "z"] { <input type="checkbox" name="tags" value={tag}> }
        },
    )
    .to_html();
    assert!(!html.contains(r#"type="hidden" name="sortBy""#) && !html.contains(r#"type="hidden" name="tags""#), "{html}");
    assert!(!html.contains(r#"type="hidden" name="dim.color""#), "{html}");
    assert!(
        html.ends_with(concat!(
            r#"<input type="hidden" name="q" value="a &quot;b&quot; &lt;c&gt;">"#,
            r#"<input type="hidden" name="dim.size" value="9">"#,
            r#"<input type="hidden" name="pageNo" value="3">"#,
        )),
        "the rest, escaped, in the route's order: {html}"
    );
    // Text that only looks like a name is not one.
    let html = keep_query(&at, html! { <p>" name=\"q\""</p> }).to_html();
    assert!(html.contains(r#"type="hidden" name="q""#), "{html}");
    // A link given as `&dyn Href` (a form several pages share) works the same.
    let shared: &dyn crate::Href = &at;
    assert!(keep_query(shared, "").to_html().contains(r#"name="pageNo" value="3""#));
    // A route with no query keeps nothing.
    assert_eq!(
        keep_query(&Kept { q: None, tags: vec![], dims: Default::default(), paging: KeptPaging::default() }, "x").to_html(),
        "x"
    );
}

/// A route's parameters are read from the path it matched: a middleware that rewrites the URI after
/// does not change them. A value that is not UTF-8 once decoded is a 400 naming the parameter, and a
/// handler that reads a route's parameters as another number of them, or a request no router
/// matched, is the app's fault (a 500).
#[tokio::test]
async fn path_parameters_are_read_from_the_path_matched() {
    struct Rewrite;
    impl crate::Middleware for Rewrite {
        async fn call(&self, mut req: Request<Body>, next: impl crate::Next) -> crate::response::Response {
            *req.uri_mut() = http::Uri::from_static("/n/123456");
            next.run(req).await
        }
    }
    let routes = || {
        Table::new()
            .route("/n/{n}", get(|Num(n): Num<u32>| async move { n.to_string() }))
            .route("/s/{s}", get(|Num(s): Num<String>| async move { s }))
            .route(
                "/two/{a}",
                get(|req: crate::http::Request| async move {
                    match crate::route::read_path::<(u32, u32)>(&req.into_parts().0) {
                        Ok(_) => StatusCode::OK.into_response(),
                        Err(rejection) => rejection.into_response(),
                    }
                }),
            )
    };
    use crate::response::IntoResponse;
    let app = App::new(Routes::from(routes())).middleware(Rewrite).router();
    let (status, _, body) = call_with(app, "GET", "/n/7", None, None).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "7"));
    let (status, _, body) = call_with(routes(), "GET", "/s/%FF", None, Some("application/json")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("Invalid UTF-8 in `s`"), "{body}");
    let (status, _, _) = call_with(routes(), "GET", "/two/1", None, None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    // A handler called with no router before it.
    let (mut parts, _) = Request::get("/n/7").body(Body::empty()).unwrap().into_parts();
    let unmatched = <Num<u32> as crate::extract::FromRequestParts<()>>::from_request_parts(&mut parts, &()).await;
    assert_eq!(unmatched.err().unwrap().into_response().status(), StatusCode::INTERNAL_SERVER_ERROR);
}
