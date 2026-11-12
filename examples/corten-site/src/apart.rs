//! One component of this page taken apart: the wall, as the three files it is. A Corten
//! component is a function of markup, a stylesheet and a script, and the refs, handler calls
//! and classes one file gives another are checked when the crate compiles. The page shows each
//! file cut to the lines where the three meet, with those names marked, so a reader sees what
//! holds the files together before the next exhibit breaks it. The whole files are behind a
//! disclosure, every shared name marked, the one nothing checks among them (a data attribute
//! the script reads back). The files are the ones the page runs, read at compile time: nothing
//! here is a sample.
use std::sync::LazyLock;

use corten::prelude::*;

use crate::{
    Here,
    code::{Kind, Lang, runs},
    looks::{Built, Slab},
};

/// The elements the wall's markup names for its script.
const REFS: [&str; 2] = ["grid", "readout"];

/// The functions its markup calls.
const CALLS: [&str; 2] = ["order", "scatter"];

/// The classes its stylesheet has, besides one for each of the twelve heats.
const CLASSES: [&str; 6] = ["wall", "controls", "press", "readout", "grid", "tile"];

/// The data attribute the markup writes and the script reads: a string, which nothing checks.
const DATA: &str = "reading";

/// The name marked when the page is drawn, so one tie is seen without pointing at any: the
/// function the wall's first link calls.
const LIT: &str = "call:order";

/// How a piece of a file is drawn: as source of some kind, as one end of a tie, or as the
/// count of lines a cut passes over.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Mark {
    Plain,
    Keyword,
    Text,
    Comment,
    Macro,
    Number,
    /// An element the markup names and the script is given.
    Ref,
    /// A function the markup calls and the script exports.
    Call,
    /// A class the markup writes and the stylesheet has.
    Class,
    /// A data attribute the markup writes and the script reads.
    Data,
    /// Lines of the file not shown here.
    Gap,
}

struct Piece {
    mark: Mark,
    text: &'static str,
    /// What ties this piece to its other ends (`ref:grid`); empty for source that is no tie.
    seam: String,
    /// For a gap, how many lines it passes over.
    passed: usize,
}

impl Piece {
    fn source(mark: Mark, text: &'static str, seam: String) -> Self {
        Piece { mark, text, seam, passed: 0 }
    }
}

/// What a tie is, said under the file a reader follows it into: its kind, the name to follow,
/// how the markup writes it, and what holds it.
type Tie = (Mark, &'static str, &'static str, &'static str);

const TIES: [Tie; 3] = [
    (
        Mark::Call,
        "call:order",
        "js::order(..)",
        " in the markup is this function. Rename either one, or pass it other arguments, and the crate does not compile.",
    ),
    (
        Mark::Ref,
        "ref:grid",
        "ref={grid}",
        " is the element this function is handed, and the JSDoc above it says what kind. Pass it the readout instead and the build fails: the fourth break below is that error.",
    ),
    (
        Mark::Class,
        "class:grid",
        "class={Grid}",
        " is this rule, scoped to the component when the crate compiles. A class the stylesheet lacks fails the build.",
    ),
];

struct Shown {
    name: &'static str,
    what: &'static str,
    /// How many lines the file has, and how many of them the cut shows.
    lines: usize,
    kept: usize,
    /// The file cut to the lines where it meets the others.
    cut: Vec<Piece>,
    /// All of it.
    whole: Vec<Piece>,
    /// The whole file's name for a screen reader, apart from the cut's.
    whole_label: String,
    /// The ties explained under this file's cut.
    ties: &'static [Tie],
}

fn class(name: &str) -> bool {
    CLASSES.contains(&name) || name.strip_prefix("heat").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Whether `word` is one end of a tie where it stands: `before` and `after` are the source
/// around it in its run.
fn tie(lang: Lang, kind: Kind, word: &str, before: &str, after: &str) -> Option<(Mark, String)> {
    let named = REFS.contains(&word).then(|| (Mark::Ref, format!("ref:{word}")));
    let data = || Some((Mark::Data, format!("data:{word}")));
    match (lang, kind) {
        (Lang::Rust, Kind::Plain) if word == DATA && before.ends_with("data-") => data(),
        (Lang::Js, Kind::Plain) if word == DATA && before.ends_with("dataset.") => data(),
        (Lang::Rust, Kind::Plain) if CALLS.contains(&word) && before.ends_with("js::") => {
            Some((Mark::Call, format!("call:{word}")))
        }
        // A class is written as a constant, `Tile`; the component's own name before its
        // lifetime is the function, not the class.
        (Lang::Rust, Kind::Plain) if word.starts_with(|c: char| c.is_ascii_uppercase()) => {
            let name = word.to_ascii_lowercase();
            (class(&name) && !after.starts_with('<')).then(|| (Mark::Class, format!("class:{name}")))
        }
        (Lang::Rust, Kind::Plain) => named,
        (Lang::Js, Kind::Plain) if CALLS.contains(&word) && after.starts_with('(') => Some((Mark::Call, format!("call:{word}"))),
        (Lang::Js, Kind::Plain) => named,
        // The JSDoc that types an element is a comment, and names it after its type.
        (Lang::Js, Kind::Comment) => named.filter(|_| before.ends_with("} ")),
        (Lang::Css, Kind::Plain) => (before.ends_with('.') && class(word)).then(|| (Mark::Class, format!("class:{word}"))),
        _ => None,
    }
}

/// Source as pieces, in order, covering all of it.
fn pieces(lang: Lang, source: &'static str) -> Vec<Piece> {
    let mut out = Vec::new();
    for (kind, text) in runs(lang, source) {
        let mark = match kind {
            Kind::Keyword => Mark::Keyword,
            Kind::Text => Mark::Text,
            Kind::Comment => Mark::Comment,
            Kind::Mark => Mark::Macro,
            Kind::Number => Mark::Number,
            _ => Mark::Plain,
        };
        let bytes = text.as_bytes();
        let (mut at, mut plain) = (0, 0);
        while at < bytes.len() {
            let word = bytes[at].is_ascii_alphabetic() || bytes[at] == b'_';
            if !word {
                at += 1;
                continue;
            }
            let end = text[at..].find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).map_or(text.len(), |len| at + len);
            if let Some((tied, seam)) = tie(lang, kind, &text[at..end], &text[..at], &text[end..]) {
                if plain < at {
                    out.push(Piece::source(mark, &text[plain..at], String::new()));
                }
                out.push(Piece::source(tied, &text[at..end], seam));
                plain = end;
            }
            at = end;
        }
        if plain < text.len() {
            out.push(Piece::source(mark, &text[plain..], String::new()));
        }
    }
    out
}

/// Where a file is cut: the text a stretch starts at the line of, and how many lines it runs.
type Cut = (&'static str, usize);

/// The lines of the wall's function that carry a tie: where its refs are made, the link that
/// calls the script, and the two elements the script is handed.
const MARKUP_CUTS: [Cut; 4] = [("#[component(css, js)]", 3), ("<a\n", 8), ("<output ref={readout}", 1), ("<div ref={grid}", 1)];

/// The function that link calls, with the JSDoc its arguments are checked against.
const SCRIPT_CUTS: [Cut; 1] = [("/**\n * @param {MouseEvent} event", 13)];

/// Where the rules of the classes those lines of markup write start, and the grid's rule whole.
const STYLE_CUTS: [Cut; 3] = [(".press {", 1), (".readout {", 1), (".grid {", 5)];

/// The stretches of `source` the cuts name, each as its byte range, in the file's order. A cut
/// whose text is not in the file after the one before it is left out (a test says none is).
fn stretches(source: &str, cuts: &[Cut]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut at = 0;
    for &(from, lines) in cuts {
        let Some(found) = source[at..].find(from) else { continue };
        let start = source[..at + found].rfind('\n').map_or(0, |line| line + 1);
        let end = start + source[start..].split_inclusive('\n').take(lines).map(str::len).sum::<usize>();
        out.push((start, end));
        at = end;
    }
    out
}

/// How far a stretch's least indented line is indented.
fn indent(stretch: &str) -> usize {
    stretch
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start_matches(' ').len())
        .min()
        .unwrap_or(0)
}

/// Pieces with `indent` spaces taken off the start of each line, a piece per line it runs over.
fn outdent(pieces: Vec<Piece>, indent: usize) -> Vec<Piece> {
    let mut out = Vec::new();
    let mut fresh = true;
    for piece in pieces {
        let mut rest = piece.text;
        while !rest.is_empty() {
            if fresh {
                rest = &rest[rest.bytes().take(indent).take_while(|byte| *byte == b' ').count()..];
            }
            let line = rest.find('\n').map_or(rest.len(), |end| end + 1);
            if line > 0 {
                out.push(Piece::source(piece.mark, &rest[..line], piece.seam.clone()));
            }
            fresh = rest[..line].ends_with('\n');
            rest = &rest[line..];
        }
    }
    out
}

/// A file cut to its stretches, with the count of lines passed over between them. Blank lines
/// between two stretches are kept as they are. Stretches from inside nested markup lose the
/// indent they all share, so they start at the plate's edge and keep their depth to each other.
fn cut(lang: Lang, source: &'static str, cuts: &[Cut]) -> Vec<Piece> {
    let mut out = Vec::new();
    let stretches = stretches(source, cuts);
    let shared =
        stretches.iter().map(|&(start, end)| indent(&source[start..end])).filter(|indent| *indent > 0).min().unwrap_or(0);
    let pass = |out: &mut Vec<Piece>, from: usize, to: usize| {
        let passed = &source[from..to];
        if passed.trim().is_empty() {
            if !passed.is_empty() {
                out.push(Piece::source(Mark::Plain, passed, String::new()));
            }
        } else {
            out.push(Piece { mark: Mark::Gap, text: "", seam: String::new(), passed: passed.lines().count() });
        }
    };
    let mut at = 0;
    for (start, end) in stretches {
        pass(&mut out, at, start);
        let stretch = pieces(lang, &source[start..end]);
        out.extend(if indent(&source[start..end]) > 0 { outdent(stretch, shared) } else { stretch });
        at = end;
    }
    pass(&mut out, at, source.len());
    out
}

/// The wall's function, cut from `surface.rs` as it is written.
fn markup() -> &'static str {
    let source = include_str!("surface.rs");
    let from = source.find("#[component(css, js)]\npub(crate) fn Wall").unwrap_or(0);
    let to = source[from..].find("\n}\n").map_or(source.len(), |end| from + end + 3);
    &source[from..to]
}

static FILES: LazyLock<[Shown; 3]> = LazyLock::new(|| {
    let file = |name: &'static str, what, lang, source: &'static str, cuts: &[Cut], ties| Shown {
        name,
        what,
        lines: source.lines().count(),
        kept: stretches(source, cuts).iter().map(|&(start, end)| source[start..end].lines().count()).sum(),
        cut: cut(lang, source, cuts),
        whole: pieces(lang, source),
        whole_label: format!("{name}, the whole file"),
        ties,
    };
    let mut files = [
        file("src/surface.rs", "fn Wall, the markup", Lang::Rust, markup(), &MARKUP_CUTS, &TIES[..0]),
        file("src/wall.js", "the script", Lang::Js, include_str!("wall.js"), &SCRIPT_CUTS, &TIES[..2]),
        file("src/wall.css", "the stylesheet", Lang::Css, include_str!("wall.css"), &STYLE_CUTS, &TIES[2..]),
    ];
    // A name is marked in a cut only where its other end is in another cut, so every marked
    // name there can be followed without opening the whole files.
    let seen: Vec<Vec<String>> = files
        .iter()
        .map(|file| file.cut.iter().filter(|piece| !piece.seam.is_empty()).map(|piece| piece.seam.clone()).collect())
        .collect();
    for file in &mut files {
        for piece in &mut file.cut {
            if !piece.seam.is_empty() && seen.iter().filter(|seams| seams.contains(&piece.seam)).count() < 2 {
                piece.mark = Mark::Plain;
                piece.seam.clear();
            }
        }
    }
    files
});

#[component(css, js)]
pub fn Apart<'a>(here: Here<'a>) -> impl Render {
    let (link, pane, whole) = refs();
    let kind = |mark: Mark| match mark {
        Mark::Ref => Named,
        Mark::Call => Called,
        Mark::Class => Classed,
        _ => Loose,
    };
    let all: usize = FILES.iter().map(|file| file.lines).sum();
    html! {
        <div
            class={(Apart, here.bare.then_some(Still))}
            on:pointerover={js::trace(event, link.closest(), link, pane, whole)}
            on:click={js::trace(event, link.closest(), link, pane, whole)}
        >
            <div class={Pitch}>
                <div class={Slab {}}>
                    <h3>"Typed end to end"</h3>
                    <p>
                        "This is the wall above, cut to the lines where its three files refer to each other. Each colored name is checked when the crate compiles: "
                        <span class={(Tied, Called)}>"a function the markup calls"</span> ", "
                        <span class={(Tied, Named)}>"an element it hands that function"</span> " or "
                        <span class={(Tied, Classed)}>"a class from the stylesheet"</span> ". " <code>"order"</code>
                        " is lit in both of its files."
                        if !here.bare {
                            <span class={Live}>" Point at another name, or tap it, to see where it goes."</span>
                        }
                    </p>
                    <Built on={&["Rust's type system", "JSDoc types, checked by TypeScript"][..]} />
                </div>
            </div>
            for (n, file) in FILES.iter().enumerate() {
                <section
                    class={(
                        File,
                        match n {
                            0 => Markup,
                            1 => Script,
                            _ => Styles,
                        },
                    )}
                >
                    <h4 class={Name}>
                        {file.name}
                        <span class={What}>{file.what} ", " {file.kept} " of its " {file.lines} " lines"</span>
                    </h4>
                    <pre ref={pane} class={Lines} tabindex="0" role="region" aria-label={file.name}>
                        <code>
                            for piece in &file.cut {
                                match piece.mark {
                                    Mark::Plain => <span>{piece.text}</span>,
                                    Mark::Keyword => <span class={Keyword}>{piece.text}</span>,
                                    Mark::Text => <span class={Text}>{piece.text}</span>,
                                    Mark::Comment => <span class={Comment}>{piece.text}</span>,
                                    Mark::Macro => <span class={Macro}>{piece.text}</span>,
                                    Mark::Number => <span class={Number}>{piece.text}</span>,
                                    Mark::Gap => <span class={Gap}>{piece.passed} " lines not shown"</span>,
                                    tied => <span
                                        ref={link}
                                        class={(Tied, kind(tied))}
                                        data-seam={piece.seam.as_str()}
                                        data-lit={(piece.seam == LIT).then_some("")}
                                    >
                                        {piece.text}
                                    </span>,
                                }
                            }
                        </code>
                    </pre>
                    for (mark, seam, shown, held) in file.ties {
                        <p class={Note}>
                            if here.bare {
                                <code class={(Tied, kind(*mark))}>{*shown}</code>
                            } else {
                                <button
                                    type="button"
                                    class={(Follow, kind(*mark))}
                                    on:click={js::follow(link, pane, whole, *seam)}
                                >
                                    {*shown}
                                </button>
                            }
                            {*held}
                        </p>
                    }
                </section>
            }
            <details ref={whole} class={Whole}>
                <summary class={All}>"Read the Wall function and its two files in full: " {all} " lines"</summary>
                <p class={Rest}>
                    "Every name the files share is marked here: the twelve heat classes too, and the one name nothing checks, "
                    <code class={(Tied, Loose)}>"data-reading"</code>
                    ". The markup writes it and the script reads it back as text, so a misspelling in either file still compiles, and the wall stops sorting."
                </p>
                <div class={Files}>
                    for file in FILES.iter() {
                        <section class={File}>
                            <h4 class={Name}>
                                {file.name}
                                <span class={What}>{file.what} ", " {file.lines} " lines"</span>
                            </h4>
                            <pre ref={pane} class={Source} tabindex="0" role="region" aria-label={file.whole_label.as_str()}>
                                <code>
                                    for piece in &file.whole {
                                        match piece.mark {
                                            Mark::Plain => <span>{piece.text}</span>,
                                            Mark::Keyword => <span class={Keyword}>{piece.text}</span>,
                                            Mark::Text => <span class={Text}>{piece.text}</span>,
                                            Mark::Comment => <span class={Comment}>{piece.text}</span>,
                                            Mark::Macro => <span class={Macro}>{piece.text}</span>,
                                            Mark::Number => <span class={Number}>{piece.text}</span>,
                                            Mark::Gap => <span class={Gap}>{piece.passed} " lines not shown"</span>,
                                            tied => <span
                                                ref={link}
                                                class={(Tied, kind(tied))}
                                                data-seam={piece.seam.as_str()}
                                                data-lit={(piece.seam == LIT).then_some("")}
                                            >
                                                {piece.text}
                                            </span>,
                                        }
                                    }
                                </code>
                            </pre>
                        </section>
                    }
                </div>
            </details>
        </div>
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources() -> [&'static str; 3] {
        [markup(), include_str!("wall.js"), include_str!("wall.css")]
    }

    #[test]
    fn the_files_are_shown_whole() {
        assert!(markup().starts_with("#[component(css, js)]\npub(crate) fn Wall") && markup().ends_with("}\n"), "{}", markup());
        for (file, source) in FILES.iter().zip(sources()) {
            assert_eq!(file.whole.iter().map(|piece| piece.text).collect::<String>(), source, "{}", file.name);
        }
    }

    /// A cut is the file's own lines in the file's order, less only the indent nested stretches
    /// share, and with the lines it passes over it accounts for every line: nothing shown is
    /// rewritten, and nothing is dropped unsaid.
    #[test]
    fn a_cut_is_the_files_lines() {
        let cuts: [&[Cut]; 3] = [&MARKUP_CUTS, &SCRIPT_CUTS, &STYLE_CUTS];
        for ((file, source), cuts) in FILES.iter().zip(sources()).zip(cuts) {
            assert_eq!(stretches(source, cuts).len(), cuts.len(), "a cut of {} is not in the file", file.name);
            let mut at = 0;
            for piece in file.cut.iter().filter(|piece| piece.mark != Mark::Gap) {
                let found =
                    source[at..].find(piece.text).unwrap_or_else(|| panic!("{:?} is not in {} in order", piece.text, file.name));
                at += found + piece.text.len();
            }
            let shown: String = file.cut.iter().map(|piece| piece.text).collect();
            let passed: usize = file.cut.iter().map(|piece| piece.passed).sum();
            assert_eq!(shown.lines().count() + passed, file.lines, "{}", file.name);
            assert!(file.kept > 0 && file.kept <= shown.lines().count() && file.kept * 3 < file.lines, "{}", file.name);
        }
    }

    /// The note under the script points at the break that hands `order` the readout.
    #[test]
    fn the_fourth_break_is_the_one_the_note_names() {
        assert!(TIES[1].3.contains("the fourth break below"));
        assert!(crate::cuts::CUTS[3].broken.contains("js::order(event, readout, grid"), "{}", crate::cuts::CUTS[3].broken);
    }

    #[test]
    fn the_script_cut_is_one_whole_function() {
        let shown: String = FILES[1].cut.iter().map(|piece| piece.text).collect();
        assert!(shown.starts_with("/**\n") && shown.ends_with("}\n"), "{shown}");
        assert!(shown.contains("export function order(event, grid, readout") && shown.matches("\n}\n").count() == 1, "{shown}");
    }

    /// A name marked in one file has its other end in another, so nothing is marked that the
    /// reader cannot follow: in the whole files, and in the cuts alone.
    #[test]
    fn every_tie_has_two_ends() {
        let ends = |pieces: &[Piece]| {
            pieces.iter().filter(|piece| !piece.seam.is_empty()).map(|piece| piece.seam.clone()).collect::<Vec<_>>()
        };
        for whole in [true, false] {
            let of = |n: usize| if whole { ends(&FILES[n].whole) } else { ends(&FILES[n].cut) };
            let (markup, script, styles) = (of(0), of(1), of(2));
            for seam in &markup {
                let other = if seam.starts_with("class:") { &styles } else { &script };
                assert!(other.contains(seam), "{seam} is in the markup alone");
            }
            for seam in script.iter().chain(&styles) {
                assert!(markup.contains(seam), "{seam} is not in the markup");
            }
            // What the page follows by itself is there to follow.
            for (_, seam, ..) in TIES {
                assert!(markup.iter().any(|end| end == seam), "a button follows {seam}");
            }
            assert!(markup.iter().any(|end| end == LIT));
        }
        // The name nothing checks is in the whole files alone, where the page says so.
        assert!(ends(&FILES[0].whole).iter().any(|end| end == "data:reading"));
        assert!(FILES.iter().all(|file| ends(&file.cut).iter().all(|end| !end.starts_with("data:"))));
    }

    /// The lists at the top are every such name in the files, so a ref, a call, a class or a
    /// data attribute added to the wall is marked, or this fails and the page is not wrong.
    #[test]
    fn the_names_marked_are_all_there_are() {
        let [markup, script, styles] = sources();
        let refs =
            markup.split_once("let (").and_then(|(_, rest)| rest.split_once(") = refs();")).expect("the wall names its refs").0;
        assert_eq!(refs.split(", ").collect::<Vec<_>>(), REFS);
        let mut calls: Vec<&str> = markup.split("js::").skip(1).map(|rest| rest.split('(').next().unwrap_or("")).collect();
        calls.dedup();
        assert_eq!(calls, CALLS);
        let after = |source: &'static str, lead: &str| -> Vec<String> {
            let mut names: Vec<String> = source
                .split(lead)
                .skip(1)
                .map(|rest| rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect())
                .collect();
            names.sort();
            names.dedup();
            names
        };
        // `data-reload` is the runtime's, said to the browser alone; the script reads one.
        assert_eq!(after(markup, "data-"), ["reading", "reload"]);
        assert_eq!(after(script, "dataset."), [DATA]);
        for (kind, text) in runs(Lang::Css, styles) {
            if kind != Kind::Plain {
                continue;
            }
            for (at, _) in text.match_indices('.') {
                let name: String =
                    text[at + 1..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
                assert!(name.is_empty() || class(&name), "{name} is a class the lists lack");
            }
        }
        for name in CLASSES {
            assert!(styles.contains(&format!(".{name} {{")), "{name} is not in the stylesheet");
        }
    }
}
