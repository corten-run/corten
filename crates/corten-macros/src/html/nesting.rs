//! Literal HTML nesting whose start tags close or discard an open element. This is not an HTML
//! validator: it follows the existing namespace evidence and never crosses a component's edge,
//! a `<template>` or a foreign element (an `<svg>`, a `<math>`, their integration points, or
//! one whose namespace the markup does not show). Their content starts with no element open, so
//! the check never refuses markup there by an ancestor it cannot be sure the browser still holds.

use super::{as_html, breaks_out, parsing_within, Attr, Error, Node, Parsing};
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
/// document's markup (`is_document`) is known to be outside one: any other `html!`, and a
/// component's children, may be written into a `<template>` by a caller.
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
/// Every rule but the form's searches `open` from the innermost element out and stops at a
/// literal match or boundary, so what lies outside the markup cannot change its answer. The form
/// pointer is not reset by scope, and a template's content does not use it, so a nested form is
/// refused only where the markup shows it is outside every template.
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
    walk(nodes, Parsing::Unknown, &mut Vec::new(), template)
}

fn walk<'a>(nodes: &'a [Node], parsing: Parsing, open: &mut Vec<Open<'a>>, template: Template) -> Result<(), Error> {
    for node in nodes {
        match node {
            Node::Element { name, attrs, children } => {
                let html = html_element(parsing, name, attrs);
                if html {
                    if let Some(parent) = displaced(open, name, template) {
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
                open.push(Open { name, html });
                // Text holders are already checked by the parser; noscript is text with
                // scripting enabled and markup without it, so do not assume either here.
                if !(html && (super::reads_as_text(parsing, name) || name.eq_ignore_ascii_case("noscript"))) {
                    let within = parsing_within(parsing, name, attrs);
                    // A template's content, and a foreign element's, start with no element open.
                    if name.eq_ignore_ascii_case("template") {
                        walk(children, within, &mut Vec::new(), Template::Inside)?;
                    } else if !html {
                        walk(children, within, &mut Vec::new(), template)?;
                    } else {
                        walk(children, within, open, template)?;
                    }
                }
                open.pop();
            }
            Node::Block { bodies, .. } => {
                for body in bodies {
                    walk(body, parsing, open, template)?;
                }
            }
            // A component's children go where it writes them, perhaps into a template of its
            // own; inside a template they stay in it.
            Node::Component { children: Some(children), .. } => {
                let template = if template == Template::Inside { Template::Inside } else { Template::Unknown };
                walk(children, Parsing::Unknown, &mut Vec::new(), template)?
            }
            _ => {}
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
