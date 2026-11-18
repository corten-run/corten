//! Literal HTML nesting whose start tags close or discard an open element. This is not an HTML
//! validator. A refusal rests only on literal markup of the same `html!` that lies between the two
//! elements: what the markup does not show (its caller's context, a component's output or
//! children, `<Corten />` among them, an expression's output, `raw` among them) may open or close
//! anything. It may also leave a browser reading text: a `<script>`, a `<textarea>`, a
//! `<plaintext>` or a comment it opens runs on past any later literal start tag, which is then
//! not a tag at all. So once the walk passes one, nothing after it in the same `html!` is
//! refused, whatever it shows. The content of a `<template>` and of a foreign element (an `<svg>`,
//! a `<math>`, their integration points, or one whose namespace the markup does not show) starts
//! with no element open. A `<script>` or `<style>` whose text may end the holder early or keep
//! it open is also unseen: `</script>` in script data ends it where the text says, while
//! `<!--<script>` can keep it open past the generated end tag.
//! What a `<noscript>` holds is not walked (text with scripting on), nor what an element a browser
//! parsing HTML reads as text holds where the markup does not show it is HTML's (`<iframe>`,
//! `<textarea>`, `<style>` at the top of an `html!`): it may be text. A `<plaintext>` written
//! there may make the rest of the page text, so nothing after it is refused either.
//!
//! Every refusal assumes the `html!`'s output is drawn where a browser reads tags: a component
//! written into a script's text that its caller left open (after `raw("<script>")`) is not
//! supported, since a script's text comes from a string, not markup.

use super::{as_html, breaks_out, may_read_as_text, parsing_within, reads_as_text, writes_tags, Attr, Error, Node, Parsing};
use crate::tokens::err;
use proc_macro::Span;

/// The "in body" start tags that close a p in button scope. A table is deliberately absent:
/// it closes a p only outside quirks mode, which a fragment's markup does not establish.
const CLOSE_P: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "center",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "header",
    "hgroup",
    "main",
    "menu",
    "nav",
    "ol",
    "p",
    "search",
    "section",
    "summary",
    "ul",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "pre",
    "listing",
    "form",
    "li",
    "dd",
    "dt",
    "plaintext",
    "hr",
    "xmp",
];

/// HTML's "special" category, which stops the li / dd / dt backwards search (apart from
/// address, div and p). Foreign elements stop it too; HTML can resume there only at an
/// integration point, all of which the standard makes special.
const SPECIAL: &[&str] = &[
    "address",
    "applet",
    "area",
    "article",
    "aside",
    "base",
    "basefont",
    "bgsound",
    "blockquote",
    "body",
    "br",
    "button",
    "caption",
    "center",
    "col",
    "colgroup",
    "dd",
    "details",
    "dir",
    "div",
    "dl",
    "dt",
    "embed",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "frame",
    "frameset",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hgroup",
    "hr",
    "html",
    "iframe",
    "img",
    "input",
    "keygen",
    "li",
    "link",
    "listing",
    "main",
    "marquee",
    "menu",
    "meta",
    "nav",
    "noembed",
    "noframes",
    "noscript",
    "object",
    "ol",
    "p",
    "param",
    "plaintext",
    "pre",
    "script",
    "search",
    "section",
    "select",
    "source",
    "style",
    "summary",
    "table",
    "tbody",
    "td",
    "template",
    "textarea",
    "tfoot",
    "th",
    "thead",
    "title",
    "tr",
    "track",
    "ul",
    "wbr",
    "xmp",
];

const IMPLIED_END: &[&str] = &["dd", "dt", "li", "optgroup", "option", "p", "rb", "rp", "rt", "rtc"];

struct Open<'a> {
    name: &'a str,
    html: bool,
}

/// The walk's state, in document order.
struct Walk<'a> {
    open: Vec<Open<'a>>,
    /// The elements of `open` below this index are outside the template or foreign element whose
    /// content is being walked, and are not open in it.
    floor: usize,
    /// Whether a node the markup does not show comes before this point (`holds_unseen`). What it
    /// writes may close the open elements or open others, and may leave a browser reading text,
    /// so from there to the end of the `html!` no start tag is known to be read as one.
    unseen: bool,
}

/// Whether `nodes` hold something the markup does not show, at any depth: an expression, a
/// component (`<Corten />` too: the macro sees only its name, which an app's component may
/// share), a `<script>` or `<style>` whose text may write tags (`writes_tags`), or a `<plaintext>`
/// (refused where the markup shows it is HTML's; elsewhere it may make the rest of the page text).
pub(super) fn holds_unseen(nodes: &[Node]) -> bool {
    nodes.iter().any(|node| match node {
        Node::Expr(_) | Node::Component { .. } => true,
        Node::Element { name, children, .. } => {
            writes_tags(name, children) || name.eq_ignore_ascii_case("plaintext") || holds_unseen(children)
        }
        Node::Block { bodies, .. } => bodies.iter().any(|body| holds_unseen(body)),
        Node::Text(_) | Node::Markup(_) | Node::Let(_) => false,
    })
}

fn is(name: &str, names: &[&str]) -> bool {
    names.iter().any(|n| name.eq_ignore_ascii_case(n))
}

fn scope_boundary(el: &Open<'_>) -> bool {
    !el.html || is(el.name, &["applet", "caption", "html", "table", "td", "th", "marquee", "object", "template"])
}

fn in_scope<'a>(open: &[Open<'a>], name: &str) -> Option<&'a str> {
    for el in open.iter().rev() {
        if el.html && el.name.eq_ignore_ascii_case(name) {
            return Some(el.name);
        }
        if scope_boundary(el) {
            break;
        }
    }
    None
}

/// The open element this start tag closes or discards, if the literal ancestors establish it.
/// `open` holds only the elements known to be open: those written since the last thing the
/// markup does not show, in the content being walked. Every rule searches it from the innermost
/// element out and stops at a literal match or boundary, and finds nothing past its end. A nested
/// `<form>` is not among them: a browser ignores one only outside every `<template>`, which no
/// markup the walk reaches shows (a fragment's caller may write it into one, and a document's
/// body follows `<Corten />`, which is unseen).
fn displaced<'a>(open: &[Open<'a>], name: &str) -> Option<&'a str> {
    if is(name, &["select", "input"]) {
        if let Some(select) = in_scope(open, "select") {
            return Some(select);
        }
    }
    if is(name, CLOSE_P) {
        for el in open.iter().rev() {
            if el.html && el.name.eq_ignore_ascii_case("p") {
                return Some(el.name);
            }
            if scope_boundary(el) || (el.html && el.name.eq_ignore_ascii_case("button")) {
                break;
            }
        }
    }
    if is(name, &["li", "dd", "dt"]) {
        for el in open.iter().rev() {
            let closes = if name.eq_ignore_ascii_case("li") { &["li"][..] } else { &["dd", "dt"][..] };
            if el.html && is(el.name, closes) {
                return Some(el.name);
            }
            if !el.html || (is(el.name, SPECIAL) && !is(el.name, &["address", "div", "p"])) {
                break;
            }
        }
    }
    if is(name, &["a", "button", "nobr"]) {
        for el in open.iter().rev() {
            if el.html && el.name.eq_ignore_ascii_case(name) {
                return Some(el.name);
            }
            let boundary = if name.eq_ignore_ascii_case("a") {
                // Active-formatting-list markers, not button scope. An a inside an object is
                // independent of one outside it.
                el.html && is(el.name, &["applet", "marquee", "object", "template", "caption", "td", "th"])
            } else {
                scope_boundary(el)
            };
            if boundary {
                break;
            }
        }
    }
    if let Some(el) = open.last().filter(|e| e.html) {
        let implied = is(el.name, IMPLIED_END);
        let option = is(name, &["option", "optgroup", "hr"])
            && if in_scope(open, "select").is_some() {
                implied && !(name.eq_ignore_ascii_case("option") && el.name.eq_ignore_ascii_case("optgroup"))
            } else {
                is(name, &["option", "optgroup"]) && el.name.eq_ignore_ascii_case("option")
            };
        let ruby = is(name, &["rb", "rtc", "rp", "rt"])
            && implied
            && in_scope(open, "ruby").is_some()
            && !(is(name, &["rp", "rt"]) && el.name.eq_ignore_ascii_case("rtc"));
        if option || ruby {
            return Some(el.name);
        }
    }
    let heading = |n| is(n, &["h1", "h2", "h3", "h4", "h5", "h6"]);
    open.last().filter(|e| e.html && heading(e.name) && heading(name)).map(|e| e.name)
}

pub(super) fn check(nodes: &[Node]) -> Result<(), Error> {
    walk(nodes, Parsing::Unknown, &mut Walk { open: Vec::new(), floor: 0, unseen: false })
}

fn walk<'a>(nodes: &'a [Node], parsing: Parsing, w: &mut Walk<'a>) -> Result<(), Error> {
    for node in nodes {
        // Past something the markup does not show, a browser may be reading text that a later
        // literal end tag does not end (`<!--<script>`, `<plaintext>`), or what follows may be
        // anywhere: nothing after it is refused.
        if w.unseen {
            return Ok(());
        }
        match node {
            Node::Element { name, attrs, children } => {
                let html = html_element(parsing, name, attrs);
                if html {
                    if let Some(parent) = displaced(&w.open[w.floor..], name) {
                        return err(
                            Span::call_site(),
                            format!(
                                "<{name}> cannot be nested in the open <{parent}>: a browser closes <{parent}> before <{name}>, so refs can leave their component's scope; put them beside one another, or use a container that can hold both (a <div> instead of a <p>)"
                            ),
                        );
                    }
                }
                w.open.push(Open { name, html });
                // Text a `<script>` or `<style>` writes as is may end it and open anything.
                // Text holders are already checked by the parser; a noscript is text with
                // scripting enabled and markup without it, and an element read as text where the
                // markup does not show it is HTML's holds text or elements, so do not assume
                // either here. What they hold is not walked, but an expression there may still
                // close them.
                if writes_tags(name, children) || reads_as_text(parsing, name) || may_read_as_text(parsing, name) {
                    w.unseen |= holds_unseen(std::slice::from_ref(node));
                } else {
                    // A template's content, and a foreign element's, start with no element open.
                    let floor = w.floor;
                    if name.eq_ignore_ascii_case("template") || !html {
                        w.floor = w.open.len();
                    }
                    walk(children, parsing_within(parsing, name, attrs), w)?;
                    w.floor = floor;
                }
                w.open.pop();
            }
            // One body or another, or one again: each is walked from where the block starts, as
            // the first time it is written (a refusal in the first run holds whenever it runs);
            // what follows the block follows any of them.
            Node::Block { bodies, .. } => {
                let mut unseen = false;
                for body in bodies {
                    w.unseen = false;
                    walk(body, parsing, w)?;
                    unseen |= w.unseen;
                }
                w.unseen = unseen;
            }
            // A component writes what it likes before its children, a `<script>` perhaps, so
            // nothing in them or after them is refused; `<Corten />` is one like any other.
            Node::Component { .. } | Node::Expr(_) => w.unseen = true,
            Node::Text(_) | Node::Markup(_) | Node::Let(_) => {}
        }
    }
    Ok(())
}

fn html_element(parsing: Parsing, name: &str, attrs: &[Attr]) -> bool {
    if is(name, &["svg", "math"]) || (parsing == Parsing::MathText && is(name, &["mglyph", "malignmark"])) {
        return false;
    }
    as_html(parsing) || (parsing == Parsing::Unknown && breaks_out(name, attrs))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lost(ancestors: &[&str], name: &str) -> bool {
        let open: Vec<_> = ancestors.iter().map(|name| Open { name, html: true }).collect();
        displaced(&open, name).is_some()
    }

    #[test]
    fn starts_close_only_the_elements_their_search_reaches() {
        for tag in CLOSE_P {
            assert!(lost(&["p", "span"], tag), "{tag}");
            for barrier in ["button", "table", "td", "th", "template", "object"] {
                assert!(!lost(&["p", barrier, "span"], tag), "{barrier}: {tag}");
            }
        }
        assert!(!lost(&["p"], "table"));
        assert!(!lost(&["p"], "button"));
        assert!(lost(&["li", "div", "span"], "li"));
        assert!(!lost(&["li", "ul"], "li"));
        assert!(lost(&["dt", "span"], "dd"));
        assert!(!lost(&["dt", "dl"], "dd"));
        assert!(lost(&["a", "div", "span"], "a"));
        assert!(!lost(&["a", "object"], "a"));
        assert!(!lost(&["a", "table", "caption"], "a"));
        // A browser ignores a nested form only outside every template, which no markup shows.
        assert!(!lost(&["form", "div"], "form"));
        assert!(lost(&["button", "span"], "button"));
        assert!(!lost(&["button", "object"], "button"));
        assert!(lost(&["h1"], "h2"));
        assert!(!lost(&["h1", "span"], "h2"));
        assert!(lost(&["select", "option"], "input"));
        assert!(lost(&["select", "option"], "select"));
        assert!(!lost(&["select", "object"], "select"));
        assert!(lost(&["select", "option"], "option"));
        assert!(lost(&["option"], "optgroup"));
        assert!(lost(&["select", "optgroup"], "optgroup"));
        assert!(lost(&["select", "optgroup", "option"], "hr"));
        assert!(!lost(&["select", "optgroup"], "option"));
        assert!(!lost(&["optgroup"], "optgroup"));
        assert!(!lost(&["select", "option", "span"], "option"));
        assert!(lost(&["ruby", "rt"], "rt"));
        assert!(lost(&["ruby", "rtc"], "rb"));
        assert!(lost(&["ruby", "p"], "rt"));
        assert!(!lost(&["ruby", "rtc"], "rt"));
        assert!(!lost(&["ruby", "rt", "span"], "rt"));
        assert!(!lost(&["rt"], "rt"));
    }

    fn el(name: &str, children: Vec<Node>) -> Node {
        Node::Element { name: name.into(), attrs: Vec::new(), children }
    }

    /// Browsers keep each of these; the check passes them by starting a template's content and a
    /// foreign element's with nothing open. (A refusal needs a macro's span: see the
    /// `compile_fail` examples in corten's `view` module.)
    #[test]
    fn templates_and_foreign_content_start_with_nothing_open() {
        let link =
            |point: &str, foreign: &str| el("div", vec![el("a", vec![el(foreign, vec![el(point, vec![el("a", Vec::new())])])])]);
        let kept = [
            link("foreignObject", "svg"),
            link("title", "svg"),
            link("desc", "svg"),
            link("mtext", "math"),
            link("mi", "math"),
            el("template", vec![el("div", vec![el("form", vec![el("form", vec![el("input", Vec::new())])])])]),
            el("div", vec![el("form", vec![el("template", vec![el("form", Vec::new())])])]),
            el("div", vec![el("p", vec![el("template", vec![el("div", Vec::new())])])]),
            // A fragment's caller may write it into a template, where a nested form is kept.
            el("div", vec![el("form", vec![el("form", vec![el("input", Vec::new())])])]),
        ];
        for node in kept {
            assert!(check(std::slice::from_ref(&node)).is_ok());
        }
    }

    fn expr() -> Node {
        Node::Expr(proc_macro::TokenStream::new())
    }

    fn component(children: Option<Vec<Node>>) -> Node {
        Node::Component { path: proc_macro::TokenStream::new(), props: Vec::new(), children }
    }

    /// A `<script>` or `<style>` whose text `html!` writes as is: `</script>` there ends it.
    fn writes(name: &str, text: &str) -> Node {
        el(name, vec![Node::Text(text.into())])
    }

    /// Each refusal needs every element between the two to be literal: an expression, or a
    /// component, may write a boundary (`raw("<button>")`), close the outer element, open an
    /// `<svg>` or a `<template>`, and browsers keep what follows. One of each kind, the
    /// expression between the two elements, inside them both or before the outer, compiles, and
    /// so does a `<script>` or `<style>` whose text may write tags in the same places.
    #[test]
    fn nothing_the_markup_does_not_show_is_assumed_between_two_elements() {
        // [around, outer, inner]: the inner one is refused when written straight in the outer.
        let kinds: &[(&[&str], &str, &str)] = &[
            (&["div"], "p", "div"),
            (&["ul"], "li", "li"),
            (&["dl"], "dt", "dd"),
            (&["div"], "a", "a"),
            (&["div"], "button", "button"),
            (&["div"], "nobr", "nobr"),
            (&["div"], "h1", "h2"),
            (&["div"], "select", "input"),
            (&["div", "select"], "option", "option"),
            (&["div", "ruby"], "rt", "rt"),
        ];
        let wrap = |around: &[&str], node: Node| around.iter().rev().fold(node, |node, name| el(name, vec![node]));
        for &(around, outer, inner) in kinds {
            let between = [
                // Between them, inside the outer.
                vec![el(outer, vec![expr(), el(inner, Vec::new())])],
                // Inside an element of the outer that closes before the inner opens.
                vec![el(outer, vec![el("span", vec![expr()]), el(inner, Vec::new())])],
                // A component with or without children between them.
                vec![el(outer, vec![component(None), el(inner, Vec::new())])],
                vec![el(outer, vec![component(Some(vec![el("span", Vec::new())])), el(inner, Vec::new())])],
                // In a block before the inner, which any later body follows.
                vec![el(
                    outer,
                    vec![
                        Node::Block { head: Vec::new(), bodies: vec![vec![expr()], Vec::new()], arms: false },
                        el(inner, Vec::new()),
                    ],
                )],
                // A script or style that ends itself and may open a boundary, its `<` split
                // across two literals or keeping the script open (`<!--<script>`).
                vec![el(outer, vec![writes("script", "</script><button><script>"), el(inner, Vec::new())])],
                vec![el(outer, vec![writes("style", "</style><object><style>"), el(inner, Vec::new())])],
                vec![el(
                    outer,
                    vec![el("script", vec![Node::Text("<".into()), Node::Text("/script><span>".into())]), el(inner, Vec::new())],
                )],
                vec![el(outer, vec![writes("script", "<!--<script>"), el(inner, Vec::new())])],
                vec![el(outer, vec![el("span", vec![writes("script", "</script></span><object>")]), el(inner, Vec::new())])],
            ];
            for nodes in between {
                let node = wrap(around, nodes.into_iter().next().unwrap());
                assert!(check(std::slice::from_ref(&node)).is_ok(), "{outer} {inner}");
            }
            // Before the outer, anywhere earlier: what it writes may open an <svg>, whose <a> or
            // <option> are SVG's, or leave a browser reading a script's text, which a literal
            // element taken out of foreign content (a <p>) does not end.
            let refused = || wrap(around, el(outer, vec![el(inner, Vec::new())]));
            let befores: [fn() -> Node; 7] = [
                expr,
                || component(None),
                || component(Some(Vec::new())),
                || el("span", vec![expr()]),
                || el("title", vec![expr()]),
                || writes("script", "<!--<script>"),
                || Node::Block { head: Vec::new(), bodies: vec![vec![expr()], Vec::new()], arms: false },
            ];
            for (i, before) in befores.iter().enumerate() {
                assert!(check(&[before(), refused()]).is_ok(), "{outer} {inner} after {i}");
                // Into a fresh context: a template's content, an <svg>'s integration point.
                for fresh in [el("template", vec![refused()]), el("svg", vec![el("foreignObject", vec![refused()])])] {
                    assert!(check(&[before(), fresh]).is_ok(), "{outer} {inner} in a fresh context after {i}");
                }
            }
            // A component's children follow what it writes first.
            assert!(check(&[component(Some(vec![refused()]))]).is_ok(), "{outer} {inner} as children");
        }
        // A nested form in a whole document compiles, after `<Corten />` as before anything.
        let forms = el("form", vec![el("form", vec![el("input", Vec::new())])]);
        let document = el("html", vec![el("head", vec![component(None)]), el("body", vec![el("main", vec![forms])])]);
        assert!(check(&[document]).is_ok());
    }

    /// A script's text that may write tags leaves what follows it unseen: `</script><svg><script>`
    /// makes the `<a>`s after it SVG's, which browsers keep nested, and `<!--<script>` keeps the
    /// script open past its literal end tag, so a later literal `<svg>`, `<p>` or `<textarea>`
    /// shows nothing either.
    #[test]
    fn a_script_whose_text_may_write_tags_shows_neither_namespace_nor_open_elements() {
        for holder in [writes("script", "</script><svg><script>"), writes("style", "</style><svg><style>")] {
            assert!(check(&[el("div", vec![holder, el("a", vec![el("a", Vec::new())])])]).is_ok());
        }
        let detail = || el("div", vec![Node::Text("Detail".into())]);
        let laters = [
            || el("svg", vec![el("div", vec![Node::Text("Detail".into())])]),
            || el("p", vec![el("div", vec![Node::Text("Detail".into())])]),
            || el("svg", vec![el("foreignObject", vec![el("p", vec![el("div", Vec::new())])])]),
            || el("template", vec![el("p", vec![el("div", Vec::new())])]),
            || el("div", vec![el("textarea", vec![el("g", Vec::new())])]),
        ];
        for (i, later) in laters.iter().enumerate() {
            for opener in [writes("script", "<!--<script>"), expr(), component(None)] {
                assert!(check(&[el("div", vec![opener, later(), expr()])]).is_ok(), "{i}");
            }
            // Inside a block, which what follows it follows.
            let block = Node::Block { head: Vec::new(), bodies: vec![vec![expr()]], arms: false };
            assert!(check(&[el("div", vec![block, later()]), el("p", vec![detail()])]).is_ok(), "{i} after a block");
        }
        assert!(holds_unseen(&[writes("style", "</style>")]));
        assert!(holds_unseen(&[el("div", vec![writes("script", "</script><svg>")])]));
        assert!(!holds_unseen(&[el("div", vec![writes("script", "a <b")])]));
        assert!(check(&[el("p", vec![writes("script", "a <b"), detail()])]).is_err());
        assert!(!holds_unseen(&[writes("script", "track();")]));
        // Only a script's or a style's text is written as is; a <title>'s is escaped.
        assert!(!holds_unseen(&[writes("title", "</title>")]));
        assert!(holds_unseen(&[component(None)]));
    }

    /// A literal `<svg>` or `<math>` where how the browser parses is not known does not show its
    /// namespace: a `<math>` written in an `<svg>` is SVG's, and its `<mtext>` no integration
    /// point; an `<svg>` straight in a `<math>` is MathML's, and its `<title>` none.
    #[test]
    fn a_foreign_root_whose_namespace_the_markup_does_not_show_shows_no_integration_point() {
        let links = |root: &str, point: &str| el(root, vec![el(point, vec![el("a", vec![el("a", Vec::new())])])]);
        for (root, point) in [("math", "mtext"), ("math", "mi"), ("svg", "title"), ("svg", "foreignObject"), ("svg", "desc")] {
            assert!(check(&[links(root, point)]).is_ok(), "{root} {point}");
            // Supplied as a component's children, which it may write into the other one.
            assert!(check(&[component(Some(vec![links(root, point)]))]).is_ok(), "{root} {point} as children");
            // After an expression in an element that showed HTML.
            assert!(check(&[el("div", vec![expr(), links(root, point)])]).is_ok(), "{root} {point} after an expression");
        }
    }

    /// What an element a browser parsing HTML reads as text holds, where the markup does not show
    /// the element is HTML's, may be text (browsers keep `<iframe><p><div>` as written there): it
    /// is not walked, and a `<noscript>`'s nowhere. After a `<plaintext>` there nothing is refused.
    #[test]
    fn what_an_element_that_may_read_as_text_holds_is_not_walked() {
        let detail = || el("p", vec![el("div", vec![Node::Text("Detail".into())])]);
        let holders = ["iframe", "noscript", "xmp", "noembed", "noframes", "style", "textarea", "title", "script", "plaintext"];
        for holder in holders {
            assert!(check(&[el(holder, vec![detail()])]).is_ok(), "{holder}");
            // At an integration point of an <svg> whose own namespace the markup does not show.
            let point = el("svg", vec![el("foreignObject", vec![el(holder, vec![detail()])])]);
            assert!(check(&[point]).is_ok(), "{holder} in a foreignObject");
            // Among a block's bodies, and nested in an element the markup does not show is HTML's.
            let block = Node::Block { head: Vec::new(), bodies: vec![vec![el(holder, vec![detail()])]], arms: false };
            assert!(check(&[el("section", vec![block])]).is_ok(), "{holder} in a block");
        }
        // A <noscript> is text with scripting on, under an element that shows HTML too.
        assert!(check(&[el("div", vec![el("noscript", vec![detail()])])]).is_ok());
        // A <plaintext> where it may be HTML's may make the rest of the page text.
        assert!(check(&[el("section", vec![el("plaintext", Vec::new())]), detail()]).is_ok());
        assert!(holds_unseen(&[el("plaintext", Vec::new())]));
        // In an <svg> they hold elements, walked as SVG's (a <p> there is refused by the parser).
        assert!(!may_read_as_text(Parsing::Foreign, "style") && !may_read_as_text(Parsing::Svg, "iframe"));
        assert!(may_read_as_text(Parsing::Svg, "noscript") && may_read_as_text(Parsing::Html, "noscript"));
        assert!(!may_read_as_text(Parsing::Html, "iframe") && reads_as_text(Parsing::Html, "iframe"));
        // Text alone in one does not hide what follows it.
        assert!(!holds_unseen(&[el("iframe", vec![Node::Text("Preview".into())])]));
    }

    #[test]
    #[ignore]
    fn nesting_check_cost() {
        let row = || Node::Element {
            name: "li".into(),
            attrs: Vec::new(),
            children: vec![Node::Element {
                name: "p".into(),
                attrs: Vec::new(),
                children: vec![Node::Element {
                    name: "span".into(),
                    attrs: Vec::new(),
                    children: vec![Node::Text("Row".into())],
                }],
            }],
        };
        let nodes = [Node::Element { name: "ul".into(), attrs: Vec::new(), children: (0..1_000).map(|_| row()).collect() }];
        let rounds = 1_000;
        for _ in 0..3 {
            let start = std::time::Instant::now();
            for _ in 0..rounds {
                check(std::hint::black_box(&nodes)).unwrap();
            }
            println!("nesting check, 3001 elements: {:.1} us/expansion", start.elapsed().as_secs_f64() * 1e6 / rounds as f64);
        }
    }
}
