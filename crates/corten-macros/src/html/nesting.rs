//! Literal HTML nesting whose start tags close or discard an open element. This is not an HTML
//! validator: it follows the existing namespace evidence and never crosses a component's edge.

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

/// The open element this start tag closes or discards, if the literal ancestors establish it.
fn displaced<'a>(open: &[Open<'a>], name: &str) -> Option<&'a str> {
    // Forms use the form pointer, not element scope. A template allows a nested form, including
    // one inside a form in that template; the pointer is not used while any template is open.
    if name.eq_ignore_ascii_case("form") && !open.iter().any(|e| e.html && e.name.eq_ignore_ascii_case("template")) {
        if let Some(form) = open.iter().rev().find(|e| e.html && e.name.eq_ignore_ascii_case("form")) {
            return Some(form.name);
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
    let heading = |n| is(n, &["h1", "h2", "h3", "h4", "h5", "h6"]);
    open.last().filter(|e| e.html && heading(e.name) && heading(name)).map(|e| e.name)
}

pub(super) fn check(nodes: &[Node]) -> Result<(), Error> {
    walk(nodes, Parsing::Unknown, &mut Vec::new())
}

fn walk<'a>(nodes: &'a [Node], parsing: Parsing, open: &mut Vec<Open<'a>>) -> Result<(), Error> {
    for node in nodes {
        match node {
            Node::Element { name, attrs, children } => {
                let html = html_element(parsing, name, attrs);
                if html {
                    if let Some(parent) = displaced(open, name) {
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
                    walk(children, parsing_within(parsing, name, attrs), open)?;
                }
                open.pop();
            }
            Node::Block { bodies, .. } => {
                for body in bodies {
                    walk(body, parsing, open)?;
                }
            }
            Node::Component { children: Some(children), .. } => check(children)?,
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
        assert!(lost(&["form", "table", "td"], "form"));
        assert!(!lost(&["form", "template", "form"], "form"));
        assert!(lost(&["button", "span"], "button"));
        assert!(!lost(&["button", "object"], "button"));
        assert!(lost(&["h1"], "h2"));
        assert!(!lost(&["h1", "span"], "h2"));
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
