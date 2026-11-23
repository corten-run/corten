use std::borrow::Cow;

mod syntax {
    corten_macros::__css_syntax!();
}
use syntax::{decoded_name, lexer, literal_lookup, name_is, Kind, Token};

/// Decode static UTF-8 CSS, dropping one leading BOM as part of decoding.
pub(crate) fn stylesheet_text(bytes: &[u8]) -> Option<&str> {
    std::str::from_utf8(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes)).ok()
}

#[cfg(test)]
pub(crate) fn custom_properties(css: &str) -> (Vec<Cow<'_, str>>, Vec<Cow<'_, str>>) {
    Scanner::default().scan(css, true)
}

#[derive(Default)]
pub(crate) struct Scanner {
    tokens: Vec<Token>,
    ends: Vec<usize>,
    blocks: Vec<(usize, u8)>,
    pending: Vec<(usize, usize, Context)>,
}

impl Scanner {
    /// What a sheet declares and, when requested, which literal var() reads have no fallback.
    pub(crate) fn scan<'a>(&mut self, css: &'a str, check_reads: bool) -> (Vec<Cow<'a, str>>, Vec<Cow<'a, str>>) {
        // A literal custom name must include two dashes, unless one is escaped.
        if !css.contains("--") && !css.as_bytes().contains(&b'\\') {
            return (Vec::new(), Vec::new());
        }
        self.tokens.clear();
        self.ends.clear();
        self.blocks.clear();
        let mut invalid_tokens = false;
        let bytes = css.as_bytes();
        for (kind, start, end) in lexer(css) {
            if kind.trivia() {
                continue;
            }
            let i = self.tokens.len();
            self.tokens.push((kind, start, end));
            self.ends.push(usize::MAX);
            match kind {
                Kind::Function => self.blocks.push((i, b')')),
                Kind::Open => self.blocks.push((
                    i,
                    match bytes[start] {
                        b'(' => b')',
                        b'[' => b']',
                        _ => b'}',
                    },
                )),
                Kind::Close if self.blocks.last().is_some_and(|&(_, close)| close == bytes[start]) => {
                    let (open, _) = self.blocks.pop().unwrap();
                    self.ends[open] = i;
                    self.ends[i] = open;
                }
                Kind::Close | Kind::BadString | Kind::BadUrl => {
                    invalid_tokens = true;
                }
                _ => {}
            }
        }
        let mut scan = Scan {
            css,
            tokens: &self.tokens,
            ends: &self.ends,
            invalid_tokens,
            check_reads,
            declared: Vec::new(),
            needed: Vec::new(),
        };
        scan.rules(&mut self.pending);
        (scan.declared, scan.needed)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Context {
    Rules,
    Scope,
    Style,
    Page,
    Descriptors,
}

struct Scan<'a, 't> {
    css: &'a str,
    tokens: &'t [Token],
    /// Matching delimiter for each block boundary, or MAX for an unmatched delimiter.
    ends: &'t [usize],
    invalid_tokens: bool,
    check_reads: bool,
    declared: Vec<Cow<'a, str>>,
    needed: Vec<Cow<'a, str>>,
}

impl<'a> Scan<'a, '_> {
    fn spelling(&self, i: usize) -> &'a str {
        let (_, start, end) = self.tokens[i];
        &self.css[start..end]
    }

    fn kind(&self, i: usize) -> Option<Kind> {
        self.tokens.get(i).map(|token| token.0)
    }

    fn custom_name(&self, i: usize) -> Option<Cow<'a, str>> {
        if self.kind(i) != Some(Kind::Ident) {
            return None;
        }
        let spelling = self.spelling(i);
        if !spelling.starts_with("--") && !spelling.as_bytes().contains(&b'\\') {
            return None;
        }
        let name = decoded_name(spelling);
        name.strip_prefix("--").filter(|name| !name.is_empty())?;
        Some(name)
    }

    fn boundary(&self, mut i: usize, end: usize, brace_in_value: bool) -> usize {
        while i < end {
            match self.tokens[i].0 {
                Kind::Semicolon => break,
                Kind::Open if !brace_in_value && self.spelling(i) == "{" => break,
                Kind::Open | Kind::Function => i = self.ends[i].saturating_add(1),
                _ => i += 1,
            }
        }
        i.min(end)
    }

    fn rules(&mut self, pending: &mut Vec<(usize, usize, Context)>) {
        use Context::*;
        let len = self.tokens.len();
        pending.push((0, len, Rules));
        while let Some((mut i, end, context)) = pending.pop() {
            while i < end {
                let kind = self.tokens[i].0;
                if kind == Kind::Semicolon || (context == Rules && matches!(kind, Kind::Cdo | Kind::Cdc)) {
                    i += 1;
                    continue;
                }
                let declaration = context != Rules && kind == Kind::Ident && self.kind(i + 1) == Some(Kind::Colon);
                let custom = declaration.then(|| self.custom_name(i)).flatten();
                let stop = self.boundary(i, end, custom.is_some());
                if stop < end && self.tokens[stop].0 == Kind::Open {
                    let close = self.ends[stop].min(end);
                    let inner = if kind == Kind::AtKeyword {
                        let name = decoded_name(&self.spelling(i)[1..]);
                        let name = if name.bytes().any(|c| c.is_ascii_uppercase()) {
                            Cow::Owned(name.to_ascii_lowercase())
                        } else {
                            name
                        };
                        if name == "property" {
                            if matches!(context, Rules | Scope) && stop == i + 2 {
                                if let Some(name) = self.custom_name(i + 1) {
                                    self.declared.push(name);
                                }
                            }
                            // initial-value cannot read a custom property: it is independent.
                            None
                        } else {
                            // Only declarations directly in @scope have its implicit style context.
                            let group_context = if context == Scope { Rules } else { context };
                            match name.as_ref() {
                                "scope" if matches!(context, Rules | Scope) => Some(Scope),
                                "scope" if context == Style => Some(Style),
                                "container" => {
                                    if self.check_reads {
                                        self.container_reads(i + 1, stop);
                                    }
                                    Some(group_context)
                                }
                                "media" | "supports" | "layer" | "starting-style" | "document" | "-moz-document" => {
                                    Some(group_context)
                                }
                                "keyframes" | "-webkit-keyframes" => Some(Rules),
                                "page" => Some(Page),
                                name if context == Page && stop == i + 1 && page_margin(name) => Some(Descriptors),
                                "font-face" | "counter-style" | "font-palette-values" | "position-try" => Some(Descriptors),
                                // An unknown at-rule is not a declaration list.
                                _ => None,
                            }
                        }
                    } else if matches!(context, Rules | Scope | Style) && !(declaration && stop == i + 2) {
                        Some(Style)
                    } else {
                        None
                    };
                    i = close + 1;
                    if let Some(inner) = inner {
                        pending.push((i, end, context));
                        pending.push((stop + 1, close, inner));
                        break;
                    }
                } else {
                    if declaration && self.valid_value(i + 2, stop) {
                        if let Some(name) = custom {
                            self.declared.push(name);
                        }
                        if self.check_reads {
                            self.reads(i + 2, stop);
                        }
                    }
                    i = stop + 1;
                }
            }
        }
    }

    /// Look inside parenthesized size features, not general-enclosed functions or other queries.
    fn container_reads(&mut self, mut i: usize, end: usize) {
        while i < end {
            match self.tokens[i].0 {
                Kind::Open if self.spelling(i) == "(" && self.ends[i] < end => {
                    let close = self.ends[i];
                    if self.size_feature(i + 1, close) {
                        if self.valid_value(i + 1, close) {
                            self.reads(i + 1, close);
                        }
                        i = close + 1;
                    } else if self.kind(i + 1) == Some(Kind::Open) && self.spelling(i + 1) == "("
                        || self.kind(i + 1) == Some(Kind::Ident) && name_is(self.spelling(i + 1), "not")
                    {
                        i += 1; // It may group other conditions.
                    } else {
                        i = close + 1;
                    }
                }
                Kind::Open | Kind::Function => i = self.ends[i].saturating_add(1),
                _ => i += 1,
            }
        }
    }

    fn size_feature(&self, start: usize, end: usize) -> bool {
        let colon = start + 1 < end && self.kind(start + 1) == Some(Kind::Colon);
        let mut operand = if colon { start + 2 } else { start };
        let mut i = operand;
        let mut first = None;
        let mut chained = false;
        while i < end {
            match self.tokens[i].0 {
                Kind::Colon | Kind::Semicolon => return false,
                Kind::Delim(op @ (b'<' | b'=' | b'>')) => {
                    if colon || i == operand || chained {
                        return false;
                    }
                    if let Some((_, previous)) = first {
                        if op == b'=' || op != previous || i != operand + 1 || !self.size_name(operand, false) {
                            return false;
                        }
                        chained = true;
                    } else {
                        first = Some((i, op));
                    }
                    let mut next = i + 1;
                    if op != b'=' && next < end && self.kind(next) == Some(Kind::Delim(b'=')) {
                        let gap = &self.css[self.tokens[i].2..self.tokens[next].1];
                        if lexer(gap).any(|(kind, ..)| kind == Kind::Space) {
                            return false;
                        }
                        next += 1;
                    }
                    operand = next;
                    i = next;
                    continue;
                }
                Kind::Function | Kind::Open => i = self.ends[i].min(end),
                _ => {}
            }
            i += 1;
        }
        if operand >= end {
            return false;
        }
        if colon {
            self.size_name(start, true)
        } else if let Some((at, _)) = first {
            chained || (at == start + 1 && self.size_name(start, false)) || (end == operand + 1 && self.size_name(operand, false))
        } else {
            false
        }
    }

    fn size_name(&self, i: usize, colon: bool) -> bool {
        if self.kind(i) != Some(Kind::Ident) {
            return false;
        }
        let name = decoded_name(self.spelling(i)).to_ascii_lowercase();
        if colon && name == "orientation" {
            return true;
        }
        let name = if colon { name.strip_prefix("min-").or_else(|| name.strip_prefix("max-")).unwrap_or(&name) } else { &name };
        matches!(name, "width" | "height" | "inline-size" | "block-size" | "aspect-ratio")
    }

    fn valid_value(&self, start: usize, stop: usize) -> bool {
        !self.invalid_tokens
            || (start..stop).all(|i| match self.tokens[i].0 {
                Kind::BadString | Kind::BadUrl => false,
                Kind::Close => self.ends[i] < self.tokens.len(),
                _ => true,
            })
    }

    fn reads(&mut self, mut i: usize, end: usize) {
        while i < end {
            if self.tokens[i].0 == Kind::Function {
                let spelling = self.spelling(i);
                let name = &spelling[..spelling.len() - 1];
                if name_is(name, "url") {
                    i = self.ends[i].saturating_add(1);
                    continue;
                }
                if name_is(name, "var") {
                    let close = self.ends[i];
                    if let Some((name, after)) = literal_lookup(self.tokens, self.css, i + 1) {
                        if after == close && close < end {
                            self.needed.push(decoded_name(self.spelling(name)));
                        } else if after < close && self.kind(after) == Some(Kind::Comma) {
                            i = close.saturating_add(1);
                            continue;
                        }
                    }
                }
            }
            i += 1;
        }
    }
}

fn page_margin(name: &str) -> bool {
    matches!(
        name,
        "top-left-corner"
            | "top-left"
            | "top-center"
            | "top-right"
            | "top-right-corner"
            | "bottom-left-corner"
            | "bottom-left"
            | "bottom-center"
            | "bottom-right"
            | "bottom-right-corner"
            | "left-top"
            | "left-middle"
            | "left-bottom"
            | "right-top"
            | "right-middle"
            | "right-bottom"
    )
}

#[cfg(test)]
mod tests {
    use super::{custom_properties, stylesheet_text, Scanner};

    #[test]
    fn reads_raw_and_scoped_css_scanner_cases() {
        type Case = (&'static str, &'static str, bool, &'static [&'static str], &'static [&'static str]);
        const CASES: &[Case] = corten_macros::__css_syntax!(cases);
        let mut scanner = Scanner::default();
        for &(name, css, external, declared, needed) in CASES {
            let css = if external { stylesheet_text(css.as_bytes()).unwrap() } else { css };
            let (got_declared, got_needed) = custom_properties(css);
            assert_eq!(got_declared, declared, "{name}: declared in {css}");
            assert_eq!(got_needed, needed, "{name}: needed in {css}");
            assert_eq!(scanner.scan(css, false), (got_declared, Vec::new()), "{name}: declaration-only scan");
        }
    }
}
