//! Literal HTML nesting whose start tags close or discard an open element. This is not an HTML
//! validator. A refusal rests only on literal markup of the same `html!` that lies between the two
//! elements: what the markup does not show (its caller's context, a component's output or
//! children, an expression's output, `raw` among them) may open or close anything, so after one
//! nothing open before it is known to be open, how the markup is parsed is not known until an
//! element shows it again, and nothing is known to be outside a `<template>`. The content of a
//! `<template>` and of a foreign element (an `<svg>`, a `<math>`, their integration points, or
//! one whose namespace the markup does not show) starts with no element open too. A `<script>`
//! or `<style>` whose literal text holds a `<` is unseen as well: `html!` writes that text as is,
//! and `</script>` in it ends the element where the text says, not where the markup does.

use super::{as_html, breaks_out, is_corten, parsing_within, writes_tags, Attr, Error, Node, Parsing};
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

/// Whether the markup being walked is in a template's content, as far as it shows. Only a
/// document's markup (`is_document`) is known to be outside one, and only before anything it does
/// not show (`Walk::opaque`), which may open a `<template>`: any other `html!`, and a component's
/// children, may be written into a `<template>` by a caller.
#[derive(Clone, Copy, PartialEq)]
enum Template {
    Inside,
    Outside,
    Unknown,
}

struct Open<'a> {
    name: &'a str,
    html: bool,
}

/// The walk's state, in document order.
struct Walk<'a> {
    open: Vec<Open<'a>>,
    /// The elements of `open` below this index are not known to be open where the walk is: they
    /// were opened before something the markup does not show, or outside the template or foreign
    /// element whose content is being walked.
    floor: usize,
    /// How many nodes the markup does not show have been passed (expressions, components and
    /// their children, but `<Corten />`, whose head tags open nothing, and a `<script>` or
    /// `<style>` whose text may write tags).
    opaque: usize,
}

impl Walk<'_> {
    /// Past a node the markup does not show: what it writes may close the open elements, or open
    /// others (a `<button>`, an `<svg>`, a `<template>`) that change what follows.
    fn unseen(&mut self) {
        self.opaque += 1;
        self.floor = self.open.len();
    }
}

/// Whether `nodes` hold something the markup does not show, at any depth: an expression, a
/// component, or a `<script>` or `<style>` whose text may write tags (`writes_tags`).
pub(super) fn holds_unseen(nodes: &[Node]) -> bool {
    nodes.iter().any(|node| match node {
        Node::Expr(_) => true,
        Node::Component { path, .. } => !is_corten(path),
        Node::Element { name, children, .. } => writes_tags(name, children) || holds_unseen(children),
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
/// markup does not show, in the content being walked. Every rule but the form's searches it from
/// the innermost element out and stops at a literal match or boundary, and finds nothing past its
/// end. The form pointer is not reset by scope, and a template's content does not use it, so a
/// nested form is refused only where the markup shows it is outside every template.
fn displaced<'a>(open: &[Open<'a>], name: &str, template: Template) -> Option<&'a str> {
    if name.eq_ignore_ascii_case("form") && template == Template::Outside {
        if let Some(form) = open.iter().rev().find(|e| e.html && e.name.eq_ignore_ascii_case("form")) {
            return Some(form.name);
        }
    }
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

/// `document`: the markup is a whole document (`<!DOCTYPE html>` and `<html>`), the page itself,
/// so outside every template. Written into a template it would not be kept as written anyway:
/// a browser drops its `<html>`, `<head>` and `<body>` tags there.
pub(super) fn check(nodes: &[Node], document: bool) -> Result<(), Error> {
    let template = if document { Template::Outside } else { Template::Unknown };
    walk(nodes, Parsing::Unknown, template, &mut Walk { open: Vec::new(), floor: 0, opaque: 0 })
}

fn walk<'a>(nodes: &'a [Node], mut parsing: Parsing, template: Template, w: &mut Walk<'a>) -> Result<(), Error> {
    for node in nodes {
        let seen = w.opaque;
        match node {
            Node::Element { name, attrs, children } => {
                let html = html_element(parsing, name, attrs);
                if html {
                    let template = if template == Template::Outside && w.opaque > 0 { Template::Unknown } else { template };
                    if let Some(parent) = displaced(&w.open[w.floor..], name, template) {
                        let action = if name.eq_ignore_ascii_case("form") && parent.eq_ignore_ascii_case("form") {
                            "ignores the nested <form> start tag".into()
                        } else {
                            format!("closes <{parent}> before <{name}>")
                        };
                        return err(
                            Span::call_site(),
                            format!(
                                "<{name}> cannot be nested in the open <{parent}>: a browser {action}, so refs can leave their component's scope; put them beside one another, or use a container that can hold both (a <div> instead of a <p>)"
                            ),
                        );
                    }
                }
                w.open.push(Open { name, html });
                // Text a `<script>` or `<style>` writes as is may end it and open anything: from
                // there, nothing open is known, nor how what it holds and what follows is parsed.
                let escapes = writes_tags(name, children);
                if escapes {
                    w.unseen();
                }
                // Text holders are already checked by the parser; noscript is text with
                // scripting enabled and markup without it, so do not assume either here. What
                // they hold is not walked, but an expression there may still close them.
                if html && (super::reads_as_text(parsing, name) || name.eq_ignore_ascii_case("noscript")) {
                    if holds_unseen(children) {
                        w.unseen();
                    }
                } else {
                    let within = if escapes { Parsing::Unknown } else { parsing_within(parsing, name, attrs) };
                    // A template's content, and a foreign element's, start with no element open.
                    let template_content = name.eq_ignore_ascii_case("template");
                    let fresh = template_content || !html;
                    let (floor, before) = (w.floor, w.opaque);
                    if fresh {
                        w.floor = w.open.len();
                    }
                    walk(children, within, if template_content { Template::Inside } else { template }, w)?;
                    if fresh && w.opaque == before {
                        w.floor = floor;
                    }
                }
                w.open.pop();
                w.floor = w.floor.min(w.open.len());
            }
            // One body or another, or one again: each is walked from where the block starts, as
            // the first time it is written; what follows the block follows any of them.
            Node::Block { bodies, .. } => {
                let (floor, before) = (w.floor, w.opaque);
                let mut unseen = false;
                for body in bodies {
                    (w.floor, w.opaque) = (floor, before);
                    walk(body, parsing, template, w)?;
                    unseen |= w.opaque != before;
                }
                (w.floor, w.opaque) = (floor, before);
                if unseen {
                    w.unseen();
                }
            }
            // `<Corten />` marks where Corten writes its own head tags, which open nothing.
            Node::Component { path, .. } if is_corten(path) => {}
            // A component writes what it likes around its children, perhaps a template of its
            // own; inside a template they stay in it, and they are walked as markup of their own.
            Node::Component { children, .. } => {
                w.unseen();
                if let Some(children) = children {
                    walk(children, Parsing::Unknown, template, w)?;
                    w.unseen();
                }
            }
            Node::Expr(_) => w.unseen(),
            Node::Text(_) | Node::Markup(_) | Node::Let(_) => {}
        }
        // Past something the markup does not show, it shows nothing of how what follows is
        // parsed, until an element shows it again.
        if w.opaque != seen {
            parsing = Parsing::Unknown;
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
        displaced(&open, name, Template::Outside).is_some()
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
        assert!(lost(&["form", "table", "td"], "form"));
        for template in [Template::Inside, Template::Unknown] {
            assert!(displaced(&[Open { name: "form", html: true }], "form", template).is_none());
        }
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
            assert!(check(std::slice::from_ref(&node), false).is_ok());
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
                assert!(check(std::slice::from_ref(&node), false).is_ok(), "{outer} {inner}");
            }
            // Before the outer, inside the elements that showed HTML: what it writes may open an
            // <svg>, whose <a> or <option> are SVG's.
            // (An element taken out of foreign content shows HTML again itself, so a <p> after
            // one is still refused.)
            if !breaks_out(outer, &[]) {
                let node = wrap(
                    around,
                    Node::Block {
                        head: Vec::new(),
                        bodies: vec![vec![expr(), el(outer, vec![el(inner, Vec::new())])]],
                        arms: false,
                    },
                );
                assert!(check(std::slice::from_ref(&node), false).is_ok(), "{outer} {inner} after an expression");
            }
        }
        // A nested form in a whole document, after an expression (`raw("<template>")`) or a
        // component anywhere before it.
        let document = |before: Node| {
            let forms = el("form", vec![el("form", vec![el("input", Vec::new())])]);
            el("html", vec![el("head", vec![before]), el("body", vec![el("main", vec![forms])])])
        };
        for before in [
            expr(),
            component(None),
            el("header", vec![expr()]),
            el("title", vec![expr()]),
            writes("script", "</script><template><script>"),
            el("header", vec![writes("style", "</style><template><style>")]),
        ] {
            assert!(check(&[document(before)], true).is_ok());
        }
    }

    /// A script's text that may write tags leaves what follows it unseen: `</script><svg><script>`
    /// makes the `<a>`s after it SVG's, which browsers keep nested.
    #[test]
    fn a_script_whose_text_may_write_tags_shows_neither_namespace_nor_open_elements() {
        for holder in [writes("script", "</script><svg><script>"), writes("style", "</style><svg><style>")] {
            assert!(check(&[el("div", vec![holder, el("a", vec![el("a", Vec::new())])])], false).is_ok());
        }
        assert!(holds_unseen(&[writes("style", "</style>")]));
        assert!(holds_unseen(&[el("div", vec![writes("script", "a <b")])]));
        assert!(!holds_unseen(&[writes("script", "track();")]));
        // Only a script's or a style's text is written as is; a <title>'s is escaped.
        assert!(!holds_unseen(&[writes("title", "</title>")]));
    }

    /// A literal `<svg>` or `<math>` where how the browser parses is not known does not show its
    /// namespace: a `<math>` written in an `<svg>` is SVG's, and its `<mtext>` no integration
    /// point; an `<svg>` straight in a `<math>` is MathML's, and its `<title>` none.
    #[test]
    fn a_foreign_root_whose_namespace_the_markup_does_not_show_shows_no_integration_point() {
        let links = |root: &str, point: &str| el(root, vec![el(point, vec![el("a", vec![el("a", Vec::new())])])]);
        for (root, point) in [("math", "mtext"), ("math", "mi"), ("svg", "title"), ("svg", "foreignObject"), ("svg", "desc")] {
            assert!(check(&[links(root, point)], false).is_ok(), "{root} {point}");
            // Supplied as a component's children, which it may write into the other one.
            assert!(check(&[component(Some(vec![links(root, point)]))], false).is_ok(), "{root} {point} as children");
            // After an expression in an element that showed HTML.
            assert!(check(&[el("div", vec![expr(), links(root, point)])], false).is_ok(), "{root} {point} after an expression");
        }
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
                check(std::hint::black_box(&nodes), false).unwrap();
            }
            println!("nesting check, 3001 elements: {:.1} us/expansion", start.elapsed().as_secs_f64() * 1e6 / rounds as f64);
        }
    }
}
