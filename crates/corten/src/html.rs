//! Small HTML helpers with no dependencies.

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

/// HTML's elements whose text is not markup (the HTML standard's script data, RAWTEXT and RCDATA
/// elements; `<plaintext>` aside, which `html!` refuses, and `<noscript>`, which a template's
/// parse, with scripting off, reads as an element): nothing in one is a tag until its end tag. The
/// same elements as `RAW_TEXT` and `TEXT_ONLY` in `crates/corten-macros/src/html.rs` together,
/// which `the_macro_s_patch_lists_are_the_check_s` holds it to.
const RAW_TEXT: &[&str] = &["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"];

/// A start tag as `html!` writes it, read by [`start_tag`].
// Where it starts and whether it closes itself are read by the debug builds' checks only.
#[cfg_attr(not(any(debug_assertions, test)), allow(dead_code))]
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
}

impl Tag<'_> {
    /// The value of its first attribute `name` (in any case), as written.
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(attr, _)| attr.eq_ignore_ascii_case(name)).map(|(_, value)| *value)
    }
}

/// The start tag whose `<` is at `html[start]`. A value in `"` or `'` is read to its closing
/// quote, so what a quoted value holds is never taken for the tag's own: `data-on` is single-quoted
/// and its JSON has `"` in it (`docs/design.md#choice-data-on-single-quoted`).
pub(crate) fn start_tag(html: &str, start: usize) -> Tag<'_> {
    let bytes = html.as_bytes();
    let mut i = start + 1;
    let name_end = html[i..].find(|c: char| c.is_ascii_whitespace() || c == '>' || c == '/').map_or(bytes.len(), |n| i + n);
    let name = html[i..name_end].to_ascii_lowercase();
    i = name_end;
    let mut attrs = Vec::new();
    let mut self_closing = false;
    while i < bytes.len() && bytes[i] != b'>' {
        let c = bytes[i];
        if c.is_ascii_whitespace() {
            i += 1;
        } else if c == b'/' {
            self_closing = true;
            i += 1;
        } else {
            self_closing = false;
            let attr_end = html[i..]
                .find(|c: char| c.is_ascii_whitespace() || c == '=' || c == '>' || c == '/')
                .map_or(bytes.len(), |n| i + n);
            let attr = &html[i..attr_end];
            i = attr_end;
            let mut value = "";
            if bytes.get(i) == Some(&b'=') {
                i += 1;
                match bytes.get(i) {
                    Some(&q @ (b'"' | b'\'')) => {
                        let close = html[i + 1..].find(q as char).map_or(bytes.len(), |n| i + 1 + n);
                        value = &html[i + 1..close];
                        i = close + 1;
                    }
                    _ => {
                        let end = html[i..].find(|c: char| c.is_ascii_whitespace() || c == '>').map_or(bytes.len(), |n| i + n);
                        value = &html[i..end];
                        i = end;
                    }
                }
            }
            attrs.push((attr, value));
        }
    }
    Tag { start, end: (i + 1).min(bytes.len()), name, attrs, self_closing }
}

/// Each start tag of `html` in order, past comments, end tags, a doctype and the text of the
/// elements whose text is not markup. Reads markup as `html!` writes it (`<` escaped in text), and a
/// `<` that starts no tag (`1 <2`, in markup placed with `raw`) as text, as the browser does.
pub(crate) fn start_tags(html: &str) -> impl Iterator<Item = Tag<'_>> {
    let mut i = 0;
    std::iter::from_fn(move || loop {
        let at = i + html.get(i..)?.find('<')?;
        if html[at..].starts_with("<!--") {
            i = html[at..].find("-->").map_or(html.len(), |n| at + n + 3);
            continue;
        }
        match html.as_bytes().get(at + 1) {
            Some(c) if c.is_ascii_alphabetic() => {}
            // An end tag, a doctype or a processing instruction: up to its `>`.
            Some(b'/' | b'!' | b'?') => {
                i = html[at..].find('>').map_or(html.len(), |n| at + n + 1);
                continue;
            }
            _ => {
                i = at + 1;
                continue;
            }
        }
        let tag = start_tag(html, at);
        i = tag.end;
        if RAW_TEXT.contains(&tag.name.as_str()) {
            let close = format!("</{}", tag.name);
            i = html[i..].to_ascii_lowercase().find(&close).map_or(html.len(), |n| i + n);
        }
        return Some(tag);
    })
}

/// Elements that have no end tag, and those the HTML parser closes at once as it does them.
#[cfg(any(debug_assertions, test))]
const VOID: &[&str] = &[
    "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link", "meta",
    "param", "source", "track", "wbr",
];

/// Where the end tag of the raw-text element `name` (in lowercase) starts in `html`, searching from
/// `from`, or `html`'s end: `</name` in any letter case followed by whitespace, `/` or `>`, so a
/// longer name (`</scriptx>`) is the element's text, as the HTML standard's tokenizer reads it.
/// Allocates nothing, so a patch with many raw-text elements is read in one pass.
#[cfg(any(debug_assertions, test))]
fn raw_text_end(html: &str, from: usize, name: &str) -> usize {
    let bytes = html.as_bytes();
    let mut at = from;
    while let Some(n) = html.get(at..).and_then(|rest| rest.find("</")) {
        let start = at + n;
        let name_end = start + 2 + name.len();
        if bytes.get(start + 2..name_end).is_some_and(|written| written.eq_ignore_ascii_case(name.as_bytes()))
            && matches!(bytes.get(name_end), None | Some(b'>' | b'/' | b'\t' | b'\n' | b'\x0c' | b'\r' | b' '))
        {
            return start;
        }
        at = start + 2;
    }
    html.len()
}

/// Where the end tag of the HTML `<script>` whose start tag ends at `from` in `html` starts, as
/// the HTML standard's tokenizer reads script data: a `</script` followed by whitespace, `/` or
/// `>`, in any letter case, but one a `<!--` and a `<script` before it in its text hide (the
/// script data escaped and double-escaped states, which a `</script` or a `-->` leaves). `html`'s
/// end if its text hides every one after it. Allocates nothing.
#[cfg(any(debug_assertions, test))]
fn script_end(html: &str, from: usize) -> usize {
    #[derive(Clone, Copy, PartialEq)]
    enum State {
        Data,
        Escaped,
        EscapedDash,
        EscapedDashDash,
        Double,
        DoubleDash,
        DoubleDashDash,
    }
    let bytes = html.as_bytes();
    // A `script` tag name at `at`, in any letter case, ended by whitespace, `/` or `>`.
    let script_at = |at: usize| {
        bytes.get(at..at + 6).is_some_and(|name| name.eq_ignore_ascii_case(b"script"))
            && matches!(bytes.get(at + 6), Some(b'>' | b'/' | b'\t' | b'\n' | b'\x0c' | b'\r' | b' '))
    };
    let mut state = State::Data;
    let mut i = from;
    while i < bytes.len() {
        let c = bytes[i];
        let double = matches!(state, State::Double | State::DoubleDash | State::DoubleDashDash);
        match c {
            b'<' if state == State::Data => {
                if bytes.get(i + 1) == Some(&b'/') && script_at(i + 2) {
                    return i;
                }
                if bytes[i + 1..].starts_with(b"!--") {
                    // `<!--`: the escaped state, as after its dash dash, so `<!-->` leaves it at once.
                    state = State::EscapedDashDash;
                    i += 4;
                    continue;
                }
            }
            b'<' if !double => {
                if bytes.get(i + 1) == Some(&b'/') && script_at(i + 2) {
                    return i;
                }
                if script_at(i + 1) {
                    // `<script` and its delimiter: double-escaped.
                    state = State::Double;
                    i += 8;
                    continue;
                }
                state = State::Escaped;
            }
            b'<' => {
                if bytes.get(i + 1) == Some(&b'/') && script_at(i + 2) {
                    // `</script` and its delimiter: escaped again.
                    state = State::Escaped;
                    i += 9;
                    continue;
                }
                state = State::Double;
            }
            b'-' => {
                state = match state {
                    State::Data => State::Data,
                    State::Escaped => State::EscapedDash,
                    State::EscapedDash | State::EscapedDashDash => State::EscapedDashDash,
                    State::Double => State::DoubleDash,
                    State::DoubleDash | State::DoubleDashDash => State::DoubleDashDash,
                };
            }
            b'>' if matches!(state, State::EscapedDashDash | State::DoubleDashDash) => state = State::Data,
            _ => {
                state = match state {
                    State::Data => State::Data,
                    State::Escaped | State::EscapedDash | State::EscapedDashDash => State::Escaped,
                    State::Double | State::DoubleDash | State::DoubleDashDash => State::Double,
                };
            }
        }
        i += 1;
    }
    html.len()
}

/// Whether the element whose start tag ends at `from` in `html` holds what a page shows: a start
/// tag, or text other than whitespace (a `<` that starts no tag among it), before the first end
/// tag, comments skipped, bogus ones (`<!note>`, `<?x>`, `</ x>`) and a doctype among them. A
/// `<form>` a table's reading puts in empty moves what it holds out of it, which loses an element
/// or text from it, and a form of only whitespace or a comment shows the same either way.
#[cfg(any(debug_assertions, test))]
fn holds_shown(html: &str, from: usize) -> bool {
    let bytes = html.as_bytes();
    let mut at = from;
    while let Some(n) = html.get(at..).and_then(|rest| rest.find('<')) {
        let start = at + n;
        if !html[at..start].trim_ascii().is_empty() {
            return true;
        }
        let rest = &html[start..];
        if let Some(comment) = rest.strip_prefix("<!--") {
            at = comment.find("-->").map_or(html.len(), |n| start + 4 + n + 3);
            continue;
        }
        match bytes.get(start + 1) {
            Some(c) if c.is_ascii_alphabetic() => return true,
            Some(b'/') if bytes.get(start + 2).is_some_and(u8::is_ascii_alphabetic) => return false,
            // A bogus comment, a doctype or a `</>`, which shows nothing: up to its `>`.
            Some(b'!' | b'?' | b'/') => at = rest.find('>').map_or(html.len(), |n| start + n + 1),
            _ => return true,
        }
    }
    !html[at..].trim_ascii().is_empty()
}

/// What the browser would drop from a patch (`req.patch`, a [`crate::live`] fragment): the first
/// top-level element without an `id`, or top-level text, described for an error. The runtime
/// replaces each top-level element by its id and ignores the rest, so either is a view that never
/// shows. Reads markup as `html!` writes it (attribute values quoted, `<` escaped in text).
/// Checked in debug builds only.
#[cfg(any(debug_assertions, test))]
pub(crate) fn patch_problem(html: &str) -> Option<String> {
    let bytes = html.as_bytes();
    let mut depth = 0usize;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            let end = html[i..].find('<').map_or(bytes.len(), |n| i + n);
            let text = html[i..end].trim();
            if depth == 0 && !text.is_empty() {
                let shown: String = text.chars().take(40).collect();
                return Some(format!("text {shown:?} outside an element"));
            }
            i = end;
            continue;
        }
        if html[i..].starts_with("<!--") {
            i = html[i..].find("-->").map_or(bytes.len(), |n| i + n + 3);
            continue;
        }
        if bytes.get(i + 1) == Some(&b'/') {
            let end = html[i..].find('>').map_or(bytes.len(), |n| i + n);
            // A void element's end tag (`html!` writes one for a `<param>` or a `<basefont>`)
            // closes nothing: the browser ignores it.
            if !VOID.iter().any(|void| void.eq_ignore_ascii_case(html[i + 2..end].trim_end())) {
                depth = depth.saturating_sub(1);
            }
            i = (end + 1).min(bytes.len());
            continue;
        }
        // A start tag: its name, then its attributes up to `>`.
        let tag = start_tag(html, i);
        i = tag.end;
        let id = tag.attrs.iter().any(|(attr, value)| attr.eq_ignore_ascii_case("id") && !value.is_empty());
        let (name, self_closing) = (tag.name, tag.self_closing);
        if depth == 0 && !id {
            let tag = &html[tag.start..tag.end];
            let shown: String = tag.chars().take(80).collect();
            let more = if shown.len() < tag.len() { ".." } else { "" };
            return Some(format!("{shown}{more} has no id"));
        }
        if RAW_TEXT.contains(&name.as_str()) {
            // Its text up to the end tag, and the end tag: nothing in it is markup.
            i = if name == "script" { script_end(html, i) } else { raw_text_end(html, i, &name) };
            i = html[i..].find('>').map_or(bytes.len(), |n| i + n + 1);
        } else if !VOID.contains(&name.as_str()) && !self_closing {
            depth += 1;
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
    let breaks_out = any(BREAKOUT) || (is("font") && ["color", "face", "size"].iter().any(|a| tag.attr(a).is_some()));
    match within {
        Within::Html if is("svg") => Some((true, Within::Svg)),
        Within::Html if is("math") => Some((true, Within::Math)),
        Within::Html => Some((false, Within::Html)),
        Within::MathText if is("mglyph") || is("malignmark") => Some((true, Within::Math)),
        Within::MathText => placed(Within::Html, tag),
        _ if breaks_out => None,
        Within::Svg if any(SVG_HTML_POINTS) => Some((true, Within::Html)),
        Within::Svg => Some((true, Within::Svg)),
        Within::AnnotationXml if is("svg") => Some((true, Within::Svg)),
        Within::Math | Within::AnnotationXml if any(MATH_HTML_POINTS) => Some((true, Within::MathText)),
        Within::Math | Within::AnnotationXml if is("annotation-xml") => {
            // An HTML integration point by its first `encoding`.
            let html = tag.attr("encoding").is_some_and(|encoding| {
                encoding.eq_ignore_ascii_case("text/html") || encoding.eq_ignore_ascii_case("application/xhtml+xml")
            });
            Some((true, if html { Within::Html } else { Within::AnnotationXml }))
        }
        Within::Math | Within::AnnotationXml => Some((true, Within::Math)),
    }
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
/// browser does. A patch it cannot read to its end (an element closed by another's end tag, an
/// element HTML's wherever it lands written straight in an `<svg>` or `<math>`, which `html!`
/// refuses, or a `</p>` or `</br>` there; a script whose text carries it past its first
/// `</script>` over a start tag) is read up to there: a loss found before the element it cannot follow (where an end
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
    /// Where it stopped reading, when it did: each element in it but a void one is read closed by
    /// its own end tag, in order, with a CDATA section only in an SVG or MathML element, every
    /// comment ended by `-->`, no element HTML's wherever it lands written
    /// straight in an `<svg>` or `<math>` and no `</p>` or `</br>` in one, and no `<!--` and `<script` in a script's text that
    /// carry it past its first `</script>` and a start tag after it. Where one is not (an `<li>` closed by its list's end tag, a `<p>` by the
    /// next `<p>`, a `<p>` the browser takes out of an `<svg>`), the browser closes it where its
    /// rules say, which this does not follow, so what follows is not read.
    unread: Option<String>,
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
        if bytes[i] != b'<' {
            i = html[i..].find('<').map_or(bytes.len(), |n| i + n);
            continue;
        }
        if html[i..].starts_with("<!--") {
            // A comment ended by `-->` alone, in foreign content as outside it: one written `<!-->`,
            // `<!--->` or with `--!>` in it ends elsewhere.
            let body = i + 4;
            let end = html[body..].find("-->").map_or(bytes.len(), |n| body + n);
            if html[body..].starts_with('>') || html[body..].starts_with("->") || html[body..end].contains("--!>") {
                unread!(
                    usize::MAX;
                    "the comment {}, which a browser ends elsewhere than at its -->",
                    shown(&html[i..(end + 3).min(bytes.len())])
                );
            }
            i = (end + 3).min(bytes.len());
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
                let end = html[i..].find('>').map_or(bytes.len(), |n| i + n);
                let closing = html[i + 2..end].trim_end();
                if !open.last().is_some_and(|last| last.name.eq_ignore_ascii_case(closing)) {
                    match open.iter().rposition(|open| open.name.eq_ignore_ascii_case(closing)) {
                        // It closes the elements open in it, whose end tags were left out.
                        Some(at) => {
                            let last = open.last().map_or("", |last| last.name.as_str());
                            unread!(open[at + 1].start; "{}, where <{last}> is open", shown(&html[i..(end + 1).min(bytes.len())]));
                        }
                        // A `</p>` or `</br>` in an `<svg>` or `<math>`: written straight in one
                        // of their elements it closes the foreign content around it and is read as
                        // HTML's, and in an integration point Firefox takes the empty paragraph it
                        // adds out of the `<svg>` or `<math>` too, which is not followed.
                        None if (closing.eq_ignore_ascii_case("p") || closing.eq_ignore_ascii_case("br"))
                            && open.iter().any(|open| open.foreign) =>
                        {
                            let holder = open.last().map_or("", |last| last.name.as_str());
                            unread!(
                                usize::MAX;
                                "{} in <{holder}>, in an <svg> or <math>, which a browser closes at it",
                                shown(&html[i..(end + 1).min(bytes.len())])
                            );
                        }
                        // An end tag that closes no open element, a void element's among them
                        // (`html!` writes one for a `<param>` or a `<basefont>`): the browser
                        // ignores it, or for a `</p>` or `</br>` adds an empty element, which
                        // loses nothing.
                        None => {
                            i = (end + 1).min(bytes.len());
                            continue;
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
                i = html[i..].find('>').map_or(bytes.len(), |n| i + n + 1);
                continue;
            }
            Some(c) if c.is_ascii_alphabetic() => {}
            _ => {
                i += 1;
                continue;
            }
        }
        let tag = start_tag(html, i);
        i = tag.end;
        let Some((foreign_element, within)) = placed(open.last().map_or(Within::Html, |last| last.within), &tag) else {
            let holder = open.last().map_or("", |last| last.name.as_str());
            unread!(usize::MAX; "{} written straight in <{holder}>, which a browser closes before it", shown(&html[tag.start..tag.end]));
        };
        let name = tag.name.as_str();
        let written = &html[tag.start..tag.end];
        let part = TABLE_PARTS.contains(&name);
        let head = HEAD_TAGS.contains(&name);
        let holds = name == "form" && holds_shown(html, i);
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
                } else if table && name == "form" && nested {
                    problem = Some(format!("{} is dropped in Firefox{}", shown(written), since(first)));
                } else if table && name == "form" && holds {
                    problem = Some(format!("{} loses what it holds{}", shown(written), since(first)));
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
            } else if name == "form" && nested {
                problem = Some(format!("{} in {} is dropped in Firefox{}", shown(written), shown(top), since(first)));
            } else if name == "form" && holds {
                problem = Some(format!("{} in {} loses what it holds{}", shown(written), shown(top), since(first)));
            }
        }
        if problem.is_some() && problem_at.is_none() {
            problem_at = Some(tag.start);
        }
        // An HTML element's text, up to its end tag: nothing in it is markup. An SVG or MathML
        // `<title>`, `<style>` or `<script>` holds elements.
        if !foreign_element && RAW_TEXT.contains(&name) {
            let written_end = raw_text_end(html, i, name);
            let end = if name == "script" { script_end(html, i) } else { written_end };
            if end == bytes.len() {
                // No end tag the tokenizer reads: a `<!--` and a `<script` in a script's text can
                // hide the one written after it (`html!` writes its text as is), and the rest of the
                // patch is its text.
                let after = html[written_end..].find('>').map_or(bytes.len(), |n| written_end + n + 1);
                if problem.is_none() && !html[after..].trim_ascii().is_empty() {
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
            // A `</p>` or `</br>` in an SVG or MathML element closes the foreign content around it,
            // and in an integration point Firefox takes it out of the `<svg>` and what follows too.
            (
                r#"<p id="m"></p><svg id="s"></p><tr id="r"></tr></svg>"#,
                "</p> in <svg>, in an <svg> or <math>, which a browser closes at it",
            ),
            (r#"<p id="m"></p><svg id="s"><g></br><tr id="r"></tr></g></svg>"#, "</br> in <g>, in an"),
            (r#"<p id="m"></p><math id="x"><mrow></P><tr id="r"></tr></mrow></math>"#, "</P> in <mrow>, in an"),
            (r#"<svg id="s"><foreignObject></p></foreignObject><desc></br></desc></svg>"#, "</p> in <foreignobject>, in an"),
            (r#"<math id="x"><mi><div></p></div></mi></math>"#, "</p> in <div>, in an"),
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
            r#"<tr id="a"></tr></div></p>"#,
            // A `</p>` and `</br>` outside an `<svg>` or `<math>` add an element with no id.
            r#"<tr id="a"></tr><div id="b"></p></br></div>"#,
            // A script whose text carries it past its first `</script>` with no start tag between.
            r#"<script id="s" type="text/plain"><!--<script></script>--></script><tr id="r"></tr>"#,
        ] {
            assert_eq!(super::patch_parse(html).unread, None, "{html}");
        }
        // A loss found before a `</p>` in an `<svg>` is kept.
        let parse = super::patch_parse(r#"<p id="m"></p><tr id="r"></tr><svg id="s"></p></svg>"#);
        assert_eq!(parse.problem.as_deref(), Some(r#"<tr id="r"> is dropped, since <p id="m"> comes first"#));
        assert!(parse.unread.is_some_and(|why| why.contains("</p> in <svg>")));
        // A loss found after an element whose end tag is left out is not kept: the browser closed
        // that element somewhere this did not read, so what follows may be elsewhere.
        let parse = super::patch_parse(r#"<tr id="a"></tr><p id="b">one<p id="c">two</p><tr id="d"></tr>"#);
        assert_eq!((parse.problem, parse.unread.as_deref()), (None, Some("<p>, which is not closed")));
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
            if super::RAW_TEXT.contains(&tag.name.as_str()) {
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
        assert_eq!(list("TABLE_PARTS"), super::TABLE_PARTS);
        assert_eq!(list("SVG_HTML_POINTS"), super::SVG_HTML_POINTS);
        assert_eq!(list("MATH_HTML_POINTS"), super::MATH_HTML_POINTS);
        assert_eq!(list("BREAKOUT"), super::BREAKOUT);
        let mut text = [list("RAW_TEXT"), list("TEXT_ONLY")].concat();
        let mut raw_text = super::RAW_TEXT.to_vec();
        text.sort();
        raw_text.sort();
        assert_eq!(text, raw_text, "the elements whose text is not markup");
    }

    /// An HTML element whose content is text (`<xmp>`, `<iframe>`, `<noembed>`, `<noframes>`
    /// as a `<textarea>`, `<title>` and `<style>`) holds no element, so markup placed in one with
    /// `raw` is not read for what a table's reading does to it: the browser keeps it as text.
    #[test]
    fn a_text_element_s_markup_is_its_text() {
        for holder in super::RAW_TEXT.iter().filter(|name| **name != "script") {
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
