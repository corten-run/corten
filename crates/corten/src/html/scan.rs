//! Token boundaries for developer checks, not an HTML tree builder.

use super::{Tag, VOID, Within, placed};

pub(super) fn space(byte: u8) -> bool {
    matches!(byte, b'\t' | b'\n' | b'\x0c' | b'\r' | b' ')
}

fn delimiter(byte: u8) -> bool {
    space(byte) || matches!(byte, b'/' | b'>')
}

/// A start or end tag, from its name through its `>`. The caller can discard end-tag
/// attributes without allocating. Values are returned as written, not entity-decoded. An
/// unfinished tag returns one past EOF, even if its last byte is `>` inside a quote.
pub(super) fn read_tag<'a>(html: &'a str, from: usize, mut attr: impl FnMut(&'a str, &'a str)) -> (&'a str, usize, bool) {
    let bytes = html.as_bytes();
    let name_end = from + bytes[from..].iter().position(|&b| delimiter(b)).unwrap_or(bytes.len() - from);
    let skip = |at| at + bytes[at..].iter().take_while(|&&b| space(b)).count();
    let mut i = skip(name_end);
    while let Some(&byte) = bytes.get(i) {
        match byte {
            b'>' => return (&html[from..name_end], i + 1, false),
            b'/' => {
                if bytes.get(i + 1) == Some(&b'>') {
                    return (&html[from..name_end], i + 2, true);
                }
                i = skip(i + 1);
            }
            _ => {
                let start = i;
                // An `=` as the first character belongs to the attribute name.
                i += 1;
                while bytes.get(i).is_some_and(|&b| !delimiter(b) && b != b'=') {
                    i += 1;
                }
                let name = &html[start..i];
                i = skip(i);
                let mut value = "";
                if bytes.get(i) == Some(&b'=') {
                    i = skip(i + 1);
                    if let Some(&quote @ (b'\'' | b'"')) = bytes.get(i) {
                        let start = i + 1;
                        let end = html[start..].find(quote as char).map_or(bytes.len(), |n| start + n);
                        value = &html[start..end];
                        i = (end + 1).min(bytes.len());
                    } else {
                        let start = i;
                        while bytes.get(i).is_some_and(|&b| !space(b) && b != b'>') {
                            i += 1;
                        }
                        value = &html[start..i];
                    }
                    i = skip(i);
                }
                attr(name, value);
            }
        }
    }
    (&html[from..name_end], i + 1, false)
}

/// Whether a `<` at `at` falls back to text in data (including `<` or `</` at EOF).
pub(super) fn lone_lt(bytes: &[u8], at: usize) -> bool {
    match bytes.get(at + 1) {
        Some(c) if c.is_ascii_alphabetic() => false,
        Some(b'/') => at + 2 == bytes.len(),
        Some(b'!' | b'?') => false,
        _ => true,
    }
}

fn name_at(bytes: &[u8], at: usize, name: &str) -> bool {
    let end = at + name.len();
    bytes.get(at..end).is_some_and(|written| written.eq_ignore_ascii_case(name.as_bytes()))
        && bytes.get(end).is_some_and(|&b| delimiter(b))
}

/// Only an appropriate end tag changes the state. Quotes on a longer, inappropriate name
/// are just text; they cannot hide the next candidate.
pub(super) fn raw_text_end(html: &str, mut at: usize, name: &str) -> usize {
    while let Some(n) = html[at..].find("</") {
        let start = at + n;
        at = start + 2;
        if name_at(html.as_bytes(), at, name) {
            return start;
        }
    }
    html.len()
}

/// `<!--` enters escaped script data. `<script` there enters double-escaped data, where
/// `</script` only returns to escaped data. `-->` returns either mode to script data.
pub(super) fn script_end(html: &str, mut i: usize) -> usize {
    #[derive(Clone, Copy, PartialEq)]
    enum State {
        Data,
        Escaped,
        Double,
    }
    let bytes = html.as_bytes();
    let mut state = State::Data;
    let mut dashes = 0;
    while let Some(&byte) = bytes.get(i) {
        if byte == b'<' {
            let end = bytes.get(i + 1) == Some(&b'/') && name_at(bytes, i + 2, "script");
            match state {
                State::Data if bytes[i + 1..].starts_with(b"!--") => {
                    state = State::Escaped;
                    dashes = 2;
                    i += 4;
                    continue;
                }
                State::Data | State::Escaped if end => return i,
                State::Escaped if name_at(bytes, i + 1, "script") => {
                    state = State::Double;
                    i += 7; // The delimiter is emitted by the double-escape-start state.
                }
                State::Double if end => {
                    state = State::Escaped;
                    i += 8;
                }
                _ => {}
            }
        }
        if byte == b'>' && dashes == 2 {
            state = State::Data;
        }
        dashes = if byte == b'-' && state != State::Data { (dashes + 1).min(2) } else { 0 };
        i += 1;
    }
    html.len()
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Mode {
    Data,
    Rcdata,
    Rawtext,
    Script,
    Plaintext,
}

impl Mode {
    pub(super) fn of(name: &str, scripting: bool) -> Self {
        match name {
            "title" | "textarea" => Self::Rcdata,
            "style" | "xmp" | "iframe" | "noembed" | "noframes" => Self::Rawtext,
            "noscript" if scripting => Self::Rawtext,
            "script" => Self::Script,
            "plaintext" => Self::Plaintext,
            _ => Self::Data,
        }
    }
}

#[cfg_attr(not(any(debug_assertions, test)), allow(dead_code))]
pub(super) enum Token<'a> {
    Text(&'a str),
    Cdata(&'a str, bool),
    Start(Tag<'a>),
    End { name: &'a str, exact: bool },
    Ignored { uncertain: bool },
}

pub(super) struct Tokens<'a> {
    html: &'a str,
    pub(super) at: usize,
}

impl<'a> Tokens<'a> {
    pub(super) fn new(html: &'a str) -> Self {
        Self { html, at: 0 }
    }

    /// The caller supplies the tokenizer state selected by the open element. In RCDATA,
    /// text still has character references; the caller decides whether those matter.
    pub(super) fn next(&mut self, mode: Mode, name: &str, foreign: bool) -> Option<Token<'a>> {
        let html = self.html;
        let at = self.at;
        let rest = html.get(at..).filter(|rest| !rest.is_empty())?;
        let bytes = html.as_bytes();
        let to_gt = || rest.find('>').map_or(bytes.len(), |n| at + n + 1);
        if mode != Mode::Data {
            self.at = match mode {
                Mode::Rcdata | Mode::Rawtext => raw_text_end(html, at, name),
                Mode::Script => script_end(html, at),
                _ => html.len(),
            };
            if self.at != at {
                return Some(Token::Text(&html[at..self.at]));
            }
            // An appropriate end tag is the only token possible here.
        } else if !rest.starts_with('<') || lone_lt(bytes, at) {
            let from = at + usize::from(rest.starts_with('<'));
            self.at = html[from..].find('<').map_or(bytes.len(), |n| from + n);
            return Some(Token::Text(&html[at..self.at]));
        }

        let token = match bytes[at + 1] {
            b'/' if bytes.get(at + 2).is_some_and(u8::is_ascii_alphabetic) => {
                let (name, end, _) = read_tag(html, at + 2, |_, _| {});
                self.at = end.min(bytes.len());
                if end <= bytes.len() {
                    Token::End { name, exact: end == at + 3 + name.len() }
                } else {
                    Token::Ignored { uncertain: true }
                }
            }
            b'!' if rest.starts_with("<!--") => {
                let (end, ordinary) = comment(html, at);
                self.at = end;
                Token::Ignored { uncertain: !ordinary }
            }
            b'!' if foreign && rest.starts_with("<![CDATA[") => {
                let body = at + 9;
                let close = html[body..].find("]]>").map(|n| body + n);
                self.at = close.map_or(html.len(), |end| end + 3);
                Token::Cdata(&html[body..close.unwrap_or(html.len())], close.is_some())
            }
            b'/' | b'!' | b'?' => {
                self.at = to_gt();
                let doctype = rest.as_bytes().get(..9).is_some_and(|b| b.eq_ignore_ascii_case(b"<!doctype"));
                let exact_doctype = html[at..self.at].eq_ignore_ascii_case("<!doctype html>");
                Token::Ignored { uncertain: (doctype && !exact_doctype) || rest.starts_with("<![CDATA[") }
            }
            _ => {
                let tag = super::start_tag(html, at);
                self.at = tag.end;
                Token::Start(tag)
            }
        };
        Some(token)
    }
}

/// Normal, abrupt-start and bang-closed comments. The strict patch check only follows
/// normal comments, including an ordinary comment running to EOF.
pub(super) fn comment(html: &str, at: usize) -> (usize, bool) {
    let body = at + 4;
    if html[body..].starts_with('>') {
        return (body + 1, false);
    }
    if html[body..].starts_with("->") {
        return (body + 2, false);
    }
    for (i, _) in html[body..].match_indices('>') {
        let before = &html[body..body + i];
        if before.ends_with("--") {
            return (body + i + 1, true);
        }
        if before.ends_with("--!") {
            return (body + i + 1, false);
        }
    }
    (html.len(), true)
}

/// For scans that need to continue after foreign content or an inert template. The stack
/// dispatches tokenizer modes; it does not implement the HTML insertion modes.
pub(crate) struct Markup<'a> {
    tokens: Tokens<'a>,
    open: Vec<Element<'a>>,
    page: bool,
    scripting: bool,
    body_shadow: bool,
}

struct Element<'a> {
    name: &'a str,
    foreign: bool,
    within: Within,
    mode: Mode,
    inert: bool,
    hidden: bool,
    can_attach_shadow: bool,
}

#[cfg_attr(not(any(debug_assertions, test)), allow(dead_code))]
pub(crate) enum Event<'a> {
    Start { tag: Tag<'a>, opens: bool, live: bool },
    Text { text: &'a str, literal: bool },
    Other,
}

pub(super) fn tags(html: &str, scripting: bool) -> impl Iterator<Item = Tag<'_>> {
    Markup::new(html, false, scripting).filter_map(|event| match event {
        Event::Start { tag, .. } => Some(tag),
        _ => None,
    })
}

impl<'a> Markup<'a> {
    /// A document allows declarative shadow roots; the runtime's patch template does not.
    pub(crate) fn new(html: &'a str, page: bool, scripting: bool) -> Self {
        Self { tokens: Tokens::new(html), open: Vec::new(), page, scripting, body_shadow: false }
    }

    #[cfg(debug_assertions)]
    pub(crate) fn depth(&self) -> usize {
        self.open.len()
    }

    fn pop_foreign(&mut self) {
        while self.open.last().is_some_and(|el| el.foreign && !matches!(el.within, Within::Html | Within::MathText)) {
            self.open.pop();
        }
    }
}

impl<'a> Iterator for Markup<'a> {
    type Item = Event<'a>;

    fn next(&mut self) -> Option<Event<'a>> {
        let parent = self.open.last();
        let mode = parent.map_or(Mode::Data, |el| el.mode);
        let name = parent.map_or("", |el| el.name);
        let foreign = parent.is_some_and(|el| el.foreign);
        let token = self.tokens.next(mode, name, foreign)?;
        match token {
            Token::Start(tag) if tag.complete => {
                let within = parent.map_or(Within::Html, |el| el.within);
                let (foreign, within) = placed(within, &tag).unwrap_or_else(|| {
                    self.pop_foreign();
                    placed(Within::Html, &tag).expect("HTML placement")
                });
                let mode = if foreign { Mode::Data } else { Mode::of(&tag.name, self.scripting) };
                let template = !foreign && tag.name == "template";
                let parent = self.open.last_mut();
                let inside_inert = parent.as_ref().is_some_and(|el| el.inert);
                let hidden = parent.as_ref().is_some_and(|el| el.hidden)
                    || matches!(tag.name.as_str(), "script" | "style")
                    || (!foreign && matches!(tag.name.as_str(), "title" | "iframe" | "noembed" | "noframes"))
                    || mode == Mode::Rawtext && tag.name == "noscript";
                let mut attached = false;
                if template && self.page && !inside_inert && tag.attr("shadowrootmode").is_some_and(shadow_mode) {
                    if let Some(host) = parent {
                        if host.can_attach_shadow {
                            host.can_attach_shadow = false;
                            attached = true;
                        }
                    } else if !self.body_shadow {
                        // A page body fragment has an implicit body host.
                        self.body_shadow = true;
                        attached = true;
                    }
                }
                let opens = if foreign { !tag.self_closing } else { !VOID.contains(&tag.name.as_str()) };
                if opens {
                    let inert = inside_inert || (template && !attached);
                    let name = &self.tokens.html[tag.start + 1..tag.start + 1 + tag.name.len()];
                    let can_attach_shadow = self.page && !foreign && shadow_host(&tag.name);
                    self.open.push(Element { name, foreign, within, mode, inert, hidden, can_attach_shadow });
                }
                Some(Event::Start { tag, opens, live: !inside_inert && !attached })
            }
            Token::End { name, .. } => {
                if foreign && (name.eq_ignore_ascii_case("p") || name.eq_ignore_ascii_case("br")) {
                    self.pop_foreign();
                }
                if let Some(i) = self.open.iter().rposition(|el| {
                    el.name.eq_ignore_ascii_case(name) || (!el.foreign && el.name.eq_ignore_ascii_case("template"))
                }) {
                    if self.open[i].name.eq_ignore_ascii_case(name) {
                        self.open.truncate(i);
                    }
                }
                Some(Event::Other)
            }
            Token::Text(text) | Token::Cdata(text, _) if !parent.is_some_and(|el| el.hidden || el.inert) => {
                let literal = matches!(token, Token::Cdata(..)) || matches!(mode, Mode::Rawtext | Mode::Plaintext);
                Some(Event::Text { text, literal })
            }
            _ => Some(Event::Other),
        }
    }
}

fn shadow_mode(mode: &str) -> bool {
    mode.eq_ignore_ascii_case("open") || mode.eq_ignore_ascii_case("closed")
}

// The DOM standard's built-in shadow hosts, or a custom element. A template is not a host.
fn shadow_host(name: &str) -> bool {
    matches!(
        name,
        "article"
            | "aside"
            | "blockquote"
            | "body"
            | "div"
            | "footer"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "header"
            | "main"
            | "nav"
            | "p"
            | "section"
            | "span"
    ) || (name.contains('-')
        && !matches!(
            name,
            "annotation-xml"
                | "color-profile"
                | "font-face"
                | "font-face-src"
                | "font-face-uri"
                | "font-face-format"
                | "font-face-name"
                | "missing-glyph"
        ))
}

#[cfg(all(test, feature = "json"))]
#[test]
fn browser_checked_markup_cases() {
    #[derive(Default, serde::Deserialize)]
    #[serde(default, rename_all = "camelCase")]
    struct Case {
        name: String,
        html: String,
        tags: Vec<String>,
        patch: bool,
        idless: bool,
        #[cfg(debug_assertions)]
        hint: bool,
        #[cfg(debug_assertions)]
        key: bool,
        #[cfg(debug_assertions)]
        scanner_hint: Option<bool>,
    }

    let cases: Vec<Case> = serde_json::from_str(include_str!("scan-cases.json")).expect("browser fixture");
    for Case { name, html, tags, patch, idless, .. } in &cases {
        let got: Vec<_> = super::start_tags(html)
            .map(|tag| {
                use std::fmt::Write as _;
                let mut signature = tag.name.clone();
                for name in ["a", "data-submit", "data-vars", "id", "shadowrootmode"] {
                    if let Some(value) = tag.attr(name) {
                        write!(signature, " {name}={value}").unwrap();
                    }
                }
                signature
            })
            .collect();
        assert_eq!(&got, tags, "{name}");
        if *patch {
            assert_eq!(super::patch_problem(html).is_some(), *idless, "{name}");
        }
    }
    #[cfg(debug_assertions)]
    for Case { name, html, patch, hint, key, scanner_hint, .. } in cases {
        let hints = ["qty-hint".to_owned()];
        let got = crate::form::unnamed_hint(&html, &hints, !patch);
        assert_eq!(got, scanner_hint.unwrap_or(hint).then_some("qty-hint"), "{name}");
        if !patch {
            assert_eq!(crate::form::keyless_submit_field(&html).is_some(), key, "{name}");
        }
    }
}
