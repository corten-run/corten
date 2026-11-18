use std::borrow::Cow;

mod syntax {
    corten_macros::__css_syntax!();
}
use syntax::{closer, decoded_name, lexer, literal_lookup, Kind, Token};

/// What a sheet declares and which literal var() reads have no fallback. A fallback
/// makes the entire lookup optional, including reads inside it.
pub(crate) fn custom_properties(css: &str) -> (Vec<Cow<'_, str>>, Vec<Cow<'_, str>>) {
    // A literal custom name must include two dashes, unless one is escaped.
    if !css.contains("--") && !css.contains('\\') {
        return (Vec::new(), Vec::new());
    }
    let tokens: Vec<_> = lexer(css).filter(|&(kind, ..)| !kind.trivia()).collect();
    let (mut ends, mut blocks) = (vec![tokens.len(); tokens.len()], Vec::new());
    let mut invalid_tokens = false;
    for (i, &(kind, start, end)) in tokens.iter().enumerate() {
        if let Some(close) = closer(kind, &css[start..end]) {
            blocks.push((i, close));
        } else if kind == Kind::Close {
            if blocks.last().is_some_and(|&(_, close)| close == css.as_bytes()[start]) {
                let (open, _) = blocks.pop().unwrap();
                ends[open] = i;
                ends[i] = open;
            } else {
                invalid_tokens = true;
            }
        } else if matches!(kind, Kind::BadString | Kind::BadUrl) {
            invalid_tokens = true;
        }
    }
    let mut scan = Scan { css, tokens, ends, invalid_tokens, declared: Vec::new(), needed: Vec::new() };
    scan.rules();
    (scan.declared, scan.needed)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Context {
    Rules,
    Style,
    Descriptors,
}

struct Scan<'a> {
    css: &'a str,
    tokens: Vec<Token>,
    /// Matching delimiter for each block boundary, or EOF for an unmatched delimiter.
    ends: Vec<usize>,
    invalid_tokens: bool,
    declared: Vec<Cow<'a, str>>,
    needed: Vec<Cow<'a, str>>,
}

impl<'a> Scan<'a> {
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
        let name = decoded_name(self.spelling(i));
        name.strip_prefix("--").filter(|name| !name.is_empty())?;
        Some(name)
    }

    fn boundary(&self, mut i: usize, end: usize, brace_in_value: bool) -> usize {
        while i < end {
            match self.tokens[i].0 {
                Kind::Semicolon => break,
                Kind::Open if !brace_in_value && self.spelling(i) == "{" => break,
                Kind::Open | Kind::Function => i = self.ends[i] + 1,
                _ => i += 1,
            }
        }
        i.min(end)
    }

    fn rules(&mut self) {
        use Context::*;
        let len = self.tokens.len();
        let mut pending = vec![(0, len, Rules)];
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
                        if name.eq_ignore_ascii_case("property") {
                            if context == Rules && stop == i + 2 {
                                if let Some(name) = self.custom_name(i + 1) {
                                    self.declared.push(name);
                                }
                            }
                            // initial-value cannot read a custom property: it is independent.
                            None
                        } else {
                            match name.to_ascii_lowercase().as_str() {
                                "media" | "supports" | "container" | "layer" | "scope" | "starting-style" | "document"
                                | "-moz-document" => Some(context),
                                "keyframes" | "-webkit-keyframes" => Some(Rules),
                                "font-face" | "counter-style" | "font-palette-values" | "position-try" | "page" => {
                                    Some(Descriptors)
                                }
                                // An unknown at-rule is not a declaration list.
                                _ => None,
                            }
                        }
                    } else if context != Descriptors {
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
                        self.reads(i + 2, stop);
                    }
                    i = stop + 1;
                }
            }
        }
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
                let name = decoded_name(&spelling[..spelling.len() - 1]);
                if name.eq_ignore_ascii_case("url") {
                    i = self.ends[i] + 1;
                    continue;
                }
                if name.eq_ignore_ascii_case("var") {
                    let close = self.ends[i];
                    if let Some((name, after)) = literal_lookup(&self.tokens, self.css, i + 1) {
                        if after == close && close < end {
                            self.needed.push(decoded_name(self.spelling(name)));
                        } else if after < close && self.kind(after) == Some(Kind::Comma) {
                            i = close + 1;
                            continue;
                        }
                    }
                }
            }
            i += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::custom_properties;

    #[test]
    fn reads_raw_and_scoped_css_scanner_cases() {
        type Case = (&'static str, &'static str, &'static [&'static str], &'static [&'static str]);
        const CASES: &[Case] = corten_macros::__css_syntax!(cases);
        for &(name, css, declared, needed) in CASES {
            let (got_declared, got_needed) = custom_properties(css);
            assert_eq!(got_declared, declared, "{name}: declared in {css}");
            assert_eq!(got_needed, needed, "{name}: needed in {css}");
        }
    }
}
