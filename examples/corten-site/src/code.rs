//! A piece of source on the page, colored on the server: no highlighter is sent to the browser.
use corten::prelude::*;

/// What the source is written in, which decides how it is read.
#[derive(Clone, Copy, PartialEq)]
pub enum Lang {
    Rust,
    Js,
    Css,
    /// Commands: a `#` starts a comment.
    Shell,
    /// The compiler's own words: `error` lines stand out, its gutter recedes.
    Rustc,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Kind {
    Plain,
    Keyword,
    Text,
    Comment,
    Mark,
    Number,
    Fault,
    Faint,
}

const RUST_WORDS: &[&str] = &[
    "as", "async", "await", "const", "else", "enum", "fn", "for", "if", "impl", "in", "let", "match", "mod", "move", "mut",
    "pub", "return", "self", "struct", "use", "where",
];
const JS_WORDS: &[&str] =
    &["const", "else", "export", "for", "function", "if", "import", "let", "new", "of", "return", "await", "async"];
const CSS_WORDS: &[&str] = &["media"];

/// The source as runs of one kind each, in order, covering all of it.
pub(crate) fn runs(lang: Lang, source: &str) -> Vec<(Kind, &str)> {
    let mut out: Vec<(Kind, &str)> = Vec::new();
    let mut push = |kind: Kind, from: usize, to: usize| {
        if from < to {
            out.push((kind, &source[from..to]));
        }
    };
    match lang {
        Lang::Shell | Lang::Rustc => {
            let mut at = 0;
            for line in source.split_inclusive('\n') {
                let end = at + line.len();
                let trimmed = line.trim_start();
                let kind = match lang {
                    Lang::Shell if trimmed.starts_with('#') => Kind::Comment,
                    Lang::Shell => Kind::Plain,
                    _ if trimmed.starts_with("error") => Kind::Fault,
                    _ if trimmed.starts_with("-->") || trimmed.starts_with('=') || trimmed.starts_with("...") => Kind::Faint,
                    _ => Kind::Plain,
                };
                // A command's own comment, after it on the line.
                match (lang, kind, line.find("  # ")) {
                    (Lang::Shell, Kind::Plain, Some(note)) => {
                        push(Kind::Plain, at, at + note);
                        push(Kind::Comment, at + note, end);
                    }
                    _ => push(kind, at, end),
                }
                at = end;
            }
        }
        Lang::Rust | Lang::Js | Lang::Css => {
            let words = match lang {
                Lang::Rust => RUST_WORDS,
                Lang::Css => CSS_WORDS,
                _ => JS_WORDS,
            };
            let bytes = source.as_bytes();
            let (mut at, mut plain) = (0, 0);
            while at < bytes.len() {
                let rest = &source[at..];
                let byte = bytes[at];
                let (kind, len) = if lang != Lang::Css && rest.starts_with("//") {
                    (Kind::Comment, rest.find('\n').unwrap_or(rest.len()))
                } else if rest.starts_with("/*") {
                    (Kind::Comment, rest.find("*/").map_or(rest.len(), |end| end + 2))
                } else if byte == b'"' || (lang == Lang::Js && byte == b'`') || (lang != Lang::Rust && byte == b'\'') {
                    let mut end = 1;
                    while end < rest.len() && rest.as_bytes()[end] != byte {
                        end += if rest.as_bytes()[end] == b'\\' { 2 } else { 1 };
                    }
                    (Kind::Text, (end + 1).min(rest.len()))
                } else if lang == Lang::Rust && rest.starts_with("#[") {
                    (Kind::Mark, rest.find(']').map_or(rest.len(), |end| end + 1))
                } else if lang == Lang::Css && byte == b'#' && rest[1..].starts_with(|c: char| c.is_ascii_hexdigit()) {
                    // A color.
                    (Kind::Number, 1 + rest[1..].find(|c: char| !c.is_ascii_alphanumeric()).unwrap_or(rest.len() - 1))
                } else if byte.is_ascii_alphabetic() || byte == b'_' {
                    let len = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(rest.len());
                    let word = &rest[..len];
                    if words.contains(&word) {
                        (Kind::Keyword, len)
                    } else if rest[len..].starts_with('!') {
                        (Kind::Mark, len + 1)
                    } else {
                        (Kind::Plain, len)
                    }
                } else if byte.is_ascii_digit() {
                    (
                        Kind::Number,
                        rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '_')).unwrap_or(rest.len()),
                    )
                } else {
                    (Kind::Plain, rest.chars().next().map_or(1, char::len_utf8))
                };
                if kind == Kind::Plain {
                    at += len;
                    continue;
                }
                push(Kind::Plain, plain, at);
                push(kind, at, at + len);
                at += len;
                plain = at;
            }
            push(Kind::Plain, plain, source.len());
        }
    }
    out
}

/// Source with the file it is from (empty for none). Styled by `code.css`.
#[component(css)]
pub fn Code<'a>(file: &'a str, lang: Lang, source: &'a str) -> impl Render {
    let runs = runs(lang, source);
    html! {
        <figure class={Code}>
            if !file.is_empty() {
                <figcaption class={File}>{file}</figcaption>
            }
            <pre class={Source}>
                <code>
                    for (kind, text) in &runs {
                        match kind {
                            Kind::Plain => <span>{text}</span>,
                            Kind::Keyword => <span class={Keyword}>{text}</span>,
                            Kind::Text => <span class={Text}>{text}</span>,
                            Kind::Comment => <span class={Comment}>{text}</span>,
                            Kind::Mark => <span class={Mark}>{text}</span>,
                            Kind::Number => <span class={Number}>{text}</span>,
                            Kind::Fault => <span class={Fault}>{text}</span>,
                            Kind::Faint => <span class={Faint}>{text}</span>,
                        }
                    }
                </code>
            </pre>
        </figure>
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_cover_the_source_in_order() {
        let source = "#[component(js)]\npub fn Counter() -> impl Render {\n    html! { \"Clicks: \" } // 14.5 KB\n}\n";
        let read = runs(Lang::Rust, source);
        assert_eq!(read.iter().map(|(_, text)| *text).collect::<String>(), source);
        assert!(read.contains(&(Kind::Mark, "#[component(js)]")) && read.contains(&(Kind::Keyword, "fn")));
        assert!(read.contains(&(Kind::Mark, "html!")) && read.contains(&(Kind::Text, "\"Clicks: \"")));
        assert!(read.contains(&(Kind::Comment, "// 14.5 KB")));
    }

    #[test]
    fn a_stylesheet_is_read_too() {
        let source = "/* Tile */\n.tile {\n  gap: 2px;\n  color: #fbe7b5;\n}\n";
        let read = runs(Lang::Css, source);
        assert_eq!(read.iter().map(|(_, text)| *text).collect::<String>(), source);
        assert!(read.contains(&(Kind::Comment, "/* Tile */")) && read.contains(&(Kind::Number, "2px")));
        assert!(read.contains(&(Kind::Number, "#fbe7b5")));
    }

    #[test]
    fn a_command_keeps_its_comment_apart() {
        let read = runs(Lang::Shell, "corten dev  # serves http://localhost:3000\n");
        assert_eq!(read, [(Kind::Plain, "corten dev"), (Kind::Comment, "  # serves http://localhost:3000\n")]);
    }
}
