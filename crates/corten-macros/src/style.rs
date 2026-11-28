//! Component stylesheets. `#[component(css)]` reads `{name}.css` next to the component, scopes
//! every class in it to the component (`.title` becomes `.offer-list__title`), and gives the
//! markup one constant per class, so `class={Title}` is checked and printed as static markup.
//!
//! The scoping runs here, at compile time: the server only concatenates finished stylesheets,
//! writing in the width of each token breakpoint an `@media` rule names (`(--md)`), which only the
//! app's token file knows.

use std::borrow::Cow;
use std::ops::Range;
use std::path::{Path, PathBuf};

use proc_macro::{Delimiter, Group, Ident, Literal, Span, TokenStream, TokenTree};

use crate::css_syntax::{closer, decode, decoded_name, lexer, literal_lookup, number_end, Kind as Tok, Token};
use crate::tokens::{err, is_ident, is_punct, literal, q, string_value, Error};

type MediaRefs = Vec<(usize, String)>;

/// A component's stylesheet, scoped.
#[derive(Debug)]
pub struct Sheet {
    /// The CSS with every class prefixed and trivia compacted.
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
    pub media: MediaRefs,
}

struct ScanCase(Vec<(String, crate::json::Value)>);

impl ScanCase {
    fn all() -> Vec<Self> {
        use crate::json::Value;
        let Value::Array(cases) = crate::json::parse(include_str!("css-scan-cases.json")).unwrap() else { unreachable!() };
        cases
            .into_iter()
            .map(|case| match case {
                Value::Object(case) => Self(case),
                _ => unreachable!(),
            })
            .collect()
    }

    fn field(&self, key: &str) -> Option<&crate::json::Value> {
        self.0.iter().find(|(name, _)| name == key).map(|(_, value)| value)
    }

    fn string(&self, key: &str) -> Option<&str> {
        match self.field(key)? {
            crate::json::Value::String(value) => Some(value),
            _ => panic!("{key} is not a string"),
        }
    }

    fn strings(&self, key: &str) -> Option<Vec<&str>> {
        use crate::json::Value;
        let Value::Array(values) = self.field(key)? else { panic!("{key} is not an array") };
        Some(
            values
                .iter()
                .map(|value| match value {
                    Value::String(value) => value.as_str(),
                    _ => panic!("{key} is not an array of strings"),
                })
                .collect(),
        )
    }
}

/// Project the fixture into Rust without a JSON dependency in the startup scanner's tests.
pub(super) fn scanner_cases() -> TokenStream {
    use std::fmt::Write;
    let mut rust = String::from("&[");
    for case in ScanCase::all() {
        let name = case.string("name").unwrap();
        let css = case.string("css").unwrap();
        let declared = case.strings("declared").unwrap();
        let needed = case.strings("needed").unwrap();
        let external = case.field("external").is_some();
        write!(rust, "({name:?}, {css:?}, {external}, &{declared:?}, &{needed:?}),").unwrap();
        if let Some(css) = case.string("scoped") {
            let declared = case.strings("scopedDeclared").unwrap_or(declared);
            let needed = case.strings("scopedNeeded").unwrap_or(needed);
            write!(rust, "({name:?}, {css:?}, false, &{declared:?}, &{needed:?}),").unwrap();
        }
    }
    rust.push(']');
    rust.parse().expect("CSS scanner fixture")
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

/// Prefixes every class in `src` with `{prefix}__`. Every selector, nested ones included, must
/// match only elements that have one of the file's classes or are inside one
/// (`Scoper::prefixed`); under an `@scope` root that does not, each rule in it must.
pub fn scope(src: &str, prefix: &str) -> Result<Sheet, String> {
    let src = preprocess(src);
    let src = src.as_ref();
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
        rewrites: Vec::new(),
        media: Vec::new(),
        prefix,
        scope_root: None,
    };
    s.block(Ctx::Top, Some(Anchor::default()), true)?;
    let names: Vec<&str> = s.properties.iter().map(|(name, _)| name.as_str()).collect();
    if let Some((_, name)) = s.media.iter().find(|(_, name)| names.contains(&name.as_str())) {
        return Err(format!(
            "(--{name}) in an @media rule names a breakpoint of the token file, and --{name} is this stylesheet's @property: rename the property"
        ));
    }
    if !names.is_empty() || !s.positions.is_empty() {
        let (css, media) = s.rewrite_names(&names)?;
        s.out = css;
        s.media = media;
    }
    Ok(Sheet { css: s.out, classes: s.classes, properties: s.properties, media: s.media })
}

/// The line of the first merge conflict marker in `src` (`<<<<<<<`, `|||||||`, `=======` or
/// `>>>>>>>` starting a line, alone or before a space), outside comments and strings: CSS has no
/// rule that starts so, and a browser drops the rule after one, so a merge left unfinished
/// (`corten ui add --merge`, git) would otherwise build and lose a rule.
fn conflict_marker(src: &str) -> Option<usize> {
    let mut tokens = lexer(src).peekable();
    for (line, (start, rest)) in src
        .split_inclusive('\n')
        .scan(0, |start, line| {
            let at = *start;
            *start += line.len();
            Some((at, line.as_bytes()))
        })
        .enumerate()
    {
        let marker = b"<|=>".iter().any(|&c| rest.len() >= 7 && rest[..7].iter().all(|&b| b == c));
        if !marker || !matches!(rest.get(7), None | Some(b' ' | b'\n' | b'\r')) {
            continue;
        }
        while tokens.peek().is_some_and(|&(_, _, end)| end <= start) {
            tokens.next();
        }
        if tokens.peek().is_some_and(|&(_, at, _)| at == start) {
            return Some(line + 1);
        }
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
    let mut tokens = lexer(syntax).filter(|&(kind, ..)| kind != Tok::Space).peekable();
    if tokens.next_if(|&(kind, ..)| kind == Tok::Delim(b'*')).is_some() {
        return tokens.next().is_none();
    }
    loop {
        let allow_multiplier = match tokens.next() {
            Some((Tok::Delim(b'<'), _, start)) => {
                let Some((Tok::Ident, at, end)) = tokens.next() else { return false };
                let name = &syntax[at..end];
                if start != at || !TYPES.contains(&name) || !matches!(tokens.next(), Some((Tok::Delim(b'>'), at, _)) if at == end)
                {
                    return false;
                }
                (name != "transform-list").then_some(end + 1)
            }
            Some((Tok::Ident, start, end)) if !syntax[start..].starts_with('-') => {
                let name = decoded_name(&syntax[start..end]);
                if ["initial", "inherit", "unset", "revert", "revert-layer", "default"]
                    .iter()
                    .any(|k| name.eq_ignore_ascii_case(k))
                {
                    return false;
                }
                Some(end)
            }
            _ => return false,
        };
        tokens.next_if(|&(kind, start, _)| allow_multiplier == Some(start) && matches!(kind, Tok::Delim(b'+' | b'#')));
        match tokens.next() {
            None => return true,
            Some((Tok::Delim(b'|'), ..)) => {}
            _ => return false,
        }
    }
}

/// `text` as CSS reads it: each line break (`\r\n`, `\r`, form feed) one `\n`, and NUL the
/// replacement character (CSS Syntax Level 3, preprocessing the input stream).
fn preprocess(text: &str) -> Cow<'_, str> {
    if text.contains(['\r', '\u{c}', '\0']) {
        text.replace("\r\n", "\n").replace(['\r', '\u{c}'], "\n").replace('\0', "\u{fffd}").into()
    } else {
        text.into()
    }
}

/// Whether `value`, an `initial-value`, is one of `kind` (a type of `SYNTAXES`): a number with a
/// unit the syntax allows (`0` alone for a length), and for a length one of `LENGTHS`, as an initial
/// value must not depend on a font or a container. The browser ignores a rule whose initial
/// value does not parse as its syntax, so markup would set a property nothing registered.
fn initial_fits(kind: &str, value: &str) -> bool {
    let Some((token @ (Tok::Number | Tok::Dimension | Tok::Percentage), 0, end)) = lexer(value).next() else { return false };
    if end != value.len() {
        return false;
    }
    let at = number_end(value.as_bytes(), 0);
    let (number, unit) = value.split_at(at);
    let Ok(number) = number.parse::<f64>() else { return false };
    if !number.is_finite() {
        return false;
    }
    let unit = decoded_name(unit).to_ascii_lowercase();
    match kind {
        "Number" => unit.is_empty(),
        "Integer" => unit.is_empty() && number.fract() == 0.0 && !value.contains(['.', 'e', 'E']),
        "Percentage" => token == Tok::Percentage,
        "Length" => LENGTHS.contains(&unit.as_str()) || (unit.is_empty() && number == 0.0),
        "LengthPercentage" => token == Tok::Percentage || LENGTHS.contains(&unit.as_str()) || (unit.is_empty() && number == 0.0),
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

fn tokens(css: &str) -> Vec<Token> {
    lexer(css).filter(|&(kind, ..)| !kind.trivia()).collect()
}

enum Rewrite {
    Registration,
    Container,
    Supports,
    /// Source range when the declaration can also name a position option.
    Declaration(Option<Range<usize>>),
}

/// Write only references that take a property name, not every ident with the same spelling.
fn rename_properties(css: &str, rewrite: &Rewrite, names: &[&str], prefix: &str, out: &mut String) -> Result<(), String> {
    let toks = tokens(css);
    let mut refs = Vec::new();
    match rewrite {
        Rewrite::Registration => ident_ref(&toks, 1, &mut refs),
        Rewrite::Container => property_refs(css, &toks, 1, PropertyScan::Container, &mut refs),
        Rewrite::Supports => property_refs(css, &toks, 1, PropertyScan::Supports, &mut refs),
        Rewrite::Declaration(_) => {
            let colon = toks.iter().position(|&(kind, ..)| kind == Tok::Colon).unwrap();
            ident_ref(&toks, 0, &mut refs);
            property_value_names(css, &toks, 0, colon + 1, &mut refs);
            property_refs(css, &toks, colon + 1, PropertyScan::Value, &mut refs);
        }
    }
    refs.sort_unstable();
    refs.dedup();
    let mut copied = 0;
    for (start, end) in refs {
        let name = decoded_name(&css[start..end]);
        let Some(name) = name.strip_prefix("--").filter(|name| names.contains(name)) else { continue };
        // Markup also sets these as !important. A more specific declaration would beat markup
        // on a full load (a page style block) but lose to it after a patch (inline).
        if start == 0
            && matches!(rewrite, Rewrite::Declaration(_))
            && matches!(toks.as_slice(), [.., (Tok::Delim(b'!'), ..), (Tok::Ident, word, end)]
                if decoded_name(&css[*word..*end]).eq_ignore_ascii_case("important"))
        {
            return Err(format!(
                "--{name}: !important on a property markup sets would beat markup's value on a full load and lose to it after a patch; set it from markup (style={{..}}) or without !important"
            ));
        }
        out.push_str(&css[copied..start]);
        out.push_str("--");
        out.push_str(prefix);
        out.push_str("__");
        out.push_str(name);
        copied = end;
    }
    out.push_str(&css[copied..]);
    Ok(())
}

fn ident_ref(toks: &[(Tok, usize, usize)], i: usize, refs: &mut Vec<(usize, usize)>) {
    if let Some(&(Tok::Ident, start, end)) = toks.get(i) {
        refs.push((start, end));
    }
}

/// These declaration values name properties in the same slots that position-try names options.
fn property_value_names(css: &str, toks: &[(Tok, usize, usize)], name: usize, value: usize, refs: &mut Vec<(usize, usize)>) {
    let (_, start, end) = toks[name];
    if ["transition", "transition-property", "will-change"]
        .iter()
        .any(|property| decoded_name(&css[start..end]).eq_ignore_ascii_case(property))
    {
        options(css, toks, value, false, refs);
    }
}

#[derive(Clone, Copy, PartialEq)]
enum PropertyScan {
    Value,
    Container,
    Supports,
    Style,
    Condition,
    SubstitutionInput,
    IfCondition { condition_result: bool },
    IfValue { condition_result: bool },
    Opaque,
}

enum SubstitutionResult {
    AfterFirst { property_lookup: bool },
    BranchValues,
    NoResultArg,
}

// https://drafts.csswg.org/css-values-5/#arbitrary-substitution-function
// Which arguments can supply literal result tokens. ident() constructs one identifier instead.
const ARBITRARY_SUBSTITUTIONS: &[(&str, SubstitutionResult)] = &[
    ("var", SubstitutionResult::AfterFirst { property_lookup: true }),
    ("env", SubstitutionResult::AfterFirst { property_lookup: false }),
    ("attr", SubstitutionResult::AfterFirst { property_lookup: false }),
    ("inherit", SubstitutionResult::AfterFirst { property_lookup: true }),
    ("if", SubstitutionResult::BranchValues),
    ("ident", SubstitutionResult::NoResultArg),
    ("random-item", SubstitutionResult::AfterFirst { property_lookup: false }),
];

fn property_refs(css: &str, toks: &[(Tok, usize, usize)], start: usize, mode: PropertyScan, refs: &mut Vec<(usize, usize)>) {
    use PropertyScan::*;
    let kind = |i: usize| toks.get(i).map(|&(kind, ..)| kind);
    let spelling = |i: usize| toks.get(i).map(|&(_, start, end)| &css[start..end]);
    let arg_end = |i| matches!(spelling(i), Some("," | ")"));
    let comparison = |i: usize| matches!(kind(i), Some(Tok::Delim(b'<' | b'>' | b'=')));
    // A plain style feature or supports declaration has a name before its colon. Its value
    // follows declaration rules, not query rules (e.g. the value in style(--state: --t)).
    let feature = |i, mode, refs: &mut Vec<_>| {
        if kind(i) == Some(Tok::Ident) && kind(i + 1) == Some(Tok::Colon) {
            ident_ref(toks, i, refs);
            property_value_names(css, toks, i, i + 2, refs);
            Value
        } else {
            mode
        }
    };
    let mut stack = vec![mode];
    for (i, &(token, start, end)) in toks.iter().enumerate().skip(start) {
        let mode = *stack.last().unwrap();
        let condition = matches!(mode, Condition | IfCondition { .. } | IfValue { condition_result: true });
        // Size queries and if() conditions can use substitutions without naming a property
        // with a bare identifier.
        let substitutions = condition || matches!(mode, Value | IfValue { .. } | Style | Container | SubstitutionInput);
        match token {
            Tok::Function => {
                let name = decoded_name(&css[start..end - 1]).to_ascii_lowercase();
                let next = match name.as_str() {
                    "url" => Opaque,
                    "style" if mode == Container || condition => feature(i + 1, Style, refs),
                    "supports" if condition => feature(i + 1, Supports, refs),
                    _ if substitutions => match ARBITRARY_SUBSTITUTIONS.iter().find(|(function, _)| *function == name) {
                        Some((_, SubstitutionResult::AfterFirst { property_lookup })) => {
                            if *property_lookup {
                                if let Some((name, _)) = literal_lookup(toks, css, i + 1).filter(|&(_, end)| arg_end(end)) {
                                    ident_ref(toks, name, refs);
                                }
                            }
                            // The first argument is a lookup or key, not part of the result.
                            if condition {
                                SubstitutionInput
                            } else {
                                Value
                            }
                        }
                        Some((_, SubstitutionResult::BranchValues)) => IfCondition { condition_result: condition },
                        Some((_, SubstitutionResult::NoResultArg)) | None => Value,
                    },
                    _ => Opaque,
                };
                stack.push(next);
            }
            Tok::Open => {
                let next = match (mode, &css[start..end]) {
                    (Supports | Style, "(") => feature(i + 1, mode, refs),
                    (Container, "(") => Container,
                    (_, "(") if condition => Condition,
                    // A leading brace pair can wrap a free-form argument without being part of it.
                    (_, "{")
                        if condition && matches!(kind(i - 1), Some(Tok::Function | Tok::Comma | Tok::Colon | Tok::Semicolon)) =>
                    {
                        Condition
                    }
                    _ if substitutions => Value,
                    _ => Opaque,
                };
                stack.push(next);
            }
            Tok::Close if stack.len() > 1 => {
                stack.pop();
            }
            Tok::Comma if mode == SubstitutionInput => *stack.last_mut().unwrap() = Condition,
            Tok::Colon => {
                if let IfCondition { condition_result } = mode {
                    *stack.last_mut().unwrap() = IfValue { condition_result };
                }
            }
            Tok::Semicolon => {
                if let IfValue { condition_result } = mode {
                    *stack.last_mut().unwrap() = IfCondition { condition_result };
                }
            }
            // A boolean style feature or a whole operand in a style range names a property.
            Tok::Ident
                if mode == Style
                    && (matches!(kind(i - 1), Some(Tok::Open | Tok::Function)) || comparison(i - 1))
                    && (kind(i + 1) == Some(Tok::Close) || comparison(i + 1)) =>
            {
                refs.push((start, end));
            }
            _ => {}
        }
    }
}

/// The value of a `position-try` or `position-try-fallbacks` declaration with each identifier token
/// that is `--` and one of `names` (the options this file defines)
/// written `--{prefix}__{name}`, where the value takes an option: at its top, in the fallback
/// of a `var()`, `env()`, `attr()` or `inherit()`, and in the value of an `if()` branch. A
/// function's name (`--above()` calls a custom function), a lookup's name, an `if()` condition
/// (`style(--above: 1)` queries a custom property), strings, URLs and whatever is inside any
/// other function keep their names.
fn rename_positions(raw: &str, names: &[String], prefix: &str) -> Option<(usize, String)> {
    if names.is_empty() {
        return None;
    }
    // Edit whole tokens in the source before normalizing the value. Replacing a hex escape
    // removes its terminator, but not a separator or comment that follows the token.
    let toks = tokens(raw);
    let colon = toks.iter().position(|&(kind, ..)| kind == Tok::Colon)?;
    let base = toks[colon].2;
    let edits: Vec<_> = position_options(raw, &toks, colon + 1)
        .into_iter()
        .filter_map(|(start, end)| {
            let written = &raw[start..end];
            let name = decoded_name(written);
            let name = names.iter().find(|n| Some(n.as_str()) == name.strip_prefix("--"))?;
            Some((start - base..end - base, name))
        })
        .collect();
    if edits.is_empty() {
        return None;
    }
    let mut out = raw[base..].to_string();
    for (range, name) in edits.into_iter().rev() {
        out.replace_range(range, &format!("--{prefix}__{name}"));
    }
    Some((base, out))
}

fn position_options(css: &str, toks: &[(Tok, usize, usize)], mut i: usize) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    while i < toks.len() {
        // Past an unmatched close, which the browser would reject, to the rest of the value.
        i = options(css, toks, i, false, &mut found) + 1;
    }
    found
}

/// Records the options among the tokens from `i` to the end of the block they are in (or, for
/// an `if()` branch, to its `;`), and returns where that is.
fn options(css: &str, toks: &[(Tok, usize, usize)], mut i: usize, branch: bool, found: &mut Vec<(usize, usize)>) -> usize {
    while let Some(&(kind, start, end)) = toks.get(i) {
        match kind {
            Tok::Close => return i,
            Tok::Semicolon if branch => return i,
            Tok::Ident => {
                found.push((start, end));
                i += 1;
            }
            Tok::Function => {
                let function = decoded_name(&css[start..end - 1]).to_ascii_lowercase();
                i = match function.as_str() {
                    // A lookup's name, then a fallback that can be an option.
                    "var" | "env" | "attr" | "inherit" => {
                        let comma = skip(toks, i + 1, &[Tok::Comma]);
                        match toks.get(comma) {
                            Some((Tok::Comma, ..)) => options(css, toks, comma + 1, false, found),
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
                            let ends = options(css, toks, colon + 1, true, found);
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

#[derive(Clone, Copy, PartialEq)]
enum Ctx {
    /// Rules, which must be scoped: at the top of the file, or in an `@scope` there whose root
    /// is not the component's.
    Top,
    /// Inside a style rule, or an `@scope` rule nested in one: declarations and nested rules,
    /// checked against the rule's elements.
    Style,
    /// Inside an `@scope` rule at the top of the file whose root is the component's: as in a
    /// style rule, and not checked, since its rules match only under the root, but name-defining
    /// at-rules such as `@property` are valid there and not scoped (CSS Cascade 6).
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
    /// Output chunks that can name a local property or option before its definition.
    rewrites: Vec<(Range<usize>, Rewrite)>,
    /// The breakpoints its `@media` rules name, without the `--`.
    media: MediaRefs,
    prefix: &'a str,
    /// The enclosing unowned `@scope` root, whose rules must prove ownership themselves.
    scope_root: Option<String>,
}

impl Scoper<'_> {
    fn rewrite_names(&self, names: &[&str]) -> Result<(String, MediaRefs), String> {
        let mut css = String::with_capacity(self.out.len());
        let mut copied = 0;
        let mut offsets = Vec::with_capacity(self.media.len());
        let mut media = self.media.iter().peekable();
        for (range, rewrite) in &self.rewrites {
            let mut chunk = Cow::Borrowed(&self.out[range.clone()]);
            if let Rewrite::Declaration(Some(source)) = rewrite {
                if let Some((base, raw)) = rename_positions(&self.text[source.clone()], &self.positions, self.prefix) {
                    let mut i = 0;
                    let Chunk { text: value, .. } =
                        scan_chunk(&raw, &mut i).map_err(|(at, message)| self.error(source.start + base + at, message))?;
                    debug_assert_eq!(i, raw.len());
                    let property = chunk.split_once(':').unwrap().0;
                    chunk = Cow::Owned(format!("{property}:{value}"));
                }
            }
            while let Some((at, name)) = media.next_if(|(at, _)| *at < range.start) {
                offsets.push((css.len() + at - copied, name.clone()));
            }
            css.push_str(&self.out[copied..range.start]);
            if !names.is_empty() {
                rename_properties(&chunk, rewrite, names, self.prefix, &mut css)?;
            } else {
                css.push_str(&chunk);
            }
            copied = range.end;
        }
        offsets.extend(media.map(|(at, name)| (css.len() + at - copied, name.clone())));
        css.push_str(&self.out[copied..]);
        Ok((css, offsets))
    }

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

    /// The rules and declarations up to the end of the block. `nest` is what the elements the
    /// block's rules are relative to require (the parent rule's, or none at the top of the file or
    /// in an `@scope` whose root is not the component's); with `None`, in an `@scope` whose root
    /// is, its selectors are not checked.
    fn block(&mut self, ctx: Ctx, nest: Option<Anchor>, top: bool) -> Result<(), String> {
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
            let Chunk { end, text, url, joined_comment } = self.chunk()?;
            let source = start..self.i;
            if end == Some(b'{') {
                if starts_custom_property(&text) {
                    return Err(self.error(
                        start,
                        "a custom property whose value holds a { } block at its outer level is not supported in a component stylesheet; put that declaration in the app's stylesheet (static/style.css)",
                    ));
                }
                self.i += 1;
                let mut scope_rule = None;
                let mut unowned_root = None;
                let mut inner_nest = nest;
                let mut position_name = None;
                let mut rewrite = None;
                let mut media = false;
                let mut property_prelude = None;
                let inner = if text.starts_with('@') {
                    // At-rule names are case-insensitive in CSS: `@MEDIA` is `@media`.
                    let (name, prelude) = self.at_rule(&text, start)?;
                    let name = name.to_ascii_lowercase();
                    if ctx != Ctx::Raw {
                        media = name == "media";
                        rewrite = match name.as_str() {
                            "property" => {
                                property_prelude = Some(prelude);
                                Some(Rewrite::Registration)
                            }
                            "container" => Some(Rewrite::Container),
                            "supports" => Some(Rewrite::Supports),
                            _ => None,
                        };
                    }
                    if name == "page" && ctx != Ctx::Raw {
                        self.check_page(prelude, start)?;
                    }
                    match (ctx, name.as_str()) {
                        (Ctx::Raw, _) => Ctx::Raw,
                        // A rule nested in a style rule holds style rules or declarations; the
                        // browser ignores an `@property` there (CSS Nesting).
                        (Ctx::Style, "property") => {
                            return Err(self.error(start, "@property registers a property for the whole page: put it at the top of the stylesheet, outside any rule"))
                        }
                        (_, "position-try") => {
                            let written = trim_leading_trivia(prelude);
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
                            self.check_selector_prelude(url, joined_comment)?;
                            let (prelude, unowned) = self.scope_prelude(prelude, nest, start)?;
                            scope_rule = Some(prelude);
                            // A root the component owns lets its rules start anywhere; any other
                            // can match elements outside it, so its rules are checked as at the
                            // top of the file, and `&` and `:scope` in them are that root.
                            match (nest, unowned) {
                                (Some(_), Some(root)) => {
                                    unowned_root = Some(root);
                                    inner_nest = Some(Anchor::default());
                                    ctx
                                }
                                (Some(_), None) => {
                                    inner_nest = None;
                                    if ctx == Ctx::Top {
                                        Ctx::Scope
                                    } else {
                                        ctx
                                    }
                                }
                                (None, _) => ctx,
                            }
                        }
                        (_, name) if GROUP_AT_RULES.contains(&name) => ctx,
                        (_, name) if RAW_AT_RULES.contains(&name) => Ctx::Raw,
                        (_, name) => return Err(self.unsupported_at_rule(start, name)),
                    }
                } else {
                    Ctx::Style
                };
                if inner == Ctx::Raw {
                    inner_nest = None;
                }
                let output_start = self.out.len();
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
                    self.check_selector_prelude(url, joined_comment)?;
                    let (selector, anchor) = self.selector(&text, nest, start)?;
                    inner_nest = nest.map(|_| anchor);
                    self.out.push_str(&selector);
                }
                if let Some(rewrite) = rewrite {
                    self.rewrites.push((output_start..self.out.len(), rewrite));
                }
                self.out.push('{');
                let body = self.out.len();
                let outer_root = unowned_root.map(|root| self.scope_root.replace(root));
                self.block(inner, inner_nest, false)?;
                if let Some(outer) = outer_root {
                    self.scope_root = outer;
                }
                if let Some(prelude) = property_prelude {
                    self.property(prelude, body, start)?;
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
            if text.starts_with('@') {
                let (name, _) = self.at_rule(&text, start)?;
                match name.to_ascii_lowercase().as_str() {
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
                    _ => return Err(self.error(start, format!("@{name} is not supported in a component's stylesheet"))),
                }
                continue;
            }
            // A declaration styles the elements the block's rules are relative to.
            if !nest.is_none_or(|anchor| anchor.owned) {
                if let Some(root) = &self.scope_root {
                    return Err(self.error(
                        start,
                        format!("`{text}` styles the root of `@scope ({root})`, which can be outside the component: put it in a rule for an element with one of the stylesheet's classes or inside one, like `.list {{ {text} }}`"),
                    ));
                }
                return Err(self.error(start, format!("`{text}` is outside any rule")));
            }
            let Some((name, value)) = split_declaration(&text) else {
                return Err(self.error(start, format!("expected `property: value`, found `{text}`")));
            };
            let output_start = self.out.len();
            self.out.push_str(name);
            self.out.push(':');
            self.out.push_str(value);
            if text.contains("--") || text.contains('\\') {
                let position = (name.eq_ignore_ascii_case("position-try") || name.eq_ignore_ascii_case("position-try-fallbacks"))
                    .then_some(source);
                self.rewrites.push((output_start..self.out.len(), Rewrite::Declaration(position)));
            }
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
        let mut copied = 0;
        let mut tokens = lexer(prelude).filter(|&(kind, ..)| !kind.trivia());
        let mut blocks = Vec::new();
        while let Some((kind, start, end)) = tokens.next() {
            let spelling = &prelude[start..end];
            if kind == Tok::Close {
                blocks.pop();
            } else if let Some(close) = closer(kind, spelling) {
                let opaque = blocks.last().copied().unwrap_or(false);
                blocks.push(opaque || kind == Tok::Function || close != b')');
                if opaque || spelling != "(" {
                    continue;
                }
                let mut rest = tokens.clone();
                let Some((Tok::Ident, name_start, name_end)) = rest.next() else { continue };
                let written = &prelude[name_start..name_end];
                if !decoded_name(written).starts_with("--") {
                    continue;
                }
                let name = written.strip_prefix("--").unwrap_or("");
                let Some((Tok::Close, close_start, close_end)) = rest.next() else {
                    return Err(self.breakpoint_usage(prelude, at));
                };
                if name.is_empty() || &prelude[close_start..close_end] != ")" {
                    return Err(self.breakpoint_usage(prelude, at));
                }
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
                out.push_str(&prelude[copied..start]);
                self.media.push((self.out.len() + out.len(), name.to_string()));
                out.push_str("(--");
                out.push_str(name);
                out.push(')');
                copied = close_end;
                tokens = rest;
                blocks.pop();
            }
        }
        out.push_str(&prelude[copied..]);
        Ok(out)
    }

    fn breakpoint_usage(&self, prelude: &str, at: usize) -> String {
        self.error(
            at,
            format!("{prelude}: a breakpoint is named alone in its parentheses, `(--md)`, with lowercase letters, digits and -, starting with a letter"),
        )
    }

    /// An `@scope` prelude, `(.list) to (.slot)` (CSS Cascade 6: `(<scope-start>) to
    /// (<scope-end>)`, each a selector list), with the classes of its root and limit prefixed and
    /// recorded, and, unless `nest` is `None`, the root as written when it can match an element
    /// the component does not own. With no root, the scope is the parent of the stylesheet's
    /// owner node, the element around the page's stylesheet link, which no component owns.
    fn scope_prelude(&mut self, prelude: &str, nest: Option<Anchor>, at: usize) -> Result<(String, Option<String>), String> {
        let css_whitespace = [' ', '\t', '\n'];
        let prelude = prelude.trim_matches(css_whitespace);
        let usage = format!(
            "`@scope {prelude}`: the browser drops an @scope whose prelude is not a root and an optional limit; write `@scope (.list)` or `@scope (.list) to (.slot)`"
        );
        let (root, rest) = match parenthesized(prelude) {
            Some((root, rest)) => (Some(root), rest.trim_start_matches(css_whitespace)),
            None => (None, prelude),
        };
        let limit = if rest.is_empty() {
            None
        } else {
            // `to` and a parenthesized list; `to(` would be a function, which is no limit.
            let to = rest.get(..3).is_some_and(|to| to.as_bytes()[..2].eq_ignore_ascii_case(b"to") && to.ends_with(' '));
            match parenthesized(if to { &rest[3..] } else { "" }) {
                Some((limit, after)) if after.trim_matches(css_whitespace).is_empty() => Some(limit),
                _ => return Err(self.error(at, usage)),
            }
        };
        let Some(root) = root else {
            return Err(self.error(
                at,
                "@scope with no root scopes its rules to the element around the page's stylesheet link, which no component owns: start it at one of the stylesheet's classes, `@scope (.list)`",
            ));
        };
        if root.is_empty() || limit == Some("") {
            return Err(self.error(at, usage));
        }
        // Chromium can resolve both explicit `&` and implicit nesting through the enclosing
        // @scope instead of an intervening style rule. An unowned outer root supplies no proof.
        let root_nest = if self.scope_root.is_some() { Anchor::default() } else { nest.unwrap_or_default() };
        let (start, _, unowned) = self.prefixed(root, root_nest, Some(prelude), at)?;
        let mut out = format!("@scope ({start})");
        if let Some(limit) = limit {
            out.push_str(" to (");
            out.push_str(&self.prefixed(limit, Anchor::default(), Some(prelude), at)?.0);
            out.push(')');
        }
        Ok((out, (nest.is_some() && unowned.is_some()).then(|| root.to_string())))
    }

    /// Records an `@property` rule, whose declarations are in `self.out` from `body`: its name,
    /// and the type of its syntax when markup can set it. The browser ignores a rule that lacks
    /// `syntax`, `inherits`, or (for any syntax but `*`) `initial-value`, so each is required.
    fn property(&mut self, prelude: &str, body: usize, at: usize) -> Result<(), String> {
        let prelude = trim_leading_trivia(prelude);
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
        let descriptors = &self.out[body..];
        let mut i = 0;
        while i < descriptors.len() {
            let start = i;
            let Chunk { end, .. } = scan_chunk(descriptors, &mut i).expect("validated block");
            let declaration = &descriptors[start..i];
            if end == Some(b'{') {
                i += block_end(&descriptors[i..]).expect("validated nested block");
                continue;
            }
            if end == Some(b';') {
                i += 1;
            }
            let declaration = split_declaration(declaration).map(|(name, value)| (name.to_ascii_lowercase(), value));
            match declaration.as_ref().map(|(name, value)| (name.as_str(), *value)) {
                Some(("syntax", value)) => {
                    let quoted = matches!(
                        lexer(value).next(), Some((Tok::String { closed: true }, 0, end)) if end == value.len()
                    );
                    if !quoted {
                        return Err(self.error(
                            at,
                            format!(
                                "@property --{name}: syntax is a string, syntax: \"{value}\"; the browser ignores it unquoted"
                            ),
                        ));
                    }
                    syntax = Some(decode(&value[1..value.len() - 1], true));
                }
                Some(("inherits", value)) if value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("false") => {
                    inherits = true
                }
                Some(("initial-value", value)) => initial = Some(value),
                _ => {}
            }
        }
        if let Some(written) = &syntax {
            if !syntax_valid(written) {
                return Err(self.error(at, format!("@property --{name}: syntax: \"{written}\" is not a syntax the browser reads (\"*\", \"<length>\", \"<color>+\", \"auto | <length>\")")));
            }
        }
        let Some(syntax) = syntax.as_deref().map(|text| text.trim_matches([' ', '\t', '\n'])) else {
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
        if let (Some(kind), Some(value)) = (kind, initial) {
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
        let prelude = trim_leading_trivia(prelude);
        let name = match lexer(prelude).next() {
            Some((Tok::Ident, _, end)) => &prelude[..end],
            _ => "",
        };
        let own = format!("{}-", self.prefix);
        if name.is_empty() {
            return Err(self.error(
                at,
                format!("an @page with no name sets every page the app prints: name it, @page {own}slip, or put it in the app's stylesheet"),
            ));
        }
        if !name.is_ascii() {
            return Err(self.error(at, format!("the page name `{}` contains a non-ASCII character", name.escape_default())));
        }
        if !name.starts_with(&own) {
            return Err(
                self.error(at, format!("a page's name is the whole app's: start it with this component's, @page {own}{name}"))
            );
        }
        Ok(())
    }

    fn at_rule<'r>(&self, rule: &'r str, at: usize) -> Result<(&'r str, &'r str), String> {
        let Some((Tok::AtKeyword, _, end)) = lexer(rule).next() else {
            return Err(self.unsupported_at_rule(at, ""));
        };
        let (name, prelude) = rule[1..].split_at(end - 1);
        if !name.is_ascii() {
            return Err(self.error(at, format!("the at-rule name `@{}` contains a non-ASCII character", name.escape_default())));
        }
        Ok((name, prelude))
    }

    fn skip_space(&mut self) {
        let rest = &self.text[self.i..];
        self.i += rest.len() - trim_leading_trivia(rest).len();
    }

    /// Reads to the next structural delimiter, removing comments and folding whitespace
    /// without changing the boundaries of escapes, strings or URLs.
    fn chunk(&mut self) -> Result<Chunk, String> {
        scan_chunk(self.text, &mut self.i).map_err(|(at, message)| self.error(at, message))
    }

    fn check_selector_prelude(&self, url: Option<usize>, joined_comment: Option<usize>) -> Result<(), String> {
        if let Some(at) = joined_comment {
            return Err(self.error(
                at,
                "a comment directly between two parts of a selector cannot be kept or removed safely here; write the selector without it (for example `.a.b`, not `.a/**/.b`)",
            ));
        }
        // The selector proof handles functions, not URL tokens, whose contents can include
        // delimiters that would change the proof. Refuse them before discarding any arm.
        if let Some(at) = url {
            return Err(
                self.error(at, "an unquoted url() cannot be checked in a component selector: quote its value or remove the arm")
            );
        }
        Ok(())
    }

    /// The selector with its classes prefixed, and what its elements require. With `nest`, what
    /// `&` requires, every selector in the list must match only elements the component owns.
    fn selector(&mut self, text: &str, nest: Option<Anchor>, at: usize) -> Result<(String, Anchor), String> {
        match (nest, self.prefixed(text, nest.unwrap_or_default(), None, at)?) {
            (Some(nest), (_, _, Some(unowned))) => Err(self.unowned(&unowned, nest, at)),
            (_, (out, anchor, _)) => Ok((out, anchor)),
        }
    }

    /// The selector list with its classes prefixed, what all of its selectors require of the
    /// elements they match, and the first that does not require them to be the component's: to
    /// have one of the file's classes or be inside an element that has one.
    ///
    /// A class counts on the element's own compound selector or on one it is inside, by a
    /// descendant or child combinator; a sibling shares what it is inside (`.list > li + li`),
    /// but `+` and `~` from the class's element, or `||`, lead outside it. In `:is()` and
    /// `:where()` every selector must count, but those the browser drops from these forgiving
    /// lists, such as one that is empty or has a pseudo-element (Selectors 4). A class in any
    /// other function, `:not()`, `:has()` or `:nth-child(2 of .row)`, is prefixed but only
    /// filters. `&` is the parent rule's elements, `nest`; a leading combinator or the absence of
    /// any `&` delimiter makes a nested selector relative to them (CSS Nesting).
    fn prefixed(
        &mut self,
        text: &str,
        nest: Anchor,
        scope: Option<&str>,
        at: usize,
    ) -> Result<(String, Anchor, Option<Unowned>), String> {
        let mut out = String::with_capacity(text.len() + 16);
        // Each block records its closer and whether it is inside an attribute or brace block,
        // where class and pseudo-class syntax does not apply.
        let mut blocks = Vec::<(u8, bool)>::new();
        let mut part_start = 0;
        // The rule's selector list, the `:is()` and `:where()` lists open in it, and for the
        // current selector, whether it has an `&` delimiter and why it might not count.
        let mut top = Branches::new();
        let mut lists = Vec::<Branches>::new();
        let (mut has_ampersand, mut why) = (false, Why::default());
        let mut all = Anchor::ALL;
        let mut unowned = None;
        let mut tokens = lexer(text).peekable();
        while let Some((kind, start, end)) = tokens.next() {
            let spelling = &text[start..end];
            let depth = lists.last().map_or(0, |list| list.depth);
            let in_list = blocks.len() == depth;
            let opaque = blocks.last().is_some_and(|&(_, opaque)| opaque);
            if in_list {
                let list = lists.last_mut().unwrap_or(&mut top);
                match kind {
                    Tok::Space => list.space(),
                    Tok::Delim(b @ (b'>' | b'+' | b'~')) => list.explicit_combinator(char::from(b)),
                    Tok::Delim(b'|') if matches!(tokens.peek(), Some((Tok::Delim(b'|'), at, _)) if *at == end) => {
                        list.explicit_combinator('|');
                        out.push_str("||");
                        tokens.next();
                        continue;
                    }
                    Tok::Comma | Tok::Close | Tok::Comment { .. } => {}
                    _ => list.token(nest, &mut why),
                }
            }
            match kind {
                Tok::Delim(b'&') => {
                    // Even an invalid arm can suppress implicit nesting. Only a matchable
                    // nesting selector supplies an anchor.
                    has_ampersand = true;
                    if blocks.get(depth).is_some_and(|&(close, _)| close == b']') {
                        lists.last_mut().unwrap_or(&mut top).invalid = true;
                    } else if in_list {
                        lists.last_mut().unwrap_or(&mut top).add(nest);
                    } else {
                        why.filtered = true;
                    }
                }
                Tok::Colon if !opaque => {
                    let mut next = tokens.clone();
                    let after = next.find(|&(kind, ..)| !matches!(kind, Tok::Comment { .. }));
                    let double_colon = after.filter(|&(kind, ..)| kind == Tok::Colon);
                    let legacy = matches!(after, Some((Tok::Ident, start, end)) if legacy_pseudo_element(&text[start..end]));
                    if double_colon.is_some() || legacy {
                        if let Some(list) = lists.last_mut().filter(|_| in_list) {
                            list.invalid = true;
                        } else if let Some(prelude) = scope {
                            return Err(self.error(
                                at,
                                format!("`@scope {prelude}`: a pseudo-element cannot be a scope's root or limit; remove it or the invalid forgiving arm that contains it"),
                            ));
                        }
                        if let Some((_, _, finish)) = double_colon {
                            out.push_str(&text[start..finish]);
                            tokens = next;
                            continue;
                        }
                    } else if let Some((Tok::Function, word, end)) = after {
                        let name = decoded_name(&text[word..end - 1]);
                        if name.eq_ignore_ascii_case("is") || name.eq_ignore_ascii_case("where") {
                            blocks.push((b')', false));
                            lists.push(Branches { depth: blocks.len(), ..Branches::new() });
                            out.push_str(&text[start..end]);
                            tokens = next;
                            continue;
                        }
                    }
                }
                Tok::Function | Tok::Open => {
                    let close = closer(kind, spelling).unwrap();
                    blocks.push((close, opaque || close != b')'));
                }
                Tok::Close => {
                    let b = spelling.as_bytes()[0];
                    if !blocks.pop().is_some_and(|(close, _)| close == b) {
                        return Err(self.error(at, format!("mismatched selector block: unexpected {}", char::from(b))));
                    }
                    if b == b')' && in_list {
                        if let Some(mut list) = lists.pop() {
                            list.next();
                            let parent = lists.last_mut().unwrap_or(&mut top);
                            if blocks.len() == parent.depth {
                                why.alternative |= list.any && !list.all.owned;
                                parent.add(list.all);
                            } else {
                                why.filtered = true;
                            }
                        }
                    }
                }
                Tok::Comma if in_list => {
                    if let Some(list) = lists.last_mut() {
                        list.next();
                    } else {
                        let anchor = top.end(true, !has_ampersand).unwrap_or_default();
                        all = all.and(anchor);
                        if !anchor.owned && unowned.is_none() {
                            unowned =
                                Some(Unowned { part: text[part_start..start].trim_matches([' ', '\t', '\n']).to_string(), why });
                        }
                        part_start = end;
                        (has_ampersand, why) = (false, Why::default());
                    }
                }
                Tok::Delim(b'.') if !opaque => {
                    if let Some(&(Tok::Ident, start, end)) = tokens.peek() {
                        let class = &text[start..end];
                        if class.contains('\\') {
                            return Err(self
                                .error(at, "escaped characters in a class name are not supported in a component's stylesheet"));
                        }
                        if !class.is_ascii() {
                            return Err(self.error(
                                at,
                                "non-ASCII characters in a class name are not supported in a component's stylesheet",
                            ));
                        }
                        if class.contains("__") {
                            return Err(
                                self.error(at, format!(".{class}: __ separates the component's name from the class; use - or _"))
                            );
                        }
                        out.push('.');
                        out.push_str(self.prefix);
                        out.push_str("__");
                        out.push_str(class);
                        if !self.classes.iter().any(|name| name == class) {
                            self.classes.push(class.to_string());
                        }
                        if in_list {
                            lists.last_mut().unwrap_or(&mut top).class();
                        } else {
                            why.filtered = true;
                        }
                        tokens.next();
                        continue;
                    }
                }
                _ => {}
            }
            out.push_str(spelling);
        }
        if let Some(&(close, _)) = blocks.last() {
            return Err(self.error(at, format!("unclosed selector block: expected {}", char::from(close))));
        }
        let anchor = top.end(true, !has_ampersand).unwrap_or_default();
        all = all.and(anchor);
        if !anchor.owned && unowned.is_none() {
            unowned = Some(Unowned { part: text[part_start..].trim_matches([' ', '\t', '\n']).to_string(), why });
        }
        Ok((out, all, unowned))
    }

    /// The error for a selector the checker cannot prove is owned.
    fn unowned(&self, unowned: &Unowned, nest: Anchor, at: usize) -> String {
        let Unowned { part, why } = unowned;
        if why.sibling && nest.owned {
            return self.error(
                at,
                format!("cannot prove that `{part}` styles only elements this component owns. To keep a nested sibling condition and require a component ancestor without adding specificity, use an anchor like `:where(.list) & + p`"),
            );
        }
        let mut reason = String::new();
        if why.alternative {
            reason.push_str("; an `:is()` or `:where()` counts only when every matchable selector in it does; remove invalid arms the compiler cannot recognize");
        }
        if why.filtered {
            reason.push_str("; a class or `&` in `:not()`, `:has()` or another function only filters");
        }
        if why.sibling {
            reason.push_str("; `+` and `~` lead to an element beside the class's, not inside it");
        }
        match &self.scope_root {
            Some(root) => self.error(
                at,
                format!("`{part}` styles elements this component does not own: `@scope ({root})` can start outside the component{reason}. Give each rule one of the stylesheet's classes on the element or one it is inside, like `.list p`, or each selector of the scope root, like `@scope (.list)`"),
            ),
            None => self.error(
                at,
                format!("`{part}` styles elements this component does not own: in every selector, the element it styles or one it is inside needs one of the stylesheet's classes{reason}. Name the class where that element is, like `.list p` or `main .list p`; styles for the whole page belong in the app's stylesheet"),
            ),
        }
    }
}

/// What a selector requires of the elements it matches: one of the file's classes on the
/// element itself, on an element it is inside, or, `owned`, either (`:is(.list, .grid p)`).
#[derive(Clone, Copy, Default)]
struct Anchor {
    class: bool,
    ancestor: bool,
    owned: bool,
}

impl Anchor {
    const ALL: Anchor = Anchor { class: true, ancestor: true, owned: true };

    fn and(self, other: Anchor) -> Anchor {
        Anchor { class: self.class && other.class, ancestor: self.ancestor && other.ancestor, owned: self.owned && other.owned }
    }

    fn or(self, other: Anchor) -> Anchor {
        Anchor { class: self.class || other.class, ancestor: self.ancestor || other.ancestor, owned: self.owned || other.owned }
    }

    /// The element a combinator leads to: a descendant or child is inside this one, a sibling
    /// inside what this one is inside, and a table cell after `||` neither.
    fn across(self, combinator: char) -> Anchor {
        let ancestor = match combinator {
            ' ' | '>' => self.owned,
            '+' | '~' => self.ancestor,
            _ => false,
        };
        Anchor { class: false, ancestor, owned: ancestor }
    }
}

/// A selector list being read: a rule's, or an `:is()` or `:where()` in it.
struct Branches {
    depth: usize,
    /// What every selector before the current one requires, and whether any is owned.
    all: Anchor,
    any: bool,
    /// What the current compound selector requires, as written and with the `& ` a nested
    /// selector without `&` has in front.
    now: Anchor,
    nested: Anchor,
    /// Whether the selector has a compound selector yet, the combinator after the last one (a
    /// space for a descendant), and whether one came first.
    compound: bool,
    combinator: Option<char>,
    leading: bool,
    invalid: bool,
}

impl Branches {
    fn new() -> Branches {
        Branches {
            depth: 0,
            all: Anchor::ALL,
            any: false,
            now: Anchor::default(),
            nested: Anchor::default(),
            compound: false,
            combinator: None,
            leading: false,
            invalid: false,
        }
    }

    fn space(&mut self) {
        if self.compound && self.combinator.is_none() {
            self.combinator = Some(' ');
        }
    }

    fn explicit_combinator(&mut self, c: char) {
        self.invalid |= self.combinator.is_some_and(|c| c != ' ');
        self.combinator = Some(c);
    }

    /// A token of a compound selector: after a combinator, it starts the next one.
    fn token(&mut self, nest: Anchor, why: &mut Why) {
        let combinator = self.combinator.take();
        if !self.compound {
            self.compound = true;
            self.leading = combinator.is_some();
            self.nested = nest.across(combinator.unwrap_or(' '));
        } else if let Some(c) = combinator {
            let (now, nested) = (self.now.across(c), self.nested.across(c));
            why.sibling |= (self.now.owned && !now.owned) || (self.nested.owned && !nested.owned);
            (self.now, self.nested) = (now, nested);
        }
    }

    fn class(&mut self) {
        self.add(Anchor { class: true, ancestor: false, owned: true });
    }

    fn add(&mut self, anchor: Anchor) {
        (self.now, self.nested) = (self.now.or(anchor), self.nested.or(anchor));
    }

    /// The end of a selector, or `None` for a statically invalid one. A leading combinator is
    /// invalid inside a forgiving list, but makes a nested rule relative even with an `&`.
    fn end(&mut self, relative: bool, implicit_parent: bool) -> Option<Anchor> {
        let valid = !self.invalid && self.compound && (relative || !self.leading) && self.combinator.is_none_or(|c| c == ' ');
        let anchor = if implicit_parent || self.leading { self.nested } else { self.now };
        *self = Branches { depth: self.depth, all: self.all, any: self.any, ..Branches::new() };
        valid.then_some(anchor)
    }

    /// The end of a selector in an `:is()` or `:where()`, which drops one the browser drops.
    fn next(&mut self) {
        if let Some(anchor) = self.end(false, false) {
            self.all = self.all.and(anchor);
            self.any |= anchor.owned;
        }
    }
}

/// Why a selector does not count, for the error.
#[derive(Clone, Copy, Default)]
struct Why {
    filtered: bool,
    alternative: bool,
    sibling: bool,
}

struct Unowned {
    part: String,
    why: Why,
}

/// The opening parenthesis of a matches-any pseudo-class after its colon, if present.
/// The text inside the first parenthesis block, trimmed of trivia outside tokens, and the
/// text after it.
fn parenthesized(text: &str) -> Option<(&str, &str)> {
    let mut tokens = lexer(text);
    if !matches!(tokens.next(), Some((Tok::Open, 0, 1))) || !text.starts_with('(') {
        return None;
    }
    let mut blocks = vec![b')'];
    let (mut first, mut last) = (None, 1);
    for (kind, start, end) in tokens {
        if let Some(close) = closer(kind, &text[start..end]) {
            blocks.push(close);
        } else if kind == Tok::Close {
            if blocks.pop()? != text.as_bytes()[start] {
                return None;
            }
            if blocks.is_empty() {
                return Some((&text[first.unwrap_or(last)..last], &text[end..]));
            }
        }
        if !kind.trivia() {
            first.get_or_insert(start);
            last = end;
        }
    }
    None
}

fn block_end(text: &str) -> Option<usize> {
    let mut blocks = Vec::new();
    for (kind, start, end) in lexer(text) {
        if let Some(close) = closer(kind, &text[start..end]) {
            blocks.push(close);
        } else if kind == Tok::Close {
            if blocks.pop()? != text.as_bytes()[start] {
                return None;
            }
            if blocks.is_empty() {
                return Some(end);
            }
        }
    }
    None
}

fn legacy_pseudo_element(name: &str) -> bool {
    let name = decoded_name(name);
    ["before", "after", "first-line", "first-letter"].iter().any(|n| name.eq_ignore_ascii_case(n))
}

fn trim_leading_trivia(text: &str) -> &str {
    lexer(text).find(|&(kind, ..)| !kind.trivia()).map_or("", |(_, start, _)| &text[start..])
}

/// The prelude starts with an ident and a colon, not a delimiter or a function.
fn declaration_head(text: &str) -> Option<(usize, usize, usize)> {
    let mut tokens = lexer(text).filter(|&(kind, ..)| !kind.trivia());
    let (Tok::Ident, start, end) = tokens.next()? else { return None };
    let (Tok::Colon, _, after) = tokens.next()? else { return None };
    Some((start, end, after))
}

fn starts_custom_property(text: &str) -> bool {
    declaration_head(text)
        .is_some_and(|(start, end, _)| decoded_name(&text[start..end]).strip_prefix("--").is_some_and(|name| !name.is_empty()))
}

struct Chunk {
    end: Option<u8>,
    text: String,
    url: Option<usize>,
    joined_comment: Option<usize>,
}

/// Reads one chunk up to a rule or declaration delimiter. Each opener has its own closer:
/// CSS would consume the rest of the file for some mismatches, including the next component.
fn scan_chunk(src: &str, i: &mut usize) -> Result<Chunk, (usize, &'static str)> {
    let from = *i;
    let mut blocks = Vec::new();
    let mut text = String::new();
    let mut space = false;
    let mut pending_comment = None;
    let mut joined_comment = None;
    let mut url = None;
    let mut prev = (None, "");
    for (kind, start, end) in lexer(&src[from..]) {
        let spelling = &src[from + start..from + end];
        *i = from + start;
        match kind {
            Tok::Space => {
                space = true;
                continue;
            }
            Tok::Comment { .. } => {
                pending_comment.get_or_insert((*i, space));
                continue;
            }
            Tok::Url { closed: true } => {
                url.get_or_insert(*i);
            }
            Tok::BadUrl | Tok::Url { closed: false } => {
                return Err((*i, "a malformed unquoted url() has no reliable boundary here: quote its value or remove it"));
            }
            Tok::BadString | Tok::String { closed: false } => return Err((*i, "a string is never closed")),
            Tok::Delim(b'\\') => {
                return Err((*i, "a backslash outside a string must escape a character, not a line break"));
            }
            _ => {}
        }
        let b = spelling.as_bytes()[0];
        if blocks.is_empty() && matches!((kind, b), (Tok::Open, b'{') | (Tok::Close, b'}') | (Tok::Semicolon, _)) {
            return Ok(Chunk { end: Some(b), text, url, joined_comment });
        }
        if let Some(close) = closer(kind, spelling) {
            blocks.push(close);
        } else if kind == Tok::Close && blocks.pop() != Some(b) {
            return Err((*i, "mismatched selector block or declaration value: delimiters must close in order"));
        }
        let comment = pending_comment.take();
        if !text.is_empty() {
            if let Some((at, space_before)) = comment {
                // A space after a comment is not an escape terminator: removing the comment
                // from `\61/**/ b` lets the escape take the space and the ident take `b`.
                if !space || (!space_before && prev.1.contains('\\')) {
                    text.push_str("/**/");
                }
                // The selector proof still refuses joined comments, except between the
                // two colons of a pseudo-element.
                if !space && joined_comment.is_none() && !(prev.0 == Some(Tok::Colon) && kind == Tok::Colon) {
                    joined_comment = Some(at);
                }
            }
            if space {
                text.push(' ');
            }
        }
        space = false;
        prev = (Some(kind), spelling);
        text.push_str(spelling);
    }
    *i = src.len();
    if !blocks.is_empty() {
        return Err((*i, "a block is never closed: add its matching delimiter"));
    }
    Ok(Chunk { end: None, text, url, joined_comment })
}

fn split_declaration(text: &str) -> Option<(&str, &str)> {
    let (start, end, after) = declaration_head(text)?;
    let name = &text[start..end];
    (name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || decoded_name(name).strip_prefix("--").is_some_and(|name| !name.is_empty()))
    .then(|| (name, trim_leading_trivia(&text[after..])))
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
    fn css_scanner_fixture_agrees_with_the_macro() {
        for case in ScanCase::all() {
            if case.field("external").is_some() {
                continue;
            }
            let name = case.string("name").unwrap();
            let result = scope(case.string("css").unwrap(), "x");
            match (case.string("scoped"), case.string("refuse")) {
                (Some(expected), None) => assert_eq!(result.map(|sheet| sheet.css).as_deref(), Ok(expected), "{name}"),
                (None, Some(expected)) => {
                    let error = result.unwrap_err();
                    assert!(error.contains(expected), "{name}: {error}");
                }
                _ => panic!("{name}: specify scoped output or a refusal, not both"),
            }
        }
    }

    #[test]
    fn quoted_url_leaves_all_whitespace_after_the_opening_parenthesis_as_trivia() {
        use Tok::*;
        let css = "u\\72l(  \r\n'x') url(/* gap */ \"x\")";
        let tokens: Vec<_> = lexer(css).map(|(kind, start, end)| (kind, &css[start..end])).collect();
        assert_eq!(
            tokens,
            [
                (Function, "u\\72l("),
                (Space, "  \r\n"),
                (String { closed: true }, "'x'"),
                (Close, ")"),
                (Space, " "),
                (BadUrl, "url(/* gap */ \"x\")"),
            ]
        );
    }

    #[test]
    fn tokenizer_reports_css_tokens_and_source_spans() {
        let css = "@a #123 -.5e+2% +1.3e-2px 2e url(a/*b) u\\72l( 'z') < !-- --> /* x */ 'a\r\nb( [ { : ; , } ] )";
        let significant: Vec<_> =
            lexer(css).filter(|&(kind, ..)| kind != Tok::Space).map(|(kind, start, end)| (kind, &css[start..end])).collect();
        use Tok::*;
        assert_eq!(
            significant,
            [
                (AtKeyword, "@a"),
                (Hash, "#123"),
                (Percentage, "-.5e+2%"),
                (Dimension, "+1.3e-2px"),
                (Dimension, "2e"),
                (Url { closed: true }, "url(a/*b)"),
                (Function, "u\\72l("),
                (String { closed: true }, "'z'"),
                (Close, ")"),
                (Delim(b'<'), "<"),
                (Delim(b'!'), "!"),
                (Ident, "--"),
                (Cdc, "-->"),
                (Comment { closed: true }, "/* x */"),
                (BadString, "'a"),
                (Function, "b("),
                (Open, "["),
                (Open, "{"),
                (Colon, ":"),
                (Semicolon, ";"),
                (Comma, ","),
                (Close, "}"),
                (Close, "]"),
                (Close, ")"),
            ]
        );
        for (css, expected) in [
            ("<!--", Cdo),
            ("url(x y\\)z)", BadUrl),
            ("url(a", Url { closed: false }),
            ("\"x", String { closed: false }),
            ("1e2", Number),
            ("#.", Delim(b'#')),
            ("@1", Delim(b'@')),
        ] {
            assert_eq!(lexer(css).next().unwrap().0, expected, "{css}");
        }
        assert_eq!(decoded_name("--w\\69\r\ndth"), "--width");
        assert_eq!(decoded_name("\\d800 \0\\"), "\u{fffd}\u{fffd}\u{fffd}");
    }

    #[test]
    fn position_values_do_not_expose_comments_to_other_readers() {
        let sheet = scope("@position-try --above{top:0}.a{position-try:--above /* @media (--ghost){ */;position-try-fallbacks:var(/* note */--missing), --above}", "x").unwrap();
        assert!(sheet.media.is_empty(), "a comment did not name a breakpoint");
        assert_eq!(
            sheet.css,
            "@position-try --x__above{top:0}.x__a{position-try:--x__above;position-try-fallbacks:var(/**/--missing), --x__above}"
        );
    }

    #[test]
    fn registered_properties_do_not_rename_global_position_options() {
        let css = "@property --external{syntax:'*';inherits:false}.a{position-try:--external;position-try-fallbacks:var(--external, --external), --above;width:var(--external)}";
        let definition = "@position-try --above{top:0}";
        for (src, local) in [(format!("{css}{definition}"), "--x__above"), (css.to_string(), "--above")] {
            let sheet = scope(&src, "x").unwrap();
            assert!(sheet.css.starts_with(&format!("@property --x__external{{syntax:'*';inherits:false}}.x__a{{position-try:--external;position-try-fallbacks:var(--x__external, --external), {local};width:var(--x__external)}}")), "{}", sheet.css);
        }
    }

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
        for space in ["  ", "\r\n ", "\t\t", "\n\n", " /* a */ ", "/**/", "/*comment*/ "] {
            let css = format!("@position-try --above {{ top: 0 }} .a {{ position-try-fallbacks: --abov\\65{space}flip-block; position-try: most-width --abov\\65{space}flip-inline }}");
            let gap = if space == "/**/" { "/**/" } else { " " };
            assert_eq!(
                scope(&css, "x").unwrap().css,
                format!("@position-try --x__above{{top:0}}.x__a{{position-try-fallbacks:--x__above{gap}flip-block;position-try:most-width --x__above{gap}flip-inline}}"),
                "{space:?}"
            );
        }
        assert_eq!(
            scope(".a { position-try-fallbacks: --abov\\65\r\n\tflip-block }", "x").unwrap().css,
            ".x__a{position-try-fallbacks:--abov\\65\n flip-block}"
        );
        assert_eq!(
            scope("@position-try --above { top: 0 } .a { position-try-fallbacks: --abov\\65 , flip-block }", "x").unwrap().css,
            "@position-try --x__above{top:0}.x__a{position-try-fallbacks:--x__above, flip-block}"
        );
        assert_eq!(
            scope("@position-try --above{top:0}.a{position-try:var(--missing\\', --above)}", "x").unwrap().css,
            "@position-try --x__above{top:0}.x__a{position-try:var(--missing\\', --x__above)}"
        );
        // A no-break space is not CSS whitespace: `--above\u{a0}flip-block` is one name.
        assert_eq!(
            scope("@position-try --above { top: 0 } .a { position-try-fallbacks: --above\u{a0}flip-block, --abov\\65\u{a0}, --above\0, --above\u{fffd}, --above, \0--above }", "x").unwrap().css,
            "@position-try --x__above{top:0}.x__a{position-try-fallbacks:--above\u{a0}flip-block, --abov\\65\u{a0}, --above\u{fffd}, --above\u{fffd}, --x__above, \u{fffd}--above}"
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
    fn position_options_keep_escaped_trailing_whitespace() {
        for (definition, option) in [("", "--above"), ("@position-try --above{top:0}", "--x__above")] {
            let sheet = scope(&format!(r"{definition}.a{{position-try:  --above, --external\  ; color:red}}"), "x").unwrap();
            assert!(sheet.css.ends_with(&format!(r".x__a{{position-try:{option}, --external\ ;color:red}}")), "{}", sheet.css);
        }
        assert_eq!(scope(r".a{--value:--external\\  ;color:red}", "x").unwrap().css, r".x__a{--value:--external\\;color:red}");
    }

    #[test]
    fn shared_selector_parsing_is_unchanged_by_position_options() {
        for (source, scoped) in [
            (".a:not(.--foreign)", ".x__a:not(.x__--foreign)"),
            (".a /**/.b", ".x__a .x__b"),
            (".a/**/ .b", ".x__a .x__b"),
            (".a:is(.--a,.a)", ".x__a:is(.x__--a,.x__a)"),
        ] {
            let sheet = scope(&format!("{source}{{position-try:--above}}@position-try --above{{top:0}}"), "x").unwrap();
            assert_eq!(sheet.css, format!("{scoped}{{position-try:--x__above}}@position-try --x__above{{top:0}}"));
        }
        assert!(scope(".a:is(.é,.b){color:green}", "x").unwrap_err().contains("non-ASCII characters in a class name"));
        assert_eq!(
            scope("@scope (.a:is(:/* gap */ :marker,.b)){.a p{color:green}}", "x").unwrap().css,
            "@scope (.x__a:is(: :marker,.x__b)){.x__a p{color:green}}"
        );
        assert_eq!(scope("@LAYER foo; .a{color:green}", "x").unwrap().css, "@LAYER foo;.x__a{color:green}");
        for (source, reason) in [
            ("@IMPORT x;", "@import loads a stylesheet the component does not own"),
            (
                "@CUSTOM-MEDIA --phone (width < 40rem);",
                "@custom-media: a component's stylesheet names the token file's breakpoints",
            ),
        ] {
            let error = scope(source, "x").unwrap_err();
            assert!(error.contains(reason), "{error}");
        }
        for name in ["LAYER_other", "layer_other"] {
            let error = scope(&format!("@{name} foo; .a{{color:green}}"), "x").unwrap_err();
            assert!(error.contains(&format!("@{name} is not supported")), "{error}");
        }
        let css = "@supports (position-area:top){:is(.a,body){position-try:--above}@position-try --above{top:0}}";
        assert!(scope(css, "x").unwrap_err().contains("styles elements this component does not own"));
    }

    #[test]
    fn selector_comments_must_not_join_parts() {
        for (selector, line) in [
            (".a:is(./**/local,body)", 1),
            (".a:is(\n./**/local,body)", 2),
            (".a/**/.b", 1),
            (".a/* one *//* two */.b", 1),
            ("@scope (.a/**/.b)", 1),
            ("@scope (.a) to/**/(.b)", 1),
        ] {
            let error = scope(&format!("{selector}{{.c{{color:red}}}}"), "x").unwrap_err();
            assert!(error.starts_with(&format!("line {line}: a comment directly between two parts of a selector")), "{error}");
            assert!(error.ends_with("write the selector without it (for example `.a.b`, not `.a/**/.b`)"), "{error}");
        }
        assert_eq!(
            scope(r#"/*start*/.a[title="a/**/b"]/*end*/{--value:a/**/b}"#, "x").unwrap().css,
            r#".x__a[title="a/**/b"]{--value:a/**/b}"#
        );
    }

    #[test]
    fn braced_custom_property_values_are_refused() {
        for (before, after, line) in [
            ("", "", 1),
            (".a {\n", "}", 2),
            (".a {\n .b {\n @media (width > 0) {\n", "}}}", 4),
            ("@scope (.a) {\n", "}", 2),
            ("@keyframes x { from {\n", "}}", 2),
        ] {
            for declaration in [
                "--theme: .b {color:red}",
                "--theme /* before */ /**/ : .b/**/.c {color:red}",
                "--theme: /**/ {foo/**/bar{color:red}}",
                r"--th\65 me/**/: {color:red}",
            ] {
                let css = format!("{before}{declaration}{after}");
                let error = scope(&css, "x").unwrap_err();
                assert_eq!(
                    error,
                    format!("line {line}: a custom property whose value holds a {{ }} block at its outer level is not supported in a component stylesheet; put that declaration in the app's stylesheet (static/style.css)"),
                    "{css}"
                );
            }
        }
    }

    #[test]
    fn plain_custom_properties_and_nested_selectors_still_compile() {
        let sheet = scope(".a{--x: 1px; &:hover{} .b{}}", "x").unwrap();
        assert_eq!(sheet.css, ".x__a{--x:1px;&:hover{}.x__b{}}");
        assert_eq!(sheet.classes, ["a", "b"]);
        // A block inside a function or square brackets is part of the value, as browsers read it.
        for (value, expected) in [("f({color:red})", "f({color:red})"), ("[{color:red}]", "[{color:red}]")] {
            let sheet = scope(&format!(".a{{--x: {value}; color:blue}}"), "x").unwrap();
            assert_eq!(sheet.css, format!(".x__a{{--x:{expected};color:blue}}"));
        }
        let sheet = scope("@scope (.a){--x/**/: 1px; .b{}}", "x").unwrap();
        assert_eq!(sheet.css, "@scope (.x__a){--x:1px;.x__b{}}");
        assert_eq!(sheet.classes, ["a", "b"]);
        for css in [".a{&:hover/**/.b{color:red}}", ".a{--theme .b/**/.c{color:red}}", r".a{--th\65/**/me:hover.a{color:red}}"] {
            let error = scope(css, "x").unwrap_err();
            assert!(error.contains("a comment"), "{error}");
        }
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
        assert_eq!(scope("@charset 'utf-8'; @layer base, widgets;", "x").unwrap().css, "@layer base, widgets;");
        assert_eq!(scope("@CHARSET 'utf-8'; @LAYER a, b;", "x").unwrap().css, "@LAYER a, b;");
        let error = scope("@supports_other (position-area:top){.a{color:red}}", "x").unwrap_err();
        assert!(error.contains("@supports_other is not supported"), "{error}");
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
            (include_str!("../../corten/src/namespaced_styles.css"), "namespaced-styles", "is not supported"),
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
    fn selector_lists_require_a_positive_class_in_every_branch() {
        for selector in [
            ":not(.list) p",
            ":is(.list, main) p",
            "main:has(.list) p",
            ":where(.list, :is(.row, main)) p",
            ":nth-child(2 of .list)",
            ".list, :not(.row)",
            ":is(.list, :has(.row))",
            ":is(.list, [data-name='.row'])",
            r"#item\.list",
            r":is(.list, #item\,main)",
            r":is(.list, [data-name=x\]\.row])",
        ] {
            let css = format!("{selector} {{ color: red }}");
            let error = scope(&css, "t").expect_err(&css);
            assert!(error.contains("styles elements this component does not own"), "{error}");
        }
        let error = scope("@scope (:not(.list)) { p { color: red } }", "t").unwrap_err();
        assert!(error.contains("`p` styles elements this component does not own"), "{error}");
        let error = scope("@scope (.list, :where(.row, main)) { p { color: red } }", "t").unwrap_err();
        assert!(error.contains("`p` styles elements this component does not own"), "{error}");
    }

    #[test]
    fn a_class_reached_through_a_sibling_does_not_own_the_element() {
        // `+` and `~` lead to an element beside the class's, which is not inside it; a sibling of
        // an element inside it is, since the two share their ancestors.
        for selector in [
            ".list + main",
            ".list ~ p",
            r".list + #outside\,main",
            ":is(.list + main, .grid) p",
            ":is(.list, .grid p) + main",
            ".list || td",
        ] {
            let css = format!("{selector} {{ color: red }}");
            let error = scope(&css, "t").expect_err(&css);
            assert!(error.contains("styles elements this component does not own"), "{error}");
        }
        for selector in [".list > li + li", ".list li ~ p", ":is(.list > li, .grid p) + p", ".list + .row", ".list ~ p .row"] {
            assert!(scope(&format!("{selector} {{ color: red }}"), "t").is_ok(), "{selector}");
        }
        let error = scope("@scope (.list + main) { p { color: red } }", "t").unwrap_err();
        assert!(error.contains("`@scope (.list + main)` can start outside the component"), "{error}");
        assert!(scope("@scope (.list > li + li) { p { color: red } }", "t").is_ok());
    }

    #[test]
    fn a_nested_selector_is_checked_where_its_ampersand_is() {
        // CSS Nesting: a nested selector without `&` is under the parent rule's elements; one with
        // it means them where it stands, which `:not()` or a sibling combinator leaves.
        for css in [
            ".list { :not(&) { color: red } }",
            ".list { :is(&, main) { color: red } }",
            ".list { + main { color: red } }",
            ".list { ~ p { color: red } }",
            ".list { p:has(&) { color: red } }",
            ".list { @media print { :not(&) { color: red } } }",
            ".list { @scope (& + main) { p { color: red } } }",
        ] {
            let error = scope(css, "t").expect_err(css);
            assert!(error.contains("styles elements this component does not own"), "{css}: {error}");
        }
        for css in [
            ".list { & + main { color: red } }",
            ".list { &.on { & + main { color: red } } }",
            ".list::before, .list > p { & + p { color: red } }",
        ] {
            let error = scope(css, "t").expect_err(css);
            assert!(error.contains("cannot prove"), "{css}: {error}");
            assert!(error.contains("`:where(.list) & + p`"), "{css}: {error}");
        }
        let error = scope(".list { @scope (& + main) { p { color: red } } }", "t").unwrap_err();
        assert!(error.contains("`@scope (& + main)` can start outside the component"), "{error}");
        let error = scope(".list { @scope (& + main) { color: red } }", "t").unwrap_err();
        assert!(error.contains("styles the root of `@scope (& + main)`"), "{error}");
        for css in [
            ".list { p { color: red } }",
            ".list { > p { color: red } }",
            ".list { & p, &.on { color: red } }",
            ".list { main & { color: red } }",
            ".list { :is(&, .row) { color: red } }",
            ".list { li { & + li { color: red } } }",
            ".list { @media print { p { color: red } } }",
            ".list { @scope (main) { p { color: red } } }",
            ".list { @scope (& > li) { color: red; p { color: red } } }",
            ".list { @scope (& + main) { .row { color: red } } }",
            ".list::before, .list > p { :where(.list) & + p { color: red } }",
            "@scope (.list) { & + main { color: red } :not(&) { color: red } }",
        ] {
            assert!(scope(css, "t").is_ok(), "{css}: {:?}", scope(css, "t"));
        }
    }

    #[test]
    fn an_ampersand_in_an_invalid_attribute_is_not_a_nesting_anchor() {
        for css in [
            ".list { :is(main, [foo=&]) { color: red } }",
            ".list { @scope (:is(main, [foo=&])) to (.slot) { p { color: red } } }",
        ] {
            let error = scope(css, "t").expect_err(css);
            assert!(error.contains("styles elements this component does not own"), "{css}: {error}");
        }
        for css in [r#".list { :is(main, [foo="&"]) { color: red } }"#, r".list { :is(main, [foo=\&]) { color: red } }"] {
            assert!(scope(css, "t").is_ok(), "{css}");
        }
    }

    #[test]
    fn a_leading_combinator_is_relative_even_with_an_ampersand() {
        let css = ".list { > :not(&), > :is(main, [foo=&]) { color: red } }";
        assert_eq!(scope(css, "t").map(|s| s.css), Ok(".t__list{> :not(&), > :is(main, [foo=&]){color:red}}".into()));
        assert!(scope(".list { + :not(&) { color: red } }", "t").is_err());
    }

    #[test]
    fn pseudo_elements_and_doubled_combinators_are_dropped_in_forgiving_arms() {
        for (input, expected) in [
            (":is(.list, ::before) p { color: red }", ":is(.t__list, ::before) p{color:red}"),
            (":where(.list, main + > p) p { color: red }", ":where(.t__list, main + > p) p{color:red}"),
            ("@scope (:is(.list, ::before)) { p { color: red } }", "@scope (:is(.t__list, ::before)){p{color:red}}"),
            (
                "@scope (.list) to (:is(.slot, ::before)) { p { color: red } }",
                "@scope (.t__list) to (:is(.t__slot, ::before)){p{color:red}}",
            ),
            ("@scope (:where(.list, :BeFoRe)) { p { color: red } }", "@scope (:where(.t__list, :BeFoRe)){p{color:red}}"),
            (
                "@scope (.list:not(:is(.slot, ::before))) { p { color: red } }",
                "@scope (.t__list:not(:is(.t__slot, ::before))){p{color:red}}",
            ),
            (
                "@scope (.list:is(: /* gap */:before,.row)) { p { color: red } }",
                "@scope (.t__list:is(: :before,.t__row)){p{color:red}}",
            ),
        ] {
            assert_eq!(scope(input, "t").map(|s| s.css), Ok(expected.to_string()), "{input}");
        }
        for css in [
            ".list { :is(main, &::before) { color: red } }",
            ".list { :is(main, & + > p) { color: red } }",
            ":is(.list, main, ::before) p { color: red }",
            ":where(.list, main + p) p { color: red }",
            "@scope (.list) to (.slot::before) { p { color: red } }",
            "@scope (:not(:is(.list, ::before))) { p { color: red } }",
        ] {
            assert!(scope(css, "t").is_err(), "{css}");
        }
        let invalid_arm = ":not(::before)";
        let css = format!(":is(.list, {invalid_arm}) p {{ color: red }}");
        assert!(scope(&css, "t").unwrap_err().contains("remove invalid arms"));
        for css in [
            format!("@scope (:is(.list, {invalid_arm})) {{ p {{ color: red }} }}"),
            format!("@scope (.list) to (:is(.slot, {invalid_arm})) {{ p {{ color: red }} }}"),
        ] {
            assert!(scope(&css, "t").unwrap_err().contains("remove it or the invalid forgiving arm"), "{css}");
            assert!(scope(&css.replace(&format!(", {invalid_arm}"), ""), "t").is_ok(), "{css}");
        }
    }

    #[test]
    fn a_forgiving_list_drops_the_branches_the_browser_drops() {
        // Selectors 4: `:is()` and `:where()` drop an empty or invalid selector and match by
        // the rest; a relative one (`> p`) is invalid there.
        for (input, expected) in [
            (":is(.list,) p { color: red }", ":is(.t__list,) p{color:red}"),
            (":where(.list, > p) p { color: red }", ":where(.t__list, > p) p{color:red}"),
            (":is(.list, main >) p { color: red }", ":is(.t__list, main >) p{color:red}"),
            (":is( .list , ) p { color: red }", ":is( .t__list , ) p{color:red}"),
        ] {
            assert_eq!(scope(input, "t").map(|s| s.css), Ok(expected.to_string()), "{input}");
        }
        for css in [":is(.list, main ) p { color: red }", ":is(, main) p { color: red }", ".list, { color: red }"] {
            assert!(scope(css, "t").is_err(), "{css}");
        }
    }

    #[test]
    fn an_unowned_selector_s_error_names_what_is_missing() {
        let error = |css: &str| scope(css, "t").unwrap_err();
        // No suggestion of a selector that cannot match, like `.list main:has(.list) p`.
        let related = error("main:has(.list) p { color: red }");
        assert!(!related.contains(".list main"), "{related}");
        assert!(related.contains("`.list p` or `main .list p`"), "{related}");
        assert!(related.contains("only filters"), "{related}");
        assert!(error(":not(.list) p { color: red }").contains("only filters"));
        let optional = error(":is(.list, main) p { color: red }");
        assert!(optional.contains("every matchable selector in it"), "{optional}");
        assert!(!optional.contains("only filters"), "{optional}");
        assert!(error(".list + main { color: red }").contains("`+` and `~`"));
        assert!(error("h2 { color: red }").contains("one of the stylesheet's classes"));
        let root = error("@scope (main) { color: red }");
        assert!(!root.contains("starts at"), "{root}");
    }

    #[test]
    fn selector_functions_keep_their_classes_and_specificity() {
        let css = r#":IS(.list, :where(.row:not(.hidden), .card:has(> .image))) > p, :is(main, aside).label { color: red }"#;
        let sheet = scope(css, "t").unwrap();
        assert_eq!(
            sheet.css,
            ":IS(.t__list, :where(.t__row:not(.t__hidden), .t__card:has(> .t__image))) > p, :is(main, aside).t__label{color:red}"
        );
        assert_eq!(sheet.classes, ["list", "row", "hidden", "card", "image", "label"]);
        assert!(scope(r":\69s(.list, .row) { color: red }", "t").is_ok());
        assert!(scope(r"#item\(.list { color: red }", "t").is_ok());
        assert!(scope(r":is(.list, #item\,main.row) { color: red }", "t").is_ok());
        let scope_css = "@scope (:where(.list, :is(.row, .card))) to (:not(.slot)) { p { color: red } }";
        assert_eq!(
            scope(scope_css, "t").unwrap().css,
            "@scope (:where(.t__list, :is(.t__row, .t__card))) to (:not(.t__slot)){p{color:red}}"
        );
        let filtered = "@scope (:not(.list)) { .row { color: red } }";
        assert_eq!(scope(filtered, "t").unwrap().css, "@scope (:not(.t__list)){.t__row{color:red}}");
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
        // A style rule outside an @scope can supply the root's nesting anchor. An owned outer
        // scope bounds its nested scopes.
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
        // the component, so each rule inside names one of them, as at the top of the file.
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
        ] {
            let message = error(&format!("@scope ([data-theme=\"dark\"]) {{ {css} }}"));
            assert!(message.contains(&format!("`{part}` styles elements this component does not own")), "{message}");
            assert!(message.contains(outside), "{message}");
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
            "@scope ( /**/ ) { p { margin: 0 } }",
            "@scope (.a) to () { p { margin: 0 } }",
            "@scope (.a) to ( /**/ ) { p { margin: 0 } }",
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
    fn scope_roots_and_limits_keep_escaped_trailing_whitespace() {
        for separator in ["", " /**/ "] {
            for (id, trimmed) in [(r"#i\ ", r"#i\ "), (r"#i\\\ ", r"#i\\\ "), (r"#i\\ ", r"#i\\"), (r"#i\20 ", r"#i\20 ")] {
                for (prelude, expected) in [
                    (format!("(.a, {id}{separator})"), format!("(.x__a, {trimmed})")),
                    (format!("(.a) to (.stop, {id}{separator})"), format!("(.x__a) to (.x__stop, {trimmed})")),
                ] {
                    let sheet = scope(&format!("@scope {prelude}{{.b{{outline-style:solid}}}}"), "x").unwrap();
                    assert_eq!(sheet.css, format!("@scope {expected}{{.x__b{{outline-style:solid}}}}"), "{prelude}");
                }
            }
        }
    }

    #[test]
    fn nested_scope_roots_cannot_borrow_an_anchor_under_an_unowned_scope() {
        for (file, root) in [("leaky_nested_scope_ampersand.css", "&"), ("leaky_nested_scope_relative.css", "main")] {
            let css = std::fs::read_to_string(Path::new("../corten/src").join(file)).expect("the example's stylesheet");
            let error = scope(&css, "x").expect_err(file);
            assert!(error.contains(&format!("`@scope ({root})`")), "{file}: {error}");
            assert!(error.contains("`p` styles elements this component does not own"), "{file}: {error}");
        }
        for (css, expected) in [
            ("@scope (body) { @scope (.list) { p { outline: solid } } }", "@scope (body){@scope (.x__list){p{outline:solid}}}"),
            (
                "@scope (body) { .list { @scope (main.list) { p { outline: solid } } } }",
                "@scope (body){.x__list{@scope (main.x__list){p{outline:solid}}}}",
            ),
            (
                "@scope (body) { .list { @supports (display: block) { @scope (.list > section) { p { outline: solid } } } } }",
                "@scope (body){.x__list{@supports (display: block){@scope (.x__list > section){p{outline:solid}}}}}",
            ),
        ] {
            assert_eq!(scope(css, "x").unwrap().css, expected);
        }
        for css in [
            "@scope (body) { .list { @media print { @scope (& + main, .list) { p { outline: solid } } } } }",
            "@scope (body) { @scope (:scope > main) { .list { @scope (&) { p { color: red } } } } }",
            "@scope (body) { .list { @supports (display: block) { @scope (:is(&, .list)) { p { color: red } } } } }",
            "@scope (body) { .list { @layer local { @scope (main) to (.slot) { p { color: red } } } } }",
        ] {
            let error = scope(css, "x").unwrap_err();
            assert!(error.contains("`p` styles elements this component does not own"), "{css}: {error}");
        }
    }

    #[test]
    fn unowned_nested_scopes_can_filter_owned_rules() {
        for (input, expected) in [
            ("@scope (body) { @scope (main) { .list p { color: red } } }", "@scope (body){@scope (main){.x__list p{color:red}}}"),
            (
                "@scope (body) { @scope (:scope > main) { .list p { color: red } } }",
                "@scope (body){@scope (:scope > main){.x__list p{color:red}}}",
            ),
            (
                "@scope (body) { @scope (:scope > main, .outer) { .list p { color: red } } }",
                "@scope (body){@scope (:scope > main, .x__outer){.x__list p{color:red}}}",
            ),
            (
                "@scope (body) { @supports (display: block) { @scope (:scope > main) { .list p { color: red } } } }",
                "@scope (body){@supports (display: block){@scope (:scope > main){.x__list p{color:red}}}}",
            ),
            (
                "@scope (body) { @scope (:scope > main) to (.slot) { .list p { color: red } } }",
                "@scope (body){@scope (:scope > main) to (.x__slot){.x__list p{color:red}}}",
            ),
        ] {
            assert_eq!(scope(input, "x").map(|sheet| sheet.css), Ok(expected.to_string()), "{input}");
            let bare = input.replace(".list p", "p");
            let error = scope(&bare, "x").unwrap_err();
            assert!(error.contains("`p` styles elements this component does not own"), "{bare}: {error}");
        }
    }

    #[test]
    fn css_strings_and_urls_keep_their_token_boundaries() {
        for line_end in ["\n", "\r", "\r\n", "\x0c"] {
            for escape in ["\\", "\\61"] {
                let attr = format!("[data-value='a{escape}{line_end},p']");
                let css = format!(".list{attr} {{ outline-style:solid }}");
                assert_eq!(scope(&css, "x").unwrap().css, format!(".x__list[data-value='a{escape}\n,p']{{outline-style:solid}}"));
            }
        }
        for value in [r"url(/a[};/*,b\).svg)", r"\75 rl(/a[};,b.svg)", "URL(  '/a,).svg')"] {
            let css = format!(".list {{ background: {value} }}");
            let output_value = if value.starts_with("URL") { "URL( '/a,).svg')" } else { value };
            assert_eq!(scope(&css, "x").unwrap().css, format!(".x__list{{background:{output_value}}}"));
        }
        for value in ["url(a' )", "URL(a\" )", r"\75 rl(a' )", "url(a b)", "url(a\\\rb)"] {
            let css = format!(".list {{ background: {value} }}");
            let error = scope(&css, "x").unwrap_err();
            assert!(error.contains("a malformed unquoted url()"), "{css}: {error}");
        }
        for css in [
            ":is(.list,[x=url(a)]) { outline-style:solid }",
            "@scope (:is(.list,[x=url(a)])) { p { outline-style:solid } }",
            "@scope (.list) to (:is(.slot,[x=url(a)])) { p { outline-style:solid } }",
        ] {
            let error = scope(css, "x").unwrap_err();
            assert!(error.contains("an unquoted url() cannot be checked in a component selector"), "{css}: {error}");
        }
    }

    #[test]
    fn selector_hex_escapes_consume_one_css_line_break() {
        for line_end in ["\n", "\r", "\r\n", "\x0c"] {
            let css = format!(".list:\\65{line_end}mpty + p {{ outline-style:solid }}");
            let error = scope(&css, "x").unwrap_err();
            assert!(error.contains("styles elements this component does not own"), "{css:?}: {error}");
        }
    }

    #[test]
    fn escaped_matches_any_functions_keep_their_anchor_across_css_line_breaks() {
        for line_end in ["\n", "\r", "\r\n", "\x0c"] {
            let css = format!(":i\\73{line_end}(.list) {{ outline-style:solid }}");
            assert_eq!(scope(&css, "x").unwrap().css, ":i\\73\n(.x__list){outline-style:solid}");
        }
    }

    #[test]
    fn selector_blocks_must_close_in_order() {
        for selector in [":is([x=&(], .list) ], p)", ":not(&) :is(.list[x=(], .list) ], p)"] {
            let css = format!(".list {{ {selector} {{ outline-style:solid }} }}");
            let error = scope(&css, "x").unwrap_err();
            assert!(error.contains("mismatched selector block"), "{css}: {error}");
        }
    }

    #[test]
    fn non_ascii_selector_characters_are_name_characters_not_spaces() {
        for class in [".list\u{a0}", ".\u{a0}list", ".-\u{a0}list"] {
            let css = format!(".list {class} {{ outline-style:solid }}");
            let error = scope(&css, "x").unwrap_err();
            assert!(error.contains("non-ASCII characters in a class name"), "{css:?}: {error}");
        }
        let css = ":is(.list, em + \u{a0} + p) { outline-style:solid }";
        let error = scope(css, "x").unwrap_err();
        assert!(error.contains("styles elements this component does not own"), "{css:?}: {error}");

        for (prelude, reason) in [
            ("@scope (.list\u{a0})", "non-ASCII characters in a class name"),
            ("@scope (.list) to (.slot\u{a0})", "non-ASCII characters in a class name"),
            ("@scope (.list)\u{a0}to (.slot)", "the browser drops an @scope"),
            ("@scope (.list) to\u{a0} (.slot)", "the browser drops an @scope"),
            ("@scope (.list) to (.slot) \u{a0}", "the browser drops an @scope"),
        ] {
            let css = format!("{prelude} {{ p {{ outline-style:solid }} }}");
            let error = scope(&css, "x").unwrap_err();
            assert!(error.contains(reason), "{css:?}: {error}");
        }

        for (css, name) in [
            ("@scope\u{a0}(.list) { p { outline-style:solid } }", r"@scope\u{a0}"),
            ("@media\u{a0}screen { .list { outline-style:solid } }", r"@media\u{a0}screen"),
            ("@layer\u{a0}base { .list { outline-style:solid } }", r"@layer\u{a0}base"),
            ("@layer\u{a0}base, kit;", r"@layer\u{a0}base"),
        ] {
            let error = scope(css, "x").unwrap_err();
            assert!(error.contains(&format!("the at-rule name `{name}` contains a non-ASCII character")), "{css:?}: {error}");
        }
        let css = "@page \u{a0}x-slip { size: A4 }";
        let error = scope(css, "x").unwrap_err();
        assert!(error.contains("the page name `\\u{a0}x-slip` contains a non-ASCII character"), "{css:?}: {error}");

        let css = "@scope (\u{a0} .list) to (.slot \u{a0}) { p { outline-style:solid } }";
        assert_eq!(scope(css, "x").unwrap().css, "@scope (\u{a0} .x__list) to (.x__slot \u{a0}){p{outline-style:solid}}");

        let css = "@scope (\u{a0}) { .list { outline-style:solid } }";
        assert_eq!(scope(css, "x").unwrap().css, "@scope (\u{a0}){.x__list{outline-style:solid}}");
        let css = "@scope (\u{a0}) { p { outline-style:solid } }";
        let error = scope(css, "x").unwrap_err();
        assert!(error.contains("styles elements this component does not own"), "{css:?}: {error}");
    }

    #[test]
    fn the_compile_fail_selector_examples_fail_for_their_reasons() {
        for (file, reason) in [
            ("negated_list.css", "`:not(.list) p` styles elements this component does not own"),
            ("optional_list.css", "`:is(.list, main) p` styles elements this component does not own"),
            ("related_list.css", "`main:has(.list) p` styles elements this component does not own"),
            ("sibling_list.css", "`.list + main` styles elements this component does not own"),
            ("negated_nest.css", "`:not(&)` styles elements this component does not own"),
            ("invalid_nest_ampersand.css", "`:is(main, [foo=&])` styles elements this component does not own"),
            ("malformed_selector_url.css", "a malformed unquoted url()"),
            ("malformed_selector_ff.css", "a string is never closed"),
            ("malformed_selector_cr.css", "a string is never closed"),
            ("escaped_sibling.css", "styles elements this component does not own"),
            ("crossed_selector_blocks.css", "mismatched selector block"),
            ("crossed_selector_after_not.css", "mismatched selector block"),
            ("non_ascii_class.css", "non-ASCII characters in a class name"),
            ("joined_selector_comment.css", "a comment directly between two parts of a selector"),
            ("braced_custom_property.css", "line 2: a custom property whose value holds a { } block at its outer level"),
            (
                "invalid_scope_ampersand.css",
                "`p` styles elements this component does not own: `@scope (:is(main, [foo=&]))` can start outside the component",
            ),
            (
                "sibling_scope.css",
                "`p` styles elements this component does not own: `@scope (& + main)` can start outside the component",
            ),
            (
                "negated_scope.css",
                "`p` styles elements this component does not own: `@scope (:not(.list))` can start outside the component",
            ),
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
    fn a_registered_property_does_not_rename_other_css_names() {
        let sheet = scope(
            "@property --t { syntax: '*'; inherits: false }
             .a { --t: 1; anchor-name: --t; view-transition-name: --t; view-timeline-name: --t; animation-timeline: --t; font-palette: --t; container-name: --t }",
            "x",
        )
        .unwrap();
        assert_eq!(sheet.css, "@property --x__t{syntax:'*';inherits:false}.x__a{--x__t:1;anchor-name:--t;view-transition-name:--t;view-timeline-name:--t;animation-timeline:--t;font-palette:--t;container-name:--t}");
    }

    #[test]
    fn registered_property_references_are_scoped_in_declarations_and_queries() {
        let sheet = scope(
            r#"@property --t { syntax: '<length>'; inherits: false; initial-value: 2px }
               @font-palette-values --t { font-family: X }
               .a { --t: 24px; container: --t / inline-size }
               .b { --\74: 17px; width: var(--missing, v\61 r(\2d -t, --t));
                    position: absolute; position-anchor: --t; top: anchor(--t bottom);
                    view-transition-name: --t; view-transition-class: --t;
                    scroll-timeline-name: --t; timeline-scope: --t; position-try: --t;
                    font-palette: --t; --raw: --t; --attr: attr(--t, --t);
                    --fn: --t(--t); background: u\72l(--t); content: "var(--t)" }
               @container --t style(--t: 24px) { .b { height: 8px } }
               .b[data-kind=--t] { --escaped: attr(--\74); --url: url("--t") }"#,
            "x",
        )
        .unwrap();
        assert_eq!(
            sheet.css,
            concat!(
                "@property --x__t{syntax:'<length>';inherits:false;initial-value:2px}",
                "@font-palette-values --t{font-family:X}",
                ".x__a{--x__t:24px;container:--t / inline-size}",
                r#".x__b{--x__t:17px;width:var(--missing, v\61 r(--x__t, --t));"#,
                "position:absolute;position-anchor:--t;top:anchor(--t bottom);view-transition-name:--t;",
                "view-transition-class:--t;scroll-timeline-name:--t;timeline-scope:--t;position-try:--t;font-palette:--t;",
                r#"--raw:--t;--attr:attr(--t, --t);--fn:--t(--t);background:u\72l(--t);content:"var(--t)"}"#,
                "@container --t style(--x__t: 24px){.x__b{height:8px}}",
                r#".x__b[data-kind=--t]{--escaped:attr(--\74);--url:url("--t")}"#,
            )
        );
    }

    #[test]
    fn registered_property_lookups_in_container_size_queries() {
        let sheet = scope(
            "@property --t { syntax: '<length>'; inherits: false; initial-value: 20px }
             .a { container: --t / inline-size }
             @container --t (width > var(--t)) { .b { width: 24px } }
             @container --t (width > calc(var(--t) + 1px)) { .b { height: 24px } }",
            "x",
        )
        .unwrap();
        assert_eq!(
            sheet.css,
            concat!(
                "@property --x__t{syntax:'<length>';inherits:false;initial-value:20px}",
                ".x__a{container:--t / inline-size}",
                "@container --t (width > var(--x__t)){.x__b{width:24px}}",
                "@container --t (width > calc(var(--x__t) + 1px)){.x__b{height:24px}}",
            )
        );
    }

    #[test]
    fn registered_property_lookups_in_if_conditions() {
        let sheet = scope(
            "@property --t { syntax: '*'; inherits: false; initial-value: else }
             .a { width: if(var(--t): 24px; else: 1px);
                  height: if(style(--t: else): 24px; else: 1px) }",
            "x",
        )
        .unwrap();
        assert_eq!(
            sheet.css,
            concat!(
                "@property --x__t{syntax:'*';inherits:false;initial-value:else}",
                ".x__a{width:if(var(--x__t): 24px; else: 1px);height:if(style(--x__t: else): 24px; else: 1px)}",
            )
        );
    }

    #[test]
    fn registered_property_style_test_in_var_fallback_feeding_if_condition() {
        let sheet = scope(
            "@property --t { syntax: '<length>'; inherits: false; initial-value: 20px }
             .a { width: if(var(--missing, style(--t: 20px)): 24px; else: 1px);
                  --raw: var(--missing, style(--t: 20px)) }",
            "x",
        )
        .unwrap();
        assert_eq!(
            sheet.css,
            concat!(
                "@property --x__t{syntax:'<length>';inherits:false;initial-value:20px}",
                ".x__a{width:if(var(--missing, style(--x__t: 20px)): 24px; else: 1px);",
                "--raw:var(--missing, style(--t: 20px))}",
            )
        );
    }

    #[test]
    fn registered_property_style_test_in_if_branch_feeding_if_condition() {
        let sheet = scope(
            "@property --t { syntax: '<length>'; inherits: false; initial-value: 20px }
             .a { width: if(if(else: style(--t: 20px)): 24px; else: 1px);
                  --raw: if(else: style(--t: 20px)) }",
            "x",
        )
        .unwrap();
        assert_eq!(
            sheet.css,
            concat!(
                "@property --x__t{syntax:'<length>';inherits:false;initial-value:20px}",
                ".x__a{width:if(if(else: style(--x__t: 20px)): 24px; else: 1px);",
                "--raw:if(else: style(--t: 20px))}",
            )
        );
    }

    #[test]
    fn registered_property_style_tests_in_substitution_results_feeding_if_conditions() {
        for (input, scoped) in [
            ("inherit(--missing, style(--t: 20px))", "inherit(--missing, style(--x__t: 20px))"),
            ("attr(--t type(*), style(--t: 20px))", "attr(--t type(*), style(--x__t: 20px))"),
            ("env(--t, style(--t: 20px))", "env(--t, style(--x__t: 20px))"),
            (
                "random-item(--t, style(--t: 20px), {style(--t: 20px)})",
                "random-item(--t, style(--x__t: 20px), {style(--x__t: 20px)})",
            ),
            ("ident(--t)", "ident(--t)"),
        ] {
            let sheet = scope(
                &format!(
                    "@property --t {{ syntax: '<length>'; inherits: false; initial-value: 20px }}
                     .a {{ width: if({input}: 24px; else: 1px); --raw: {input} }}"
                ),
                "x",
            )
            .unwrap();
            assert_eq!(
                sheet.css,
                format!(
                    "@property --x__t{{syntax:'<length>';inherits:false;initial-value:20px}}\
                     .x__a{{width:if({scoped}: 24px; else: 1px);--raw:{input}}}"
                ),
                "{input}"
            );
        }
    }

    #[test]
    fn only_substitution_result_slots_carry_the_enclosing_condition() {
        let sheet = scope(
            "@property --t { syntax: '*'; inherits: false }
             .a { width: if({attr(var(--missing, data-test) type(*), {env(--t, style(--t: style(--t)))})}: 24px; else: 1px);
                  --raw: if(else: attr(data-test type(*), style(--t))) }",
            "x",
        )
        .unwrap();
        assert_eq!(
            sheet.css,
            concat!(
                "@property --x__t{syntax:'*';inherits:false}",
                ".x__a{width:if({attr(var(--missing, data-test) type(*), {env(--t, style(--x__t: style(--t)))})}: 24px; else: 1px);",
                "--raw:if(else: attr(data-test type(*), style(--t)))}",
            )
        );
    }

    #[test]
    fn registered_property_lookups_with_brace_wrapped_names() {
        let sheet = scope(
            r"@property --t { syntax: '*'; inherits: false }
              .a { width: var({--t}, 1px); height: inherit({--\74}, 1px);
                   --raw: var(--missing, {--t}); --computed: var({var(--missing, --t)}, 1px) }",
            "x",
        )
        .unwrap();
        assert_eq!(
            sheet.css,
            concat!(
                "@property --x__t{syntax:'*';inherits:false}",
                ".x__a{width:var({--x__t}, 1px);height:inherit({--x__t}, 1px);",
                "--raw:var(--missing, {--t});--computed:var({var(--missing, --t)}, 1px)}",
            )
        );
    }

    #[test]
    fn custom_properties_in_conditions_and_property_lists() {
        let sheet = scope(
            "@property --t { syntax: '*'; inherits: false }
             @supports (--t: --t) and (font-palette: --t) { .a { --t: --t } }
             @container --t (style((--t) and (0 < --t <= var(--t))) and style(--t: --t)) { .a { --t: --t } }
             .a { --paint: if(style(--t: --t): --t; else: style(--t));
                  width: inherit(--t, var(--t)); transition: --t 1s, var(--choice, --t 2s);
                  transition-property: opacity, --t; will-change: --t, opacity }",
            "x",
        )
        .unwrap();
        assert_eq!(
            sheet.css,
            concat!(
                "@property --x__t{syntax:'*';inherits:false}",
                "@supports (--x__t: --t) and (font-palette: --t){.x__a{--x__t:--t}}",
                "@container --t (style((--x__t) and (0 < --x__t <= var(--x__t))) and style(--x__t: --t)){.x__a{--x__t:--t}}",
                ".x__a{--paint:if(style(--x__t: --t): --t; else: style(--t));width:inherit(--x__t, var(--x__t));",
                "transition:--x__t 1s, var(--choice, --x__t 2s);transition-property:opacity, --x__t;will-change:--x__t, opacity}",
            )
        );
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
