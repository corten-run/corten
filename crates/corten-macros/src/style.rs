//! Component stylesheets. `#[component(css)]` reads `{name}.css` next to the component, scopes
//! every class in it to the component (`.title` becomes `.offer-list__title`), and gives the
//! markup one constant per class, so `class={Title}` is checked and printed as static markup.
//!
//! The scoping runs here, at compile time: the server only concatenates finished stylesheets,
//! writing in the width of each token breakpoint an `@media` rule names (`(--md)`), which only the
//! app's token file knows.

use std::path::{Path, PathBuf};

use proc_macro::{Delimiter, Group, Ident, Literal, Span, TokenStream, TokenTree};

use crate::tokens::{err, is_ident, is_punct, literal, q, string_value, Error};

/// A component's stylesheet, scoped.
#[derive(Debug)]
pub struct Sheet {
    /// The CSS with every class prefixed, comments and extra whitespace removed.
    pub css: String,
    /// The classes, as written in the file, first use first.
    pub classes: Vec<String>,
    /// The custom properties its `@property` rules register, in order: each name as written
    /// (`fill` for `--fill`) and the type of its `syntax`, when markup can set it
    /// (`style={FILL.pct(42.0)}`).
    pub properties: Vec<(String, Option<&'static str>)>,
    /// Each breakpoint an `@media` rule names (`@media not (--sm)`): where its `(--sm)` starts in
    /// `css`, and the name (`sm`). The app's token file says how wide each is, so it is resolved
    /// when the app starts.
    pub media: Vec<(usize, String)>,
}

/// The Rust type (in `corten::style::syntax`) of each `@property` syntax markup can set: a
/// number with one of the units the type allows, so no CSS text from data reaches the page.
const SYNTAXES: &[(&str, &str)] = &[
    ("<number>", "Number"),
    ("<integer>", "Integer"),
    ("<percentage>", "Percentage"),
    ("<length>", "Length"),
    ("<length-percentage>", "LengthPercentage"),
    ("<angle>", "Angle"),
    ("<time>", "Time"),
];

const GROUP_AT_RULES: &[&str] = &["media", "supports", "container", "layer", "starting-style"];
const RAW_AT_RULES: &[&str] =
    &["keyframes", "font-face", "property", "page", "counter-style", "font-palette-values", "font-feature-values"];

/// Prefixes every class in `src` with `{prefix}__`. A rule outside any at-rule (or in `@media`,
/// `@supports`, `@container`, `@layer`) must name one of the file's classes, so a component's
/// styles cannot reach elements it does not render; so must each rule in an `@scope` there unless
/// the scope's root names one.
pub fn scope(src: &str, prefix: &str) -> Result<Sheet, String> {
    if let Some(line) = conflict_marker(src) {
        return Err(format!(
            "line {line}: a merge conflict's marker; keep what each side should between <<<<<<< and >>>>>>>, then remove the markers"
        ));
    }
    let mut s = Scoper {
        text: src,
        bytes: src.as_bytes(),
        i: 0,
        out: String::with_capacity(src.len()),
        classes: Vec::new(),
        properties: Vec::new(),
        positions: Vec::new(),
        position_refs: Vec::new(),
        media: Vec::new(),
        prefix,
        scope_root: None,
    };
    s.block(Ctx::Top, true)?;
    let names: Vec<&str> = s.properties.iter().map(|(name, _)| name.as_str()).collect();
    if let Some(name) = s.media.iter().find(|m| names.contains(&m.as_str())) {
        return Err(format!(
            "(--{name}) in an @media rule names a breakpoint of the token file, and --{name} is this stylesheet's @property: rename the property"
        ));
    }
    if !s.positions.is_empty() {
        // Work backwards so expanding a reference does not move the remaining ranges.
        for (start, end, raw) in s.position_refs.into_iter().rev() {
            if let Some(value) = rename_positions(raw, &s.positions, prefix) {
                s.out.replace_range(start..end, &value);
            }
        }
    }
    let css = rename_properties(&s.out, &names, prefix)?;
    let media = media_refs(&css);
    Ok(Sheet { css, classes: s.classes, properties: s.properties, media })
}

/// Where each `(--name)` of an `@media` prelude starts in scoped CSS, as [`Scoper`] writes them:
/// at-rule preludes in one piece, no comments, strings left alone.
fn media_refs(css: &str) -> Vec<(usize, String)> {
    let b = css.as_bytes();
    let mut refs = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            q @ (b'"' | b'\'') => {
                i += 1;
                while i < b.len() && b[i] != q {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
            }
            b'@' if b.get(i + 1..i + 6).is_some_and(|n| n.eq_ignore_ascii_case(b"media")) => {
                let end = css[i..].find('{').map_or(b.len(), |at| i + at);
                let mut at = i;
                while let Some(found) = css[at..end].find("(--") {
                    let start = at + found;
                    let close = css[start..end].find(')').map_or(end, |c| start + c);
                    refs.push((start, css[start + 3..close].to_string()));
                    at = close;
                }
                i = end;
            }
            _ => i += 1,
        }
    }
    refs
}

/// The line of the first merge conflict marker in `src` (`<<<<<<<`, `|||||||`, `=======` or
/// `>>>>>>>` starting a line, alone or before a space), outside comments and strings: CSS has no
/// rule that starts so, and a browser drops the rule after one, so a merge left unfinished
/// (`corten ui add --merge`, git) would otherwise build and lose a rule.
fn conflict_marker(src: &str) -> Option<usize> {
    let bytes = src.as_bytes();
    let (mut i, mut line, mut quote, mut comment) = (0, 1, None::<u8>, false);
    while i < bytes.len() {
        if !comment && quote.is_none() && (i == 0 || bytes[i - 1] == b'\n') {
            let rest = &bytes[i..];
            let marker = b"<|=>".iter().any(|&c| rest.len() >= 7 && rest[..7].iter().all(|&b| b == c));
            if marker && matches!(rest.get(7), None | Some(b' ' | b'\n' | b'\r')) {
                return Some(line);
            }
        }
        let b = bytes[i];
        if comment {
            if b == b'*' && bytes.get(i + 1) == Some(&b'/') {
                comment = false;
                i += 1;
            }
        } else if let Some(q) = quote {
            if b == b'\\' {
                // An escaped line end continues the string: `\\\r\n` as one.
                if bytes.get(i + 1) == Some(&b'\r') && bytes.get(i + 2) == Some(&b'\n') {
                    i += 1;
                }
                if bytes.get(i + 1) == Some(&b'\n') {
                    line += 1;
                }
                i += 1;
            } else if b == q || b == b'\n' {
                quote = None;
            }
        } else if b == b'/' && bytes.get(i + 1) == Some(&b'*') {
            comment = true;
            i += 1;
        } else if b == b'"' || b == b'\'' {
            quote = Some(b);
        }
        if b == b'\n' {
            line += 1;
        }
        i += 1;
    }
    None
}

/// Whether `syntax` (the text of an `@property`'s `syntax`, its escapes decoded) is one the
/// browser reads, by the algorithm of CSS Properties and Values API Level 1 (5.4, consume a syntax
/// definition): `*`, or components joined by `|`, each a supported data type name (`<length>`)
/// or a keyword, either followed by `+` (a list) or `#` (a comma list), but
/// `<transform-list>`, which is a list already. A keyword is an identifier that starts with a
/// letter, `_`, a non-ASCII character or an escape (not `-`) and is not a CSS-wide keyword or
/// `default`. The browser ignores a rule with another syntax.
fn syntax_valid(syntax: &str) -> bool {
    const TYPES: &[&str] = &[
        "angle",
        "color",
        "custom-ident",
        "image",
        "integer",
        "length",
        "length-percentage",
        "number",
        "percentage",
        "resolution",
        "string",
        "time",
        "transform-function",
        "transform-list",
        "url",
    ];
    let space = |c: &char| matches!(c, ' ' | '\t' | '\n');
    let chars: Vec<char> = preprocess(syntax).chars().collect();
    let (mut start, mut end) = (0, chars.len());
    while start < end && space(&chars[start]) {
        start += 1;
    }
    while end > start && space(&chars[end - 1]) {
        end -= 1;
    }
    let chars = &chars[start..end];
    if chars.is_empty() {
        return false;
    }
    if chars == ['*'] {
        return true;
    }
    let mut i = 0;
    loop {
        while chars.get(i).is_some_and(space) {
            i += 1;
        }
        match chars.get(i) {
            Some('<') => {
                let Some(len) = chars[i..].iter().position(|&c| c == '>') else { return false };
                let name: String = chars[i + 1..i + len].iter().collect();
                if !TYPES.contains(&name.as_str()) {
                    return false;
                }
                i += len + 1;
                if name != "transform-list" && matches!(chars.get(i), Some('+' | '#')) {
                    i += 1;
                }
            }
            Some(&c) if starts_ident(c) || (c == '\\' && chars.get(i + 1) != Some(&'\n')) => {
                let mut name = String::new();
                loop {
                    match chars.get(i) {
                        Some(&c) if starts_ident(c) || c.is_ascii_digit() || c == '-' => {
                            name.push(c);
                            i += 1;
                        }
                        Some('\\') if chars.get(i + 1) != Some(&'\n') => {
                            let (c, next) = escaped(chars, i + 1);
                            name.push(c);
                            i = next;
                        }
                        _ => break,
                    }
                }
                if ["initial", "inherit", "unset", "revert", "revert-layer", "default"]
                    .iter()
                    .any(|k| name.eq_ignore_ascii_case(k))
                {
                    return false;
                }
                if matches!(chars.get(i), Some('+' | '#')) {
                    i += 1;
                }
            }
            _ => return false,
        }
        while chars.get(i).is_some_and(space) {
            i += 1;
        }
        match chars.get(i) {
            None => return true,
            Some('|') => i += 1,
            Some(_) => return false,
        }
    }
}

/// Whether `c` starts an identifier: a letter, `_` or a non-ASCII character (CSS Syntax Level 3,
/// ident-start code point).
fn starts_ident(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || !c.is_ascii()
}

/// `text` as CSS reads it: each line break (`\r\n`, `\r`, form feed) one `\n`, and NUL the
/// replacement character (CSS Syntax Level 3, preprocessing the input stream).
fn preprocess(text: &str) -> String {
    text.replace("\r\n", "\n").replace(['\r', '\u{c}'], "\n").replace('\0', "\u{fffd}")
}

/// A CSS string's contents with its escapes decoded (CSS Syntax Level 3, consume a string token):
/// `\` and a line break is nothing, and `\` before anything else is the code point it escapes.
fn unescape(text: &str) -> String {
    let chars: Vec<char> = preprocess(text).chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        match (chars[i], chars.get(i + 1)) {
            ('\\', None) => i += 1,
            ('\\', Some('\n')) => i += 2,
            ('\\', Some(_)) => {
                let (c, next) = escaped(&chars, i + 1);
                out.push(c);
                i = next;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// The code point the escape whose `\` is just before `at` stands for, and where the escape
/// ends (CSS Syntax Level 3, consume an escaped code point): one to six hex digits and one
/// whitespace after them, the replacement character for zero, a surrogate or past U+10FFFF, or
/// else the next character itself.
fn escaped(chars: &[char], at: usize) -> (char, usize) {
    let hex = chars[at..].iter().take(6).take_while(|c| c.is_ascii_hexdigit()).count();
    if hex == 0 {
        return match chars.get(at) {
            Some(&c) => (c, at + 1),
            None => ('\u{fffd}', at),
        };
    }
    let value = chars[at..at + hex].iter().fold(0u32, |value, c| value * 16 + c.to_digit(16).unwrap_or(0));
    let end = at + hex + usize::from(matches!(chars.get(at + hex), Some(' ' | '\t' | '\n')));
    (if value == 0 { '\u{fffd}' } else { char::from_u32(value).unwrap_or('\u{fffd}') }, end)
}

/// Whether `value`, an `initial-value`, is one of `kind` (a type of `SYNTAXES`): a number with a
/// unit the syntax allows (`0` alone for a length), and for a length one of `LENGTHS`, as an initial
/// value must not depend on a font or a container. The browser ignores a rule whose initial
/// value does not parse as its syntax, so markup would set a property nothing registered.
fn initial_fits(kind: &str, value: &str) -> bool {
    // The number: a sign, digits and a point, and an exponent only when digits follow its `e`
    // (`1em` is one em, `2e3` two thousand).
    // CSS's number token: digits, or digits around a point with at least one after it (`.5`, not `1.`).
    let b = value.as_bytes();
    let digits = |mut i: usize| {
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        i
    };
    let start = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    let mut at = digits(start);
    if b.get(at) == Some(&b'.') {
        let after = digits(at + 1);
        if after == at + 1 {
            return false;
        }
        at = after;
    }
    if at == start {
        return false;
    }
    if matches!(b.get(at), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(b.get(at + 1), Some(b'+' | b'-')));
        if b.get(at + 1 + sign).is_some_and(u8::is_ascii_digit) {
            at = digits(at + 1 + sign);
        }
    }
    let (number, unit) = value.split_at(at);
    let Ok(number) = number.parse::<f64>() else { return false };
    if !number.is_finite() {
        return false;
    }
    let unit = unit.to_ascii_lowercase();
    match kind {
        "Number" => unit.is_empty(),
        "Integer" => unit.is_empty() && number.fract() == 0.0 && !value.contains(['.', 'e', 'E']),
        "Percentage" => unit == "%",
        "Length" => LENGTHS.contains(&unit.as_str()) || (unit.is_empty() && number == 0.0),
        "LengthPercentage" => unit == "%" || LENGTHS.contains(&unit.as_str()) || (unit.is_empty() && number == 0.0),
        "Angle" => matches!(unit.as_str(), "deg" | "grad" | "rad" | "turn"),
        "Time" => matches!(unit.as_str(), "s" | "ms"),
        _ => true,
    }
}

/// The length units an `initial-value` may have. It must be computationally independent: absolute
/// units and the viewport's, which CSS cannot change, but none that depends on a font or a container
/// (`1em`, `1cqw`), which the browser refuses (CSS Properties and Values API Level 1, 3.1).
const LENGTHS: &[&str] = &[
    "px", "cm", "mm", "q", "in", "pt", "pc", "vw", "vh", "vi", "vb", "vmin", "vmax", "svw", "svh", "svi", "svb", "svmin",
    "svmax", "lvw", "lvh", "lvi", "lvb", "lvmin", "lvmax", "dvw", "dvh", "dvi", "dvb", "dvmin", "dvmax",
];

/// `css` with each of `names` (a custom property its `@property` rules register, `fill`)
/// written `--{prefix}__fill` wherever it is a whole name outside strings: the property is the
/// component's, as its classes are, so two components can both register a `--fill`.
///
/// A declaration of one marked `!important` is an error: markup's values (`style={FILL.pct(..)}`)
/// are `!important` too, inline after a patch and in a rule of the page's style block on a full
/// load, and an `!important` rule of the component's with more specificity than that rule would
/// win on a full load and lose after a patch.
fn rename_properties(css: &str, names: &[&str], prefix: &str) -> Result<String, String> {
    if names.is_empty() {
        return Ok(css.to_string());
    }
    let b = css.as_bytes();
    let ident = |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_') || c >= 0x80 || c == b'\\';
    let mut out = String::with_capacity(css.len() + names.len() * (prefix.len() + 4));
    let (mut i, mut copied) = (0, 0);
    while i < b.len() {
        match b[i] {
            q @ (b'"' | b'\'') => {
                i += 1;
                while i < b.len() && b[i] != q {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
            }
            // An attribute selector's value, `[data-kind=--fill]`, is text.
            b'[' => {
                while i < b.len() && b[i] != b']' {
                    i += match b[i] {
                        b'\\' => 2,
                        q @ (b'"' | b'\'') => 1 + css[i + 1..].find(q as char).map_or(b.len(), |end| end + 1),
                        _ => 1,
                    };
                }
            }
            // An unquoted `url(..)` is a URL, `url(--fill.svg)` a file's name.
            b'(' if i >= 3 && b[i - 3..i].eq_ignore_ascii_case(b"url") && (i == 3 || !ident(b[i - 4])) => {
                while i < b.len() && b[i] != b')' {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
            }
            b'-' if b.get(i + 1) == Some(&b'-') && (i == 0 || !ident(b[i - 1])) => {
                // The whole name, escapes included: `--f\69 ll` is `--fill` to the browser.
                let end = css_name_end(css, i + 2);
                let written = &css[i + 2..end];
                let name = if written.contains('\\') { unescape(written) } else { written.to_string() };
                if names.contains(&name.as_str()) {
                    let declared =
                        b[..i].iter().rev().find(|c| !c.is_ascii_whitespace()).is_none_or(|c| matches!(c, b'{' | b';'))
                            && b[end..].iter().find(|c| !c.is_ascii_whitespace()) == Some(&b':');
                    if declared && important(&css[end..]) {
                        return Err(format!(
                            "--{name}: !important on a property markup sets would beat markup's value on a full load and lose to it after a patch; set it from markup (style={{..}}) or without !important"
                        ));
                    }
                    out.push_str(&css[copied..i + 2]);
                    out.push_str(prefix);
                    out.push_str("__");
                    out.push_str(&name);
                    copied = end;
                }
                i = end;
            }
            _ => i += 1,
        }
    }
    out.push_str(&css[copied.min(css.len())..]);
    Ok(out)
}

/// Where the identifier from `end` ends, escapes included (CSS Syntax Level 3, consume an ident
/// sequence): a hex escape takes one whitespace after it, a CRLF counting as one.
fn css_name_end(css: &str, mut end: usize) -> usize {
    let b = css.as_bytes();
    while end < b.len() {
        if b[end] == b'\\' {
            if matches!(b.get(end + 1), None | Some(b'\n' | b'\r' | b'\x0c')) {
                break;
            }
            let hex = b[end + 1..].iter().take(6).take_while(|c| c.is_ascii_hexdigit()).count();
            end += 1 + hex.max(1);
            if hex > 0 && b.get(end) == Some(&b'\r') && b.get(end + 1) == Some(&b'\n') {
                end += 2;
            } else if hex > 0 && matches!(b.get(end), Some(b' ' | b'\t' | b'\n' | b'\r' | b'\x0c')) {
                end += 1;
            }
            while end < b.len() && !css.is_char_boundary(end) {
                end += 1;
            }
        } else if b[end].is_ascii_alphanumeric() || matches!(b[end], b'-' | b'_') || b[end] >= 0x80 {
            end += 1;
        } else {
            break;
        }
    }
    end
}

/// What the position pass tells apart in a declaration's value (CSS Syntax Level 3, tokenization).
#[derive(Clone, Copy, PartialEq)]
enum Tok {
    /// An identifier: `--above`, `flip-block`.
    Ident,
    /// A function's name with its `(`: `var(`, `--above(`.
    Function,
    /// `(`, `[` or `{`.
    Open,
    /// `)`, `]` or `}`.
    Close,
    Comma,
    Colon,
    Semicolon,
    Space,
    /// A comment, a string, a URL, a number, a hash, an at-keyword or a delimiter.
    Other,
}

/// The tokens of `css`, each with where it starts and ends.
fn tokens(css: &str) -> Vec<(Tok, usize, usize)> {
    let b = css.as_bytes();
    let escape = |at: usize| b.get(at) == Some(&b'\\') && !matches!(b.get(at + 1), None | Some(b'\n' | b'\r' | b'\x0c'));
    let name_start = |c: u8| c.is_ascii_alphabetic() || c == b'_' || c >= 0x80;
    let ident_start = |at: usize| match b.get(at) {
        Some(b'-') => b.get(at + 1).is_some_and(|&c| name_start(c) || c == b'-') || escape(at + 1),
        Some(b'\\') => escape(at),
        Some(&c) => name_start(c),
        None => false,
    };
    let digits = |mut at: usize| {
        while b.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        at
    };
    let number_start = |at: usize| {
        let at = at + usize::from(matches!(b.get(at), Some(b'+' | b'-')));
        b.get(at).is_some_and(u8::is_ascii_digit) || (b.get(at) == Some(&b'.') && b.get(at + 1).is_some_and(u8::is_ascii_digit))
    };
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let start = i;
        let kind = match b[i] {
            c if c.is_ascii_whitespace() => {
                while b.get(i).is_some_and(u8::is_ascii_whitespace) {
                    i += 1;
                }
                Tok::Space
            }
            q @ (b'"' | b'\'') => {
                i += 1;
                while i < b.len() && b[i] != q {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                i = (i + 1).min(b.len());
                Tok::Other
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i = css[i + 2..].find("*/").map_or(b.len(), |end| i + end + 4);
                Tok::Other
            }
            // A number and its unit: `1px` is not the identifier `px`.
            _ if number_start(i) => {
                i = digits(i + usize::from(matches!(b[i], b'+' | b'-')));
                if b.get(i) == Some(&b'.') && b.get(i + 1).is_some_and(u8::is_ascii_digit) {
                    i = digits(i + 1);
                }
                if matches!(b.get(i), Some(b'e' | b'E')) {
                    let sign = usize::from(matches!(b.get(i + 1), Some(b'+' | b'-')));
                    if b.get(i + 1 + sign).is_some_and(u8::is_ascii_digit) {
                        i = digits(i + 1 + sign);
                    }
                }
                if ident_start(i) {
                    i = css_name_end(css, i);
                } else if b.get(i) == Some(&b'%') {
                    i += 1;
                }
                Tok::Other
            }
            _ if ident_start(i) => {
                i = css_name_end(css, i);
                if b.get(i) != Some(&b'(') {
                    Tok::Ident
                } else {
                    let url = unescape(&css[start..i]).eq_ignore_ascii_case("url");
                    i += 1;
                    let mut at = i;
                    while b.get(at).is_some_and(u8::is_ascii_whitespace) {
                        at += 1;
                    }
                    if url && !matches!(b.get(at), Some(b'"' | b'\'')) {
                        // An unquoted URL is one token to its `)`: `url(--above.svg)`.
                        while i < b.len() && b[i] != b')' {
                            i += if escape(i) { 2 } else { 1 };
                        }
                        i = (i + 1).min(b.len());
                        Tok::Other
                    } else {
                        Tok::Function
                    }
                }
            }
            b'#' | b'@' if css_name_end(css, i + 1) > i + 1 => {
                i = css_name_end(css, i + 1);
                Tok::Other
            }
            c => {
                i += css[i..].chars().next().map_or(1, char::len_utf8);
                match c {
                    b'(' | b'[' | b'{' => Tok::Open,
                    b')' | b']' | b'}' => Tok::Close,
                    b',' => Tok::Comma,
                    b':' => Tok::Colon,
                    b';' => Tok::Semicolon,
                    _ => Tok::Other,
                }
            }
        };
        while i < b.len() && !css.is_char_boundary(i) {
            i += 1;
        }
        out.push((kind, start, i.min(b.len())));
    }
    out
}

/// The value of a `position-try` or `position-try-fallbacks` declaration with each identifier token
/// that is `--` and one of `names` (the options this file defines)
/// written `--{prefix}__{name}`, where the value takes an option: at its top, in the fallback
/// of a `var()`, `env()`, `attr()` or `inherit()`, and in the value of an `if()` branch. A
/// function's name (`--above()` calls a custom function), a lookup's name, an `if()` condition
/// (`style(--above: 1)` queries a custom property), strings, URLs and whatever is inside any
/// other function keep their names.
fn rename_positions(raw: &str, names: &[String], prefix: &str) -> Option<String> {
    // Read the source before squash can turn two spaces after a hex escape (or an escape
    // followed by a comment) into just an escape terminator. Replace only the name tokens.
    let toks = tokens(raw);
    let mut renamed = Vec::new();
    let colon = toks.iter().position(|&(kind, ..)| kind == Tok::Colon)?;
    let mut i = colon + 1;
    while i < toks.len() {
        // Past a `)` with no `(`, which the browser would reject, to the rest of the value.
        i = options(raw, &toks, i, false, names, &mut renamed) + 1;
    }
    let mut out = String::with_capacity(raw.len() + renamed.len() * (prefix.len() + 2));
    let start = if let Some(&(Tok::Space, _, end)) = toks.get(colon + 1) { end } else { toks[colon].2 };
    let end = if let Some(&(Tok::Space, start, _)) = toks.last() { start } else { raw.len() };
    let mut copied = start.min(end);
    for (start, end, name) in renamed {
        out.push_str(&raw[copied..start]);
        out.push_str("--");
        out.push_str(prefix);
        out.push_str("__");
        out.push_str(&name);
        copied = end;
    }
    out.push_str(&raw[copied..end]);
    Some(out)
}

/// Records the options among the tokens from `i` to the end of the block they are in (or, for
/// an `if()` branch, to its `;`), and returns where that is.
fn options(
    css: &str,
    toks: &[(Tok, usize, usize)],
    mut i: usize,
    branch: bool,
    names: &[String],
    renamed: &mut Vec<(usize, usize, String)>,
) -> usize {
    while let Some(&(kind, start, end)) = toks.get(i) {
        match kind {
            Tok::Close => return i,
            Tok::Semicolon if branch => return i,
            Tok::Ident => {
                if let Some(name) = unescape(&css[start..end]).strip_prefix("--").filter(|name| names.iter().any(|n| n == name)) {
                    renamed.push((start, end, name.to_string()));
                }
                i += 1;
            }
            Tok::Function => {
                let function = unescape(&css[start..end - 1]).to_ascii_lowercase();
                i = match function.as_str() {
                    // A lookup's name, then a fallback that can be an option.
                    "var" | "env" | "attr" | "inherit" => {
                        let comma = skip(toks, i + 1, &[Tok::Comma]);
                        match toks.get(comma) {
                            Some((Tok::Comma, ..)) => options(css, toks, comma + 1, false, names, renamed),
                            _ => comma,
                        }
                    }
                    // `if(<condition>: <value>; else: <value>)`: only the values are options.
                    "if" => {
                        let mut at = i + 1;
                        loop {
                            let colon = skip(toks, at, &[Tok::Colon, Tok::Semicolon]);
                            match toks.get(colon) {
                                Some((Tok::Colon, ..)) => {}
                                Some((Tok::Semicolon, ..)) => {
                                    at = colon + 1;
                                    continue;
                                }
                                _ => break colon,
                            }
                            let ends = options(css, toks, colon + 1, true, names, renamed);
                            match toks.get(ends) {
                                Some((Tok::Semicolon, ..)) => at = ends + 1,
                                _ => break ends,
                            }
                        }
                    }
                    _ => skip(toks, i + 1, &[]),
                } + 1;
            }
            Tok::Open => i = skip(toks, i + 1, &[]) + 1,
            _ => i += 1,
        }
    }
    i
}

/// Where the block the tokens from `i` are in ends, or the first of `stop` before that outside
/// any block nested in it.
fn skip(toks: &[(Tok, usize, usize)], mut i: usize, stop: &[Tok]) -> usize {
    let mut depth = 0usize;
    while let Some(&(kind, ..)) = toks.get(i) {
        match kind {
            Tok::Open | Tok::Function => depth += 1,
            Tok::Close if depth == 0 => return i,
            Tok::Close => depth -= 1,
            kind if depth == 0 && stop.contains(&kind) => return i,
            _ => {}
        }
        i += 1;
    }
    i
}

/// Whether the declaration value at the start of `rest` (up to its `;` or `}`, outside strings
/// and brackets) ends `!important`, in any case and with any space after the `!`.
fn important(rest: &str) -> bool {
    let b = rest.as_bytes();
    let (mut i, mut depth) = (0, 0usize);
    while i < b.len() {
        match b[i] {
            q @ (b'"' | b'\'') => {
                i += 1;
                while i < b.len() && b[i] != q {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
            }
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth = depth.saturating_sub(1),
            b';' | b'}' | b'{' if depth == 0 => break,
            b'!' if depth == 0 => {
                let word = rest[i + 1..].trim_start();
                if word.len() >= 9 && word.as_bytes()[..9].eq_ignore_ascii_case(b"important") {
                    return true;
                }
            }
            _ => {}
        }
        i += 1;
    }
    false
}

#[derive(Clone, Copy, PartialEq)]
enum Ctx {
    /// Rules, which must be scoped: at the top of the file, or in an `@scope` there whose root
    /// is not the component's.
    Top,
    /// Inside a style rule, or an `@scope` rule nested in one: declarations and nested rules.
    Style,
    /// Inside an `@scope` rule at the top of the file whose root names one of its classes: as in a
    /// style rule, since its rules match only under the root, but name-defining at-rules such as
    /// `@property` are valid there and not scoped (CSS Cascade 6).
    Scope,
    /// `@keyframes`, `@font-face` and the like: copied as written.
    Raw,
}

struct Scoper<'a> {
    text: &'a str,
    bytes: &'a [u8],
    i: usize,
    out: String,
    classes: Vec<String>,
    properties: Vec<(String, Option<&'static str>)>,
    positions: Vec<String>,
    position_refs: Vec<(usize, usize, &'a str)>,
    /// The breakpoints its `@media` rules name, without the `--`.
    media: Vec<String>,
    prefix: &'a str,
    /// The root of the `@scope` rule being read when it is at the top of the file and not the
    /// component's, whose rules are checked as the file's are.
    scope_root: Option<String>,
}

impl Scoper<'_> {
    fn error(&self, at: usize, message: impl std::fmt::Display) -> String {
        let line = self.text[..at.min(self.text.len())].matches('\n').count() + 1;
        format!("line {line}: {message}")
    }

    fn close(&mut self) {
        if self.out.ends_with(';') {
            self.out.pop();
        }
        self.out.push('}');
    }

    fn block(&mut self, ctx: Ctx, top: bool) -> Result<(), String> {
        loop {
            self.skip_space();
            match self.bytes.get(self.i) {
                None if top => return Ok(()),
                None => return Err(self.error(self.i, "a block is never closed: add }")),
                Some(b'}') if top => return Err(self.error(self.i, "unexpected }")),
                Some(b'}') => {
                    self.i += 1;
                    return Ok(());
                }
                _ => {}
            }
            let start = self.i;
            let end = self.chunk()?;
            let raw = &self.text[start..self.i];
            let text = squash(raw);
            if end == Some(b'{') {
                self.i += 1;
                let mut scope_rule = None;
                let mut unowned_root = None;
                let mut position_name = None;
                let inner = if let Some(rule) = text.strip_prefix('@') {
                    // At-rule names are case-insensitive in CSS: `@MEDIA` is `@media`.
                    let name =
                        rule.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-')).next().unwrap_or("").to_ascii_lowercase();
                    let name = name.as_str();
                    if name == "page" && ctx != Ctx::Raw {
                        self.check_page(rule["page".len()..].trim(), start)?;
                    }
                    match (ctx, name) {
                        (Ctx::Raw, _) => Ctx::Raw,
                        // A rule nested in a style rule holds style rules or declarations; the
                        // browser ignores an `@property` there (CSS Nesting).
                        (Ctx::Style, "property") => {
                            return Err(self.error(start, "@property registers a property for the whole page: put it at the top of the stylesheet, outside any rule"))
                        }
                        (_, "position-try") if raw.strip_prefix('@').is_some_and(|rule| css_name_end(rule, 0) == "position-try".len()) => {
                            let written = rule["position-try".len()..].trim_matches(|c: char| c.is_ascii_whitespace());
                            let Some(name) = written.strip_prefix("--").filter(|name| !name.is_empty() && name.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))) else {
                                return Err(self.error(start, "@position-try: a name starts with -- and has letters, digits, - and _"));
                            };
                            if name.contains("__") {
                                return Err(self.error(start, "@position-try: __ separates the component's name from the option; use - or _"));
                            }
                            if ctx == Ctx::Style {
                                return Err(self.error(start, "@position-try defines a name for the whole page: put it at the top of the stylesheet, outside any rule"));
                            }
                            if !self.positions.iter().any(|other| other == name) {
                                self.positions.push(name.to_string());
                            }
                            position_name = Some(name);
                            Ctx::Raw
                        }
                        (_, "scope") => {
                            let (prelude, unowned) = self.scope_prelude(&rule["scope".len()..], ctx == Ctx::Top, start)?;
                            scope_rule = Some(prelude);
                            // A root the component owns lets its rules start anywhere; any other
                            // root at the top of the file matches elements outside it, so its
                            // rules must each start at one of the file's classes.
                            match (ctx, unowned) {
                                (Ctx::Top, Some(root)) => {
                                    unowned_root = Some(root);
                                    Ctx::Top
                                }
                                (Ctx::Top, None) => Ctx::Scope,
                                _ => ctx,
                            }
                        }
                        (_, name) if GROUP_AT_RULES.contains(&name) => ctx,
                        (_, name) if RAW_AT_RULES.contains(&name) => Ctx::Raw,
                        _ => return Err(self.unsupported_at_rule(start, name)),
                    }
                } else {
                    Ctx::Style
                };
                let media = ctx != Ctx::Raw && text.get(..6).is_some_and(|at| at.eq_ignore_ascii_case("@media"));
                if let Some(prelude) = scope_rule {
                    self.out.push_str(&prelude);
                } else if media {
                    let prelude = self.custom_media(&text, start)?;
                    self.out.push_str(&prelude);
                } else if let Some(name) = position_name {
                    self.out.push_str(&text[..text.len() - name.len()]);
                    self.out.push_str(self.prefix);
                    self.out.push_str("__");
                    self.out.push_str(name);
                } else if text.starts_with('@') || ctx == Ctx::Raw {
                    self.out.push_str(&text);
                } else {
                    let selector = self.selector(&text, ctx == Ctx::Top, start)?;
                    self.out.push_str(&selector);
                }
                self.out.push('{');
                let body = self.out.len();
                let outer_root = unowned_root.map(|root| self.scope_root.replace(root));
                self.block(inner, false)?;
                if let Some(outer) = outer_root {
                    self.scope_root = outer;
                }
                if ctx != Ctx::Raw && text.get(..9).is_some_and(|at| at.eq_ignore_ascii_case("@property")) {
                    self.property(&text["@property".len()..], body, start)?;
                }
                self.close();
                continue;
            }
            if end == Some(b';') {
                self.i += 1;
            }
            if text.is_empty() {
                continue;
            }
            if let Some(rule) = text.strip_prefix('@') {
                let keyword = raw.strip_prefix('@').unwrap_or(rule);
                let name = keyword[..css_name_end(keyword, 0)].to_ascii_lowercase();
                match name.as_str() {
                    "custom-media" => {
                        return Err(self.error(
                            start,
                            "@custom-media: a component's stylesheet names the token file's breakpoints, `@media (--md)` or `@media not (--md)`, and tokens! defines them ($extensions.\"run.corten\".breakpoints)",
                        ))
                    }
                    "import" => {
                        return Err(self.error(
                            start,
                            "@import loads a stylesheet the component does not own; put it in the app's stylesheet",
                        ))
                    }
                    "charset" => {}
                    "layer" => {
                        self.out.push_str(&text);
                        self.out.push(';');
                    }
                    // The old split stopped at `_`, non-ASCII and escapes. Do not turn an
                    // unknown statement it let through into an error for the whole sheet.
                    _ if matches!(rule.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-')).next(), Some("layer" | "charset")) => {}
                    _ => return Err(self.unsupported_at_rule(start, &name)),
                }
                continue;
            }
            if ctx == Ctx::Top {
                if let Some(root) = &self.scope_root {
                    return Err(self.error(
                        start,
                        format!("`{text}` styles the root of `@scope ({root})`, which can be outside the component: put it in a rule that starts at one of the stylesheet's classes"),
                    ));
                }
                return Err(self.error(start, format!("`{text}` is outside any rule")));
            }
            let Some((name, value)) = split_declaration(&text) else {
                return Err(self.error(start, format!("expected `property: value`, found `{text}`")));
            };
            self.out.push_str(name);
            self.out.push(':');
            if name.eq_ignore_ascii_case("position-try") || name.eq_ignore_ascii_case("position-try-fallbacks") {
                self.position_refs.push((self.out.len(), self.out.len() + value.len(), raw));
            }
            self.out.push_str(value);
            self.out.push(';');
        }
    }

    fn unsupported_at_rule(&self, at: usize, name: &str) -> String {
        self.error(at, format!("@{name} is not supported in a component's stylesheet: the macro does not know how to keep its rules or names inside the component; put it in the app's stylesheet (docs/guide/styles.md, At-rules)"))
    }

    /// An `@media` prelude with each breakpoint it names (`( --md )`, a custom media query of
    /// Media Queries 5) written `(--md)` and recorded; the app resolves them when it starts.
    fn custom_media(&mut self, prelude: &str, at: usize) -> Result<String, String> {
        let mut out = String::with_capacity(prelude.len());
        let mut rest = prelude;
        while let Some(open) = rest.find('(') {
            out.push_str(&rest[..=open]);
            rest = &rest[open + 1..];
            let inner = rest.trim_start();
            let Some(name) = inner.strip_prefix("--") else { continue };
            let len = name.bytes().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_')).count();
            let after = name[len..].trim_start();
            if len == 0 || !after.starts_with(')') {
                return Err(self.error(
                    at,
                    format!(
                        "{}: a breakpoint is named alone in its parentheses, `(--md)`, with lowercase letters, digits and -, starting with a letter",
                        squash(prelude)
                    ),
                ));
            }
            let name = &name[..len];
            let made = name.starts_with(|c: char| c.is_ascii_lowercase())
                && name.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                && !name.ends_with('-');
            if !made {
                return Err(self.error(
                    at,
                    format!(
                        "(--{name}): a token file's breakpoint is named with lowercase letters, digits and -, starting with a letter, so no token file makes this one"
                    ),
                ));
            }
            if !self.media.iter().any(|m| m == name) {
                self.media.push(name.to_string());
            }
            out.push_str("--");
            out.push_str(name);
            out.push(')');
            rest = &after[1..];
        }
        out.push_str(rest);
        Ok(out)
    }

    /// An `@scope` prelude, `(.list) to (.slot)` (CSS Cascade 6: `(<scope-start>) to
    /// (<scope-end>)`, each a selector list), with the classes of its root and limit prefixed and
    /// recorded, and with `top`, the root as written when a selector in it names none of the
    /// file's classes. Nested in a rule or another `@scope`, the root is relative to that one's
    /// elements. With no root, the scope is the parent of the stylesheet's owner node, the element
    /// around the page's stylesheet link, which no component owns.
    fn scope_prelude(&mut self, prelude: &str, top: bool, at: usize) -> Result<(String, Option<String>), String> {
        let prelude = prelude.trim();
        let usage = format!(
            "`@scope {prelude}`: the browser drops an @scope whose prelude is not a root and an optional limit; write `@scope (.list)` or `@scope (.list) to (.slot)`"
        );
        let (root, rest) = match parenthesized(prelude) {
            Some((root, rest)) => (Some(root), rest.trim_start()),
            None => (None, prelude),
        };
        let limit = if rest.is_empty() {
            None
        } else {
            // `to` and a parenthesized list; `to(` would be a function, which is no limit.
            let to = rest.get(..3).is_some_and(|to| to.as_bytes()[..2].eq_ignore_ascii_case(b"to") && to.ends_with(' '));
            match parenthesized(if to { &rest[3..] } else { "" }) {
                Some((limit, after)) if after.trim().is_empty() => Some(limit),
                _ => return Err(self.error(at, usage)),
            }
        };
        let Some(root) = root else {
            return Err(self.error(
                at,
                "@scope with no root scopes its rules to the element around the page's stylesheet link, which no component owns: start it at one of the stylesheet's classes, `@scope (.list)`",
            ));
        };
        for selector in [Some(root), limit].into_iter().flatten() {
            if selector.trim().is_empty() {
                return Err(self.error(at, usage));
            }
            if pseudo_element(selector) {
                return Err(self.error(
                    at,
                    format!(
                        "`@scope {prelude}`: a pseudo-element cannot be a scope's root or limit, and the browser drops the rule"
                    ),
                ));
            }
        }
        let (start, unowned) = self.prefixed(root.trim(), at)?;
        let mut out = format!("@scope ({start})");
        if let Some(limit) = limit {
            out.push_str(" to (");
            out.push_str(&self.selector(limit.trim(), false, at)?);
            out.push(')');
        }
        Ok((out, (top && unowned.is_some()).then(|| root.trim().to_string())))
    }

    /// Records an `@property` rule, whose declarations are in `self.out` from `body`: its name,
    /// and the type of its syntax when markup can set it. The browser ignores a rule that lacks
    /// `syntax`, `inherits`, or (for any syntax but `*`) `initial-value`, so each is required.
    fn property(&mut self, prelude: &str, body: usize, at: usize) -> Result<(), String> {
        let prelude = prelude.trim();
        let name = prelude
            .strip_prefix("--")
            .filter(|name| !name.is_empty() && name.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_')));
        let Some(name) = name else {
            return Err(self.error(
                at,
                format!("@property {prelude}: a custom property's name starts with -- and has letters, digits, - and _"),
            ));
        };
        if name.contains("__") {
            return Err(self.error(at, format!("--{name}: __ separates the component's name from the property; use - or _")));
        }
        if self.properties.iter().any(|(other, _)| other == name) {
            return Err(self.error(at, format!("@property --{name} is registered twice")));
        }
        let (mut syntax, mut inherits, mut initial) = (None, false, None);
        for declaration in self.out[body..].split(';') {
            let declaration = split_declaration(declaration).map(|(name, value)| (name.to_ascii_lowercase(), value));
            match declaration.as_ref().map(|(name, value)| (name.as_str(), *value)) {
                Some(("syntax", value)) => {
                    let quoted = value.len() >= 2
                        && matches!(value.as_bytes()[0], b'"' | b'\'')
                        && value.as_bytes()[value.len() - 1] == value.as_bytes()[0];
                    if !quoted {
                        return Err(self.error(
                            at,
                            format!(
                                "@property --{name}: syntax is a string, syntax: \"{value}\"; the browser ignores it unquoted"
                            ),
                        ));
                    }
                    syntax = Some(unescape(&value[1..value.len() - 1]).trim_matches([' ', '\t', '\n']).to_string());
                }
                Some(("inherits", value)) if value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("false") => {
                    inherits = true
                }
                Some(("initial-value", value)) => initial = Some(value.trim().to_string()),
                _ => {}
            }
        }
        if let Some(written) = &syntax {
            if !syntax_valid(written) {
                return Err(self.error(at, format!("@property --{name}: syntax: \"{written}\" is not a syntax the browser reads (\"*\", \"<length>\", \"<color>+\", \"auto | <length>\")")));
            }
        }
        let Some(syntax) = syntax else {
            return Err(self.error(
                at,
                format!(
                    "@property --{name} needs a syntax, such as syntax: \"<percentage>\"; the browser ignores it without one"
                ),
            ));
        };
        if !inherits {
            return Err(self.error(
                at,
                format!("@property --{name} needs inherits: true or inherits: false; the browser ignores it without one"),
            ));
        }
        if initial.is_none() && syntax != "*" {
            return Err(self.error(at, format!("@property --{name} needs an initial-value; the browser ignores it without one")));
        }
        let kind = SYNTAXES.iter().find(|(written, _)| *written == syntax).map(|(_, kind)| *kind);
        if let (Some(_), Some(value)) = (kind, &initial) {
            // A math function's grammar and types are the browser's, and it drops the rule when one
            // does not fit (`calc(1px 2px)`, `calc(1px * 2px)`); checking them is a CSS math parser
            // per syntax, so the initial value is written as one value, which the macro can check.
            if value.contains('(') {
                return Err(self.error(
                    at,
                    format!(
                        "@property --{name}: initial-value {value}: write one value, such as 6px for calc(2px * 3), which can be checked; the browser drops the rule when a math function does not fit its syntax"
                    ),
                ));
            }
        }
        if let (Some(kind), Some(value)) = (kind, &initial) {
            if !initial_fits(kind, value) {
                return Err(self.error(
                    at,
                    format!("@property --{name}: initial-value {value} is not a {syntax}; the browser ignores the rule"),
                ));
            }
        }
        self.properties.push((name.to_string(), kind));
        Ok(())
    }

    /// A page's name is the whole app's (`page: name` in any stylesheet picks it), so a component
    /// names its own after itself, and one with no name, which sets every page the app prints,
    /// belongs in the app's stylesheet.
    fn check_page(&self, prelude: &str, at: usize) -> Result<(), String> {
        let name = prelude.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_')).next().unwrap_or("");
        let own = format!("{}-", self.prefix);
        if name.is_empty() {
            return Err(self.error(
                at,
                format!("an @page with no name sets every page the app prints: name it, @page {own}slip, or put it in the app's stylesheet"),
            ));
        }
        if !name.starts_with(&own) {
            return Err(
                self.error(at, format!("a page's name is the whole app's: start it with this component's, @page {own}{name}"))
            );
        }
        Ok(())
    }

    fn skip_space(&mut self) {
        loop {
            while self.bytes.get(self.i).is_some_and(|b| b.is_ascii_whitespace()) {
                self.i += 1;
            }
            if self.bytes[self.i.min(self.bytes.len())..].starts_with(b"/*") {
                match self.text[self.i + 2..].find("*/") {
                    Some(end) => self.i += end + 4,
                    None => self.i = self.bytes.len(),
                }
                continue;
            }
            return;
        }
    }

    /// Moves to the next `{`, `;` or `}` outside strings, comments and brackets.
    fn chunk(&mut self) -> Result<Option<u8>, String> {
        let mut depth = 0usize;
        while let Some(&b) = self.bytes.get(self.i) {
            match b {
                b'"' | b'\'' => {
                    let start = self.i;
                    self.i += 1;
                    loop {
                        match self.bytes.get(self.i) {
                            None | Some(b'\n') => return Err(self.error(start, "a string is never closed")),
                            // An escaped line end, CRLF as one, continues the string.
                            Some(b'\\') if self.bytes.get(self.i + 1..self.i + 3) == Some(b"\r\n") => self.i += 3,
                            Some(b'\\') => self.i += 2,
                            Some(&c) if c == b => break,
                            Some(_) => self.i += 1,
                        }
                    }
                }
                b'/' if self.bytes.get(self.i + 1) == Some(&b'*') => match self.text[self.i + 2..].find("*/") {
                    Some(end) => self.i += end + 3,
                    None => self.i = self.bytes.len() - 1,
                },
                b'\\' => self.i += 1,
                b'(' | b'[' => depth += 1,
                b')' | b']' => depth = depth.saturating_sub(1),
                b'{' | b';' | b'}' if depth == 0 => return Ok(Some(b)),
                _ => {}
            }
            self.i += 1;
        }
        Ok(None)
    }

    /// The selector with its classes prefixed. With `check`, every selector in the list must
    /// name a class of the file.
    fn selector(&mut self, text: &str, check: bool, at: usize) -> Result<String, String> {
        match self.prefixed(text, at)? {
            (_, Some(part)) if check => Err(self.unowned(&part, at)),
            (out, _) => Ok(out),
        }
    }

    /// The selector with its classes prefixed, and the first selector in the list that names no
    /// class of the file.
    fn prefixed(&mut self, text: &str, at: usize) -> Result<(String, Option<String>), String> {
        let chars: Vec<char> = text.chars().collect();
        let mut out = String::with_capacity(text.len() + 16);
        let (mut i, mut brackets, mut parens) = (0, 0usize, 0usize);
        let mut quote = None;
        let mut part_start = 0;
        let mut part_scoped = false;
        let mut unowned = None;
        while i < chars.len() {
            let c = chars[i];
            if let Some(q) = quote {
                out.push(c);
                if c == '\\' && i + 1 < chars.len() {
                    out.push(chars[i + 1]);
                    i += 1;
                } else if c == q {
                    quote = None;
                }
                i += 1;
                continue;
            }
            match c {
                '"' | '\'' => quote = Some(c),
                '[' => brackets += 1,
                ']' => brackets = brackets.saturating_sub(1),
                '(' => parens += 1,
                ')' => parens = parens.saturating_sub(1),
                ',' if brackets == 0 && parens == 0 => {
                    if !part_scoped && unowned.is_none() {
                        unowned = Some(chars[part_start..i].iter().collect::<String>().trim().to_string());
                    }
                    part_start = i + 1;
                    part_scoped = false;
                }
                '.' if brackets == 0 && ident_start(&chars[i + 1..]) => {
                    let mut end = i + 1;
                    while end < chars.len() && (chars[end].is_ascii_alphanumeric() || matches!(chars[end], '-' | '_')) {
                        end += 1;
                    }
                    if chars.get(end) == Some(&'\\') {
                        return Err(
                            self.error(at, "escaped characters in a class name are not supported in a component's stylesheet")
                        );
                    }
                    let class: String = chars[i + 1..end].iter().collect();
                    if class.contains("__") {
                        return Err(
                            self.error(at, format!(".{class}: __ separates the component's name from the class; use - or _"))
                        );
                    }
                    out.push('.');
                    out.push_str(self.prefix);
                    out.push_str("__");
                    out.push_str(&class);
                    if !self.classes.contains(&class) {
                        self.classes.push(class);
                    }
                    part_scoped = true;
                    i = end;
                    continue;
                }
                _ => {}
            }
            out.push(c);
            i += 1;
        }
        if !part_scoped && unowned.is_none() {
            unowned = Some(chars[part_start..].iter().collect::<String>().trim().to_string());
        }
        Ok((out, unowned))
    }

    /// The error for a selector that names no class of the file.
    fn unowned(&self, part: &str, at: usize) -> String {
        match &self.scope_root {
            Some(root) => self.error(
                at,
                format!("`{part}` styles elements this component does not own: `@scope ({root})` can start outside the component, so start each rule in it with one of the stylesheet's classes, like `.list p`, or start the scope at one, `@scope (.list)`"),
            ),
            None => self.error(
                at,
                format!("`{part}` styles elements this component does not own: start the rule with one of the stylesheet's classes, like `.list {part}`"),
            ),
        }
    }
}

fn ident_start(rest: &[char]) -> bool {
    match rest {
        [c, ..] if c.is_ascii_alphabetic() || *c == '_' => true,
        ['-', c, ..] => c.is_ascii_alphabetic() || *c == '_',
        _ => false,
    }
}

/// The text inside the parentheses `text` starts with, and the text after them, outside strings
/// and brackets: `(.a) to (.b)` is `.a` and ` to (.b)`.
fn parenthesized(text: &str) -> Option<(&str, &str)> {
    if !text.starts_with('(') {
        return None;
    }
    let b = text.as_bytes();
    let (mut i, mut depth) = (0, 0usize);
    while i < b.len() {
        match b[i] {
            q @ (b'"' | b'\'') => {
                i += 1;
                while i < b.len() && b[i] != q {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
            }
            b'\\' => i += 1,
            b'(' | b'[' => depth += 1,
            b')' | b']' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return (b[i] == b')').then(|| (&text[1..i], &text[i + 1..]));
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Whether a selector names a pseudo-element (`::before`, or one of the four CSS 2 wrote with
/// one colon, `:before`), outside strings and brackets.
fn pseudo_element(selector: &str) -> bool {
    let b = selector.as_bytes();
    let (mut i, mut brackets) = (0, 0usize);
    while i < b.len() {
        match b[i] {
            q @ (b'"' | b'\'') => {
                i += 1;
                while i < b.len() && b[i] != q {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
            }
            b'\\' => i += 1,
            b'[' => brackets += 1,
            b']' => brackets = brackets.saturating_sub(1),
            b':' if brackets == 0 => {
                if b.get(i + 1) == Some(&b':') {
                    return true;
                }
                let name: String = selector[i + 1..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
                if ["before", "after", "first-line", "first-letter"].iter().any(|n| name.eq_ignore_ascii_case(n)) {
                    return true;
                }
            }
            _ => {}
        }
        i += 1;
    }
    false
}

/// Comments removed and whitespace collapsed, outside strings.
fn squash(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut space = false;
    while let Some(c) = chars.next() {
        match c {
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut last = ' ';
                for c in chars.by_ref() {
                    if last == '*' && c == '/' {
                        break;
                    }
                    last = c;
                }
                space = true;
            }
            '"' | '\'' => {
                if space && !out.is_empty() {
                    out.push(' ');
                }
                space = false;
                out.push(c);
                while let Some(s) = chars.next() {
                    out.push(s);
                    if s == '\\' {
                        if let Some(next) = chars.next() {
                            out.push(next);
                        }
                    } else if s == c {
                        break;
                    }
                }
            }
            c if c.is_whitespace() => space = true,
            c => {
                if space && !out.is_empty() {
                    out.push(' ');
                }
                space = false;
                out.push(c);
            }
        }
    }
    out
}

fn split_declaration(text: &str) -> Option<(&str, &str)> {
    let (name, value) = text.split_once(':')?;
    let name = name.trim();
    (!name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).then(|| (name, value.trim()))
}

/// The constant for a class: `alert-message` is `AlertMessage`.
pub fn class_ident(class: &str) -> Result<String, String> {
    let mut out = String::new();
    for word in class.split(['-', '_']).filter(|w| !w.is_empty()) {
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            out.push(first.to_ascii_uppercase());
            out.push_str(chars.as_str());
        }
    }
    if out.is_empty() || out.starts_with(|c: char| c.is_ascii_digit()) || out == "Self" {
        return Err(format!(".{class} has no Rust name; start it with a letter"));
    }
    Ok(out)
}

/// The constant for a custom property: `bar-width` is `BAR_WIDTH`.
pub fn var_ident(name: &str) -> Result<String, String> {
    let words: Vec<String> = name.split(['-', '_']).filter(|w| !w.is_empty()).map(str::to_ascii_uppercase).collect();
    let out = words.join("_");
    if out.is_empty() || out.starts_with(|c: char| c.is_ascii_digit()) {
        return Err(format!("--{name} has no Rust name; start it with a letter"));
    }
    Ok(out)
}

/// The stylesheet or script `file` next to the source file of `span`. When the compiler gives no source
/// path (some editors' macro servers), the one file with that name under the crate's `src`.
pub fn locate(file: &str, span: Span) -> Result<PathBuf, Error> {
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into()));
    if let Some(source) = span.local_file() {
        // A relative path is from the compiler's directory (the workspace root under cargo).
        let source = match (source.is_relative(), std::env::current_dir()) {
            (true, Ok(cwd)) if cwd.join(&source).is_file() => cwd.join(source),
            (true, _) => root.join(source),
            (false, _) => source,
        };
        if let Some(dir) = source.parent() {
            let path = dir.join(file);
            if path.is_file() {
                return Ok(path);
            }
            return err(span, format!("{file} belongs next to this source file, and {} does not exist", path.display()));
        }
    }
    let mut found = Vec::new();
    find(&root.join("src"), file, &mut found);
    match found.len() {
        1 => Ok(found.pop().expect("one")),
        0 => err(span, format!("{file} belongs next to this source file, and there is none")),
        _ => err(span, format!("several files are named {file}; the compiler gave no source path to choose one")),
    }
}

fn find(dir: &Path, file: &str, found: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            find(&path, file, found);
        } else if path.file_name().is_some_and(|n| n == file) {
            found.push(path);
        }
    }
}

/// A component's stylesheet, read and scoped, and what the macro generates from it.
pub struct Css {
    /// `offer-list`.
    pub prefix: String,
    /// `offer_list.css`.
    pub file: String,
    pub path: PathBuf,
    pub sheet: Sheet,
    /// The constant for each class, in the order of `sheet.classes`.
    pub idents: Vec<String>,
    /// The constant for each custom property markup can set (`FILL` for `--fill`), with its
    /// scoped name and its type.
    pub vars: Vec<(String, String, &'static str)>,
}

impl Css {
    pub fn read(owner: &Ident, span: Span) -> Result<Css, Error> {
        let file = format!("{}.css", crate::names::snake(&owner.to_string()));
        Css::read_at(owner, locate(&file, span)?, span)
    }

    /// The stylesheet at `path`, which its owner's module gave (see `items`).
    pub fn read_at(owner: &Ident, path: PathBuf, span: Span) -> Result<Css, Error> {
        let name = owner.to_string();
        let prefix = crate::names::kebab(&name);
        let file = format!("{}.css", crate::names::snake(&name));
        let text = std::fs::read_to_string(&path).map_err(|e| (span, format!("cannot read {}: {e}", path.display())))?;
        let sheet = scope(&text, &prefix).map_err(|e| (span, format!("{file}, {e}")))?;
        let mut idents: Vec<String> = Vec::with_capacity(sheet.classes.len());
        for class in &sheet.classes {
            let ident = class_ident(class).map_err(|e| (span, format!("{file}: {e}")))?;
            if let Some(i) = idents.iter().position(|other| *other == ident) {
                return err(span, format!("{file}: .{} and .{class} are both {ident} in Rust; rename one", sheet.classes[i]));
            }
            idents.push(ident);
        }
        let mut vars: Vec<(String, String, &'static str)> = Vec::new();
        for (name, kind) in &sheet.properties {
            let Some(kind) = kind else { continue };
            let ident = var_ident(name).map_err(|e| (span, format!("{file}: {e}")))?;
            if let Some(i) = idents.iter().position(|other| *other == ident) {
                return err(span, format!("{file}: .{} and --{name} are both {ident} in Rust; rename one", sheet.classes[i]));
            }
            if let Some((other, ..)) = vars.iter().find(|(other, ..)| *other == ident) {
                return err(span, format!("{file}: two custom properties are both {other} in Rust; rename one"));
            }
            vars.push((ident, format!("--{prefix}__{name}"), kind));
        }
        Ok(Css { prefix, file, path, sheet, idents, vars })
    }

    fn scoped(&self, class: &str) -> String {
        format!("{}__{class}", self.prefix)
    }

    fn class_for(&self, ident: &str) -> Option<&str> {
        self.idents.iter().position(|i| i == ident).map(|i| self.sheet.classes[i].as_str())
    }

    fn unknown(&self, ident: &Ident) -> Error {
        let list = self.idents.join(", ");
        (ident.span(), format!("{} has no class {ident}; its classes are {list}", self.file))
    }

    /// The module of class constants, named after the stylesheet's owner. Its constants are
    /// not `allow(dead_code)`: a class no component of the file uses is a warning.
    pub fn items(&self, owner: &Ident) -> TokenStream {
        let mut consts = q("const _: &str = ::core::include_str!(__A0);", &[literal(&self.path.display().to_string())]);
        for (class, ident) in self.sheet.classes.iter().zip(&self.idents) {
            // With the owner's span (not the macro's), rustc reports an unused class as dead code.
            consts.extend(respan(
                q(
                    "pub const __A0: ::corten::style::Class = ::corten::style::Class::__new(__A1);",
                    &[TokenTree::Ident(Ident::new(ident, owner.span())).into(), literal(&self.scoped(class))],
                ),
                owner.span(),
            ));
        }
        // A custom property markup can set: `style={FILL.pct(42.0)}`. One no markup sets is not an
        // error: a stylesheet registers a property to animate it too.
        for (ident, name, kind) in &self.vars {
            consts.extend(respan(
                q(
                    "#[allow(dead_code)] pub const __A0: ::corten::style::Var<::corten::style::syntax::__A1> = ::corten::style::Var::__new(__A2);",
                    &[
                        TokenTree::Ident(Ident::new(ident, owner.span())).into(),
                        TokenTree::Ident(Ident::new(kind, owner.span())).into(),
                        literal(name),
                    ],
                ),
                owner.span(),
            ));
        }
        // `css = path::Owner` in any module calls this macro, which calls `#[component]` again with
        // the sheet's path first: only the owner knows where its stylesheet is. The module is
        // `pub(crate)`, so Rust's visibility of the owner's module decides who shares the sheet.
        consts.extend(q(
            "#[allow(unused_macros)]
            macro_rules! __corten_sheet {
                ([$($corten_args:tt)*] $($corten_item:tt)*) => {
                    #[::corten::component(@ __A0, $($corten_args)*)] $($corten_item)*
                };
            }
            #[allow(unused_imports)]
            pub(crate) use __corten_sheet;",
            &[literal(&self.path.display().to_string())],
        ));
        q(
            "#[doc(hidden)] #[allow(non_snake_case, non_upper_case_globals)] pub(crate) mod __A0 { __A1 }",
            &[TokenTree::Ident(module(owner)).into(), consts],
        )
    }

    /// Statements at the start of `render`: the owner's constants in scope, and a use of each
    /// class the markup printed as static text (so they count as used).
    pub fn scope(&self, path: &TokenStream, owner: &Ident, used: &[Ident]) -> TokenStream {
        let mut module_path = path.clone();
        module_path.extend([TokenTree::Ident(module(owner))]);
        let mut out = q("#[allow(unused_imports)] use __A0::*;", &[module_path]);
        if !used.is_empty() {
            let mut list = TokenStream::new();
            for ident in used {
                list.extend([TokenTree::Ident(ident.clone())]);
                list.extend(q(",", &[]));
            }
            out.extend(q("let _ = (__A0);", &[list]));
        }
        out
    }

    /// `::corten::style::Style { .. }`.
    pub fn style(&self) -> TokenStream {
        let mut classes = TokenStream::new();
        for class in &self.sheet.classes {
            classes.extend(literal(class));
            classes.extend(q(",", &[]));
        }
        let mut media = TokenStream::new();
        for (at, name) in &self.sheet.media {
            media.extend(q("(__A0, __A1),", &[TokenTree::from(Literal::usize_unsuffixed(*at)).into(), literal(name)]));
        }
        q(
            "::corten::style::Style { name: __A0, file: __A1, css: __A2, classes: &[__A3], media: &[__A4], breakpoints: &[] }",
            &[literal(&self.prefix), literal(&self.file), literal(&self.sheet.css), classes, media],
        )
    }

    /// The component's markup with `class={Title}` and `class={[Title, Active]}` as static
    /// markup, after checking every class it names (and that no class of the file is written as
    /// text). The names printed as text go in `used`.
    pub fn rewrite(&self, tokens: TokenStream, markup: bool, used: &mut Vec<Ident>) -> Result<TokenStream, Error> {
        let tokens: Vec<TokenTree> = tokens.into_iter().collect();
        let mut out: Vec<TokenTree> = Vec::with_capacity(tokens.len());
        let mut tag = String::new();
        let mut i = 0;
        while i < tokens.len() {
            match &tokens[i] {
                TokenTree::Ident(id) if !markup && id.to_string() == "html" && is_punct(tokens.get(i + 1), '!') => {
                    if let Some(TokenTree::Group(g)) = tokens.get(i + 2) {
                        out.extend(tokens[i..i + 2].iter().cloned());
                        out.push(regroup(g, self.rewrite(g.stream(), true, used)?));
                        i += 3;
                        continue;
                    }
                }
                TokenTree::Group(g) => {
                    out.push(regroup(g, self.rewrite(g.stream(), markup, used)?));
                    i += 1;
                    continue;
                }
                TokenTree::Punct(p) if markup && p.as_char() == '<' => {
                    tag = match tokens.get(i + 1) {
                        Some(TokenTree::Ident(name)) if !is_punct(tokens.get(i + 2), ':') => name.to_string(),
                        _ => String::new(),
                    };
                }
                TokenTree::Ident(id)
                    if markup
                        && id.to_string() == "class"
                        && is_punct(tokens.get(i + 1), '=')
                        && !is_punct(tokens.get(i + 2), '=')
                        && !(i > 0 && (is_ident(tokens.get(i - 1), "let") || is_ident(tokens.get(i - 1), "mut")))
                        && tag.starts_with(|c: char| c.is_ascii_lowercase()) =>
                {
                    out.extend(tokens[i..i + 2].iter().cloned());
                    if let Some(value) = tokens.get(i + 2) {
                        out.push(self.value(value, used)?);
                    }
                    i += 3;
                    continue;
                }
                _ => {}
            }
            out.push(tokens[i].clone());
            i += 1;
        }
        Ok(out.into_iter().collect())
    }

    fn value(&self, value: &TokenTree, used: &mut Vec<Ident>) -> Result<TokenTree, Error> {
        let mut names = |idents: &[&Ident]| -> Result<TokenTree, Error> {
            let mut text = String::new();
            for ident in idents {
                let class = self.class_for(&ident.to_string()).ok_or_else(|| self.unknown(ident))?;
                used.push((*ident).clone());
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(&self.scoped(class));
            }
            let mut lit = Literal::string(&text);
            lit.set_span(idents[0].span());
            Ok(TokenTree::Literal(lit))
        };
        let camel =
            |t: &TokenTree| matches!(t, TokenTree::Ident(id) if id.to_string().starts_with(|c: char| c.is_ascii_uppercase()));
        match value {
            TokenTree::Literal(lit) => {
                self.not_text(lit)?;
                Ok(value.clone())
            }
            TokenTree::Ident(id) if camel(value) => names(&[id]),
            TokenTree::Group(g) if g.delimiter() == Delimiter::Brace => {
                let inner: Vec<TokenTree> = g.stream().into_iter().collect();
                match inner.as_slice() {
                    [TokenTree::Ident(id)] if camel(&inner[0]) => names(&[id]),
                    [TokenTree::Literal(lit)] => {
                        self.not_text(lit)?;
                        Ok(value.clone())
                    }
                    [TokenTree::Group(list)] if list.delimiter() == Delimiter::Bracket => {
                        let items: Vec<TokenTree> = list.stream().into_iter().collect();
                        let idents: Vec<&Ident> = items
                            .iter()
                            .enumerate()
                            .filter_map(|(n, t)| match t {
                                TokenTree::Ident(id) if n % 2 == 0 => Some(id),
                                _ => None,
                            })
                            .collect();
                        let plain = !items.is_empty()
                            && items.iter().enumerate().all(|(n, t)| if n % 2 == 0 { camel(t) } else { is_punct(Some(t), ',') });
                        if plain {
                            names(&idents)
                        } else {
                            Ok(regroup(g, self.rewrite(g.stream(), false, used)?))
                        }
                    }
                    _ => Ok(regroup(g, self.rewrite(g.stream(), false, used)?)),
                }
            }
            other => Ok(other.clone()),
        }
    }

    /// An error when text names a class of the file, which the scoped rule would not match.
    fn not_text(&self, lit: &Literal) -> Result<(), Error> {
        let Some(text) = string_value(lit) else { return Ok(()) };
        for word in text.split_ascii_whitespace() {
            if let Some(i) = self.sheet.classes.iter().position(|c| c == word) {
                return err(
                    lit.span(),
                    format!(
                        "\"{word}\" is a class of {}: write class={{{}}}, which is scoped to this component",
                        self.file, self.idents[i]
                    ),
                );
            }
        }
        Ok(())
    }
}

fn respan(tokens: TokenStream, span: Span) -> TokenStream {
    tokens
        .into_iter()
        .map(|mut token| {
            if let TokenTree::Group(g) = &token {
                let mut copy = Group::new(g.delimiter(), respan(g.stream(), span));
                copy.set_span(span);
                return TokenTree::Group(copy);
            }
            token.set_span(span);
            token
        })
        .collect()
}

/// `__corten_css_OfferList`: the class constants of `OfferList`'s stylesheet.
pub fn module(owner: &Ident) -> Ident {
    Ident::new(&format!("__corten_css_{owner}"), owner.span())
}

fn regroup(g: &Group, stream: TokenStream) -> TokenTree {
    let mut copy = Group::new(g.delimiter(), stream);
    copy.set_span(g.span());
    TokenTree::Group(copy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn position_options_are_component_local() {
        let css = ".popup { position-try-fallbacks: --below flip-inline, --global; position-try: most-width --below; position-anchor: --below; --below: 2px; width: var(--below) } @position-try --below { position-area: block-end; margin: 2px }";
        let sheet = scope(css, "menu").unwrap();
        assert_eq!(sheet.css, ".menu__popup{position-try-fallbacks:--menu__below flip-inline, --global;position-try:most-width --menu__below;position-anchor:--below;--below:2px;width:var(--below)}@position-try --menu__below{position-area:block-end;margin:2px}");
        assert!(scope(css, "other").unwrap().css.contains("@position-try --other__below"));
        let nested = scope("@supports (position-area: top) { @POSITION-TRY --below { top: anchor(bottom); width: anchor-size(width) } .a { @media (width > 10px) { POSITION-TRY: var(--below, --b\\65 low) !important; content: '--below'; } } } @position-try --below { position-area: top }", "x").unwrap();
        assert_eq!(nested.css, "@supports (position-area: top){@POSITION-TRY --x__below{top:anchor(bottom);width:anchor-size(width)}.x__a{@media (width > 10px){POSITION-TRY:var(--below, --x__below) !important;content:'--below'}}}@position-try --x__below{position-area:top}");
        assert!(nested.properties.is_empty(), "position options are not custom properties for markup");
        let same = scope("@property --above { syntax: '*'; inherits: false } @position-try --above { position-area: top } .a { position-try: var(--above, --above); position-try-fallbacks: --above-extra, --Above, --above; content: '--above'; background: url(--above.svg) }", "x").unwrap();
        assert!(same.css.contains("position-try:var(--x__above, --x__above)"));
        assert!(same.css.contains("position-try-fallbacks:--above-extra, --Above, --x__above"));
        assert!(same.css.contains("content:'--above';background:url(--above.svg)"));
        let functions = scope("@position-try --above { top: 0 } .a { position-try: v\\61r(--above, --above); position-try-fallbacks: env(--above, --above), attr(--above), u\\72l(--above); }", "x").unwrap();
        assert!(functions.css.contains("v\\61r(--above, --x__above)"));
        assert!(functions.css.contains("env(--above, --x__above), attr(--above), u\\72l(--above)"));
        let escaped = scope("@position-try --above { top: 0 } .a { position-try: \\2d \\2d above; position-try-fallbacks: var(--above, \\-\\-above) }", "x").unwrap();
        assert!(escaped.css.contains("position-try:--x__above;position-try-fallbacks:var(--above, --x__above)"));
        assert_eq!(
            scope("@position-try --md { position-area: top } @media (--md) { .a { position-try: --md } }", "x").unwrap().media[0]
                .1,
            "md"
        );
        for (css, why) in [
            ("@position-try below { top: 0 }", "starts with --"),
            ("@position-try --a__b { top: 0 }", "__ separates"),
            (".a { @position-try --b { top: 0 } }", "outside any rule"),
        ] {
            assert!(scope(css, "x").unwrap_err().contains(why), "{css}");
        }
    }

    #[test]
    fn position_references_are_whole_css_tokens() {
        // A hex escape takes one whitespace; the next one still separates the tactic.
        for (space, separator) in [
            ("  ", " "),
            ("\r\n ", " "),
            ("\t\t", "\t"),
            ("\n\n", "\n"),
            (" /* a */ ", "/* a */ "),
            ("/**/", "/**/"),
            ("/*comment*/ ", "/*comment*/ "),
        ] {
            let css = format!("@position-try --above {{ top: 0 }} .a {{ position-try-fallbacks: --abov\\65{space}flip-block; position-try: most-width --abov\\65{space}flip-inline }}");
            assert_eq!(
                scope(&css, "x").unwrap().css,
                format!("@position-try --x__above{{top:0}}.x__a{{position-try-fallbacks:--x__above{separator}flip-block;position-try:most-width --x__above{separator}flip-inline}}"),
                "{space:?}"
            );
        }
        assert_eq!(
            scope(".a { position-try-fallbacks: --abov\\65\r\n\tflip-block }", "x").unwrap().css,
            ".x__a{position-try-fallbacks:--abov\\65 flip-block}"
        );
        // A no-break space is not CSS whitespace: `--above\u{a0}flip-block` is one name.
        assert_eq!(
            scope("@position-try --above { top: 0 } .a { position-try-fallbacks: --above\u{a0}flip-block, --abov\\65\u{a0}, --above }", "x").unwrap().css,
            "@position-try --x__above{top:0}.x__a{position-try-fallbacks:--above\u{a0}flip-block, --abov\\65\u{a0}, --x__above}"
        );
        // `--above()` calls a custom function, whose name is not a position option's.
        assert_eq!(
            scope("@position-try --above { top: 0 } .a { position-try: --above(); position-try-fallbacks: --abov\\65(), \\2d \\2d above(1), --above }", "x").unwrap().css,
            "@position-try --x__above{top:0}.x__a{position-try:--above();position-try-fallbacks:--abov\\65(), \\2d \\2d above(1), --x__above}"
        );
        // An `if()` condition queries a custom property; only its branches' values are options.
        let conditional = scope("@position-try --above { top: 0 } .a { position-try: if(style(--above: 1): --above; else: flip-block); position-try-fallbacks: i\\66(st\\79le(--above: 1): --above; else: flip-block), var(--choice, if(style(--above: 2): if(style(--above: 3): --above; else: flip-inline); else: --above)), inherit(--above, --above), anchor(--above top), --above }", "x").unwrap();
        assert_eq!(
            conditional.css,
            "@position-try --x__above{top:0}.x__a{position-try:if(style(--above: 1): --x__above; else: flip-block);position-try-fallbacks:i\\66(st\\79le(--above: 1): --x__above; else: flip-block), var(--choice, if(style(--above: 2): if(style(--above: 3): --x__above; else: flip-inline); else: --x__above)), inherit(--above, --x__above), anchor(--above top), --x__above}"
        );
    }

    #[test]
    fn shared_selector_parsing_is_unchanged_by_position_options() {
        for (source, scoped) in [
            (".a:not(.--foreign)", ".x__a:not(.--foreign)"),
            (".a:is(./**/local,body)", ".x__a:is(. local,body)"),
            (".a:is(.é,.b)", ".x__a:is(.é,.x__b)"),
            (".a:is(.--a,.a)", ".x__a:is(.--a,.x__a)"),
        ] {
            let sheet = scope(&format!("{source}{{color:green}}"), "x").unwrap();
            assert_eq!(sheet.css, format!("{scoped}{{color:green}}"));
        }
        assert_eq!(
            scope("@scope (.a:is(:/* gap */:marker,.b)){.a p{color:green}}", "x").unwrap().css,
            "@scope (.x__a:is(: :marker,.x__b)){.x__a p{color:green}}"
        );
        assert!(scope("@LAYER_other foo; .a{color:green}", "x").unwrap_err().contains("@layer_other is not supported"));
        assert_eq!(scope("@layer_other foo; .a{color:green}", "x").unwrap().css, ".x__a{color:green}");
    }

    #[test]
    fn at_rules_match_the_documented_inventory() {
        let mut accepted: Vec<&str> =
            GROUP_AT_RULES.iter().chain(RAW_AT_RULES).copied().chain(["scope", "position-try"]).collect();
        accepted.sort_unstable();
        let design = include_str!("../../../docs/design.md")
            .split("id=\"limit-stylesheet-support\"")
            .nth(1)
            .unwrap()
            .split("10. <a")
            .next()
            .unwrap();
        let guide =
            include_str!("../../../docs/guide/styles.md").split("## At-rules").nth(1).unwrap().split("## Motion").next().unwrap();
        for doc in [design, guide] {
            let mut documented = Vec::new();
            for line in doc.lines().filter(|line| line.starts_with("| `@")) {
                let names = line.split('|').nth(1).unwrap();
                documented.extend(names.split('`').filter_map(|word| word.strip_prefix('@')));
            }
            documented.sort_unstable();
            assert_eq!(documented, accepted, "the block at-rule table must match the parser");
            for name in ["@charset", "@import", "@custom-media", "@namespace", "@document"] {
                assert!(doc.contains(name), "missing statement or refusal: {name}");
            }
        }
        for name in GROUP_AT_RULES {
            let sheet = scope(&format!("@{} screen {{ .a {{ color: red }} }}", name.to_ascii_uppercase()), "x").unwrap();
            assert_eq!(sheet.classes, ["a"]);
            assert!(scope(&format!("@{name} screen {{ body {{ color: red }} }}"), "x").is_err());
        }
        for (name, prelude, body) in [
            ("keyframes", "spin", "from { opacity: 0 }"),
            ("font-face", "", "font-family: test"),
            ("counter-style", "bullets", "system: cyclic; symbols: 'x'"),
            ("font-palette-values", "--ink", "font-family: Test; base-palette: 0"),
            ("font-feature-values", "Test", "@styleset { fancy: 1 }"),
            ("page", "x-slip", "@top-left { content: 'x' }"),
        ] {
            let sheet = scope(&format!("@{name} {prelude} {{ {body} }}"), "x").unwrap();
            assert!(sheet.classes.is_empty(), "{name} contents are raw");
            assert!(sheet.css.starts_with(format!("@{name} {prelude}").trim()));
        }
        assert_eq!(scope("@CHARSET 'utf-8'; @LAYER base, widgets;", "x").unwrap().css, "@LAYER base, widgets;");
        for name in ["import", "IMPORT", "custom-media", "CUSTOM-MEDIA", "namespace", "document", "unknown"] {
            assert!(scope(&format!("@{name} x;"), "x").is_err(), "{name}");
        }
        for name in ["document", "unknown"] {
            assert!(scope(&format!("@{name} x {{ .a {{ color: red }} }}"), "x").unwrap_err().contains("does not know how"));
        }
    }

    #[test]
    fn refused_at_rule_doctests_fail_for_their_reasons() {
        for (css, prefix, why) in [
            (include_str!("../../corten/src/imported_styles.css"), "imported-styles", "does not own"),
            (include_str!("../../corten/src/custom_media_styles.css"), "custom-media-styles", "token file's breakpoints"),
            (include_str!("../../corten/src/namespaced_styles.css"), "namespaced-styles", "does not know how"),
            (include_str!("../../corten/src/document_styles.css"), "document-styles", "does not know how"),
            (include_str!("../../corten/src/unnamed_page.css"), "unnamed-page", "with no name"),
            (include_str!("../../corten/src/global_page.css"), "global-page", "start it with this component's"),
            (include_str!("../../corten/src/nested_property.css"), "nested-property", "outside any rule"),
            (include_str!("../../corten/src/nested_position.css"), "nested-position", "outside any rule"),
            (include_str!("../../corten/src/invalid_position.css"), "invalid-position", "starts with --"),
            (include_str!("../../corten/src/reserved_position.css"), "reserved-position", "__ separates"),
        ] {
            let error = scope(css, prefix).unwrap_err();
            assert!(error.contains(why), "{prefix}: {error}");
        }
    }

    #[test]
    fn classes_are_prefixed_and_rules_stay_inside_the_component() {
        // (A breakpoint of the token file, named in an @media rule: written one way, and recorded
        // where it is, for the app to write the width in.)
        let sheet = scope("@media not ( --sm ) { .a { gap: 1px } }\n.b { content: \"@media (--x)\" }\n.c { & { @media (--md) and (pointer: coarse) { gap: 0 } } }", "t").unwrap();
        assert_eq!(
            sheet.css,
            "@media not (--sm){.t__a{gap:1px}}.t__b{content:\"@media (--x)\"}.t__c{&{@media (--md) and (pointer: coarse){gap:0}}}"
        );
        let at: Vec<(&str, &str)> =
            sheet.media.iter().map(|(at, name)| (&sheet.css[*at..*at + name.len() + 4], name.as_str())).collect();
        assert_eq!(at, [("(--sm)", "sm"), ("(--md)", "md")]);
        assert!(scope("@media (--) { .a { gap: 0 } }", "t").unwrap_err().contains("named alone in its parentheses"));
        assert!(scope("@media (--sm and (hover)) { .a { gap: 0 } }", "t").unwrap_err().contains("named alone"));
        for never in ["Sm", "sm_wide", "2col", "sm-"] {
            let error = scope(&format!("@media (--{never}) {{ .a {{ gap: 0 }} }}"), "t").unwrap_err();
            assert!(error.contains("so no token file makes this one"), "{never}: {error}");
        }
        assert!(scope("@custom-media --phone (width < 40rem);", "t").unwrap_err().contains("names the token file's breakpoints"));
        assert!(scope(
            "@property --sm { syntax: '<length>'; inherits: false; initial-value: 0px }\n@media (--sm) { .a { width: var(--sm) } }",
            "t"
        )
        .unwrap_err()
        .contains("is this stylesheet's @property"));
        let css = "/* list */\n.list { gap: 8px; }\n.list > .row:hover, .row.is-on { color: var(--ink) }\n@media (min-width: 40rem) { .list { gap: 1.5rem } }\n.title { & span { font-weight: 700 } h2 & { margin: 0 } }\n@keyframes spin { from { rotate: 0 } to { rotate: 1turn } }\n.img { background: url(\"a.b.png\") }\n.x[data-tone=\".y\"] { opacity: .5 }";
        let sheet = scope(css, "offer-list").unwrap();
        assert_eq!(
            sheet.css,
            ".offer-list__list{gap:8px}.offer-list__list > .offer-list__row:hover, .offer-list__row.offer-list__is-on{color:var(--ink)}@media (min-width: 40rem){.offer-list__list{gap:1.5rem}}.offer-list__title{& span{font-weight:700}h2 &{margin:0}}@keyframes spin{from{rotate:0}to{rotate:1turn}}.offer-list__img{background:url(\"a.b.png\")}.offer-list__x[data-tone=\".y\"]{opacity:.5}"
        );
        assert_eq!(sheet.classes, ["list", "row", "is-on", "title", "img", "x"]);
        assert!(scope("h2 { margin: 0 }", "x").unwrap_err().contains("`h2` styles elements this component does not own"));
        assert!(scope(".a, h2 { margin: 0 }", "x").unwrap_err().contains("line 1"));
        assert!(scope("@media print { body { margin: 0 } }", "x").is_err(), "at-rules do not unscope");
        let print = scope(
            "@page x-slip { size: 4in 6in; margin: 0 }\n.slip { page: x-slip }\n@media print { .bar { display: none } }",
            "x",
        );
        assert_eq!(
            print.map(|s| s.css),
            Ok("@page x-slip{size:4in 6in;margin:0}.x__slip{page:x-slip}@media print{.x__bar{display:none}}".to_string()),
            "a page named after the component; print rules are scoped"
        );
        assert!(scope("@page { margin: 0 }", "x").unwrap_err().contains("with no name"));
        assert!(scope("@page :first { margin: 0 }", "x").unwrap_err().contains("with no name"));
        assert!(scope("@page slip { margin: 0 }", "x").unwrap_err().contains("@page x-slip"));
        assert!(scope("@page x-slip:first { margin: 0 }", "x").is_ok());
        assert!(scope("\n\n@import \"x.css\";", "x").unwrap_err().starts_with("line 3: @import"));
        assert!(scope(".a { color: red", "x").unwrap_err().contains("never closed"));
        assert!(scope(".a__b { color: red }", "x").is_err());
    }

    #[test]
    fn a_scope_rule_s_root_and_limit_are_the_component_s_classes() {
        // CSS Cascade 6: `@scope (<scope-start>) to (<scope-end>)`, each a selector list.
        let sheet = scope("@scope (.list) to (.slot) { .title { color: red } }", "t").unwrap();
        assert_eq!(sheet.css, "@scope (.t__list) to (.t__slot){.t__title{color:red}}");
        assert_eq!(sheet.classes, ["list", "slot", "title"]);
        // Its rules match only under the root, so they start anywhere: `:scope`, `&`, an element,
        // a combinator, or declarations, which apply to the root.
        let sheet = scope(
            "@SCOPE ( .card ) TO ( :scope > .body > * ) {\n  gap: 1px;\n  :scope { padding: 0 }\n  & > img { width: 100% }\n  p { margin: 0 }\n  > .body { gap: 2px }\n}",
            "t",
        )
        .unwrap();
        assert_eq!(
            sheet.css,
            "@scope (.t__card) to (:scope > .t__body > *){gap:1px;:scope{padding:0}& > img{width:100%}p{margin:0}> .t__body{gap:2px}}"
        );
        assert_eq!(sheet.classes, ["card", "body"]);
        // Nested in a style rule, `&` in the root is the rule's elements; nested in another
        // `@scope`, the root is relative to the outer one.
        assert_eq!(
            scope(".card { @scope (& > .body) to (.slot) { p { margin: 0 } } }", "t").unwrap().css,
            ".t__card{@scope (& > .t__body) to (.t__slot){p{margin:0}}}"
        );
        assert_eq!(
            scope("@scope (.a) { @scope (:scope > .b) to (:scope .c) { :scope .d { color: red } } }", "t").unwrap().css,
            "@scope (.t__a){@scope (:scope > .t__b) to (:scope .t__c){:scope .t__d{color:red}}}"
        );
        assert_eq!(
            scope("@media print { @scope (.a) { p { margin: 0 } } }", "t").unwrap().css,
            "@media print{@scope (.t__a){p{margin:0}}}"
        );
        let error = |css: &str| scope(css, "t").unwrap_err();
        // A root at the top of the file that names none of its classes matches elements outside
        // the component, so each rule inside starts at one of them, as at the top of the file.
        assert_eq!(
            scope("@scope ([data-theme=\"dark\"]) { .title { color: plum } }", "t").unwrap().css,
            "@scope ([data-theme=\"dark\"]){.t__title{color:plum}}"
        );
        assert_eq!(
            scope("@scope (main) to (.slot) { .list p { margin: 0 } @scope (.card) { p { margin: 0 } } }", "t").unwrap().css,
            "@scope (main) to (.t__slot){.t__list p{margin:0}@scope (.t__card){p{margin:0}}}"
        );
        let outside = "`@scope ([data-theme=\"dark\"])` can start outside the component";
        for (css, part) in [
            (":scope { color: plum }", ":scope"),
            ("& > p { margin: 0 }", "& > p"),
            ("> p { margin: 0 }", "> p"),
            ("p { margin: 0 }", "p"),
            ("@media print { p { margin: 0 } }", "p"),
            ("@scope (div) { :scope { margin: 0 } }", ":scope"),
        ] {
            let message = error(&format!("@scope ([data-theme=\"dark\"]) {{ {css} }}"));
            assert!(message.contains(&format!("`{part}` styles elements this component does not own")), "{message}");
            if !css.starts_with("@scope") {
                assert!(message.contains(outside), "{message}");
            }
        }
        assert!(error("@scope (div) { color: plum }")
            .contains("styles the root of `@scope (div)`, which can be outside the component"));
        assert!(error("@scope (.a, main) to (.b) { p { margin: 0 } }").contains("`@scope (.a, main)` can start outside"));
        assert!(error("@media print { @scope (main) { p { margin: 0 } } }").contains("`@scope (main)` can start outside"));
        assert!(!error("@scope (main) { } p { margin: 0 }").contains("can start outside"), "the root's rules end with it");
        // Name-defining at-rules in an `@scope` are valid and not scoped (CSS Cascade 6); in a
        // style rule the browser ignores an `@property`.
        for root in [".a", "main"] {
            let sheet = scope(
                &format!("@scope ({root}) {{ @property --fill {{ syntax: '*'; inherits: false }} .b {{ width: var(--fill) }} }}"),
                "t",
            )
            .unwrap();
            let root = if root == ".a" { ".t__a" } else { root };
            assert_eq!(
                sheet.css,
                format!("@scope ({root}){{@property --t__fill{{syntax:'*';inherits:false}}.t__b{{width:var(--t__fill)}}}}")
            );
            assert_eq!(sheet.properties, [("fill".to_string(), None)]);
        }
        assert!(error(".a { @scope (.b) { @property --fill { syntax: '*'; inherits: false } } }").contains("outside any rule"));
        // With no root, the scope is the element around the stylesheet's link, in a style rule too.
        for css in ["@scope { p { margin: 0 } }", "@scope to (.b) { p { margin: 0 } }", ".a { @scope { p { margin: 0 } } }"] {
            assert!(error(css).contains("@scope with no root"), "{css}");
        }
        // A prelude the browser does not read drops the rule.
        for css in [
            "@scope () { p { margin: 0 } }",
            "@scope (.a) to () { p { margin: 0 } }",
            "@scope (.a) to(.b) { p { margin: 0 } }",
            "@scope (.a) (.b) { p { margin: 0 } }",
            "@scope .a { p { margin: 0 } }",
        ] {
            assert!(error(css).contains("write `@scope (.list)` or `@scope (.list) to (.slot)`"), "{css}");
        }
        for css in ["@scope (.a::before) { p { margin: 0 } }", "@scope (.a) to (.b:after) { p { margin: 0 } }"] {
            assert!(error(css).contains("a pseudo-element cannot be"), "{css}");
        }
        assert!(scope("@scope (.a[title=\"x::y\"]) { p { margin: 0 } }", "t").is_ok(), "an attribute's value is text");
    }

    #[test]
    fn the_compile_fail_scope_examples_fail_for_their_reasons() {
        for (file, reason) in [
            (
                "leaky_scope.css",
                "`li` styles elements this component does not own: `@scope (main)` can start outside the component",
            ),
            ("rootless_scope.css", "@scope with no root"),
        ] {
            let text = std::fs::read_to_string(Path::new("../corten/src").join(file)).expect("the example's stylesheet");
            let error = scope(&text, "x").expect_err("an error");
            assert!(error.contains(reason), "{file}: {error}");
        }
    }

    #[test]
    fn a_merge_conflict_s_markers_are_refused_outside_comments_and_strings() {
        let conflict = ".a { color: red }\n<<<<<<< this copy\n.b { color: blue }\n=======\n.b { color: green }\n>>>>>>> the kit\n.c { color: red }";
        assert!(scope(conflict, "x").unwrap_err().starts_with("line 2: a merge conflict's marker"));
        assert_eq!(conflict_marker(".a { color: red }\r\n=======\r\n"), Some(2));
        assert_eq!(conflict_marker(".a { color: red }\n>>>>>>>"), Some(2));
        assert_eq!(conflict_marker("/*\n=======\n*/\n.a { color: red }"), None, "a separator in a comment");
        assert_eq!(conflict_marker(".a::after { content: \"\\\n=======\" }"), None, "in a string");
        assert_eq!(conflict_marker(".a::after { content: \"\\\r\n=======\" }"), None, "in a string continued past a CRLF");
        assert!(scope(".a::after { content: \"a\\\r\nb\" }", "x").is_ok(), "the scoper reads it as one string too");
        assert_eq!(conflict_marker("========\n"), None, "eight is not a marker");
        assert_eq!(conflict_marker(".a { color: red }\n.b{x:1} <<<<<<< y"), None, "only at a line's start");
        assert!(scope("/* ======= */\n.a { color: red }", "x").is_ok());
    }

    #[test]
    fn a_registered_property_is_the_component_s_and_its_syntax_types_it() {
        let css = "@property --fill { syntax: '<percentage>'; inherits: false; initial-value: 0% }\n@property --hue { syntax: \"<color>\"; inherits: true; initial-value: red }\n.bar { width: var(--fill); color: var(--hue); --fill-x: 1; transition: --fill 1s; content: \"--fill\"; margin: var(--space-fill) }\n@keyframes grow { to { --fill: 100% } }";
        let sheet = scope(css, "meter").unwrap();
        assert_eq!(
            sheet.css,
            "@property --meter__fill{syntax:'<percentage>';inherits:false;initial-value:0%}@property --meter__hue{syntax:\"<color>\";inherits:true;initial-value:red}.meter__bar{width:var(--meter__fill);color:var(--meter__hue);--fill-x:1;transition:--meter__fill 1s;content:\"--fill\";margin:var(--space-fill)}@keyframes grow{to{--meter__fill:100%}}"
        );
        assert_eq!(sheet.properties, [("fill".to_string(), Some("Percentage")), ("hue".to_string(), None)]);
        assert_eq!(var_ident("bar-width").unwrap(), "BAR_WIDTH");
        let error = |css: &str| scope(css, "m").unwrap_err();
        assert!(error("@property --a { inherits: false; initial-value: 0 }").contains("needs a syntax"));
        assert!(error("@property --a { syntax: '<number>'; initial-value: 0 }").contains("needs inherits"));
        assert!(error("@property --a { syntax: '<number>'; inherits: false }").contains("needs an initial-value"));
        assert!(scope("@property --a { syntax: '*'; inherits: false }", "m").is_ok(), "* needs no initial value");
        assert!(error("@property --a__b { syntax: '*'; inherits: false }").contains("__ separates"));
        assert!(error("@property fill { syntax: '*'; inherits: false }").contains("starts with --"));
        assert!(error("@property --a { syntax: '*'; inherits: false }\n@property --a { syntax: '*'; inherits: false }")
            .contains("twice"));
        assert!(error("@property --a { syntax: '<percentage>'; inherits: false; initial-value: 0px }")
            .contains("is not a <percentage>"));
        assert!(
            error("@property --a { syntax: '<integer>'; inherits: false; initial-value: 1.5 }").contains("is not a <integer>")
        );
        assert!(error("@property --a { syntax: '<angle>'; inherits: false; initial-value: 0 }").contains("is not a <angle>"));
        assert!(error("@property --a { syntax: <number>; inherits: false; initial-value: 0 }").contains("syntax is a string"));
        assert!(error(".bar { @property --a { syntax: '*'; inherits: false } }").contains("outside any rule"));
        assert!(
            scope("@property --fill { syntax: '*'; inherits: false }\n.a { --probe: xéé(--fill); }", "m").is_ok(),
            "text that is not ASCII"
        );
        for bad in [
            "''",
            "'<not-a-type>'",
            "'<text>'",
            "'<length'",
            "'<transform-list>+'",
            "'inherit'",
            "'<length> |'",
            "'- | <length>'",
            // A keyword starts like an identifier but not with `-` (Chromium drops `-foo` and `--foo`).
            "'--foo | compact'",
            "'-foo | compact'",
            "'-_x'",
            "'a b'",
            "'\\64 efault'",
        ] {
            assert!(
                error(&format!("@property --a {{ syntax: {bad}; inherits: false; initial-value: 0 }}"))
                    .contains("is not a syntax"),
                "{bad}"
            );
        }
        for good in [
            "'*'",
            "'<color>+'",
            "'<length>#'",
            "'auto | <length>'",
            "'small | medium'",
            "'open+'",
            "'é | compact'",
            "'_x'",
            "'\\\\61 b | compact'",
            "'\\61 b | compact'",
            "'\\3c color>'",
            "'<string>+'",
            "'x\\\\2d y'",
            "' auto\t|  <length> '",
        ] {
            assert!(
                scope(&format!("@property --a {{ syntax: {good}; inherits: false; initial-value: x }}"), "m").is_ok(),
                "{good}"
            );
        }
        assert_eq!(
            scope("@PROPERTY --x { SYNTAX: \"<number>\"; INHERITS: false; INITIAL-VALUE: 0 }", "m").unwrap().properties,
            [("x".to_string(), Some("Number"))],
            "at-rule and descriptor names are case-insensitive"
        );
        assert_eq!(
            scope("@property --x { syntax: '\\3c percentage>'; inherits: false; initial-value: 0% }", "m").unwrap().properties,
            [("x".to_string(), Some("Percentage"))],
            "the syntax is read with its escapes decoded, as the browser reads it"
        );
        assert_eq!(
            scope(".a { width: var(--f\\69 ll); height: var(--\\66ill); color: var(--fill\\é); }\n@property --fill { syntax: '*'; inherits: false }", "m").unwrap().css,
            ".m__a{width:var(--m__fill);height:var(--m__fill);color:var(--fill\\é)}@property --m__fill{syntax:'*';inherits:false}",
            "a name written with escapes is the same name to the browser"
        );
        // Markup's values are !important, so the component's own may not be: a rule more specific
        // than the page's style block's would win on a full load and lose after a patch.
        for bad in [".a.b { --fill: 0% !important }", ".a { color: red; --fill: 0% ! IMPORTANT; }"] {
            assert!(
                error(&format!("@property --fill {{ syntax: '<percentage>'; inherits: false; initial-value: 0% }}\n{bad}"))
                    .contains("!important on a property markup sets"),
                "{bad}"
            );
        }
        for good in [
            ".a { --fill: 0%; color: red !important }",
            ".a { width: var(--fill) !important }",
            ".a { --other: 0% !important; transition: --fill 1s }",
            ".a { --fill: 0%; content: '!important' }",
        ] {
            assert!(
                scope(&format!("@property --fill {{ syntax: '<percentage>'; inherits: false; initial-value: 0% }}\n{good}"), "m")
                    .is_ok(),
                "{good}"
            );
        }
        assert!(error("@property --a { syntax: '<number>'; inherits: false; initial-value: 1. }").contains("is not a <number>"));
        assert!(error("@property --a { syntax: '<number>'; inherits: false; initial-value: . }").contains("is not a <number>"));
        assert!(
            error("@property --a { syntax: '<length>'; inherits: false; initial-value: 1.5em }").contains("is not a <length>")
        );
        // The viewport's units, which CSS cannot change (as Chromium, Firefox and WebKit read them).
        for good in ["2vw", "1dvh", "3svmin"] {
            assert!(
                scope(&format!("@property --a {{ syntax: '<length>'; inherits: false; initial-value: {good} }}"), "m").is_ok(),
                "{good}"
            );
        }
        assert!(error("@property --a { syntax: '<length>'; inherits: false; initial-value: 2cqw }").contains("is not a <length>"));
        // A math function is the browser's to check (`calc(1px 2px)` drops the rule), so a number
        // syntax's initial value is written as one value.
        for bad in ["calc(2px * 3)", "calc()", "calc(1px 2px)", "min(1px, 2px)", "CALC(1px)", "calc(1 + 2"] {
            assert!(
                scope(&format!("@property --a {{ syntax: '<length>'; inherits: false; initial-value: {bad} }}"), "m").is_err(),
                "{bad}"
            );
        }
        assert!(error("@property --a { syntax: '<length>'; inherits: false; initial-value: calc(2px * 3) }")
            .contains("write one value"));
        assert!(
            scope("@property --a { syntax: '<color>'; inherits: false; initial-value: rgb(0 0 0) }", "m").is_ok(),
            "another syntax's initial value is the browser's"
        );
        for ok in [
            "'<length>'; initial-value: 0",
            "'<length>'; initial-value: 1.5pt",
            "'<number>'; initial-value: -2e3",
            "'<time>'; initial-value: 150ms",
            "'<color>'; initial-value: red",
        ] {
            assert!(scope(&format!("@property --a {{ syntax: {ok}; inherits: TRUE }}"), "m").is_ok(), "{ok}");
        }
        let url = scope(
            "@property --fill { syntax: '*'; inherits: false }\n.a { background: url(--fill.svg); width: var(--fill) }\n.a[data-kind=--fill] { color: red }",
            "m",
        )
        .unwrap();
        assert!(
            url.css.contains("url(--fill.svg)") && url.css.contains("var(--m__fill)") && url.css.contains("[data-kind=--fill]"),
            "a URL is not a property: {}",
            url.css
        );
    }

    #[test]
    fn class_names_become_rust_names() {
        assert_eq!(class_ident("alert-message").unwrap(), "AlertMessage");
        assert_eq!(class_ident("img").unwrap(), "Img");
        assert_eq!(class_ident("is_on").unwrap(), "IsOn");
        assert!(class_ident("self").is_err());
    }
}
