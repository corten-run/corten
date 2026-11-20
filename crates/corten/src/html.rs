//! Small HTML helpers with no dependencies.

#[cfg(any(debug_assertions, test))]
mod scan;
#[cfg(any(debug_assertions, test))]
use scan::{lone_lt, raw_text_end, script_end, Mode, Token, Tokens};
#[cfg(debug_assertions)]
pub(crate) use scan::{Event, Markup};

/// Escapes text for use in HTML text or a quoted attribute.
/// To append to a string instead, use [`crate::view::escape_into`].
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    crate::view::escape_into(text, &mut out);
    out
}

/// Text that [`escape`] wrote, read back: the five entities it writes become their characters
/// again, and nothing else changes.
#[cfg(feature = "json")]
pub(crate) fn unescape(text: &str) -> std::borrow::Cow<'_, str> {
    if !text.contains('&') {
        return std::borrow::Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let entity = [("&amp;", '&'), ("&lt;", '<'), ("&gt;", '>'), ("&quot;", '"'), ("&#39;", '\'')]
            .into_iter()
            .find(|(entity, _)| rest.starts_with(entity));
        match entity {
            Some((entity, c)) => {
                out.push(c);
                rest = &rest[entity.len()..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    std::borrow::Cow::Owned(out)
}

#[cfg(all(test, feature = "json"))]
#[test]
fn unescape_reads_back_what_escape_wrote() {
    let text = "Pika <Promo> & \"Friends\" 'x' &amp";
    assert_eq!(unescape(&escape(text)), text);
    assert_eq!(unescape("plain"), "plain");
}

/// `text` as a JSON string literal, quotes included. `<` is escaped too, so the result is safe
/// inside an inline `<script>`.
pub(crate) fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '<' => out.push_str("\\u003c"),
            c if (c as u32) < 0x20 || c == '\u{2028}' || c == '\u{2029}' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A start tag as `html!` writes it, read by [`start_tag`].
#[cfg(any(debug_assertions, test))]
pub(crate) struct Tag<'a> {
    /// Where its `<` is, and one past its `>`.
    pub start: usize,
    pub end: usize,
    /// Its name, in lowercase.
    pub name: String,
    /// Its attributes in order: each name and its value as written, entities and all (empty for
    /// one written without a value).
    pub attrs: Vec<(&'a str, &'a str)>,
    /// It ends `/>`.
    pub self_closing: bool,
    /// It ends at its `>`: the patch does not end inside it (a browser drops a tag the input ends
    /// in, `<col data-note='` without its quote's end or its `>`).
    pub complete: bool,
}

#[cfg(any(debug_assertions, test))]
impl Tag<'_> {
    /// The value of its first attribute `name` (in any case), as written.
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(attr, _)| attr.eq_ignore_ascii_case(name)).map(|(_, value)| *value)
    }
}

/// The start tag whose `<` is at `html[start]`, read as the HTML standard's tokenizer reads one.
/// A value in `"` or `'` is read to its closing quote, so what a quoted value holds is never
/// taken for the tag's own: `data-on` is single-quoted and its JSON has `"` in it
/// (`docs/design.md#choice-data-on-single-quoted`). Whitespace may come around an attribute's
/// `=`, and only a `/` right before the `>` makes it self-closing.
#[cfg(any(debug_assertions, test))]
fn start_tag(html: &str, start: usize) -> Tag<'_> {
    let mut attrs = Vec::new();
    let (name, end, self_closing) = scan::read_tag(html, start + 1, |name, value| attrs.push((name, value)));
    Tag { start, end: end.min(html.len()), name: name.to_ascii_lowercase(), attrs, self_closing, complete: end <= html.len() }
}

/// Each start tag of a page, including those in inert templates that a script can copy.
#[cfg(test)]
pub(crate) fn start_tags(html: &str) -> impl Iterator<Item = Tag<'_>> {
    scan::tags(html, true)
}

#[cfg(debug_assertions)]
pub(crate) fn start_tags_no_script(html: &str) -> impl Iterator<Item = Tag<'_>> {
    scan::tags(html, false)
}

/// Elements that have no end tag, and those the HTML parser closes at once as it does them.
#[cfg(any(debug_assertions, test))]
const VOID: &[&str] = &[
    "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link", "meta",
    "param", "source", "track", "wbr",
];

/// Whether the `<form>` whose start tag ends at `from` in `html` holds what a page shows: a
/// start tag ended by its `>`, or text that shows ([`text_shows`]; a `<` that starts no tag among it), before its
/// end tag `</form>`, past comments ended by `-->`, bogus ones (`<!note>`, `<?x>`, `</ x>`), a
/// `<!DOCTYPE html>`, a `</>` and a void element's end tag (`</input>`), which show nothing. A `<form>` a
/// table's reading puts in empty moves what it holds out of it, which loses an element or text
/// from it, and a form of only whitespace or a comment shows the same either way. Any other token
/// before a start tag or text (another end tag, `</form >`, a comment a browser ends elsewhere
/// than at its `-->`, another doctype, text with a named character reference it does not decode, a
/// start tag the patch ends in) is not read: `Err` with where it starts and ends.
#[cfg(any(debug_assertions, test))]
fn holds_shown(html: &str, from: usize) -> Result<bool, (usize, usize)> {
    let bytes = html.as_bytes();
    let mut at = from;
    while let Some(n) = html.get(at..).and_then(|rest| rest.find('<')) {
        let start = at + n;
        match text_shows(&html[at..start]) {
            Some(true) => return Ok(true),
            Some(false) => {}
            None => return Err((at, start)),
        }
        let rest = &html[start..];
        let to_gt = rest.find('>').map_or(html.len(), |n| start + n + 1);
        if rest.starts_with("<!--") {
            at = comment_end(html, start).ok_or((start, to_gt))?;
            continue;
        }
        if lone_lt(bytes, start) {
            return Ok(true);
        }
        if doctype(bytes, start) == Some(false) {
            return Err((start, to_gt));
        }
        match bytes.get(start + 1) {
            // A start tag counts once it ends at its `>`: one the patch ends in is dropped, and its
            // `</form>` with it (`<b title='</form>`), so it is not read.
            Some(c) if c.is_ascii_alphabetic() => {
                return if start_tag(html, start).complete { Ok(true) } else { Err((start, html.len())) };
            }
            Some(b'/') if bytes.get(start + 2).is_some_and(u8::is_ascii_alphabetic) => match exact_end_tag(html, start) {
                Some((name, _)) if name.eq_ignore_ascii_case("form") => return Ok(false),
                Some((name, end)) if ignored_end_tag(name) => at = end,
                _ => return Err((start, to_gt)),
            },
            // A bogus comment, a doctype or a `</>`, which shows nothing: up to its `>`.
            Some(b'!' | b'?' | b'/') => at = to_gt,
            _ => return Ok(true),
        }
    }
    text_shows(&html[at..]).ok_or((at, html.len()))
}

/// The end tag at `html[at]` when it is written exactly `</name>`, as `html!` writes one: its
/// name and one past its `>`. `None` for one with anything between its name and `>`
/// (`</div ignored>`, `</div/>`, `</div >`), which the check does not read.
#[cfg(any(debug_assertions, test))]
fn exact_end_tag(html: &str, at: usize) -> Option<(&str, usize)> {
    let bytes = html.as_bytes();
    let start = at + 2;
    if !bytes.get(start).is_some_and(u8::is_ascii_alphabetic) {
        return None;
    }
    let len = bytes[start..].iter().position(|c| c.is_ascii_whitespace() || matches!(c, b'/' | b'>'))?;
    (bytes[start + len] == b'>').then(|| (&html[start..start + len], start + len + 1))
}

/// Whether the browser ignores the end tag `</name>` where no element of that name is open: a
/// void element's (`html!` writes one for a `<param>` or a `<basefont>`), but a `</br>`, which it
/// reads as a `<br>`.
#[cfg(any(debug_assertions, test))]
fn ignored_end_tag(name: &str) -> bool {
    !name.eq_ignore_ascii_case("br") && VOID.iter().any(|void| void.eq_ignore_ascii_case(name))
}

/// The strict patch checks stop at comments that do not end as `html!` writes them.
#[cfg(any(debug_assertions, test))]
fn comment_end(html: &str, at: usize) -> Option<usize> {
    let (end, ordinary) = scan::comment(html, at);
    ordinary.then_some(end)
}

/// Whether `text`, written in an HTML element, shows: `Some(true)` when it has a character but ASCII
/// whitespace and NUL (which the HTML parser ignores outside foreign content), its character
/// references decoded; `Some(false)` when it has none. A numeric reference is decoded (it is
/// whitespace only for a tab, line feed, form feed, carriage return or space), `&Tab;` and
/// `&NewLine;` are whitespace, and `html!`'s own escapes (`&amp;`, `&lt;`, `&gt;`, `&quot;`,
/// `&#39;`) and `&nbsp;` show; `None` when the text shows nothing else and has another named
/// reference, which the check does not decode. Debug builds only.
#[cfg(any(debug_assertions, test))]
pub(crate) fn text_shows(text: &str) -> Option<bool> {
    let bytes = text.as_bytes();
    let mut undecided = false;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\t' | b'\n' | b'\x0c' | b'\r' | b' ' | 0 => i += 1,
            b'&' => {
                let (shows, end) = reference(bytes, i);
                match shows {
                    Some(true) => return Some(true),
                    Some(false) => {}
                    None => undecided = true,
                }
                i = end;
            }
            _ => return Some(true),
        }
    }
    if undecided {
        None
    } else {
        Some(false)
    }
}

/// The character reference whose `&` is at `bytes[at]`, as [`text_shows`] reads it: whether it
/// shows (`None` for a named one it does not decode) and one past it. A `&` that starts no
/// reference (`&`, `&#;`) is the text `&`, which shows.
#[cfg(any(debug_assertions, test))]
fn reference(bytes: &[u8], at: usize) -> (Option<bool>, usize) {
    let mut i = at + 1;
    if bytes.get(i) == Some(&b'#') {
        i += 1;
        let hex = matches!(bytes.get(i), Some(b'x' | b'X'));
        if hex {
            i += 1;
        }
        let digits = i;
        let mut value: u32 = 0;
        while let Some(digit) = bytes.get(i).and_then(|c| (*c as char).to_digit(if hex { 16 } else { 10 })) {
            value = value.saturating_mul(if hex { 16 } else { 10 }).saturating_add(digit);
            i += 1;
        }
        if i == digits {
            return (Some(true), at + 1);
        }
        if bytes.get(i) == Some(&b';') {
            i += 1;
        }
        // A tab, line feed, form feed, carriage return or space; any other number is a character
        // (U+FFFD for 0, a surrogate or one past Unicode), which shows.
        return (Some(!matches!(value, 9 | 10 | 12 | 13 | 32)), i);
    }
    while bytes.get(i).is_some_and(u8::is_ascii_alphanumeric) {
        i += 1;
    }
    if i == at + 1 {
        return (Some(true), at + 1);
    }
    let semicolon = bytes.get(i) == Some(&b';');
    let name = &bytes[at + 1..i];
    if semicolon {
        i += 1;
    }
    let shows = if semicolon && (name == b"Tab" || name == b"NewLine") {
        Some(false)
    } else if [&b"amp"[..], b"lt", b"gt", b"quot", b"nbsp"].contains(&name) {
        // Decoded with or without its `;`.
        Some(true)
    } else {
        None
    };
    (shows, i)
}

/// Whether `html[at..]` starts a doctype (`<!doctype` in any letter case), and whether it is the one
/// `<!DOCTYPE html>` (in any letter case), which a browser ignores in a patch. The check reads no
/// other: what it holds (a quoted `>` ends it early) is not followed.
#[cfg(any(debug_assertions, test))]
fn doctype(bytes: &[u8], at: usize) -> Option<bool> {
    let is = |from: usize, what: &[u8]| bytes.get(from..from + what.len()).is_some_and(|b| b.eq_ignore_ascii_case(what));
    is(at, b"<!doctype").then(|| is(at, b"<!doctype html>"))
}

/// What the browser would drop from a patch (`action.patch`, a [`crate::live`] fragment): the first
/// top-level element without an `id`, or top-level text, described for an error. The runtime
/// replaces each top-level element by its id and ignores the rest, so either is a view that never
/// shows. Reads markup as `html!` writes it (attribute values quoted, `<` escaped in text), each
/// element closed by its own end tag written `</name>`; at a token it does not read so (an end tag
/// written otherwise or that closes no element open, an HTML element's start tag ending `/>`, a
/// start tag the patch ends in, a doctype but `<!DOCTYPE html>`, text with a named character
/// reference it does not decode at the top level or in a table holder ([`text_shows`]), an element
/// the browser does not put where it is written ([`misplaced`])), it stops and finds nothing after
/// it, which [`patch_parse_checked`] logs.
/// Checked in debug builds only.
#[cfg(any(debug_assertions, test))]
pub(crate) fn patch_problem(html: &str) -> Option<String> {
    let mut tokens = Tokens::new(html);
    let mut open: Vec<Open> = Vec::new();
    let in_template = |open: &[Open]| open.iter().any(|el| !el.foreign && el.name == "template");
    loop {
        let name = open.last().map_or("", |el| el.name.as_str());
        let foreign = open.last().is_some_and(|el| el.foreign);
        let mode = if foreign { Mode::Data } else { Mode::of(name, false) };
        let Some(token) = tokens.next(mode, name, foreign) else { break };
        let tag = match token {
            Token::Text(text) => {
                // A table holder moves visible text out; the parse check handles that case.
                let holder = !foreign && !in_template(&open) && TABLE_HOLDERS.contains(&name);
                if open.is_empty() || holder {
                    match text_shows(text) {
                        Some(true) if open.is_empty() => {
                            let shown: String = text.trim_ascii().chars().take(40).collect();
                            return Some(format!("text {shown:?} outside an element"));
                        }
                        Some(false) => {}
                        _ => return None,
                    }
                }
                continue;
            }
            Token::End { name, exact: true } => {
                if open.last().is_some_and(|el| el.name.eq_ignore_ascii_case(name)) {
                    open.pop();
                } else if !ignored_end_tag(name) {
                    return None;
                }
                continue;
            }
            Token::Ignored { uncertain: false } | Token::Cdata(_, true) => continue,
            Token::Start(tag) if tag.complete => tag,
            _ => return None,
        };
        let id = tag.attrs.iter().any(|(attr, value)| attr.eq_ignore_ascii_case("id") && !value.is_empty());
        let written = &html[tag.start..tag.end];
        if open.is_empty() && !id {
            let shown: String = written.chars().take(80).collect();
            let more = if shown.len() < written.len() { ".." } else { "" };
            return Some(format!("{shown}{more} has no id"));
        }
        // Where it lands, as [`template_problem`] reads it: one HTML's wherever it lands, written
        // straight in an `<svg>` or `<math>`, is not read.
        let (foreign, within) = placed(open.last().map_or(Within::Html, |last| last.within), &tag)?;
        let self_closing = tag.self_closing;
        let void = VOID.contains(&tag.name.as_str());
        if self_closing && !foreign && !void {
            // The browser ignores the `/` and opens it.
            return None;
        }
        let in_html = open.last().is_none_or(|last| !last.foreign);
        if (!foreign || in_html) && !in_template(&open) && misplaced(&open, &tag).is_some() {
            // Where the browser puts it is not followed.
            return None;
        }
        if !self_closing && (foreign || !void) {
            open.push(Open { name: tag.name, foreign, within, start: tag.start });
        }
    }
    None
}

/// Why the browser would lose part of a patch, after [`patch_parse`]'s description of it.
#[cfg(debug_assertions)]
pub(crate) const PATCH_PARSE_HELP: &str = "The runtime parses a patch as a <template>'s content, where the first top-level element other than a head tag (a <template>, <script>, <style>, <link>, <meta>, or a <title>, <base>, <basefont>, <bgsound> or <noframes>, which Chromium and WebKit let decide when one comes first) decides how the rest is read: after a table part (<tr>, <td>, <tbody>, <caption>, <col> ..), a <table>, a <form> or a table part inside a later top-level element that is not one is taken apart, after a <col> anything but a <col> or <template> is dropped, and after any other element table parts are dropped. Send the <table> whole, with an id, or put the table parts first, of one kind (rows, cells, or a table's row groups, caption and column groups), with no <table> or <form> in the elements after them, or keep them out of this patch";

/// Start tags a table's insertion modes read: a `<template>`'s first such element (in the HTML
/// standard's "in template" insertion mode) reads the rest as a table's. The same list as
/// `TABLE_PARTS` in `crates/corten-macros/src/html.rs`, which
/// `the_macro_s_patch_lists_are_the_check_s` holds it to.
#[cfg(any(debug_assertions, test))]
const TABLE_PARTS: &[&str] = &["caption", "col", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr"];

/// The SVG elements whose children are HTML's: the HTML standard's HTML integration points in SVG.
/// The same list as `SVG_HTML_POINTS` in `crates/corten-macros/src/html.rs`, which
/// `the_macro_s_patch_lists_are_the_check_s` holds it to.
#[cfg(any(debug_assertions, test))]
const SVG_HTML_POINTS: &[&str] = &["foreignObject", "desc", "title"];

/// The MathML elements whose children are HTML's but a `<mglyph>` and a `<malignmark>`: the HTML
/// standard's MathML text integration points. The same list as `MATH_HTML_POINTS` in
/// `crates/corten-macros/src/html.rs`.
#[cfg(any(debug_assertions, test))]
const MATH_HTML_POINTS: &[&str] = &["mi", "mo", "mn", "ms", "mtext"];

/// The start tags the HTML standard's rules for foreign content take out of an `<svg>` or a
/// `<math>` (and a `<font>` with a `color`, `face` or `size`). The same list as `BREAKOUT` in
/// `crates/corten-macros/src/html.rs`, which refuses one written straight in either.
#[cfg(any(debug_assertions, test))]
const BREAKOUT: &[&str] = &[
    "b",
    "big",
    "blockquote",
    "body",
    "br",
    "center",
    "code",
    "dd",
    "div",
    "dl",
    "dt",
    "em",
    "embed",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "hr",
    "i",
    "img",
    "li",
    "listing",
    "menu",
    "meta",
    "nobr",
    "ol",
    "p",
    "pre",
    "ruby",
    "s",
    "small",
    "span",
    "strong",
    "strike",
    "sub",
    "sup",
    "table",
    "tt",
    "u",
    "ul",
    "var",
];

/// How the start tags in an open element are read, as the HTML standard's tree construction
/// dispatcher reads them, as far as a patch's foreign content needs.
#[cfg(any(debug_assertions, test))]
#[derive(Clone, Copy, PartialEq, Eq)]
enum Within {
    /// As HTML's: outside foreign content, and in an SVG or MathML HTML integration point.
    Html,
    /// As HTML's but a `<mglyph>` and a `<malignmark>`: in a MathML text integration point.
    MathText,
    /// As SVG's.
    Svg,
    /// As MathML's.
    Math,
    /// As MathML's but an `<svg>`: in an `<annotation-xml>` that is not an HTML integration point.
    AnnotationXml,
}

/// An element open in a patch: its name, whether it is foreign content's (an SVG or MathML
/// element, in which a CDATA section is one and a `<title>` or `<style>` holds elements), and how
/// what it holds is read.
#[cfg(any(debug_assertions, test))]
struct Open {
    name: String,
    foreign: bool,
    within: Within,
    /// Where its start tag is.
    start: usize,
}

/// Where the element of `tag`, written in an element whose content is read `within`, lands: whether
/// it is foreign content's and how what it holds is read. `None` for an element HTML's wherever it
/// lands written straight in foreign content (`BREAKOUT`), which the browser takes out of it, closing
/// the elements around it: not followed here, and `html!` refuses it.
#[cfg(any(debug_assertions, test))]
fn placed(within: Within, tag: &Tag) -> Option<(bool, Within)> {
    let is = |name: &str| tag.name.eq_ignore_ascii_case(name);
    let any = |list: &[&str]| list.iter().any(|name| is(name));
    let breaks_out = || any(BREAKOUT) || (is("font") && ["color", "face", "size"].iter().any(|a| tag.attr(a).is_some()));
    match within {
        Within::Html if is("svg") => Some((true, Within::Svg)),
        Within::Html if is("math") => Some((true, Within::Math)),
        Within::Html => Some((false, Within::Html)),
        Within::MathText if is("mglyph") || is("malignmark") => Some((true, Within::Math)),
        Within::MathText => placed(Within::Html, tag),
        _ if breaks_out() => None,
        Within::Svg if any(SVG_HTML_POINTS) => Some((true, Within::Html)),
        Within::Svg => Some((true, Within::Svg)),
        Within::AnnotationXml if is("svg") => Some((true, Within::Svg)),
        Within::Math | Within::AnnotationXml if any(MATH_HTML_POINTS) => Some((true, Within::MathText)),
        Within::Math | Within::AnnotationXml if is("annotation-xml") => {
            // An HTML integration point by its first `encoding`, its character references decoded.
            let html = tag.attr("encoding").is_some_and(|encoding| {
                let encoding = encoding_decoded(encoding);
                encoding.eq_ignore_ascii_case("text/html") || encoding.eq_ignore_ascii_case("application/xhtml+xml")
            });
            Some((true, if html { Within::Html } else { Within::AnnotationXml }))
        }
        Within::Math | Within::AnnotationXml => Some((true, Within::Math)),
    }
}

/// An `<annotation-xml>`'s `encoding` as the tokenizer gives it, as far as whether it is
/// `text/html` or `application/xhtml+xml` (in any letter case): a numeric character reference
/// decoded, with or without its `;` (U+FFFD for one that is no character, which neither has),
/// and `&sol;` and `&plus;`, the only named ones for a character of theirs (no named one
/// is a letter). Any other is left as written, which neither is either way.
#[cfg(any(debug_assertions, test))]
fn encoding_decoded(value: &str) -> std::borrow::Cow<'_, str> {
    if !value.contains('&') {
        return value.into();
    }
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(value.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            let rest = &value[i..];
            if let Some((name, c)) = [("&sol;", '/'), ("&plus;", '+')].into_iter().find(|(name, _)| rest.starts_with(name)) {
                out.push(c);
                i += name.len();
                continue;
            }
            if bytes.get(i + 1) == Some(&b'#') {
                let hex = matches!(bytes.get(i + 2), Some(b'x' | b'X'));
                let digits = i + 2 + usize::from(hex);
                let mut end = digits;
                let mut number: u32 = 0;
                while let Some(digit) = bytes.get(end).and_then(|c| (*c as char).to_digit(if hex { 16 } else { 10 })) {
                    number = number.saturating_mul(if hex { 16 } else { 10 }).saturating_add(digit);
                    end += 1;
                }
                if end > digits {
                    // U+FFFD for one that is no character, as the tokenizer gives it.
                    out.push(char::from_u32(number).filter(|c| *c != '\0').unwrap_or('\u{fffd}'));
                    i = end + usize::from(bytes.get(end) == Some(&b';'));
                    continue;
                }
            }
        }
        let c = value[i..].chars().next().unwrap_or_default();
        out.push(c);
        i += c.len_utf8().max(1);
    }
    out.into()
}

/// The HTML standard's special elements, at which the walk up the open elements for an `<li>`,
/// a `<dd>` or a `<dt>` stops, but an `<address>`, a `<div>` and a `<p>`.
#[cfg(any(debug_assertions, test))]
const SPECIAL: &[&str] = &[
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

/// The HTML elements whose text the browser moves out of them (foster-parents) or that it closes
/// for text.
#[cfg(any(debug_assertions, test))]
const TABLE_HOLDERS: &[&str] = &["colgroup", "table", "tbody", "tfoot", "thead", "tr"];

/// Start tags the "in body" insertion mode closes a `<p>` open in button scope for.
#[cfg(any(debug_assertions, test))]
fn closes_p(name: &str) -> bool {
    matches!(
        name,
        "address"
            | "article"
            | "aside"
            | "blockquote"
            | "center"
            | "dd"
            | "details"
            | "dialog"
            | "dir"
            | "div"
            | "dl"
            | "dt"
            | "fieldset"
            | "figcaption"
            | "figure"
            | "footer"
            | "form"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "header"
            | "hgroup"
            | "hr"
            | "li"
            | "listing"
            | "main"
            | "menu"
            | "nav"
            | "ol"
            | "p"
            | "plaintext"
            | "pre"
            | "search"
            | "section"
            | "summary"
            | "table"
            | "ul"
            | "xmp"
    )
}

#[cfg(any(debug_assertions, test))]
const SCOPE: &[&str] = &["applet", "caption", "html", "table", "td", "th", "marquee", "object", "select", "template"];

/// Why the browser does not put the HTML element of `tag` where the patch writes it, in the
/// elements `open` around it (innermost last, a `<template>`'s content read on its own), or
/// `None` where it does, as the HTML standard's "in body", "in table" and related insertion modes
/// place a start tag. In a `<table>` a row, a cell or a `<col>` may be written without the
/// `<tbody>`, `<tr>` or `<colgroup>` the browser adds around it, which loses nothing. Each
/// `Some` is where the check stops: what the browser does there (moves the element out of a table,
/// ignores it, closes an element open around it, reads it as another element or as text, or reads
/// it differently in different engines) is not followed. Debug builds only.
#[cfg(any(debug_assertions, test))]
fn misplaced(open: &[Open], tag: &Tag) -> Option<String> {
    let name = tag.name.as_str();
    // Whether one of `targets` is open, walking up from the innermost to a foreign element (an
    // SVG or MathML integration point, every scope's boundary) or one of `boundary`.
    let open_in = |targets: &[&str], boundary: &dyn Fn(&str) -> bool| {
        for el in open.iter().rev() {
            if el.foreign {
                return false;
            }
            if targets.contains(&el.name.as_str()) {
                return true;
            }
            if boundary(el.name.as_str()) {
                return false;
            }
        }
        false
    };
    let scope = |name: &str| SCOPE.contains(&name);
    let closes = |what: &str| Some(format!("which closes the <{what}> open around it"));
    // The innermost open element, when it is HTML's.
    let current = open.last().filter(|el| !el.foreign).map(|el| el.name.as_str());
    match name {
        "image" => return Some("which a browser reads as an <img>, an element with no end tag".into()),
        "plaintext" => return Some("which makes the rest of the patch its text".into()),
        "noscript" => return Some("whose content Firefox reads as text and Chromium and WebKit as elements".into()),
        "html" | "body" | "head" | "frame" | "frameset" => return Some("which a browser does not open in a patch".into()),
        _ => {}
    }
    // A table, a row group, a row and a column group keep their own parts and a `<script>`,
    // `<style>` or `<template>`: the browser moves anything else out of the table, or closes them.
    let kept: Option<&[&str]> = match current {
        Some("table") => {
            Some(&["caption", "col", "colgroup", "script", "style", "tbody", "td", "template", "tfoot", "th", "thead", "tr"])
        }
        Some("tbody" | "thead" | "tfoot") => Some(&["script", "style", "td", "template", "th", "tr"]),
        Some("tr") => Some(&["script", "style", "td", "template", "th"]),
        Some("colgroup") => Some(&["col", "template"]),
        _ => None,
    };
    if let (Some(kept), Some(current)) = (kept, current) {
        return (!kept.contains(&name)).then(|| format!("which a browser moves out of the <{current}> or closes it for"));
    }
    if TABLE_PARTS.contains(&name) && !open.is_empty() {
        return Some("a table part outside a table, which a browser drops or closes the cell or caption it is in for".into());
    }
    if open.iter().any(|el| !el.foreign && el.name == "select") {
        let kept = match current {
            Some("select") => ["hr", "optgroup", "option", "script", "template"].contains(&name),
            Some("optgroup") => ["option", "script", "template"].contains(&name),
            _ => false,
        };
        return (!kept).then(|| "content of a <select>, which the engines read by rules of their own".into());
    }
    if closes_p(name) && open_in(&["p"], &|el| scope(el) || el == "button") {
        return closes("p");
    }
    let heading = |el: &str| matches!(el, "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
    if heading(name) && current.is_some_and(heading) {
        return closes(current.unwrap_or_default());
    }
    // An `<li>` closes the `<li>` it is in, and a `<dd>` or `<dt>` either, up to a special element.
    let items: &[&str] = match name {
        "li" => &["li"],
        "dd" | "dt" => &["dd", "dt"],
        _ => &[],
    };
    if !items.is_empty() && open_in(items, &|el| SPECIAL.contains(&el) && !matches!(el, "address" | "div" | "p")) {
        return closes(items[0]);
    }
    if name == "form" && open.iter().any(|el| !el.foreign && el.name == "form") {
        return Some("a <form> in a <form>, which Chromium and Firefox ignore and WebKit keeps".into());
    }
    if name == "a" {
        // An `<a>` closes the `<a>` in the list of active formatting elements back to its last
        // marker (an `<applet>`, `<object>`, `<marquee>`, `<template>`, cell or caption), which an
        // SVG or MathML integration point between them is not: there it takes the outer `<a>` off
        // the elements open, and what follows the `<svg>` or `<math>` lands outside it.
        let marker = |el: &Open| ["applet", "caption", "marquee", "object", "td", "template", "th"].contains(&el.name.as_str());
        if open.iter().rev().filter(|el| !el.foreign).take_while(|el| !marker(el)).any(|el| el.name == "a") {
            return closes(name);
        }
    }
    if matches!(name, "button" | "nobr") && open_in(&[name], &scope) {
        return closes(name);
    }
    let implied = ["dd", "dt", "li", "optgroup", "option", "p", "rb", "rp", "rt", "rtc"];
    if matches!(name, "option" | "optgroup") && current == Some("option")
        || matches!(name, "rb" | "rp" | "rt" | "rtc") && current.is_some_and(|el| implied.contains(&el))
    {
        return closes(current.unwrap_or_default());
    }
    None
}

/// Start tags the "in template" insertion mode reads as a head's: they do not decide how the rest
/// is read (but [`DECIDING_HEAD`]'s, in Chromium and WebKit), and every mode keeps them but a
/// `<col>`'s, which keeps only `<template>`. The same list as `TEMPLATE_HEAD` in
/// `crates/corten-macros/src/html.rs`, which `the_macro_s_patch_lists_are_the_check_s` holds it to.
#[cfg(any(debug_assertions, test))]
const HEAD_TAGS: &[&str] = &["base", "basefont", "bgsound", "link", "meta", "noframes", "script", "style", "template", "title"];

/// Head tags Chromium and WebKit let decide how a `<template>`'s content is read when one comes
/// before any other element, as a page's body does (they read the rest as a body's, dropping table
/// parts); the HTML standard reads them as a head's, and Firefox follows it.
#[cfg(any(debug_assertions, test))]
const DECIDING_HEAD: &[&str] = &["base", "basefont", "bgsound", "noframes", "title"];

/// How a `<template>`'s top level reads its elements, set by the first one that is not a head's.
#[cfg(any(debug_assertions, test))]
#[derive(Clone, Copy, PartialEq)]
enum Reading {
    Undecided,
    /// After any element but a table part: table parts are dropped.
    Body,
    /// After a `<caption>`, `<colgroup>`, `<tbody>`, `<thead>` or `<tfoot>` ("in table").
    Table,
    /// After a `<tr>` ("in table body").
    TableBody,
    /// After a `<td>` or `<th>` ("in row").
    Row,
    /// After a `<col>` ("in column group"): only `<col>` and `<template>` are kept.
    ColumnGroup,
}

/// What a browser loses of a patch when the runtime parses it, which is as a `<template>`'s
/// content (`parse` in `corten.js`): its first top-level element that is not a head's decides how
/// the rest is read (the HTML standard's "in template" insertion mode). After any element but a
/// table part, table parts are dropped; after a table part, other table parts are dropped or put
/// in a `<tbody>`, `<tr>` or `<colgroup>` the browser adds, a `<table>` is dropped, a
/// table part inside another top-level element is moved out of it, a `<table>` there is taken
/// apart, its parts moved out, and a `<form>` there or at the top level loses what it holds; after a `<col>`, everything but a `<col>` or `<template>` is
/// dropped. A `<template>`'s content, at the top level (`Append`'s rows) or inside an element,
/// is read the same way on its own. Chromium and WebKit let a leading `<title>`, `<base>`,
/// `<basefont>`, `<bgsound>` or `<noframes>` decide too ([`DECIDING_HEAD`]; the standard does not,
/// and Firefox does not), so a patch with one is read both ways. Describes the first loss, for an
/// error; [`PATCH_PARSE_HELP`] says why and what to do. Reads markup as `html!` writes it, each
/// element closed by its own end tag, in one pass for each way it is read
/// ([`template_problem`]). What an `<svg>` or `<math>` holds is read by foreign content's rules
/// ([`placed`]: a `<title>` or `<style>` there holds elements, a CDATA section is text) for where
/// it ends, and no loss inside one is reported; a `<script>`'s text is read by the tokenizer's
/// script data states ([`script_end`]), and the end tag of a void element is ignored, as the
/// browser does. It reports a loss only from tokens it reads as the browser does ([`Read::unread`]
/// lists them); at any other (an end tag not written `</name>` or that closes no element open, an
/// HTML element's start tag ending `/>`, a comment a browser ends elsewhere than at its `-->`, a
/// doctype but `<!DOCTYPE html>`, text with a named character reference it does not decode
/// ([`text_shows`]) where text decides, a CDATA section outside foreign content, an element HTML's wherever it lands written straight in
/// an `<svg>` or `<math>`, which `html!` refuses; a script whose text carries it past its first
/// `</script>` over a start tag; in a form whose content decides a loss, any token but a start
/// tag, text, a comment, a bogus comment and a void element's end tag before its `</form>`) it
/// stops: a loss found before the element it cannot follow (where an end
/// tag is left out, before that element's start tag, which the browser closes somewhere this does
/// not read) is reported, and [`patch_parse_checked`] logs that the rest was not read. Checked in debug builds only; `scripts/smoke.mjs` checks the
/// browsers against `patch-parsing.json`, the cases `a_patch_s_parse_problems_are_what_browsers_parse`
/// holds this to.
#[cfg(any(debug_assertions, test))]
pub(crate) fn patch_parse(html: &str) -> Parse {
    let read = template_problem(html, false, false);
    let Some(head) = read.headed.filter(|_| read.problem.is_none()) else {
        return Parse { problem: read.problem, unread: read.unread };
    };
    let other = template_problem(html, true, false);
    Parse {
        problem: other.problem.map(|problem| {
            format!("{problem} in Chromium and WebKit, which let a <{head}> before it decide how the rest is read")
        }),
        unread: read.unread.or(other.unread),
    }
}

/// What [`patch_parse`] found of a patch: the first loss, and where it stopped reading, if it did.
#[cfg(any(debug_assertions, test))]
pub(crate) struct Parse {
    pub problem: Option<String>,
    pub unread: Option<String>,
}

/// The loss [`patch_parse`] finds, which the tests read.
#[cfg(test)]
pub(crate) fn patch_parse_problem(html: &str) -> Option<String> {
    patch_parse(html).problem
}

/// [`patch_parse`] for a patch about to be sent (`what`: where it comes from), logging a
/// warning when it found no loss but could not read the patch to its end, so a patch the check
/// does not follow is not passed in silence.
#[cfg(debug_assertions)]
pub(crate) fn patch_parse_checked(html: &str, what: &dyn std::fmt::Display) -> Option<String> {
    let parse = patch_parse(html);
    if let (None, Some(unread)) = (&parse.problem, &parse.unread) {
        tracing::warn!(
            "corten: the debug check of what the browser keeps of {what} read it only up to {unread}, which it does not follow, so what comes after was not checked: it reads markup as html! writes it, each element closed by its own end tag"
        );
    }
    parse.problem
}

/// What one reading of a patch (or of a `<template>`'s content in it) found.
#[cfg(any(debug_assertions, test))]
struct Read {
    /// The first loss.
    problem: Option<String>,
    /// The first of [`DECIDING_HEAD`] read before the first element that decides, here or in a
    /// `<template>`'s content.
    headed: Option<&'static str>,
    /// Where it stopped reading, when it did. It reads only these tokens: text; a start tag, an HTML
    /// one ending `/>` only for a void element; an end tag written `</name>` that closes the
    /// element open last, or a void element's, which the browser ignores; a comment ended by `-->`
    /// alone; a bogus comment up to its `>`; the doctype `<!DOCTYPE html>`; text, read where it
    /// decides with its character references decoded ([`text_shows`]); a CDATA section in an SVG or MathML
    /// element; and an HTML element's text up to its end tag (a script's as the tokenizer ends it,
    /// unless that carries it over a start tag). At any other (an `<li>` closed by its list's end
    /// tag, a `</div ignored>`, a `</p>` that closes nothing), the browser places what follows by
    /// rules this does not follow, so what follows is not read.
    unread: Option<String>,
}

/// Where an HTML element in foreign content is, for a message: `in <foreignobject>, an SVG or MathML
/// integration point` when the innermost element open is the integration point, and `in <div>, inside
/// <foreignobject>, an SVG or MathML integration point` when it is an HTML element inside one,
/// naming the nearest SVG or MathML element.
#[cfg(any(debug_assertions, test))]
fn integration_point(open: &[Open]) -> String {
    let holder = open.last().map_or("", |last| last.name.as_str());
    match open.iter().rev().find(|el| el.foreign).map(|el| el.name.as_str()) {
        Some(point) if point != holder => format!("in <{holder}>, inside <{point}>, an SVG or MathML integration point"),
        Some(point) => format!("in <{point}>, an SVG or MathML integration point"),
        None => format!("in <{holder}>"),
    }
}

/// [`patch_parse`] for one way of reading a leading head tag ([`DECIDING_HEAD`]'s
/// decide when `head_decides`), in one pass that also reads whether the patch is closed as
/// [`Read`] says. `nested`: `html` is the content of a `<template>` in the patch, which is on the
/// parser's stack of open elements as the runtime's own `<template>` is not, so a table's reading
/// drops a `<form>` there whole, as the HTML standard says and Firefox does (Chromium and WebKit
/// keep it).
#[cfg(any(debug_assertions, test))]
fn template_problem(html: &str, head_decides: bool, nested: bool) -> Read {
    let shown = |written: &str| -> String {
        let shown: String = written.chars().take(80).collect();
        if shown.len() < written.len() {
            format!("{shown}..")
        } else {
            shown
        }
    };
    let since = |first: &str| format!(", since {} comes first", shown(first));
    let bytes = html.as_bytes();
    let mut reading = Reading::Undecided;
    // The element that decided, as written.
    let mut first = "";
    let mut headed = None;
    // The first loss, and where the tag it was found at starts: once one is found, the rest is read
    // only for whether it is closed.
    let mut problem: Option<String> = None;
    let mut problem_at: Option<usize> = None;
    // Stops reading where the patch is not read as written ([`Read::unread`]). The loss found
    // before is kept if it was found before `since`: the start tag of the first element whose end
    // tag may have been left out (the browser closed it somewhere after it, so what came after was
    // not where this read it), or `usize::MAX` where the reason is where it is found.
    macro_rules! unread {
        ($since:expr; $($why:tt)*) => {{
            let since: usize = $since;
            return Read {
                problem: problem.filter(|_| problem_at.is_some_and(|at| at < since)),
                headed,
                unread: Some(format!($($why)*)),
            };
        }};
    }
    // The elements open, each closed by its own end tag.
    let mut open: Vec<Open> = Vec::new();
    // A top-level element other than a table part or a head's, open in a table's reading: the
    // browser reads what it holds by the table's rules, so a table part in it leaves it.
    let mut watched: Option<&str> = None;
    // An open `<template>`, at any depth: how many elements are open around it and where its
    // content starts. Its content is read on its own, when it closes, so nothing in it is read here.
    let mut template: Option<(usize, usize)> = None;
    // How many elements are open around an open `<svg>` or `<math>`: what it holds is foreign
    // content, read by its own rules ([`placed`]) for where it ends, and no loss in it is reported.
    let mut foreign: Option<usize> = None;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' || lone_lt(bytes, i) {
            // Text, a `<` that starts no tag among it.
            let from = if bytes[i] == b'<' { i + 1 } else { i };
            let end = html[from..].find('<').map_or(bytes.len(), |n| from + n);
            let text = &html[i..end];
            let holder = open.last().filter(|last| !last.foreign && TABLE_HOLDERS.contains(&last.name.as_str()));
            // Where it decides (a table holder, a column group's reading and the top level, where the
            // id check reads it), text with a named reference the check does not decode stops it.
            if template.is_none() && (holder.is_some() || open.is_empty()) {
                let shows = text_shows(text);
                if let Some(holder) = holder.filter(|_| shows != Some(false)) {
                    unread!(usize::MAX; "the text {} in <{}>, which a browser moves out of it", shown(text), holder.name);
                }
                if open.is_empty() && reading == Reading::ColumnGroup && shows != Some(false) {
                    unread!(usize::MAX; "the text {}, which a browser drops{}", shown(text), since(first));
                }
                if open.is_empty() && shows.is_none() {
                    unread!(usize::MAX; "the text {}, whose character reference the check does not decode", shown(text));
                }
            }
            i = end;
            continue;
        }
        if html[i..].starts_with("<!--") {
            // A comment ended by `-->` alone, in foreign content as outside it: one written `<!-->`,
            // `<!--->` or with `--!>` in it ends elsewhere.
            match comment_end(html, i) {
                Some(end) => i = end,
                None => {
                    let end = html[i + 4..].find("-->").map_or(bytes.len(), |n| i + 4 + n + 3);
                    unread!(usize::MAX; "the comment {}, which a browser ends elsewhere than at its -->", shown(&html[i..end]));
                }
            }
            continue;
        }
        // A CDATA section, which an SVG or MathML element holds as text up to `]]>`, and HTML as a
        // comment up to `>`, which is not followed.
        if html[i..].starts_with("<![CDATA[") {
            match html[i..].find("]]>").filter(|_| open.last().is_some_and(|last| last.foreign)) {
                Some(n) => i += n + 3,
                None => unread!(
                    usize::MAX;
                    "the CDATA section {}, outside an SVG or MathML element (HTML reads it as a comment up to its first >) or not ended by ]]>",
                    shown(&html[i..])
                ),
            }
            continue;
        }
        match bytes.get(i + 1) {
            Some(b'/') => {
                let at = i;
                // Read only an end tag written `</name>`, as `html!` writes one: the browser
                // ignores what follows the name, which may be another tag's end (`</div ignored>`).
                let Some((closing, after)) = exact_end_tag(html, i) else {
                    let end = html[i..].find('>').map_or(bytes.len(), |n| i + n + 1);
                    unread!(usize::MAX; "the end tag {}, which is not written </name>", shown(&html[i..end]));
                };
                let end = after - 1;
                if !open.last().is_some_and(|last| last.name.eq_ignore_ascii_case(closing)) {
                    match open.iter().rposition(|open| open.name.eq_ignore_ascii_case(closing)) {
                        // It closes the elements open in it, whose end tags were left out.
                        Some(at) => {
                            let last = open.last().map_or("", |last| last.name.as_str());
                            unread!(open[at + 1].start; "{}, where <{last}> is open", shown(&html[i..(end + 1).min(bytes.len())]));
                        }
                        // A void element's end tag (`html!` writes one for a `<param>` or a
                        // `<basefont>`), which the browser ignores.
                        None if ignored_end_tag(closing) => {
                            i = after;
                            continue;
                        }
                        // Any other end tag that closes no open element: the browser ignores it,
                        // adds an element for it (`</p>`, `</br>`) or, in an `<svg>` or `<math>`,
                        // closes the foreign content around it, which is not followed.
                        None => {
                            unread!(usize::MAX; "{}, which closes no element open", shown(&html[i..after]));
                        }
                    }
                }
                open.pop();
                i = (end + 1).min(bytes.len());
                if foreign.is_some_and(|around| open.len() <= around) {
                    foreign = None;
                }
                if let Some((_, start)) = template.filter(|(around, _)| open.len() <= *around) {
                    template = None;
                    let inner = template_problem(&html[start..at], head_decides, true);
                    headed = headed.or(inner.headed);
                    if problem.is_none() && inner.problem.is_some() {
                        problem = inner.problem;
                        problem_at = Some(start);
                    }
                    if let Some(why) = inner.unread {
                        unread!(usize::MAX; "{why}, in a <template>'s content");
                    }
                }
                if open.is_empty() {
                    watched = None;
                }
                continue;
            }
            Some(b'!' | b'?') => {
                let end = html[i..].find('>').map_or(bytes.len(), |n| i + n + 1);
                if doctype(bytes, i) == Some(false) {
                    unread!(usize::MAX; "the doctype {}, which the check does not read (a quoted > in it ends it early)", shown(&html[i..end]));
                }
                i = end;
                continue;
            }
            Some(c) if c.is_ascii_alphabetic() => {}
            _ => {
                i += 1;
                continue;
            }
        }
        let tag = start_tag(html, i);
        if !tag.complete {
            // The patch ends in it, and the browser drops it, with what the patch writes after its
            // `<` (an end tag in a value too). What came before it is placed as written, and no
            // verdict before it read past it (what a form holds stops at it), so a loss found before
            // is kept.
            unread!(usize::MAX; "{}, a start tag the patch ends in before its >", shown(&html[tag.start..]));
        }
        i = tag.end;
        let Some((foreign_element, within)) = placed(open.last().map_or(Within::Html, |last| last.within), &tag) else {
            let holder = open.last().map_or("", |last| last.name.as_str());
            unread!(usize::MAX; "{} written straight in <{holder}>, which a browser closes before it", shown(&html[tag.start..tag.end]));
        };
        let name = tag.name.as_str();
        let written = &html[tag.start..tag.end];
        if tag.self_closing && !foreign_element && !VOID.contains(&name) {
            // The browser ignores the `/` of an HTML element's start tag and opens it, which
            // `html!` never writes (it writes `<div></div>` for `<div />`).
            unread!(usize::MAX; "{}, an HTML element's start tag ending />, which a browser leaves open", shown(written));
        }
        if name == "template"
            && !foreign_element
            && foreign.is_some()
            && template.is_none()
            && matches!(reading, Reading::Table | Reading::TableBody | Reading::Row | Reading::ColumnGroup)
        {
            // Past its end tag, Firefox reads the rest of the patch as a body's (it drops a later
            // row, and a form keeps what it holds), and Chromium and WebKit by the table's rules,
            // as the HTML standard does.
            let point = integration_point(&open);
            unread!(
                usize::MAX;
                "{} {point}, past whose end tag Firefox reads the rest by other rules than a table's{}",
                shown(written),
                since(first)
            );
        }
        let part = TABLE_PARTS.contains(&name);
        let head = HEAD_TAGS.contains(&name);
        // What a `<form>` holds, read only where a table's reading would put it in empty.
        let table_reading = matches!(reading, Reading::Table | Reading::TableBody | Reading::Row);
        let read_holds = name == "form"
            && problem.is_none()
            && if open.is_empty() { table_reading } else { watched.is_some() && template.is_none() && foreign.is_none() };
        let holds = if read_holds {
            match holds_shown(html, i) {
                Ok(holds) => holds,
                Err((start, end)) => {
                    unread!(usize::MAX; "{} in {}, which the check of what a form holds does not read", shown(&html[start..end]), shown(written));
                }
            }
        } else {
            false
        };
        // It ends at `/>`, and an HTML one with no end tag at once.
        let opens = !tag.self_closing && (foreign_element || !VOID.contains(&name));
        if problem.is_some() {
            // Read on only for whether it is closed.
        } else if open.is_empty() {
            watched = None;
            if reading == Reading::Undecided {
                let deciding = DECIDING_HEAD.iter().find(|tag| **tag == name).copied();
                headed = headed.or(deciding);
                if !head || (deciding.is_some() && head_decides) {
                    first = written;
                    reading = match name {
                        "caption" | "colgroup" | "tbody" | "tfoot" | "thead" => Reading::Table,
                        "tr" => Reading::TableBody,
                        "td" | "th" => Reading::Row,
                        "col" => Reading::ColumnGroup,
                        _ => Reading::Body,
                    };
                }
            } else {
                let table = matches!(reading, Reading::Table | Reading::TableBody | Reading::Row);
                let dropped = match reading {
                    Reading::Undecided => false,
                    Reading::Body => part,
                    Reading::Table => name == "table",
                    Reading::TableBody => name == "table" || (part && name != "tr" && name != "td" && name != "th"),
                    Reading::Row => name == "table" || (part && name != "td" && name != "th"),
                    Reading::ColumnGroup => name != "col" && name != "template",
                };
                let added = match (reading, name) {
                    (Reading::Table, "tr") => Some("a <tbody>"),
                    (Reading::Table, "td" | "th") => Some("a <tbody> and a <tr>"),
                    (Reading::Table, "col") => Some("a <colgroup>"),
                    (Reading::TableBody, "td" | "th") => Some("a <tr>"),
                    _ => None,
                };
                if dropped {
                    let what = if tag.attr("data-corten-style").is_some() {
                        format!("the area's stylesheet ({}), which Corten writes after the patch's elements,", shown(written))
                    } else {
                        shown(written)
                    };
                    problem = Some(format!("{what} is dropped{}", since(first)));
                } else if let Some(added) = added {
                    problem = Some(format!("{} is put in {added} the browser adds{}", shown(written), since(first)));
                } else if table && name == "form" && holds {
                    // In a `<template>`'s content too, where Chromium and WebKit move what it holds
                    // out of it and Firefox drops it.
                    problem = Some(format!("{} loses what it holds{}", shown(written), since(first)));
                } else if table && name == "form" && nested {
                    problem = Some(format!("{} is dropped in Firefox{}", shown(written), since(first)));
                } else if table && !part && !head && opens {
                    watched = Some(written);
                }
            }
        } else if let (Some(top), None, None) = (watched, template, foreign) {
            if name == "table" {
                problem = Some(format!(
                    "{} in {} is taken apart, its parts moved out of it{}",
                    shown(written),
                    shown(top),
                    since(first)
                ));
            } else if part {
                problem = Some(format!("{} in {} is moved out of it{}", shown(written), shown(top), since(first)));
            } else if name == "form" && holds {
                problem = Some(format!("{} in {} loses what it holds{}", shown(written), shown(top), since(first)));
            } else if name == "form" && nested {
                problem = Some(format!("{} in {} is dropped in Firefox{}", shown(written), shown(top), since(first)));
            }
        }
        if problem.is_some() && problem_at.is_none() {
            problem_at = Some(tag.start);
        }
        // A table, a table part or a form in an SVG or MathML integration point, which a table's
        // reading reads by its rules there too, unless the element is in a top-level table part.
        if !foreign_element
            && foreign.is_some()
            && template.is_none()
            && matches!(reading, Reading::Table | Reading::TableBody | Reading::Row)
            && open.first().is_some_and(|outer| !TABLE_PARTS.contains(&outer.name.as_str()))
            && (part || name == "table" || name == "form")
        {
            let point = integration_point(&open);
            unread!(usize::MAX; "{} {point}, where a table's reading moves it{}", shown(written), since(first));
        }
        // An HTML element, or an `<svg>` or `<math>` in one, the browser does not put where it is
        // written: what it does there is not followed (in a `<template>`'s content it is read when
        // the content is).
        let in_html = open.last().is_none_or(|last| !last.foreign);
        if (!foreign_element || in_html) && template.is_none() {
            if let Some(why) = misplaced(&open, &tag) {
                let around = open.last().map(|last| format!(" in <{}>", last.name)).unwrap_or_default();
                unread!(usize::MAX; "{}{around}, {why}", shown(written));
            }
        }
        // An HTML element's text, up to its end tag: nothing in it is markup. An SVG or MathML
        // `<title>`, `<style>` or `<script>` holds elements.
        let mode = Mode::of(name, false);
        if !foreign_element && matches!(mode, Mode::Rcdata | Mode::Rawtext | Mode::Script) {
            let written_end = raw_text_end(html, i, name);
            let end = if mode == Mode::Script { script_end(html, i) } else { written_end };
            if end == bytes.len() {
                // No end tag the tokenizer reads: a `<!--` and a `<script` in a script's text can
                // hide the one written after it (`html!` writes its text as is), and the rest of the
                // patch is its text.
                let after = html[written_end..].find('>').map_or(bytes.len(), |n| written_end + n + 1);
                // An element written after it is lost; text and end tags only may be its own.
                if problem.is_none() && scan::tags(&html[after..], false).next().is_some() {
                    problem = Some(format!(
                        "what follows {} is read as its text, since a <!-- and a <script in its text hide its end tag",
                        shown(written)
                    ));
                    problem_at = Some(tag.start);
                }
                unread!(usize::MAX; "{}, which is not closed", shown(written));
            }
            // A `<!--` and a `<script` in its text hide its first `</script>`, and the browser ends
            // it at a later one. `html!` closes each element it opens, so with no start tag between
            // them the later one is this script's own text, as written; with one, what is between may
            // be text written for it or a patch's elements read as its text, which the markup does
            // not say.
            if end != written_end
                && html.as_bytes()[written_end..end].windows(2).any(|w| w[0] == b'<' && w[1].is_ascii_alphabetic())
            {
                unread!(usize::MAX; "{}, whose text a <!-- and a <script in it carry past its first </script>", shown(written));
            }
            i = end;
        }
        if opens {
            // One inside an `<svg>` or `<math>` is foreign content's, not read; what an open
            // `<template>` holds is read when it closes.
            if name == "template" && template.is_none() && foreign.is_none() {
                template = Some((open.len(), i));
            }
            if foreign_element && foreign.is_none() && template.is_none() {
                foreign = Some(open.len());
            }
            open.push(Open { name: tag.name, foreign: foreign_element, within, start: tag.start });
        }
    }
    match open.first() {
        None => Read { problem, headed, unread: None },
        Some(outer) => {
            let last = open.last().map_or("", |last| last.name.as_str());
            unread!(outer.start; "<{last}>, which is not closed")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{patch_parse_problem, patch_problem};

    const TEXT_ELEMENTS: &[&str] = &["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"];

    /// A start tag's attributes are read past what a quoted value holds: `data-on`'s JSON, with
    /// `"` in it, can look like another attribute or the tag's end, and is not one.
    #[test]
    fn start_tags_read_a_quoted_value_to_its_own_quote() {
        let html = concat!(
            r#"<!DOCTYPE html><p data-on='connect:m.f($t,["a data-vars=","b"," id=\"c\" />"])' id="p">x</p>"#,
            r#"<!-- <i id="no"> --><script>"<b id=no>"</script><br/><input value=plain disabled></p>"#,
        );
        let tags: Vec<_> = super::start_tags(html).map(|tag| (tag.name, tag.attrs, tag.self_closing)).collect();
        assert_eq!(
            tags,
            [
                (
                    "p".to_string(),
                    vec![("data-on", r#"connect:m.f($t,["a data-vars=","b"," id=\"c\" />"])"#), ("id", "p")],
                    false
                ),
                ("script".to_string(), vec![], false),
                ("br".to_string(), vec![], true),
                ("input".to_string(), vec![("value", "plain"), ("disabled", "")], false),
            ]
        );
        let p = super::start_tags(html).next().expect("the p");
        assert_eq!(
            (p.attr("ID"), p.attr("data-vars"), &html[p.start..p.end]),
            (Some("p"), None, &html[15..html.find(">x").unwrap() + 1])
        );
    }

    /// The same past a double-quoted value, which may hold `'` and `>`; and a `<` that starts no
    /// tag is text, as the browser reads it, so the tag after it is still found.
    #[test]
    fn start_tags_read_a_double_quoted_value_and_take_a_lone_lt_for_text() {
        let html = concat!(
            r#"<p title="It's > 'b' data-vars='x'" id="p">1 <2 <i id="i">x</i> < 3 <= 4</p>"#,
            r#"<div data-vars="--m__fill:7%"></div></p><?x y="<u>"?><b>"#,
        );
        let tags: Vec<_> = super::start_tags(html).map(|tag| (tag.name, tag.attrs)).collect();
        assert_eq!(
            tags,
            [
                ("p".to_string(), vec![("title", "It's > 'b' data-vars='x'"), ("id", "p")]),
                ("i".to_string(), vec![("id", "i")]),
                ("div".to_string(), vec![("data-vars", "--m__fill:7%")]),
                ("b".to_string(), vec![]),
            ]
        );
        let names = |html: &str| super::start_tags(html).map(|tag| tag.name).collect::<Vec<_>>();
        assert_eq!(names(r#"<<b id="x">"#), ["b"], "one byte on from a lone <, the next < starts the tag");
        assert_eq!(names("<p>x<"), ["p"], "a < that ends the input is text");
        assert_eq!(names("<p><\u{e9} <b>"), ["p", "b"], "a < before a letter past ASCII is text");
    }

    #[test]
    fn a_patch_names_its_first_top_level_element_without_an_id() {
        assert_eq!(patch_problem(r#"<div id="a"><p>x</p></div> <form id="f"><input name="q"></form>"#), None);
        assert_eq!(patch_problem(r#"<template id="row-7" data-remove></template>"#), None);
        assert_eq!(patch_problem(r#"<template id="rows" data-append><tr><td>8</td></tr></template>"#), None);
        assert_eq!(patch_problem(""), None, "an empty patch changes nothing, and says so");
        assert_eq!(patch_problem("<!-- note --><p id=b>1</p>\n"), None);
        assert_eq!(patch_problem(r#"<div id="a">1 <2</div><p>x</p>"#).as_deref(), Some("<p> has no id"));
        assert_eq!(
            patch_problem(r#"<div id="recovery">ok</div><div class="write-off"><form id="w">..</form></div>"#).as_deref(),
            Some(r#"<div class="write-off"> has no id"#),
            "the pilot's Write off form, wrapped"
        );
        assert_eq!(patch_problem(r#"<p id="">x</p>"#).as_deref(), Some(r#"<p id=""> has no id"#));
        assert_eq!(
            patch_problem(r#"<p data-id="x" title="id=y">x</p>"#).as_deref(),
            Some(r#"<p data-id="x" title="id=y"> has no id"#)
        );
        assert_eq!(patch_problem(r#"<p id="a">x</p>saved"#).as_deref(), Some(r#"text "saved" outside an element"#));
        // Nested markup, void elements and raw text do not end an element early.
        let nested = r#"<section id="s"><img alt="a > b"><br/><script>if (a < b) "</div>";</script><textarea><p></textarea><div><p>x</p></div></section><p id="t"></p>"#;
        assert_eq!(patch_problem(nested), None);
        let long = format!(r#"<div class="{}">x</div>"#, "c".repeat(100));
        assert!(patch_problem(&long).unwrap().ends_with(".. has no id"));
        // A void element's end tag, which `html!` writes for a `<param>`, closes nothing.
        let object =
            r#"<p id="m"><object><param name="a"></param>fallback</object></p><div id="d"><param></param><span>x</span></div>"#;
        assert_eq!(patch_problem(object), None);
        // A script's text is read as the tokenizer reads it, to the end tag its `<!--` hides.
        assert_eq!(
            patch_problem(r#"<script id="s" type="text/plain"><!--<script></script>--></script><p>x</p>"#).as_deref(),
            Some("<p> has no id")
        );
        // At a token it does not read as the browser does it stops, finding nothing after it (the
        // parse check logs where): a `</p>` that closes nothing, which the browser reads as a `<p>`
        // inside the `<div>`, so the `<span>` is still the div's.
        for stops in [
            r#"<div id="a"></p><span>x</span></div>"#,
            r#"<div id="a"></div ignored><span>x</span></div>"#,
            r#"<div id="a"/><span>x</span></div>"#,
            r#"<div id="a"><!--->x--><span>x</span></div>"#,
            r#"<div id="a"><![CDATA[x]]><span>x</span></div>"#,
        ] {
            assert_eq!(patch_problem(stops), None, "{stops}");
        }
        assert_eq!(patch_problem(r#"<p>x</p></div ignored>"#).as_deref(), Some("<p> has no id"), "a problem before is found");
        assert_eq!(patch_problem(r#"<svg id="s"><![CDATA[<p>]]><path d="M0 0"/></svg>"#), None);
    }

    /// A script's end tag is where the HTML standard's tokenizer ends it: a `</script` and a
    /// delimiter, but one a `<!--` and a `<script` before it hide.
    #[test]
    fn a_script_s_text_ends_where_the_tokenizer_ends_it() {
        for (html, end) in [
            ("a</script>", 1),
            ("a</SCRIPT >", 1),
            ("a</scriptx></script>", 11),
            ("<!-- </script>", 5),
            ("<!--<scriptx></script>", 13),
            ("<!--<script></script>--></script>", 24),
            ("<!--<script>--></script>", 15),
            ("<!--<Script/></script -->--></script>", 28),
            ("<!--><script></script>", 13),
            ("<!--<script></script>", 21),
            ("<!--<script>", 12),
            ("a</script", 9),
        ] {
            assert_eq!(super::script_end(html, 0), end, "{html}");
        }
    }

    /// Where the check cannot read a patch as written, it says where it stopped, and reports a loss
    /// found before (`a_patch_names_what_the_browser_loses_and_what_came_first`); `html!`'s own
    /// output, void elements' end tags and foreign content included, is read to its end.
    #[test]
    fn a_patch_the_check_cannot_read_says_where_it_stopped() {
        for (html, says) in [
            (r#"<tr id="a"></tr><ul id="b"><li>x</ul><tr id="c"></tr>"#, "</ul>, where <li> is open"),
            (r#"<!-- --!><tr id="a"></tr>"#, "which a browser ends elsewhere than at its -->"),
            (r#"<tr id="a"></tr><svg id="s"><p>x</p></svg>"#, "<p> written straight in <svg>, which a browser closes before it"),
            (r#"<tr id="a"></tr><div id="b"><![CDATA[x]]></div>"#, "the CDATA section <![CDATA[x]]></div>, outside"),
            (r#"<tr id="a"></tr><div id="b">"#, "<div>, which is not closed"),
            (r#"<div id="b"><template><ul><li>x</ul></template></div>"#, "</ul>, where <li> is open"),
            (r#"<script id="s"><!--<script></script>"#, r#"<script id="s">, which is not closed"#),
            // The browser ends the first script at the second's end tag, so the paragraph and the
            // second script are its text: `html!`'s output for two data blocks and a paragraph.
            (
                r#"<script id="s" type="text/plain"><!--<script></script><p id="m">saved</p><script id="t" type="text/plain">--></script><tr id="r"><td>1</td></tr>"#,
                r#"<script id="s" type="text/plain">, whose text a <!-- and a <script in it carry past its first </script>"#,
            ),
            (
                r#"<script id="s" type="text/plain"><!--<script></script><div id="d"></div>--></script><tr id="r"></tr>"#,
                "carry past its first </script>",
            ),
            // An end tag that closes no element open: a `</p>` or `</br>` in an SVG or MathML
            // element closes the foreign content around it (and in an integration point Firefox takes
            // it out of the `<svg>` and what follows too), and outside one adds an element.
            (r#"<p id="m"></p><svg id="s"></p><tr id="r"></tr></svg>"#, "</p>, which closes no element open"),
            (r#"<p id="m"></p><svg id="s"><g></br><tr id="r"></tr></g></svg>"#, "</br>, which closes no element open"),
            (r#"<p id="m"></p><math id="x"><mrow></P><tr id="r"></tr></mrow></math>"#, "</P>, which closes no element open"),
            (r#"<svg id="s"><foreignObject></p></foreignObject><desc></br></desc></svg>"#, "</p>, which closes no element open"),
            (r#"<math id="x"><mi><div></p></div></mi></math>"#, "</p>, which closes no element open"),
            (r#"<tr id="a"></tr></div></p>"#, "</div>, which closes no element open"),
            (r#"<tr id="a"></tr><div id="b"></p></br></div>"#, "</p>, which closes no element open"),
            // An end tag written otherwise than `</name>`: the browser ignores what follows its name,
            // so `</div ignored>` closes the `<div>` and the row after it is the patch's.
            (
                r#"<tr id="a"></tr><div id="d"></div ignored><tr id="b"></tr></div>"#,
                "the end tag </div ignored>, which is not written </name>",
            ),
            (r#"<tr id="a"></tr><div id="d"></div/><tr id="b"></tr></div>"#, "the end tag </div/>, which is not"),
            (r#"<tr id="a"></tr><div id="d"></div ><tr id="b"></tr></div>"#, "the end tag </div >, which is not"),
            // An HTML element's start tag ending `/>`, which the browser opens: the cell is the row's.
            (r#"<tr id="a"/><td id="b"></td></tr>"#, r#"<tr id="a"/>, an HTML element's start tag ending />"#),
            // A token in a form the check of what it holds does not read: an end tag it does not ignore.
            (
                r#"<tr id="r"></tr><form id="f"></bogus><input name="q"></form>"#,
                r#"</bogus> in <form id="f">, which the check of what a form holds does not read"#,
            ),
            (r#"<tr id="r"></tr><form id="f"></form ><input name="q"></form>"#, "</form > in <form"),
            (r#"<tr id="r"></tr><div id="d"><form><!--->x--></form></div>"#, "<!---> in <form>"),
            // A start tag the patch ends in, in a form: its `</form>` is in the tag's value, and the
            // browser drops the tag, keeping the form empty.
            (
                r#"<tr id="r"></tr><form id="f"><b title='</form>"#,
                r#"<b title='</form> in <form id="f">, which the check of what a form holds does not read"#,
            ),
            (r#"<tr id="r"></tr><div id="d"><form><b title="</form></div>"#, r#"<b title="</form></div> in <form>"#),
            // An `<annotation-xml>` whose `encoding` is `text/html` written with a character
            // reference is an HTML integration point.
            (
                r#"<tr id="r"></tr><div id="d"><math><annotation-xml encoding="text&#x2F;html"><form><label>x</label></form></annotation-xml></math></div>"#,
                "<form> in <annotation-xml>, an SVG or MathML integration point",
            ),
            (
                r#"<tr id="r"></tr><div id="d"><math><annotation-xml encoding="text&sol;html"><form></form></annotation-xml></math></div>"#,
                "<form> in <annotation-xml>, an SVG or MathML integration point",
            ),
            // An `<a>` in an `<a>` across an integration point, which is no marker: the browser takes
            // the outer `<a>` off the elements open, and the `<span>` lands outside it.
            (
                r#"<p id="p"><a href="/x"><svg><foreignObject><a href="/y">t</a></foreignObject></svg><span>u</span></a></p>"#,
                r#"<a href="/y"> in <foreignobject>, which closes the <a> open around it"#,
            ),
            (r#"<p id="p"><a href="/x"><math><mi><a href="/y">t</a></mi></math></a></p>"#, "which closes the <a> open around it"),
            (
                r#"<colgroup id="c"><script></script></colgroup>"#,
                "<script> in <colgroup>, which a browser moves out of the <colgroup>",
            ),
            // A `<template>` in an integration point under a table's reading: past it Firefox reads
            // the rest as a body's (the row after is dropped, a form keeps what it holds).
            (
                r#"<tr id="a"><td><svg><foreignObject><template></template></foreignObject></svg></td></tr><tr id="b"></tr>"#,
                "<template> in <foreignobject>, an SVG or MathML integration point, past whose end tag Firefox",
            ),
            (
                r#"<tbody id="b"></tbody><math><mi><template></template></mi></math><span id="s"><form><p>x</p></form></span>"#,
                "<template> in <mi>, an SVG or MathML integration point",
            ),
            // A start tag the patch ends in, which the browser drops: the `<div>` is kept whole.
            (r#"<div id="d"></div><col data-note='</div>"#, "<col data-note='</div>, a start tag the patch ends in before its >"),
            (r#"<p id="m"></p><tr id="r" title="</tr>"#, "a start tag the patch ends in"),
            // An `<image>`, which the browser reads as an `<img>`: the row it holds is the patch's.
            (r#"<image id="i"><tr id="r"></tr></image>"#, r#"<image id="i">, which a browser reads as an <img>"#),
            // An element the browser does not put where it is written.
            (r#"<p id="a"><div id="b"></div></p>"#, r#"<div id="b"> in <p>, which closes the <p> open around it"#),
            (r#"<div id="a"><tr id="r"></tr></div>"#, r#"<tr id="r"> in <div>, a table part outside a table"#),
            (
                r#"<tbody id="b"><div id="d"></div></tbody>"#,
                r#"<div id="d"> in <tbody>, which a browser moves out of the <tbody>"#,
            ),
            (
                r#"<table id="t"><tbody><tr><td>1</td></tr></tbody>x</table>"#,
                "the text x in <table>, which a browser moves out of it",
            ),
            (r#"<colgroup id="g"><col>x</colgroup><p id="p"></p>"#, "the text x in <colgroup>"),
            (r#"<plaintext id="p"><b>x</b>"#, "which makes the rest of the patch its text"),
            (r#"<noscript id="n"><p id="x">a</p></noscript>"#, "whose content Firefox reads as text"),
            (r#"<select id="s"><div id="d">x</div></select>"#, "content of a <select>"),
            (r#"<div id="a"><form id="f"><form id="g"></form></form></div>"#, "a <form> in a <form>"),
            (r#"<ul id="u"><li>a<li>b</li></li></ul>"#, "<li> in <li>, which closes the <li> open around it"),
            (r#"<a id="a"><span><a id="b">x</a></span></a>"#, r#"<a id="b"> in <span>, which closes the <a> open"#),
            (r#"<td id="c"><tr><td>1</td></tr></td>"#, "<tr> in <td>, a table part outside a table"),
            // Under a table's reading, a form or a table in an SVG or MathML integration point is
            // read by its rules: the form is put in empty, the table's parts moved out.
            (
                r#"<thead id="a"></thead><svg id="s"><foreignObject><form><p>x</p></form></foreignObject></svg>"#,
                "<form> in <foreignobject>, an SVG or MathML integration point, where a table's reading moves it",
            ),
            (r#"<tr id="a"></tr><math id="m"><mi><table></table></mi></math>"#, "<table> in <mi>, an SVG or MathML"),
            (
                r#"<table id="t"><tbody><tr><td></td></tr></tbody><svg><path/></svg></table>"#,
                "<svg> in <table>, which a browser moves out of the <table>",
            ),
            (r#"<div id="d"><body><p>x</p></body></div>"#, "<body> in <div>, which a browser does not open in a patch"),
        ] {
            let why = super::patch_parse(html).unread.unwrap_or_else(|| panic!("{html}: read to its end"));
            assert!(why.contains(says), "{html}: {why}");
            assert_eq!(patch_parse_problem(html), None, "{html}");
        }
        for html in [
            "",
            r#"<tr id="a"><td><object><param></param></object></td></tr>"#,
            r#"<basefont id="h"></basefont><p id="m"></p>"#,
            r#"<svg id="s"><![CDATA[x]]><title><b>t</b></title><!-- c --></svg>"#,
            r#"<math id="x"><mi>a</mi><annotation-xml encoding="text/html"><div>d</div></annotation-xml></math>"#,
            r#"<script id="s" type="text/plain"><!-- <script></script> --></script>"#,
            // A void element's end tag, which the browser ignores, and a foreign element's `/>`.
            r#"<tr id="a"><td><input name="q"></input><svg><path d="M0 0"/></svg></td></tr>"#,
            // A script whose text carries it past its first `</script>` with no start tag between.
            r#"<script id="s" type="text/plain"><!--<script></script>--></script><tr id="r"></tr>"#,
            // Rows and cells written straight in a `<table>` or a row group: the browser adds the
            // `<tbody>` or `<tr>` around them, which loses nothing.
            r#"<table id="t"><tr><td>1</td></tr><col></table><td id="c"><table><td>1</td></table></td>"#,
            r#"<ul id="u"><li>a<ul><li>b</li></ul></li></ul><dl id="d"><dt>a</dt><dd>b<dl><dt>c</dt></dl></dd></dl>"#,
            r#"<select id="s"><optgroup label="g"><option>a</option></optgroup><option>b</option></select>"#,
            r#"<a id="a"><b>x</b></a><a id="b"><button>y</button></a><p id="p" title = "a>b"><button><p>z</p></button></p>"#,
            r#"<svg id="s"><foreignObject><div><table><tr><td><p>x</p></td></tr></table></div></foreignObject></svg>"#,
            r#"<template id="t"><tr><td>1</td></tr></template><caption id="c"><p>x</p></caption>"#,
            // An `<object>` is a marker: the `<a>` in it does not close the one around it.
            r#"<div id="d"><a href="/x"><object><a href="/y">t</a></object><span>u</span></a></div>"#,
            r#"<math id="m"><annotation-xml encoding="text&#x2F;plain"><mi>x</mi></annotation-xml></math>"#,
            // In a top-level cell, a table's reading is a cell's, which reads an integration point's
            // content as written.
            r#"<tr id="a"><td><svg><foreignObject><form><p>x</p></form></foreignObject></svg></td></tr>"#,
        ] {
            assert_eq!(super::patch_parse(html).unread, None, "{html}");
        }
        // A loss found before a start tag the patch ends in, or an element the browser puts
        // elsewhere, is kept.
        for html in
            [r#"<p id="m"></p><tr id="r"></tr><col data-x='"#, r#"<p id="m"></p><tr id="r"></tr><div id="d"><td>x</td></div>"#]
        {
            let parse = super::patch_parse(html);
            assert_eq!(parse.problem.as_deref(), Some(r#"<tr id="r"> is dropped, since <p id="m"> comes first"#), "{html}");
            assert!(parse.unread.is_some(), "{html}");
        }
        // A loss found in an element still open at a start tag the patch ends in is kept: the
        // browser places what came before as written, and closes it at the patch's end.
        for (html, lost) in [
            (r#"<tr id="r"></tr><form id="f"><b>x</b><i title='</form>"#, r#"<form id="f"> loses what it holds"#),
            (
                r#"<tr id="r"></tr><div id="d"><form><b>x</b><i title='</form></div>"#,
                r#"<form> in <div id="d"> loses what it holds"#,
            ),
            (r#"<tr id="r"></tr><table id="t"><b title='"#, r#"<table id="t"> is dropped"#),
            (r#"<tr id="r"></tr><div id="d"><table></table><b title='"#, r#"<table> in <div id="d"> is taken apart"#),
        ] {
            let parse = super::patch_parse(html);
            let problem = parse.problem.unwrap_or_else(|| panic!("{html}: no loss"));
            assert!(problem.contains(lost), "{html}: {problem}");
            assert!(parse.unread.is_some_and(|why| why.contains("a start tag the patch ends in")), "{html}");
        }
        // The round-9 case: a form that holds only a start tag the patch ends in is kept empty.
        assert_eq!(super::patch_parse_problem(r#"<tr id="r"></tr><form id="f"><b title='</form>"#), None);
        // An HTML element in an integration point is named with the SVG or MathML element it is in.
        let why = super::patch_parse(
            r#"<tr id="a"></tr><svg><foreignObject><div><template></template></div></foreignObject></svg><tr id="b"></tr>"#,
        )
        .unread
        .expect("a stop");
        assert!(why.contains("<template> in <div>, inside <foreignobject>, an SVG or MathML integration point"), "{why}");
        // A loss found before a `</p>` in an `<svg>` is kept.
        let parse = super::patch_parse(r#"<p id="m"></p><tr id="r"></tr><svg id="s"></p></svg>"#);
        assert_eq!(parse.problem.as_deref(), Some(r#"<tr id="r"> is dropped, since <p id="m"> comes first"#));
        assert!(parse.unread.is_some_and(|why| why.contains("</p>, which closes no element open")));
        // A loss after an element the browser closes where it is not written is not looked for: the
        // browser closed that element somewhere this does not follow, so what follows may be elsewhere.
        let parse = super::patch_parse(r#"<tr id="a"></tr><p id="b">one<p id="c">two</p><tr id="d"></tr>"#);
        assert_eq!(
            (parse.problem, parse.unread.as_deref()),
            (None, Some(r#"<p id="c"> in <p>, which closes the <p> open around it"#))
        );
    }

    /// Markup with characters past ASCII in its tag and attribute names, values and text is read
    /// without a panic, cut at any character, and read on past them: an attribute name that starts
    /// with one (`<span é="x">`) is that whole name.
    #[test]
    fn a_patch_with_characters_past_ascii_is_read_to_its_end() {
        let tags: Vec<_> = super::start_tags("<span \u{e9}=\"x\" data-\u{e9}t\u{e9}='\u{65e5}>' \u{65e5} title=\u{e9}>")
            .map(|tag| tag.attrs.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>())
            .collect();
        assert_eq!(tags, [["\u{e9}=x", "data-\u{e9}t\u{e9}=\u{65e5}>", "\u{65e5}=", "title=\u{e9}"]]);
        let kept = [
            "<div id=\"d\"><span \u{e9}=\"x\"></span></div>",
            "<p id=\"a\" title=\"\u{e9}t\u{e9}>\">\u{65e5}\u{672c} <\u{e9}>x</p><x-\u{e9} id=\"b\">\u{e9}</x-\u{e9}>",
            "<tr id=\"r\"><td \u{e9}><form \u{e9}=\u{e9}>\u{a0}</form></td></tr>",
        ];
        for html in kept {
            let parse = super::patch_parse(html);
            assert_eq!((parse.problem, parse.unread, patch_problem(html)), (None, None, None), "{html}");
        }
        let lost = "<p id=\"m\" \u{e9}=\"\u{e9}\">\u{e9}t\u{e9}</p><tr id=\"r\" \u{65e5}><td>\u{65e5}</td></tr>";
        assert_eq!(
            patch_parse_problem(lost).as_deref(),
            Some("<tr id=\"r\" \u{65e5}> is dropped, since <p id=\"m\" \u{e9}=\"\u{e9}\"> comes first")
        );
        for html in kept.iter().chain([&lost]) {
            for (at, _) in html.char_indices() {
                let cut = &html[..at];
                let _ = (super::patch_parse(cut).problem, patch_problem(cut), super::start_tags(cut).count());
                let _ = super::holds_shown(cut, 0);
            }
        }
    }

    /// An `<annotation-xml>`'s `encoding` is compared with its character references decoded, as the
    /// tokenizer gives it: numeric ones with or without their `;`, `&sol;` and `&plus;`.
    #[test]
    fn an_annotation_xml_s_encoding_is_read_decoded() {
        for (written, decoded) in [
            ("text/html", "text/html"),
            ("text&#x2F;html", "text/html"),
            ("text&#47html", "text/html"),
            ("&#x54;ext&sol;HTML", "Text/HTML"),
            ("application/xhtml&plus;xml", "application/xhtml+xml"),
            ("text&sol html", "text&sol html"),
            ("&#0;&#x110000;&#;&", "\u{fffd}\u{fffd}&#;&"),
            ("\u{e9}&#xe9;", "\u{e9}\u{e9}"),
        ] {
            assert_eq!(super::encoding_decoded(written), decoded, "{written}");
        }
    }

    /// Text decides a verdict where a browser moves or drops it: in a `<form>` a table's reading
    /// puts in empty, in a table holder, after a first `<col>` and at the top level. There the check
    /// reads it with its character references decoded (`&#32;` is a space, `&nbsp;` shows), and
    /// stops at a named one it does not decode; NUL, which the parser ignores, shows nothing.
    #[test]
    fn text_is_read_with_its_character_references_decoded() {
        for (text, shows) in [
            ("", Some(false)),
            (" \t\n\r\x0c\0", Some(false)),
            ("&#32;&#x20;&#X0a;&#9&#13;&#12;&Tab;&NewLine;", Some(false)),
            ("&#0;", Some(true)),
            ("&#xD800;", Some(true)),
            ("&#99999999999;", Some(true)),
            ("&#11;", Some(true)),
            ("&nbsp;", Some(true)),
            ("&nbsp", Some(true)),
            ("&amp; &lt;", Some(true)),
            ("&", Some(true)),
            ("&#;", Some(true)),
            ("&#x;", Some(true)),
            ("&Tab", None),
            ("&tab;", None),
            ("&bogus; ", None),
            ("&bogus; x", Some(true)),
            ("\u{a0}", Some(true)),
            ("\u{e9}", Some(true)),
        ] {
            assert_eq!(super::text_shows(text), shows, "{text:?}");
        }
        for html in [
            r#"<tr id="r"></tr><form id="f">&#32;</form>"#,
            "<tr id=\"r\"></tr><form id=\"f\"> &Tab;&#x0a;\0 </form>",
            r#"<tr id="r"></tr><div id="d"><form>&NewLine;</form></div>"#,
            r#"<col id="c">&#32;"#,
            r#"<table id="t"><tbody><tr><td>1</td></tr>&#32;</tbody></table>"#,
            r#"<!DOCTYPE html><!doctype HTML><tr id="r"></tr>"#,
        ] {
            let parse = super::patch_parse(html);
            assert_eq!((parse.problem, parse.unread, patch_problem(html)), (None, None, None), "{html}");
        }
        assert_eq!(
            patch_parse_problem(r#"<tr id="r"></tr><form id="f">&nbsp;</form>"#).as_deref(),
            Some(r#"<form id="f"> loses what it holds, since <tr id="r"> comes first"#)
        );
        for (html, says) in [
            (
                r#"<tr id="r"></tr><form id="f">&bogus;</form>"#,
                r#"&bogus; in <form id="f">, which the check of what a form holds"#,
            ),
            (r#"<tbody id="b"><tr><td>1</td></tr>&bogus;</tbody>"#, "the text &bogus; in <tbody>"),
            (r#"<col id="c">&bogus;"#, "the text &bogus;, which a browser drops"),
            (r#"<p id="p"></p>&tab;"#, "the text &tab;, whose character reference the check does not decode"),
        ] {
            let parse = super::patch_parse(html);
            assert_eq!(parse.problem, None, "{html}");
            assert!(parse.unread.as_deref().is_some_and(|why| why.contains(says)), "{html}: {:?}", parse.unread);
        }
        // The id check: text outside an element is what shows there.
        assert_eq!(patch_problem("<p id=\"p\"></p>&#32;&Tab;\0"), None);
        assert_eq!(patch_problem(r#"<p id="p"></p>&nbsp;"#).as_deref(), Some(r#"text "&nbsp;" outside an element"#));
        assert_eq!(patch_problem(r#"<p id="p"></p>&tab;<div></div>"#), None, "it stops at a reference it does not decode");
        assert_eq!(patch_problem(r#"<p id="p"></p><"#).as_deref(), Some(r#"text "<" outside an element"#));
        assert_eq!(patch_problem(r#"<p id="p"></p></"#).as_deref(), Some(r#"text "</" outside an element"#));
    }

    /// A doctype but `<!DOCTYPE html>` is not read, as review asked: a quoted `>` in it ends it
    /// early (the HTML standard's abrupt doctype identifier error), so what follows may be the
    /// patch's or the doctype's, and the check stops there. A `<` that starts no tag is text, which a
    /// first `<col>`'s reading drops: it stops there too.
    #[test]
    fn a_doctype_and_a_lone_lt_stop_the_check() {
        for (html, says) in [
            (r#"<div id="d"></div><!DOCTYPE html PUBLIC "><tr id='r'></tr>"></div>"#, "the doctype <!DOCTYPE html PUBLIC \">"),
            (r#"<tr id="r"></tr><form id="f"><!DOCTYPE x></form>"#, r#"<!DOCTYPE x> in <form id="f">"#),
            (r#"<col id="e1"><"#, "the text <, which a browser drops"),
            (r#"<col id="e1"></"#, "the text </, which a browser drops"),
            (r#"<tbody id="b"><tr><td>1</td></tr><</tbody>"#, "the text < in <tbody>"),
        ] {
            let parse = super::patch_parse(html);
            assert_eq!(parse.problem, None, "{html}");
            assert!(parse.unread.as_deref().is_some_and(|why| why.contains(says)), "{html}: {:?}", parse.unread);
        }
        assert_eq!(patch_problem(r#"<div id="d"></div><!DOCTYPE html PUBLIC "><p></p>">"#), None);
        assert_eq!(patch_problem(r#"<!DOCTYPE html><p></p>"#).as_deref(), Some("<p> has no id"));
    }

    /// The parse check names what is lost and the element that decided, and passes a patch a
    /// browser keeps whole: an id-less `ReadAgain` tag and an area's stylesheet after rows.
    #[test]
    fn a_patch_names_what_the_browser_loses_and_what_came_first() {
        assert_eq!(
            patch_parse_problem(r#"<p id="msg">saved</p><tr id="row-1"><td>1</td></tr>"#).as_deref(),
            Some(r#"<tr id="row-1"> is dropped, since <p id="msg"> comes first"#)
        );
        let rows: String =
            (0..50).map(|n| format!(r#"<tr id="row-{n}"><td>{n}</td><td><form><input name="q"></form></td></tr>"#)).collect();
        let kept = format!(
            r#"{rows}<template data-corten-read-again="2" data-from="/x"></template><link rel="stylesheet" href="/s.css" data-corten-style>"#
        );
        assert_eq!(patch_parse_problem(&kept), None);
        assert_eq!(patch_parse_problem(""), None);
        assert_eq!(
            patch_parse_problem("<!-- note --><script>\"<tr>\"</script><tr id=a></tr>"),
            None,
            "a script's text is not markup"
        );
        let long = format!(r#"<div class="{}"></div><tr id="b"></tr>"#, "c".repeat(100));
        assert!(patch_parse_problem(&long).unwrap().ends_with(r#"cccc.. comes first"#), "the element that decided is shortened");
        assert_eq!(
            patch_parse_problem(r#"<title>t</title><td id="a"></td>"#).as_deref(),
            Some(
                r#"<td id="a"> is dropped, since <title> comes first in Chromium and WebKit, which let a <title> before it decide how the rest is read"#
            )
        );
        for head in ["base", "basefont", "bgsound"] {
            assert_eq!(
                patch_parse_problem(&format!(r#"<{head} id="h"><tr id="r"></tr>"#)),
                Some(format!(
                    r#"<tr id="r"> is dropped, since <{head} id="h"> comes first in Chromium and WebKit, which let a <{head}> before it decide how the rest is read"#
                )),
            );
        }
        assert_eq!(
            patch_parse_problem(r#"<link id="l" rel="stylesheet" href="/s.css"><meta id="m" name="x"><tr id="r"></tr>"#),
            None,
            "a <link> or a <meta> decides in no engine"
        );
        assert_eq!(
            patch_parse_problem(r#"<tr id="a"></tr><div id="b"><template><tr><td>1</td></tr></template></div>"#),
            None,
            "a <template>'s content is read on its own"
        );
        assert_eq!(
            patch_parse_problem(r#"<tr id="a"></tr><input id="b" type="hidden" name="h"><tr id="c"><td>1</td></tr>"#),
            None,
            "a void element holds nothing: the next row's cells are its own"
        );
        assert_eq!(
            patch_parse_problem(r#"<script id="s" type="text/plain"></scriptx><div id="d"></div></script><tr id="r"></tr>"#),
            None,
            "</scriptx> is a script's text, not its end tag"
        );
        assert_eq!(
            patch_parse_problem(r#"<tr id="a"></tr><ul id="b"><li>x</ul><tr id="c"></tr>"#),
            None,
            "an <li> whose end tag is left out: not read"
        );
        assert_eq!(
            patch_parse_problem(r#"<tr id="a"></tr><p id="b">one<p id="c">two</p><tr id="d"></tr>"#),
            None,
            "a <p> closed by the next: not read"
        );
        assert_eq!(
            patch_parse_problem(r#"<tr id="a"></tr><svg id="b"><g><tr></tr></g></svg>"#),
            None,
            "an <svg>'s <tr> is SVG's"
        );
        assert_eq!(
            patch_parse_problem(r#"<svg id="s"><template><g></g><tr></tr></template></svg>"#),
            None,
            "an <svg>'s <template> is SVG's"
        );
        assert_eq!(
            patch_parse_problem(r#"<template id="t"><tr id="r"></tr><form id="f"></form></template>"#).as_deref(),
            Some(r#"<form id="f"> is dropped in Firefox, since <tr id="r"> comes first"#),
            "a table's reading drops a <form> in a <template> the patch has, empty too"
        );
        assert_eq!(
            patch_parse_problem(r#"<template id="t"><td id="c"></td><form><label></label></form></template>"#).as_deref(),
            Some("<form> loses what it holds, since <td id=\"c\"> comes first"),
            "and Chromium and WebKit move out what it holds"
        );
        assert_eq!(
            patch_parse_problem(
                r#"<tr id="r"></tr><svg id="s"><style><!--</style></svg><table id="t"></table><svg id="s2"><style>--></style></svg>"#
            ),
            None,
            "an <svg>'s <style> holds markup, here a comment that hides the <table>"
        );
        assert_eq!(
            patch_parse_problem(r#"<!-- --!><tr id="a"></tr><!-- --><div id="b"></div><tr id="c"></tr>"#),
            None,
            "a comment ended by --!>: not read"
        );
        assert_eq!(
            patch_parse_problem(r#"<svg id="s"><![CDATA[></svg><tr id="r"></tr><svg id="x">]]></svg>"#),
            None,
            "an <svg>'s CDATA section is text, up to ]]>"
        );
        // Foreign content is read for where it ends, so a loss before, around or after it is found.
        let icon = r#"<svg><title>Delete</title><style>path { fill: red; }</style><!-- trash --><path d="M0 0"/></svg>"#;
        assert_eq!(
            patch_parse_problem(&format!(r#"<p id="msg">saved</p><tr id="row-1"><td>{icon}</td></tr>"#)).as_deref(),
            Some(r#"<tr id="row-1"> is dropped, since <p id="msg"> comes first"#),
            "a row with an icon's <svg> in it, after a <p>"
        );
        assert_eq!(
            patch_parse_problem(&format!(r#"<tr id="row-1"><td>{icon}</td></tr><p id="msg">saved</p><tr id="row-2"></tr>"#)),
            None,
            "after a first <tr>, a <p> and a <tr> are kept, an icon's <svg> or not"
        );
        assert_eq!(
            patch_parse_problem(&format!(r#"<tr id="row-1"><td>{icon}</td></tr><table id="t"></table>"#)).as_deref(),
            Some(r#"<table id="t"> is dropped, since <tr id="row-1"> comes first"#),
            "a loss after an <svg> is found"
        );
        assert_eq!(
            patch_parse_problem(r#"<p id="m"></p><tr id="r"><td><svg><![CDATA[<x>]]><g/></svg><math><mi>x</mi><annotation-xml encoding="text/html"><style><svg></style></annotation-xml></math></td></tr>"#)
                .as_deref(),
            Some(r#"<tr id="r"> is dropped, since <p id="m"> comes first"#),
            "a CDATA section, a MathML text integration point and an HTML <style> in an <annotation-xml>"
        );
        assert_eq!(
            patch_parse_problem(
                r#"<tr id="r"></tr><svg id="s"><desc><style></desc></svg><table id="t"></table></style></desc></svg>"#
            ),
            None,
            "an HTML <style> at an <svg>'s integration point is text up to its end tag"
        );
        assert_eq!(
            patch_parse_problem(r#"<p id="m"></p><tr id="r"><td><svg><p>x</p></svg></td></tr>"#).as_deref(),
            Some(r#"<tr id="r"> is dropped, since <p id="m"> comes first"#),
            "a loss before a <p> written straight in an <svg> (which html! refuses), where reading stops, is found"
        );
        assert_eq!(
            patch_parse_problem(r#"<tr id="r"></tr><form id="f">saved</form>"#).as_deref(),
            Some(r#"<form id="f"> loses what it holds, since <tr id="r"> comes first"#),
            "a form's text is moved out of it too, which patch-parsing.json's elements do not show"
        );
        assert_eq!(
            patch_parse_problem(r#"<tr id="r"></tr><form id="f"></form>"#),
            None,
            "an empty <form> at the patch's top level is kept"
        );
        for holds in [" \n\t ", "<!-- note -->", " <!-- a --> <!-- b --> ", "<!note> <?x>"] {
            assert_eq!(
                patch_parse_problem(&format!(
                    r#"<tr id="r"></tr><form id="f">{holds}</form><div id="d"><form>{holds}</form></div>"#
                )),
                None,
                "a <form> of whitespace and comments shows the same put in empty: {holds:?}"
            );
        }
        for holds in [
            "<!-- note --><input name=\"q\">",
            " <b>x</b>",
            "<!-- a -->saved",
            // A bogus comment and a doctype show nothing, and the text after them is moved out.
            "<!note>saved",
            "<?x>saved",
            "</ x>saved",
            "</>saved",
            "<!DOCTYPE html>saved",
            "a < b",
            // A void element's end tag, which the browser ignores, before what the form holds.
            "</input><input name=\"q\">",
            "</param>saved",
        ] {
            assert_eq!(
                patch_parse_problem(&format!(r#"<tr id="r"></tr><form id="f">{holds}</form>"#)).as_deref(),
                Some(r#"<form id="f"> loses what it holds, since <tr id="r"> comes first"#),
                "{holds:?}"
            );
        }
        assert_eq!(
            patch_parse_problem(r#"<script id="s"><!-- note --></script><p id="m"></p><tr id="r"></tr>"#).as_deref(),
            Some(r#"<tr id="r"> is dropped, since <p id="m"> comes first"#),
            "a comment in a script hides no end tag"
        );
        for text in ["<!-- <scriptx> -->", "<!-- <script></script> -->", "<!--<SCRIPT/>-->"] {
            assert_eq!(
                patch_parse_problem(&format!(
                    r#"<script id="s" type="text/plain">{text}</script><p id="m">saved</p><tr id="r"><td>1</td></tr>"#
                ))
                .as_deref(),
                Some(r#"<tr id="r"> is dropped, since <p id="m"> comes first"#),
                "what follows a script whose text has <!-- and <script in it is read: {text}"
            );
        }
        assert_eq!(
            patch_parse_problem(r#"<script id="s" type="text/plain"><!--<script></script><p id="m">saved</p>"#).as_deref(),
            Some(
                r#"what follows <script id="s" type="text/plain"> is read as its text, since a <!-- and a <script in its text hide its end tag"#
            ),
            "a script whose text hides the end tag written after it"
        );
        assert_eq!(
            patch_parse_problem(r#"<p id="m">saved</p><tr id="r"><td><object><param name="a"></param>x</object></td></tr>"#)
                .as_deref(),
            Some(r#"<tr id="r"> is dropped, since <p id="m"> comes first"#),
            "a void element's end tag, which html! writes for a <param>, is ignored and the loss before it kept"
        );
        assert_eq!(
            patch_parse_problem(r#"<basefont id="h"></basefont><bgsound id="b"></bgsound><p id="m">saved</p><tr id="r"></tr>"#)
                .as_deref(),
            Some(r#"<tr id="r"> is dropped, since <p id="m"> comes first"#),
            "a <basefont>'s and a <bgsound>'s end tags close nothing"
        );
        assert_eq!(
            patch_parse_problem(r#"<basefont id="h"><p id="m">saved</p><tr id="r"></tr>"#).as_deref(),
            Some(r#"<tr id="r"> is dropped, since <p id="m"> comes first"#),
            "a <basefont> holds nothing"
        );
        assert_eq!(
            patch_parse_problem(r#"<div id="host"><template id="rows"><p id="msg"></p><tr id="row"></tr></template></div>"#)
                .as_deref(),
            Some(r#"<tr id="row"> is dropped, since <p id="msg"> comes first"#),
            "a <template>'s content inside an element is read on its own"
        );
    }

    /// `html` as written, in the form `patch-parsing.json` gives a browser's parse: each element
    /// as `name#id`, its child elements in `(..)` and a `<template>`'s content in `{..}`.
    #[cfg(feature = "json")]
    fn written(html: &str) -> Vec<String> {
        // Each open element as written so far, and its children.
        let mut open: Vec<(String, Vec<String>)> = vec![(String::new(), Vec::new())];
        let close = |open: &mut Vec<(String, Vec<String>)>| {
            let (name, children) = open.pop().expect("an open element");
            let tag = |shown: &str, tag: &str| shown.split('#').next() == Some(tag);
            // An `<svg>`'s or `<math>`'s `<template>` is foreign content's, with children, not content.
            let foreign = open.iter().any(|(shown, _)| tag(shown, "svg") || tag(shown, "math"));
            let shown = if tag(&name, "template") && !foreign {
                format!("{name}{{{}}}", children.join(","))
            } else if children.is_empty() {
                name
            } else {
                format!("{name}({})", children.join(","))
            };
            open.last_mut().expect("the top").1.push(shown);
        };
        let mut i = 0;
        while let Some(at) = html.get(i..).and_then(|rest| rest.find('<')).map(|n| i + n) {
            if let Some(comment) = html[at..].strip_prefix("<!--") {
                // A comment is no element, and a parse lists none.
                i = comment.find("-->").map_or(html.len(), |n| at + 4 + n + 3);
                continue;
            }
            if let Some(cdata) = html[at..].strip_prefix("<![CDATA[") {
                // A CDATA section, an `<svg>`'s or a `<math>`'s text, is no element either.
                i = cdata.find("]]>").map_or(html.len(), |n| at + 9 + n + 3);
                continue;
            }
            if html[at..].starts_with("</") {
                // It closes the element it names and those inside it whose end tags are left out.
                let end = html[at..].find('>').map_or(html.len(), |n| at + n);
                let name = html[at + 2..end].trim().to_ascii_lowercase();
                let named = |shown: &str| shown.split('#').next().is_some_and(|shown| shown.eq_ignore_ascii_case(&name));
                if open.iter().skip(1).any(|(shown, _)| named(shown)) {
                    while !named(&open.last().expect("an open element").0) {
                        close(&mut open);
                    }
                    close(&mut open);
                }
                i = (end + 1).min(html.len());
                continue;
            }
            let tag = super::start_tag(html, at);
            i = tag.end;
            let id = tag.attr("id").map(|id| format!("#{id}")).unwrap_or_default();
            // An SVG element keeps its name's case (`foreignObject`), as written here.
            let svg = tag.name == "svg" || open.iter().any(|(shown, _)| shown.split('#').next() == Some("svg"));
            let name = if svg { &html[at + 1..at + 1 + tag.name.len()] } else { tag.name.as_str() };
            open.push((format!("{name}{id}"), Vec::new()));
            if TEXT_ELEMENTS.contains(&tag.name.as_str()) {
                // A script's text as the tokenizer ends it, or, where its text hides every end tag,
                // as `html!` wrote it (to the end tag after its text).
                let script = (tag.name == "script").then(|| super::script_end(html, i)).filter(|end| *end < html.len());
                i = script.unwrap_or_else(|| super::raw_text_end(html, i, &tag.name));
            }
            if super::VOID.contains(&tag.name.as_str()) || tag.self_closing {
                close(&mut open);
            }
        }
        open.pop().expect("the top").1
    }

    /// `patch-parsing.json`'s cases, whose parses `scripts/smoke.mjs` checks in Chromium, Firefox
    /// and WebKit: of these cases, the check reports exactly those some browser does not parse as
    /// written, naming what it loses. Elements are compared, not text: a form's text moved out of it is
    /// [`a_patch_names_what_the_browser_loses_and_what_came_first`]'s.
    #[cfg(feature = "json")]
    #[test]
    fn a_patch_s_parse_problems_are_what_browsers_parse() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("patch-parsing.json")).expect("patch-parsing.json is JSON");
        let cases = vectors["cases"].as_array().expect("cases");
        assert!(cases.len() > 30);
        for case in cases {
            let html = case["html"].as_str().expect("html");
            let as_written = serde_json::Value::from(written(html));
            let mut parses = vec![&case["parsed"]];
            if let Some(engines) = case["parsedIn"].as_object() {
                parses.extend(engines.values());
            }
            let loses = parses.iter().any(|parsed| **parsed != as_written);
            let parse = super::patch_parse(html);
            if let Some(stops) = case["unread"].as_str() {
                // A construct the check does not follow: it says where it stopped, and reports none.
                assert!(case["lost"].is_null(), "{html}: a case the check stops at loses nothing it reports");
                assert_eq!(parse.problem, None, "{html}");
                let why = parse.unread.unwrap_or_else(|| panic!("{html}: read to its end"));
                assert!(why.contains(stops), "{html}: {why:?} does not say {stops:?}");
                continue;
            }
            let problem = parse.problem;
            assert_eq!(
                case["lost"].is_null(),
                !loses,
                "{html}: lost is set exactly when a browser parses it otherwise than {as_written}"
            );
            assert_eq!(problem.is_some(), loses, "{html}: {problem:?}");
            if let Some(lost) = case["lost"].as_str() {
                let problem = problem.expect("a problem");
                assert!(problem.contains(lost), "{html}: {problem:?} does not say {lost:?}");
            }
        }
    }

    /// The shapes `html!` refuses at a patch's top level (`check_patch_top` in
    /// `crates/corten-macros/src/html.rs`: a table part after a first `<table>`; an element HTML's
    /// wherever it lands after a first `<col>`; after a first other table part, a `<table>` at the
    /// top level or in a later element, and a `<form>` that holds an element with one HTML's
    /// wherever it lands in or around it) are lost in every browser wherever a patch puts them:
    /// first, and after each table part the patch may begin with, which a component's markup does
    /// not show. Each is a case of `patch-parsing.json`, whose parses
    /// `scripts/smoke.mjs` checks in Chromium, Firefox and WebKit, so the refusal is held to the
    /// same browsers as the debug check.
    #[cfg(feature = "json")]
    #[test]
    fn a_shape_html_refuses_is_lost_after_each_table_part() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("patch-parsing.json")).expect("patch-parsing.json is JSON");
        let cases = vectors["cases"].as_array().expect("cases");
        // An element as the cases write it: a row with a cell, a cell with its number, a caption,
        // a <div> or a <p> with text.
        let element = |name: &str, id: &str, n: u8| match name {
            "col" => format!(r#"<col id="{id}">"#),
            "tr" => format!(r#"<tr id="{id}"><td>{n}</td></tr>"#),
            "td" | "th" => format!(r#"<{name} id="{id}">{n}</{name}>"#),
            "caption" | "div" | "p" => format!(r#"<{name} id="{id}">x</{name}>"#),
            _ => format!(r#"<{name} id="{id}"></{name}>"#),
        };
        let table = r#"<table id="a"><tbody><tr><td>1</td></tr></tbody></table>"#;
        let mut shapes: Vec<String> = super::TABLE_PARTS.iter().map(|part| format!("{table}{}", element(part, "b", 2))).collect();
        shapes.extend(["div", "p", "table"].map(|name| format!(r#"<col id="a">{}"#, element(name, "b", 2))));
        let after_part = [
            r#"<table id="b"><tbody><tr><td>1</td></tr></tbody></table>"#,
            r#"<div id="b"><table><tbody><tr><td>1</td></tr></tbody></table></div>"#,
            r#"<label id="b"><span><table><tbody><tr><td>1</td></tr></tbody></table></span></label>"#,
            r#"<form id="b"><div><input name="q"></div></form>"#,
            r#"<form id="b"><p>x</p></form>"#,
            r#"<form id="b"><label><span><input name="q"></span></label></form>"#,
            r#"<div id="b"><form><input name="q"></form></div>"#,
        ];
        for part in super::TABLE_PARTS.iter().filter(|part| **part != "col") {
            shapes.extend(after_part.map(|after| format!("{}{after}", element(part, "a", 2))));
        }
        let mut before = vec![String::new()];
        before.extend(super::TABLE_PARTS.iter().map(|part| element(part, "h", 1)));
        for before in &before {
            for shape in &shapes {
                let html = format!("{before}{shape}");
                let case = cases.iter().find(|case| case["html"] == html.as_str()).unwrap_or_else(|| panic!("no case {html}"));
                let as_written = serde_json::Value::from(written(&html));
                let mut parses = vec![&case["parsed"]];
                if let Some(engines) = case["parsedIn"].as_object() {
                    parses.extend(engines.values());
                }
                assert!(parses.iter().all(|parsed| **parsed != as_written), "{html}: some browser keeps it as written");
                assert!(patch_parse_problem(&html).is_some(), "{html}");
            }
        }
    }

    /// Hold the actual `html!` expansions and their whole-patch verdicts to the browser vectors.
    #[cfg(feature = "json")]
    #[test]
    fn a_whole_patch_s_literal_top_level_follows_the_browser_vectors() {
        use crate::prelude::Id;
        #[derive(Id)]
        struct AId;
        #[derive(Id)]
        struct BId;
        #[derive(Id)]
        struct CId;
        #[derive(Id)]
        struct HId;
        #[derive(Id)]
        struct RId;
        #[derive(Id)]
        struct TId;
        fn render_patch(view: impl crate::view::Patch) -> String {
            view.to_html()
        }

        let vectors: serde_json::Value = serde_json::from_str(include_str!("patch-parsing.json")).unwrap();
        let cases = vectors["cases"].as_array().unwrap();
        for (markup, _, verdict, html) in corten_macros::__whole_patch_cases!(render) {
            let case = cases.iter().find(|case| case["html"] == html.as_str()).unwrap_or_else(|| panic!("no case {html}"));
            let as_written = serde_json::Value::from(written(&html));
            let differs = case["parsed"] != as_written
                || case["parsedIn"].as_object().is_some_and(|engines| engines.values().any(|parsed| *parsed != as_written));
            assert_eq!(verdict.is_some(), differs, "{markup}: {verdict:?} against {case}");
            let problem = patch_parse_problem(&html);
            match case["lost"].as_str() {
                Some(want) => assert!(problem.is_some_and(|why| why.contains(want)), "{html}: {want}"),
                None => assert_eq!(problem, None, "{html}"),
            }
        }
    }

    /// The lists `html!`'s refusal reads a patch's top level and foreign content by are this check's:
    /// `corten-macros` has no dependency to share them through. (Skipped outside the repository.)
    #[test]
    fn the_macro_s_patch_lists_are_the_check_s() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../corten-macros/src/html.rs");
        let Ok(source) = std::fs::read_to_string(path) else { return };
        let list = |name: &str| -> Vec<String> {
            let start = source.find(&format!("const {name}: &[&str] =")).unwrap_or_else(|| panic!("{name} in corten-macros"));
            let end = start + source[start..].find("];").expect("the list's end");
            source[start..end].split('"').skip(1).step_by(2).map(str::to_owned).collect()
        };
        assert_eq!(list("TEMPLATE_HEAD"), super::HEAD_TAGS);
        assert_eq!(list("DECIDING_HEAD"), super::DECIDING_HEAD);
        assert_eq!(list("TABLE_PARTS"), super::TABLE_PARTS);
        assert_eq!(list("SVG_HTML_POINTS"), super::SVG_HTML_POINTS);
        assert_eq!(list("MATH_HTML_POINTS"), super::MATH_HTML_POINTS);
        assert_eq!(list("BREAKOUT"), super::BREAKOUT);
        let mut text = [list("RAW_TEXT"), list("TEXT_ONLY")].concat();
        let mut raw_text = TEXT_ELEMENTS.to_vec();
        text.sort();
        raw_text.sort();
        assert_eq!(text, raw_text, "the elements whose text is not markup");
        assert!(raw_text.iter().all(|name| matches!(
            super::Mode::of(name, false),
            super::Mode::Rcdata | super::Mode::Rawtext | super::Mode::Script
        )));
    }

    /// A seeded generator of patches: the shapes of \`patch-parsing.json\` (table parts, a
    /// \`<table>\`, a \`<form>\`, head tags, a \`<template>\`, an \`<svg>\` and a \`<math>\` with their
    /// integration points) composed at random with text (characters past ASCII, character
    /// references, NUL) and the tokens the check has been found to misread (a doctype with a quoted
    /// `>`, names past ASCII, a start tag the patch ends in, an end tag written otherwise than \`</name>\` or closing
    /// nothing, an element whose content is text and a script's comment-like text, a CDATA section,
    /// a comment a browser ends early and a bogus one, an \`<image>\`, an element written where a
    /// browser does not put it, attributes the tokenizer reads past a \`>\` or an \`=\`), each piece
    /// with what it shows as written.
    #[cfg(feature = "json")]
    mod generate {
        /// splitmix64, so a seed gives the same cases on every machine.
        pub struct Rng(pub u64);

        impl Rng {
            pub fn next(&mut self) -> u64 {
                self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
                let mut z = self.0;
                z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
                z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
                z ^ (z >> 31)
            }

            pub fn below(&mut self, n: usize) -> usize {
                (self.next() % n as u64) as usize
            }

            pub fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
                items[self.below(items.len())]
            }

            pub fn one_in(&mut self, n: usize) -> bool {
                self.below(n) == 0
            }
        }

        /// Markup, and what it shows as written: each element as \`name#id\`, a \`"\` when it holds
        /// text, its child elements in \`(..)\` and a \`<template>\`'s content in \`{..}\`.
        #[derive(Default)]
        pub struct Piece {
            pub html: String,
            pub shown: Vec<String>,
            pub text: bool,
        }

        impl Piece {
            fn add(&mut self, other: Piece) {
                self.html.push_str(&other.html);
                self.shown.extend(other.shown);
                self.text |= other.text;
            }

            /// Markup that shows nothing.
            fn token(html: &str) -> Piece {
                Piece { html: html.into(), ..Piece::default() }
            }

            fn text(html: &str) -> Piece {
                Piece { html: html.into(), text: true, ..Piece::default() }
            }

            /// Text that shows only when `shows`: something but ASCII whitespace and NUL once its
            /// character references are decoded.
            fn chars(html: &str, shows: bool) -> Piece {
                Piece { html: html.into(), text: shows, ..Piece::default() }
            }
        }

        /// What a piece is read as: HTML, HTML straight in an SVG or MathML integration point (where
        /// a CDATA section is text), SVG or MathML.
        #[derive(Clone, Copy, PartialEq)]
        enum In {
            Html,
            Point,
            Svg,
            Math,
        }

        const CONTAINERS: &[&str] = &[
            "div", "span", "p", "li", "ul", "a", "button", "form", "label", "b", "h2", "h3", "section", "dl", "dt", "dd", "ruby",
            "rt", "select", "table", "template", "svg", "math", "i", "p", "div", "span", "form", "label", "section",
            // In a tricky patch only.
            "option", "td", "th", "tr", "tbody", "caption", "noscript", "image", "x-\u{e9}",
        ];
        /// Text, and whether it shows: anything but ASCII whitespace and NUL (which the HTML parser
        /// ignores outside foreign content) once its character references are decoded. The first
        /// are what `html!` writes for text (its escapes, and characters past ASCII as they are).
        const TEXT: &[(&str, bool)] = &[
            ("x", true),
            (" ", false),
            ("\u{e9}t\u{e9}", true),
            ("\u{65e5}\u{672c}", true),
            ("\u{a0}", true),
            ("&amp;", true),
            ("&lt;", true),
            ("&#39;", true),
            // In a tricky patch only.
            ("&#32;", false),
            ("&#x20;", false),
            ("&#9", false),
            ("&#X0a;", false),
            ("&#13;", false),
            ("&Tab;", false),
            ("&NewLine;", false),
            ("&nbsp;", true),
            ("&nbsp", true),
            ("&#0;", true),
            ("&#xD800;", true),
            ("&#1114112;", true),
            ("&#128;", true),
            ("&bogus;", true),
            ("&tab;", true),
            ("&", true),
            ("&#;", true),
            ("&#x;", true),
            ("\0", false),
            (" &#32;\0&Tab; ", false),
        ];
        const VOIDS: &[&str] = &["br", "img", "input", "hr", "col", "wbr", "meta", "link", "base", "basefont", "param"];
        const RAW: &[&str] = &["textarea", "title", "style", "script", "xmp", "iframe", "noembed", "noframes"];
        const RAW_TEXT: &[&str] = &["x", r#"<p id="r">y</p>"#, "</div>", "<tr><td>1</td></tr>", "<!--", "a<b", "</form>"];
        const SCRIPT_TEXT: &[&str] =
            &["f()", "<!--", "<!--<script>", "<!--<script></script>", "a<b", "<!-- x -->", "</scriptx>", "<!--x--><script>"];
        const TOKENS: &[&str] = &[
            "<!--c-->",
            "<!-->",
            "<!--->",
            "<!--a--!>b-->",
            r#"<!--a--!><p id="h"></p>-->"#,
            "<!b>",
            "<?b>",
            "</ b>",
            "</>",
            "<![CDATA[c]]>",
            "</p>",
            "</br>",
            "</span>",
            "</input>",
            "</bogus>",
            "</image>",
            "</div ignored>",
            "</tr>",
            "</form>",
            "<!DOCTYPE html>",
            "<!doctype HTML>",
            r#"<!DOCTYPE html PUBLIC "><p id='q'></p>">"#,
            "<!DOCTYPE html SYSTEM '>'>",
            "<!DOCTYPE x>",
        ];
        const ATTRS: &[&str] = &[
            r#" class="c""#,
            r#" title = "a>b""#,
            " title='</div>'",
            r#" data-on='{"a":"b>c"}'"#,
            r#" title="a"lang="b""#,
            " =x",
            " hidden /",
            " title=a/",
            r#" TITLE="T""#,
            r#" id="dup""#,
            r#" title="<tr id='q'>""#,
            " \u{e9}=\"x\"",
            " data-\u{e9}t\u{e9}='\u{65e5}>'",
            " title=\u{e9}",
            " \u{65e5}",
        ];
        const UNFINISHED: &[&str] = &[
            "<col data-note='",
            r#"<tr id="z""#,
            "<p",
            "</div",
            "<!--x",
            r#"<div id="u" title="a"#,
            "<![CDATA[x",
            "<",
            "</",
            r#"<td id="q" "#,
            r#"<tr id="z" title="</tr>"#,
            "<p \u{e9}",
        ];
        /// A start tag or comment the patch ends in, in a `<form>`, and what is written after it,
        /// which is its value or text.
        const UNFINISHED_IN_FORM: &[(&str, &str)] = &[
            ("<b title='", "</form>"),
            (r#"<label class="a"#, "</form>"),
            ("<input name='q", "</form></div>"),
            ("<p", ""),
            (r#"<span id="s" "#, ""),
            ("<!--x", "</form>"),
        ];
        /// The unfinished tokens a browser keeps as text: a `<` or `</` the patch ends in.
        const UNFINISHED_TEXT: &[&str] = &["<", "</"];
        const PARTS: &[&str] = &["tr", "td", "th", "tbody", "thead", "tfoot", "caption", "col", "colgroup"];
        const HEADS: &[&str] =
            &["title", "base", "basefont", "bgsound", "noframes", "link", "meta", "style", "script", "template"];

        /// Elements that hold phrasing content only, and what a clean patch puts in one.
        const PHRASING_HOLDERS: &[&str] = &["p", "span", "a", "b", "i", "label", "button", "h2", "h3", "dt", "rt", "option"];
        const PHRASING: &[&str] = &["span", "a", "b", "i", "label", "button", "select", "svg", "math", "template"];

        pub struct Gen {
            rng: Rng,
            ids: usize,
            /// This patch has the tokens the check stops at (half of them do): the others are
            /// markup `html!` could write, or a component composed beside one.
            tricky: bool,
            /// The element being filled holds phrasing content only.
            phrasing: bool,
        }

        impl Gen {
            pub fn new(seed: u64) -> Self {
                Gen { rng: Rng(seed), ids: 0, tricky: false, phrasing: false }
            }

            fn id(&mut self, id: bool) -> Option<String> {
                id.then(|| {
                    self.ids += 1;
                    format!("e{}", self.ids)
                })
            }

            fn shown(name: &str, id: &Option<String>, content: &Piece, template: bool) -> String {
                let id = id.as_ref().map(|id| format!("#{id}")).unwrap_or_default();
                let text = if content.text { "\"" } else { "" };
                let children = content.shown.join(",");
                if template {
                    format!("{name}{id}{text}{{{children}}}")
                } else if children.is_empty() {
                    format!("{name}{id}{text}")
                } else {
                    format!("{name}{id}{text}({children})")
                }
            }

            /// \`<name id attrs>content</name>\`, its end tag sometimes written otherwise.
            fn element(&mut self, name: &str, id: bool, content: Piece, template: bool) -> Piece {
                let mut id = self.id(id);
                let attrs = if self.tricky && self.rng.one_in(12) { self.rng.pick(ATTRS) } else { "" };
                if id.is_none() && attrs == r#" id="dup""# {
                    // The browser reads the attributes' `id` when there is no other.
                    id = Some("dup".into());
                    let piece = Piece {
                        html: format!("<{name}{attrs}>{}</{name}>", content.html),
                        shown: vec![Self::shown(name, &id, &content, template)],
                        text: false,
                    };
                    return piece;
                }
                let end = match if self.tricky { self.rng.below(40) } else { 40 } {
                    0 => format!("</{name} ignored>"),
                    1 => format!("</{name} >"),
                    2 => format!("</{}>", name.to_ascii_uppercase()),
                    _ => format!("</{name}>"),
                };
                let id_attr = id.as_ref().map(|id| format!(r#" id="{id}""#)).unwrap_or_default();
                Piece {
                    html: format!("<{name}{id_attr}{attrs}>{}{end}", content.html),
                    shown: vec![Self::shown(name, &id, &content, template)],
                    text: false,
                }
            }

            /// An element with no end tag, or a foreign one closed by its \`/>\`.
            fn void(&mut self, name: &str, id: bool, slash: bool) -> Piece {
                let id = self.id(id);
                let id_attr = id.as_ref().map(|id| format!(r#" id="{id}""#)).unwrap_or_default();
                let slash = if slash { "/" } else { "" };
                Piece {
                    html: format!("<{name}{id_attr}{slash}>"),
                    shown: vec![Self::shown(name, &id, &Piece::default(), false)],
                    text: false,
                }
            }

            /// Text from `TEXT`: what `html!` writes for text, and in a tricky patch character
            /// references, whitespace and NUL.
            fn some_text(&mut self) -> Piece {
                let pool = if self.tricky { TEXT } else { &TEXT[..8] };
                let (html, shows) = pool[self.rng.below(pool.len())];
                Piece::chars(html, shows)
            }

            fn content(&mut self, within: In, depth: usize) -> Piece {
                let mut content = Piece::default();
                let n = if depth > 2 { self.rng.below(2) } else { self.rng.below(3) };
                for _ in 0..n {
                    let child = if depth > 2 { Piece::text("x") } else { self.child(within, depth) };
                    content.add(child);
                }
                content
            }

            fn table(&mut self, id: bool, depth: usize) -> Piece {
                let cell = self.content(In::Html, depth + 1);
                let id_cell = self.rng.one_in(3);
                let td = self.element("td", id_cell, cell, false);
                let tr = self.element("tr", false, td, false);
                let tbody = self.element("tbody", false, tr, false);
                let mut inner = Piece::default();
                if self.rng.one_in(4) {
                    inner.add(self.element("caption", false, Piece::text("c"), false));
                }
                if self.rng.one_in(4) {
                    let col = self.void("col", false, false);
                    inner.add(self.element("colgroup", false, col, false));
                }
                inner.add(tbody);
                if self.rng.one_in(6) {
                    // Something written straight in the table, but a table part, which the browser
                    // puts in the `<tbody>` or `<tr>` it adds, losing nothing.
                    let name = self.rng.pick(&["div", "span", "p", "form", "b", "svg", "template", "select", "image"]);
                    let stray = if self.rng.one_in(3) { Piece::text("x") } else { self.html_element(name, false, depth + 1) };
                    inner.add(stray);
                }
                self.element("table", id, inner, false)
            }

            fn part(&mut self, name: &str, id: bool, depth: usize) -> Piece {
                match name {
                    "tr" => {
                        let cell = self.content(In::Html, depth + 1);
                        let td = self.element("td", false, cell, false);
                        self.element("tr", id, td, false)
                    }
                    "tbody" | "thead" | "tfoot" => {
                        let rows = if self.rng.one_in(2) {
                            let td = self.element("td", false, Piece::text("1"), false);
                            self.element("tr", false, td, false)
                        } else {
                            Piece::default()
                        };
                        self.element(name, id, rows, false)
                    }
                    "col" => self.void("col", id, false),
                    "colgroup" => {
                        let col = self.void("col", false, false);
                        self.element("colgroup", id, col, false)
                    }
                    _ => {
                        let content = self.content(In::Html, depth + 1);
                        self.element(name, id, content, false)
                    }
                }
            }

            fn raw(&mut self, name: &str, id: bool) -> Piece {
                let pool = if name == "script" { SCRIPT_TEXT } else { RAW_TEXT };
                let text = if self.tricky { self.rng.pick(pool) } else { pool[0] };
                self.element(name, id, Piece::text(text), false)
            }

            fn html_element(&mut self, name: &str, id: bool, depth: usize) -> Piece {
                match name {
                    "table" => self.table(id, depth),
                    "svg" => {
                        let content = self.content(In::Svg, depth + 1);
                        self.element("svg", id, content, false)
                    }
                    "math" => {
                        let content = self.content(In::Math, depth + 1);
                        self.element("math", id, content, false)
                    }
                    "template" => {
                        let content = self.content(In::Html, depth + 1);
                        self.element("template", id, content, true)
                    }
                    "select" => {
                        let mut options = Piece::default();
                        for _ in 0..1 + self.rng.below(2) {
                            let option = if self.rng.one_in(4) {
                                self.child(In::Html, depth + 1)
                            } else {
                                self.element("option", false, Piece::text("o"), false)
                            };
                            options.add(option);
                        }
                        self.element("select", id, options, false)
                    }
                    _ if PARTS.contains(&name) => self.part(name, id, depth),
                    _ if self.tricky && self.rng.one_in(30) => {
                        // \`<div id="x"/>\`, which a browser leaves open.
                        let id = self.id(id);
                        let id_attr = id.as_ref().map(|id| format!(r#" id="{id}""#)).unwrap_or_default();
                        Piece {
                            html: format!("<{name}{id_attr}/>"),
                            shown: vec![Self::shown(name, &id, &Piece::default(), false)],
                            text: false,
                        }
                    }
                    _ => {
                        let holder = std::mem::replace(&mut self.phrasing, PHRASING_HOLDERS.contains(&name));
                        let content = self.content(In::Html, depth + 1);
                        self.phrasing = holder;
                        self.element(name, id, content, false)
                    }
                }
            }

            fn child(&mut self, within: In, depth: usize) -> Piece {
                let id = self.rng.one_in(2);
                let roll = self.rng.below(100);
                match within {
                    In::Html | In::Point => match roll {
                        0..15 => self.some_text(),
                        15..21 if !self.tricky => Piece::text("x"),
                        15..21 => {
                            let token = self.rng.pick(TOKENS);
                            if within == In::Point && token.starts_with("<![CDATA[") {
                                Piece::text(token)
                            } else {
                                Piece::token(token)
                            }
                        }
                        21..60 => {
                            let pool = if self.tricky {
                                CONTAINERS
                            } else if self.phrasing {
                                PHRASING
                            } else {
                                &CONTAINERS[..CONTAINERS.len() - 8]
                            };
                            let name = self.rng.pick(pool);
                            self.html_element(name, id, depth)
                        }
                        60..72 => {
                            let name = self.rng.pick(VOIDS);
                            let slash = self.rng.one_in(4);
                            self.void(name, id, slash)
                        }
                        72..88 => {
                            let name = self.rng.pick(RAW);
                            self.raw(name, id)
                        }
                        88..96 => {
                            let name = self.rng.pick(PARTS);
                            self.part(name, id, depth)
                        }
                        _ if !self.tricky => Piece::text("x"),
                        _ => match self.rng.below(5) {
                            0 => {
                                let content = self.content(In::Html, depth + 1);
                                let id = self.id(id);
                                let id_attr = id.as_ref().map(|id| format!(r#" id="{id}""#)).unwrap_or_default();
                                Piece {
                                    html: format!("<plaintext{id_attr}>{}", content.html),
                                    shown: vec![Self::shown("plaintext", &id, &content, false)],
                                    text: false,
                                }
                            }
                            1 => self.void("frame", id, false),
                            n => {
                                let name = ["html", "body", "head"][n - 2];
                                let content = self.content(In::Html, depth + 1);
                                self.element(name, id, content, false)
                            }
                        },
                    },
                    In::Svg => match roll {
                        0..12 => Piece::text("x"),
                        12..20 => Piece::text(r#"<![CDATA[<p id="c">]]>"#),
                        20..24 => Piece::token("<![CDATA[]]>"),
                        24..32 => Piece::token(self.rng.pick(&["<!--c-->", "<!--a--!>b-->", "<!b>", "</p>", "</br>"])),
                        32..46 => self.void("path", id, true),
                        46..58 => {
                            let content = self.content(In::Svg, depth + 1);
                            self.element("g", id, content, false)
                        }
                        58..72 => {
                            let name = self.rng.pick(&["title", "desc", "foreignObject"]);
                            let content = self.content(In::Point, depth + 1);
                            self.element(name, id, content, false)
                        }
                        72..78 => {
                            let name = self.rng.pick(&["style", "script", "textarea"]);
                            let content = if self.rng.one_in(2) { Piece::text("a{}") } else { self.content(In::Svg, depth + 1) };
                            self.element(name, id, content, false)
                        }
                        78..84 => self.void("image", id, true),
                        84..90 => {
                            let content = self.content(In::Html, depth + 1);
                            self.element("p", id, content, false)
                        }
                        90..94 => {
                            let id = self.id(id);
                            let id_attr = id.as_ref().map(|id| format!(r#" id="{id}""#)).unwrap_or_default();
                            Piece {
                                html: format!(r#"<font{id_attr} color="red">x</font>"#),
                                shown: vec![Self::shown("font", &id, &Piece::text("x"), false)],
                                text: false,
                            }
                        }
                        _ => {
                            let content = self.content(In::Svg, depth + 1);
                            self.element("path", id, content, false)
                        }
                    },
                    In::Math => match roll {
                        0..12 => Piece::text("x"),
                        12..20 => Piece::text(r#"<![CDATA[<p id="c">]]>"#),
                        20..26 => Piece::token(self.rng.pick(&["<!--c-->", "<!--->", "</p>", "</br>"])),
                        26..50 => {
                            let name = self.rng.pick(&["mi", "mo", "mn", "ms", "mtext"]);
                            let mut content = self.content(In::Point, depth + 1);
                            if self.rng.one_in(4) {
                                content.add(self.void("mglyph", false, true));
                            }
                            self.element(name, id, content, false)
                        }
                        50..64 => {
                            let content = self.content(In::Math, depth + 1);
                            let name = self.rng.pick(&["mrow", "semantics"]);
                            self.element(name, id, content, false)
                        }
                        64..78 => {
                            let html = self.rng.one_in(2);
                            let content = if html {
                                self.content(In::Point, depth + 1)
                            } else if self.rng.one_in(2) {
                                let content = self.content(In::Svg, depth + 1);
                                self.element("svg", false, content, false)
                            } else {
                                self.content(In::Math, depth + 1)
                            };
                            let mut piece = self.element("annotation-xml", id, content, false);
                            if html {
                                piece.html = piece.html.replacen("<annotation-xml", r#"<annotation-xml encoding="text/html""#, 1);
                            }
                            piece
                        }
                        78..86 => {
                            let content = self.content(In::Html, depth + 1);
                            self.element("p", id, content, false)
                        }
                        86..92 => {
                            let content = self.content(In::Math, depth + 1);
                            self.element("mi", id, content, false)
                        }
                        _ => self.void("mspace", id, true),
                    },
                }
            }

            /// A patch: one to four top-level pieces, sometimes ended inside a tag.
            pub fn patch(&mut self) -> Piece {
                self.ids = 0;
                self.tricky = self.rng.one_in(2);
                self.phrasing = false;
                let mut patch = Piece::default();
                for _ in 0..1 + self.rng.below(4) {
                    let id = !self.rng.one_in(10);
                    let roll = self.rng.below(100);
                    let piece = match roll {
                        0..35 => {
                            let name = self.rng.pick(PARTS);
                            self.part(name, id, 0)
                        }
                        35..60 => {
                            let name = self.rng.pick(CONTAINERS);
                            self.html_element(name, id, 0)
                        }
                        60..70 => {
                            let name = self.rng.pick(HEADS);
                            match name {
                                "base" | "basefont" | "bgsound" | "link" | "meta" => self.void(name, id, false),
                                "template" => self.html_element(name, id, 0),
                                _ => self.raw(name, id),
                            }
                        }
                        70..78 => {
                            let name = self.rng.pick(RAW);
                            self.raw(name, id)
                        }
                        78..84 if self.tricky => Piece::token(self.rng.pick(TOKENS)),
                        78..84 => {
                            let name = self.rng.pick(&["div", "p", "form", "table", "label", "section"]);
                            self.html_element(name, id, 0)
                        }
                        84..88 => {
                            let name = self.rng.pick(PARTS);
                            self.part(name, id, 0)
                        }
                        88..92 => self.some_text(),
                        _ => {
                            let name = self.rng.pick(&["svg", "math"]);
                            self.html_element(name, id, 0)
                        }
                    };
                    patch.add(piece);
                }
                if self.tricky && self.rng.one_in(12) {
                    // A form the patch ends in, holding a start tag or comment the patch ends in:
                    // its `</form>`, when written, is the tag's value or the comment's text, and
                    // the browser keeps the form empty.
                    let (unfinished, end) = UNFINISHED_IN_FORM[self.rng.below(UNFINISHED_IN_FORM.len())];
                    let id = !self.rng.one_in(4);
                    let id = self.id(id);
                    let id_attr = id.as_ref().map(|id| format!(r#" id="{id}""#)).unwrap_or_default();
                    patch.add(Piece {
                        html: format!("<form{id_attr}>{unfinished}{end}"),
                        shown: vec![Self::shown("form", &id, &Piece::default(), false)],
                        text: false,
                    });
                } else if self.tricky && self.rng.one_in(6) {
                    let unfinished = self.rng.pick(UNFINISHED);
                    // A `<` or `</` the patch ends in is text; an unfinished tag or comment is dropped.
                    patch.add(if UNFINISHED_TEXT.contains(&unfinished) {
                        Piece::text(unfinished)
                    } else {
                        Piece::token(unfinished)
                    });
                }
                patch
            }
        }
    }

    /// What the check makes of a patch, for \`scripts/patch-generated.json\`: the engines it reports a
    /// loss in (\`all\`, \`chromium webkit\` for a reading only theirs has, \`firefox\` for a
    /// \`<form>\` only Firefox drops, or empty), and whether it stopped reading before the end.
    #[cfg(feature = "json")]
    fn verdict(html: &str) -> (&'static str, bool) {
        let first = super::template_problem(html, false, false);
        if let Some(problem) = first.problem {
            let lost = if problem.contains("is dropped in Firefox") { "firefox" } else { "all" };
            return (lost, first.unread.is_some());
        }
        if first.headed.is_some() {
            let other = super::template_problem(html, true, false);
            let stops = first.unread.is_some() || other.unread.is_some();
            return (if other.problem.is_some() { "chromium webkit" } else { "" }, stops);
        }
        ("", first.unread.is_some())
    }

    /// \`scripts/patch-generated.json\` is the generator's cases from its seed, each with what it
    /// shows as written and the check's verdict: \`scripts/smoke.mjs\` parses each in Chromium,
    /// Firefox and WebKit, text included (the patch's own top level's too), and holds the check to
    /// report a loss only in an engine that loses something, and, where an engine loses something,
    /// to report it or say where it stopped; and the id check ([`patch_problem`]) to report an
    /// element without an id or text outside one only where the engine's parse has one at its top
    /// level or loses something. The test rewrites the file and fails when the generator or the check changed, so the smoke checks
    /// the check as it is. (Skipped outside the repository.) To look further, `PATCH_GENERATED_SEED`,
    /// `PATCH_GENERATED_CASES` and `PATCH_GENERATED_TO` (a path) write other cases elsewhere, for a
    /// browser to parse the same way, without failing.
    #[cfg(feature = "json")]
    #[test]
    fn generated_patches_carry_the_check_s_verdict() {
        let var = |name: &str| std::env::var(name).ok();
        let explore = var("PATCH_GENERATED_TO");
        let seed: u64 = var("PATCH_GENERATED_SEED").and_then(|n| n.parse().ok()).unwrap_or(1409);
        let cases: usize = var("PATCH_GENERATED_CASES").and_then(|n| n.parse().ok()).unwrap_or(3000);
        let path = match &explore {
            Some(to) => std::path::PathBuf::from(to),
            None => std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/patch-generated.json"),
        };
        if !path.parent().is_some_and(std::path::Path::is_dir) {
            return;
        }
        let mut generate = generate::Gen::new(seed);
        let mut seen = std::collections::HashSet::new();
        let mut lines = Vec::new();
        while lines.len() < cases {
            let patch = generate.patch();
            if !seen.insert(patch.html.clone()) {
                continue;
            }
            let (lost, stops) = verdict(&patch.html);
            // What the id check finds: a top-level element without an id, or text outside one.
            let idless = patch_problem(&patch.html).is_some();
            // Text written at the top level, first.
            let mut shown = patch.shown;
            if patch.text {
                shown.insert(0, "\"".into());
            }
            lines.push(serde_json::to_string(&serde_json::json!([patch.html, shown, lost, stops, idless])).expect("JSON"));
        }
        let comment = "Patches generated by html.rs's generated_patches_carry_the_check_s_verdict from its seed, which rewrites this file: each is [html, what it shows as written (a \" first when the patch has text at its top level, each top-level element as name#id, a \" when it holds text that shows (anything but ASCII whitespace and NUL once its character references are decoded), its child elements in (..) and a template's content in {..}), the engines the server's debug check (patch_parse) reports a loss in (all, chromium webkit, firefox, or none), whether the check stopped before the end, whether the id check (patch_problem) reports a top-level element without an id or text outside an element]. scripts/smoke.mjs parses each in Chromium, Firefox and WebKit: the check reports a loss only in an engine that parses the patch otherwise than as written, and where one does, the check reports a loss in it or stopped; the id check reports one only where the engine's parse has text or an element without an id at its top level, or loses something.";
        let written = format!(
            "{{\n  \"//\": {},\n  \"seed\": {seed},\n  \"cases\": [\n    {}\n  ]\n}}\n",
            serde_json::to_string(comment).expect("JSON"),
            lines.join(",\n    ")
        );
        let current = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
        if explore.is_some() {
            std::fs::write(&path, &written).expect("the cases are written");
        } else if current != written {
            std::fs::write(&path, &written).expect("scripts/patch-generated.json is written");
            panic!("scripts/patch-generated.json was rewritten from the generator and the check: commit it");
        }
    }

    /// An HTML element whose content is text (`<xmp>`, `<iframe>`, `<noembed>`, `<noframes>`
    /// as a `<textarea>`, `<title>` and `<style>`) holds no element, so markup placed in one with
    /// `raw` is not read for what a table's reading does to it: the browser keeps it as text.
    #[test]
    fn a_text_element_s_markup_is_its_text() {
        for holder in TEXT_ELEMENTS.iter().filter(|name| **name != "script") {
            let html = format!(r#"<tr id="r"></tr><{holder} id="x"><table><tr><td><form>x</form></td></tr></table></{holder}>"#);
            let parse = super::patch_parse(&html);
            assert_eq!((parse.problem, parse.unread), (None, None), "{html}");
            assert_eq!(patch_problem(&format!(r#"<{holder} id="x"><p></{holder}>"#)), None, "{holder}");
        }
        // In an `<svg>` they are SVG's elements, whose children are elements.
        let parse = super::patch_parse(r#"<tr id="r"></tr><svg id="s"><xmp><table></table></xmp></svg>"#);
        assert!(parse.unread.is_some_and(|why| why.contains("<table> written straight in <xmp>")));
    }
}
