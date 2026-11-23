// CSS Syntax Level 3, tokenization. Offsets always refer to the original UTF-8 text.
// Comments are exposed as trivia, not whitespace tokens. In particular, `./**/a`
// has the same significant tokens as `.a`, but `a/**/b` has two identifiers.
// Quoted URL functions end at `(` in these source spans; all following space is trivia.
use std::borrow::Cow;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Space,
    Comment { closed: bool },
    String { closed: bool },
    BadString,
    Url { closed: bool },
    BadUrl,
    Ident,
    Function,
    AtKeyword,
    Hash,
    Number,
    Percentage,
    Dimension,
    Open,
    Close,
    Comma,
    Colon,
    Semicolon,
    Cdo,
    Cdc,
    Delim(u8),
}

impl Kind {
    pub(crate) fn trivia(self) -> bool {
        matches!(self, Self::Space | Self::Comment { .. })
    }
}

pub(crate) type Token = (Kind, usize, usize);

pub(crate) fn lexer(css: &str) -> Lexer<'_> {
    Lexer { css, at: 0 }
}

#[derive(Clone)]
pub(crate) struct Lexer<'a> {
    css: &'a str,
    at: usize,
}

impl Iterator for Lexer<'_> {
    type Item = Token;

    fn next(&mut self) -> Option<Token> {
        use Kind::*;
        let b = self.css.as_bytes();
        let start = self.at;
        let c = *b.get(start)?;
        let (kind, end) = match c {
            c if space(c) => (Space, skip_space(b, start)),
            b'/' if b.get(start + 1) == Some(&b'*') => match self.css[start + 2..].find("*/") {
                Some(end) => (Comment { closed: true }, start + end + 4),
                None => (Comment { closed: false }, b.len()),
            },
            b'"' | b'\'' => string(b, start, c),
            b'<' if b[start..].starts_with(b"<!--") => (Cdo, start + 4),
            b'-' if b[start..].starts_with(b"-->") => (Cdc, start + 3),
            b'@' if ident_start(b, start + 1) => (AtKeyword, name_end(b, start + 1)),
            b'#' if b.get(start + 1).is_some_and(|&c| name_byte(c)) || valid_escape(b, start + 1) => {
                (Hash, name_end(b, start + 1))
            }
            _ if ident_start(b, start) => {
                let end = name_end(b, start);
                if b.get(end) != Some(&b'(') {
                    (Ident, end)
                } else if name_is(&self.css[start..end], "url") {
                    let input = skip_space(b, end + 1);
                    if matches!(b.get(input), Some(b'"' | b'\'')) {
                        (Function, end + 1)
                    } else {
                        url(b, input)
                    }
                } else {
                    (Function, end + 1)
                }
            }
            _ if number_start(b, start) => {
                let end = number_end(b, start);
                if ident_start(b, end) {
                    (Dimension, name_end(b, end))
                } else if b.get(end) == Some(&b'%') {
                    (Percentage, end + 1)
                } else {
                    (Number, end)
                }
            }
            c => (
                match c {
                    b'(' | b'[' | b'{' => Open,
                    b')' | b']' | b'}' => Close,
                    b',' => Comma,
                    b':' => Colon,
                    b';' => Semicolon,
                    _ => Delim(c),
                },
                start + 1,
            ),
        };
        self.at = end;
        Some((kind, start, end))
    }
}

pub(crate) fn closer(kind: Kind, spelling: &str) -> Option<u8> {
    match (kind, spelling) {
        (Kind::Function, _) | (Kind::Open, "(") => Some(b')'),
        (Kind::Open, "[") => Some(b']'),
        (Kind::Open, "{") => Some(b'}'),
        _ => None,
    }
}

/// A literal lookup argument, optionally wrapped in braces (CSS Values 5). Tokens exclude
/// trivia. The caller decides what should follow the argument and whether the name is local.
pub(crate) fn literal_lookup(tokens: &[Token], css: &str, at: usize) -> Option<(usize, usize)> {
    let spelling = |i| tokens.get(i).map(|&(_, start, end)| &css[start..end]);
    let wrapped = spelling(at) == Some("{");
    let index = at + usize::from(wrapped);
    if tokens.get(index)?.0 != Kind::Ident || (wrapped && spelling(index + 1) != Some("}")) {
        return None;
    }
    let name = decoded_name(spelling(index)?);
    name.strip_prefix("--").filter(|name| !name.is_empty())?;
    Some((index, index + 1 + usize::from(wrapped)))
}

pub(crate) fn space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 12)
}

fn newline(c: u8) -> bool {
    matches!(c, b'\n' | b'\r' | 12)
}

fn space_end(b: &[u8], at: usize) -> usize {
    at + if b[at..].starts_with(b"\r\n") { 2 } else { 1 }
}

pub(crate) fn skip_space(b: &[u8], mut at: usize) -> usize {
    while b.get(at).is_some_and(|&c| space(c)) {
        at += 1;
    }
    at
}

fn valid_escape(b: &[u8], at: usize) -> bool {
    b.get(at) == Some(&b'\\') && !b.get(at + 1).is_some_and(|&c| newline(c))
}

fn hex_end(b: &[u8], start: usize) -> usize {
    start + b[start..].iter().take(6).take_while(|c| c.is_ascii_hexdigit()).count()
}

fn escape_end(b: &[u8], at: usize) -> usize {
    let start = at + 1;
    let end = hex_end(b, start);
    if end != start {
        if b.get(end).is_some_and(|&c| space(c)) {
            space_end(b, end)
        } else {
            end
        }
    } else {
        let mut end = (start + 1).min(b.len());
        while b.get(end).is_some_and(|c| c & 0xc0 == 0x80) {
            end += 1;
        }
        end
    }
}

fn name_byte(c: u8) -> bool {
    c.is_ascii_digit() || c == b'-' || name_start(c)
}

fn name_start(c: u8) -> bool {
    // NUL is U+FFFD after CSS input preprocessing.
    matches!(c, b'a'..=b'z' | b'A'..=b'Z' | b'_' | 0 | 0x80..=0xff)
}

fn ident_start(b: &[u8], at: usize) -> bool {
    b.get(at).is_some_and(|&c| name_start(c))
        || valid_escape(b, at)
        || (b.get(at) == Some(&b'-') && (b.get(at + 1).is_some_and(|&c| c == b'-' || name_start(c)) || valid_escape(b, at + 1)))
}

fn name_end(b: &[u8], mut at: usize) -> usize {
    while let Some(&c) = b.get(at) {
        if name_byte(c) {
            at += 1;
        } else if valid_escape(b, at) {
            at = escape_end(b, at);
        } else {
            break;
        }
    }
    at
}

fn digits(b: &[u8], mut at: usize) -> usize {
    while b.get(at).is_some_and(u8::is_ascii_digit) {
        at += 1;
    }
    at
}

fn sign(b: &[u8], at: usize) -> usize {
    usize::from(matches!(b.get(at), Some(b'+' | b'-')))
}

fn number_start(b: &[u8], at: usize) -> bool {
    let at = at + sign(b, at);
    b.get(at).is_some_and(u8::is_ascii_digit) || (b.get(at) == Some(&b'.') && b.get(at + 1).is_some_and(u8::is_ascii_digit))
}

pub(crate) fn number_end(b: &[u8], start: usize) -> usize {
    let mut at = digits(b, start + sign(b, start));
    if b.get(at) == Some(&b'.') && b.get(at + 1).is_some_and(u8::is_ascii_digit) {
        at = digits(b, at + 1);
    }
    if matches!(b.get(at), Some(b'e' | b'E')) {
        let start = at + 1 + sign(b, at + 1);
        if b.get(start).is_some_and(u8::is_ascii_digit) {
            at = digits(b, start);
        }
    }
    at
}

fn string(b: &[u8], start: usize, quote: u8) -> (Kind, usize) {
    let mut at = start + 1;
    while let Some(&c) = b.get(at) {
        match c {
            c if c == quote => return (Kind::String { closed: true }, at + 1),
            c if newline(c) => return (Kind::BadString, at),
            b'\\' if b.get(at + 1).is_some_and(|&c| newline(c)) => at = space_end(b, at + 1),
            b'\\' => at = escape_end(b, at),
            _ => at += 1,
        }
    }
    (Kind::String { closed: false }, at)
}

fn url(b: &[u8], mut at: usize) -> (Kind, usize) {
    while let Some(&c) = b.get(at) {
        match c {
            b')' => return (Kind::Url { closed: true }, at + 1),
            c if space(c) => {
                at = skip_space(b, at);
                match b.get(at) {
                    Some(b')') => return (Kind::Url { closed: true }, at + 1),
                    None => break,
                    _ => return bad_url(b, at),
                }
            }
            b'"' | b'\'' | b'(' | 1..=8 | 11 | 14..=31 | 127 => return bad_url(b, at),
            b'\\' if valid_escape(b, at) => at = escape_end(b, at),
            b'\\' => return bad_url(b, at),
            _ => at += 1,
        }
    }
    (Kind::Url { closed: false }, at)
}

fn bad_url(b: &[u8], mut at: usize) -> (Kind, usize) {
    while let Some(&c) = b.get(at) {
        match c {
            b')' => return (Kind::BadUrl, at + 1),
            b'\\' if valid_escape(b, at) => at = escape_end(b, at),
            _ => at += 1,
        }
    }
    (Kind::BadUrl, at)
}

pub(crate) fn decoded_name(text: &str) -> Cow<'_, str> {
    if text.contains(['\\', '\0']) {
        decode(text, false).into()
    } else {
        text.into()
    }
}

/// Match an ASCII lowercase keyword without decoding non-matching ordinary names.
pub(crate) fn name_is(text: &str, keyword: &str) -> bool {
    text.eq_ignore_ascii_case(keyword) || (text.as_bytes().contains(&b'\\') && decoded_name(text).eq_ignore_ascii_case(keyword))
}

pub(crate) fn decode(text: &str, string: bool) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while let Some(&c) = b.get(at) {
        if c != b'\\' {
            let c = text[at..].chars().next().unwrap();
            out.push(if c == '\0' { '\u{fffd}' } else { c });
            at += c.len_utf8();
        } else if string && at + 1 == b.len() {
            break;
        } else if string && newline(b[at + 1]) {
            at = space_end(b, at + 1);
        } else {
            let start = at + 1;
            let end = hex_end(b, start);
            let c = if end != start {
                char::from_u32(u32::from_str_radix(&text[start..end], 16).unwrap())
            } else {
                text[start..].chars().next()
            };
            out.push(c.filter(|&c| c != '\0').unwrap_or('\u{fffd}'));
            at = escape_end(b, at);
        }
    }
    out
}
