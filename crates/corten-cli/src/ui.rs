//! `corten ui`: the UI kit. `init` writes the theme tokens and `src/ui.rs`, `add` copies a
//! component's source into `src/ui/`, where it is the app's to change, and `diff` shows how a copy
//! differs from the kit this command carries. The files are embedded in the
//! binary (`kit/`), so this needs no network and the command stays standard-library only.

use std::{
    io::Write,
    path::{Path, PathBuf},
};

/// A component of the kit: its files, and the component `src/ui.rs` lists in `COMPONENTS` (the one
/// that owns the stylesheet).
struct Piece {
    name: &'static str,
    summary: &'static str,
    owner: &'static str,
    files: &'static [(&'static str, &'static str)],
    /// The corten-ui component it styles, which the app depends on and lists itself.
    styles: Option<&'static str>,
}

macro_rules! piece {
    ($name:literal, $owner:literal, $summary:literal, [$($file:literal),+]) => {
        Piece { name: $name, owner: $owner, summary: $summary, files: &[$(($file, include_str!(concat!("../kit/", $file)))),+], styles: None }
    };
    ($name:literal, $owner:literal, $summary:literal, [$($file:literal),+], styles $widget:literal) => {
        Piece { name: $name, owner: $owner, summary: $summary, files: &[$(($file, include_str!(concat!("../kit/", $file)))),+], styles: Some($widget) }
    };
}

// The kit's earlier files, `WAS`: (file, the hash its copies carry, text), from `kit/was/`.
include!(concat!(env!("OUT_DIR"), "/was.rs"));

const KIT: &[Piece] = &[
    piece!("accordion", "Accordion", "sections that open one at a time, on <details name>", ["accordion.rs", "accordion.css"]),
    piece!(
        "alert",
        "Alert",
        "a message the page calls out, neutral, info, success, warning or destructive",
        ["alert.rs", "alert.css"]
    ),
    piece!("avatar", "Avatar", "a person's picture over their initials", ["avatar.rs", "avatar.css"]),
    piece!("badge", "Badge", "a short label: a status, a count, a tag", ["badge.rs", "badge.css"]),
    piece!("breadcrumb", "Breadcrumb", "typed links to the pages above this one", ["breadcrumb.rs", "breadcrumb.css"]),
    piece!("button", "Button", "the look of a <button> or <a>, in six variants and four sizes", ["button.rs", "button.css"]),
    piece!("card", "Card", "a surface that groups content, with a header, content and footer", ["card.rs", "card.css"]),
    piece!("checkbox", "Checkbox", "a checkbox and its label", ["checkbox.rs", "checkbox.css"]),
    piece!(
        "checkboxes",
        "Checkboxes",
        "the look of corten-ui's CheckboxGroup: a fieldset of checkboxes, at least one required",
        ["checkboxes.rs", "checkboxes.css"],
        styles "CheckboxGroup"
    ),
    piece!("combobox", "Combobox", "the look of corten-ui's ComboBox: a filtered list under an input", ["combobox.rs", "combobox.css"], styles "ComboBox"),
    piece!(
        "control_width",
        "ControlWidth",
        "an input's, select's or textarea's width: the theme's small, medium or large, or full",
        ["control_width.rs", "control_width.css"]
    ),
    piece!("dialog", "Dialog", "a modal <dialog>, opened by command=\"show-modal\" with no script", ["dialog.rs", "dialog.css"]),
    piece!("dropdown_menu", "DropdownMenu", "the look of corten-ui's MenuButton", ["dropdown_menu.rs", "dropdown_menu.css"], styles "MenuButton"),
    piece!("field", "Field", "a label, its control and a hint or the server's error", ["field.rs", "field.css"]),
    piece!("icon", "Icon", "an icon of Lucide's at the text's size and color, as an inline <svg>", ["icon.rs", "icon.css"]),
    piece!("input", "Input", "the look of a text <input>, invalid state included", ["input.rs", "input.css"]),
    piece!(
        "input_group",
        "InputGroup",
        "a text <input> with a sign, a unit or a button inside its border",
        ["input_group.rs", "input_group.css"]
    ),
    piece!(
        "meter",
        "Meter",
        "the look of a <meter>: a measure in a known range, colored by its state",
        ["meter.rs", "meter.css"]
    ),
    piece!(
        "nav_bar",
        "NavBar",
        "the bar across the top of every page: the app's name, its section links, actions at the end",
        ["nav_bar.rs", "nav_bar.css"]
    ),
    piece!("pagination", "Pagination", "typed links to the pages of a list", ["pagination.rs", "pagination.css"]),
    piece!("popover", "Popover", "content over the page beside its button, on popover", ["popover.rs", "popover.css"]),
    piece!(
        "progress",
        "Progress",
        "the look of a <progress>: how far along a task is, or a moving band while that is not known",
        ["progress.rs", "progress.css"]
    ),
    piece!("radio_group", "RadioGroup", "a fieldset of radio buttons and their labels", ["radio_group.rs", "radio_group.css"]),
    piece!(
        "segmented",
        "Segmented",
        "the look of corten-ui's ChoiceGroup, a nav of links and native radios: a few choices side by side",
        ["segmented.rs", "segmented.css"],
        styles "ChoiceGroup"
    ),
    piece!(
        "select",
        "Select",
        "the look of a <select>, its open list where base-select is supported",
        ["select.rs", "select.css"]
    ),
    piece!("separator", "Separator", "a line between sections, across or upright", ["separator.rs", "separator.css"]),
    piece!("sheet", "Sheet", "a <dialog> that slides in from an edge of the window", ["sheet.rs", "sheet.css"]),
    piece!("skeleton", "Skeleton", "a placeholder's shape while a part loads", ["skeleton.rs", "skeleton.css"]),
    piece!("slider", "Slider", "the look of an <input type=\"range\">", ["slider.rs", "slider.css"]),
    piece!(
        "stack",
        "Stack",
        "the space between a screen's parts: a column (Stack) or a wrapping row (Cluster)",
        ["stack.rs", "stack.css"]
    ),
    piece!("stats", "Stats", "labelled figures for a dashboard's summary, on a <dl>", ["stats.rs", "stats.css"]),
    piece!(
        "status_dot",
        "StatusDot",
        "a dot in a status's color, before the words that name it; LiveDot pulses while a stream is live",
        ["status_dot.rs", "status_dot.css"]
    ),
    piece!(
        "stepper",
        "Stepper",
        "the look of corten-ui's NumberField: a number between a fewer and a more button",
        ["stepper.rs", "stepper.css"],
        styles "NumberField"
    ),
    piece!(
        "steps",
        "Steps",
        "a workflow's steps in a labelled <nav>, each done, current (aria-current=\"step\") or to do",
        ["steps.rs", "steps.css"]
    ),
    piece!("switch", "Switch", "an on and off setting: a checkbox with role=\"switch\"", ["switch.rs", "switch.css"]),
    piece!("table", "Table", "the look of a <table>, scrolling sideways or stacked on a phone", ["table.rs", "table.css"]),
    piece!("tabs", "Tabs", "the look of corten-ui's TabGroup: a segmented tab list", ["tabs.rs", "tabs.css"], styles "TabGroup"),
    piece!("textarea", "Textarea", "the look of a <textarea>", ["textarea.rs", "textarea.css"]),
    piece!("tip", "Tip", "the look of corten-ui's Tooltip: a short text above a control", ["tip.rs", "tip.css"], styles "Tooltip"),
    piece!("toasts", "Toasts", "the look and place of corten-ui's Toaster", ["toasts.rs", "toasts.css"], styles "Toaster"),
    piece!(
        "visually_hidden",
        "VisuallyHidden",
        "text a screen reader reads and the page does not draw: an icon control's name",
        ["visually_hidden.rs", "visually_hidden.css"]
    ),
];

/// What `init` writes, from the app's root.
const INIT: &[(&str, &str)] = &[
    ("tokens/ui.tokens.json", include_str!("../kit/tokens/ui.tokens.json")),
    ("tokens/ui-dark.tokens.json", include_str!("../kit/tokens/ui-dark.tokens.json")),
    ("tokens/ui.resolver.json", include_str!("../kit/tokens/ui.resolver.json")),
    ("src/ui.rs", include_str!("../kit/ui.rs")),
];

/// Added to `static/style.css` by `init`: the page's own colors, and the theme form controls and
/// scrollbars follow, which are properties of the page rather than tokens.
const PAGE_CSS: &str = include_str!("../kit/page.css");

const COMPONENTS: &str = "pub const COMPONENTS: &[Component] =";

/// The line in `src/ui.rs` the first `pub mod` goes before.
const TOKENS_LINE: &str = "corten::style::tokens!(";

/// A theme in the app's own code: a `tokens!` call, however it is imported.
const TOKENS_CALL: &str = "tokens!(";

/// `src/ui.rs` for an app with a theme of its own, which the components read: no tokens of the kit.
const OWN_THEME_MODULE: &str = "// corten ui {{version}}
//! The UI kit: the components `corten ui add` copied into `src/ui/`, reading their colors from the
//! app's own theme. They are the app's to change; `corten ui list` names the others.

use corten::Component;

/// Each component with a stylesheet: `App::components(ui::COMPONENTS)`.
pub const COMPONENTS: &[Component] = &[];
";

/// Above `pub mod ui;` in `src/lib.rs`.
const MODULE_DOC: &str = "/// The UI kit (`corten ui`): public, so a component not used yet is not a warning.";

const USAGE: &str = "usage: corten ui init [--kit-theme] | corten ui add <name>.. [--force | --merge] | corten ui add --all [--force | --merge] | corten ui list | corten ui diff [name]..";

pub fn run(args: &[String]) -> Result<(), String> {
    let root = std::env::current_dir().map_err(|e| e.to_string())?;
    let note = crate::pin::note(&root, env!("CARGO_PKG_VERSION"), crate::pin::REV, crate::pin::target().as_deref());
    if let Some(note) = pinned(args.first().map(String::as_str), note)? {
        // A note: a closed stderr fails nothing.
        let _ = writeln!(std::io::stderr(), "corten: note: {note}\n");
    }
    run_in(&root, args)
}

/// What `ui` does when the app pins another corten than this command was built from (`note`, as
/// [`crate::pin::note`] says it): the kit is the command's own, so `add` and `init`
/// refuse, as they would copy another corten's components (and what `--force` puts back may be
/// older than the copies it replaces), and the rest print the note, saying `diff` compares with
/// this command's kit.
fn pinned(sub: Option<&str>, note: Option<crate::pin::Note>) -> Result<Option<String>, String> {
    let Some(crate::pin::Note { text, this, package }) = note else { return Ok(None) };
    match sub {
        Some("add" | "init") => Err(format!(
            "not copying: {text}\nor, to take this command's kit, move the app to its corten first: {this} for corten in Cargo.toml, then cargo update -p {package}"
        )),
        Some("diff") => Ok(Some(format!(
            "{text}\nui diff compares the copies with this command's kit, not the pin's, and ui add refuses until the two match"
        ))),
        _ => Ok(Some(text)),
    }
}

fn run_in(root: &Path, args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("init") => init(root, &args[1..]),
        Some("add") => add(root, &args[1..]),
        Some("list") => {
            print!("{}", list());
            Ok(())
        }
        Some("diff") => diff(root, &args[1..]),
        _ => Err(USAGE.to_string()),
    }
}

fn list() -> String {
    let width = KIT.iter().map(|p| p.name.len()).max().unwrap_or(0);
    let mut out = String::new();
    for piece in KIT {
        out.push_str(&format!("  {:width$}  {}\n", piece.name, piece.summary));
    }
    out
}

/// The text a kit file is written with. Its first line says where it came from, the version and
/// a hash of the rest as the kit has it (`// corten ui 0.1.0: button 9a3f..`), so `corten ui diff` can tell
/// a copy the app edited from one the kit changed since. Files with no hash place (`src/ui.rs`,
/// the JSON tokens) only get the version.
fn stamped(text: &str) -> String {
    let text = text.replace("{{version}}", env!("CARGO_PKG_VERSION"));
    let Some((first, rest)) = text.split_once('\n') else { return text };
    let hash = format!("{:016x}", fnv(rest));
    if let Some(head) = first.strip_suffix(" */") {
        format!("{head} {hash} */\n{rest}")
    } else if first.starts_with("// corten ui ") && first.contains(": ") {
        format!("{first} {hash}\n{rest}")
    } else {
        text
    }
}

/// FNV-1a, 64 bits, over the text with CRLF read as LF (a checkout may convert line ends): stable
/// across Rust releases, as `std`'s hasher is not.
fn fnv(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes().filter(|&b| b != b'\r') {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// A copy's first line: the kit version and the hash of the kit's text it was copied from.
fn stamp_of(text: &str) -> Option<(String, u64)> {
    let first = text.lines().next()?;
    let rest = first.strip_prefix("// corten ui ").or_else(|| first.strip_prefix("/* corten ui "))?;
    let rest = rest.trim_end_matches(" */");
    let (version, rest) = rest.split_once(": ")?;
    let hash = rest.rsplit_once(' ')?.1;
    Some((version.to_string(), u64::from_str_radix(hash, 16).ok()?))
}

fn init(root: &Path, args: &[String]) -> Result<(), String> {
    let kit_theme = match args {
        [] => false,
        [flag] if flag == "--kit-theme" => true,
        _ => return Err(USAGE.to_string()),
    };
    for (path, _) in INIT {
        if root.join(path).exists() {
            return Err(format!("{path} exists: the kit is already set up here (corten ui add <name> adds a component)"));
        }
    }
    let app = sources(root);
    // An app with colors of its own keeps them, unless it asks for the kit's: the kit's components
    // read their tokens from its theme. One whose theme has no colors (spacing alone) gets the
    // kit's; one whose theme cannot be read is told why, rather than given a second theme. Every
    // `tokens!` is read, so one that cannot be is reported whichever file comes first.
    let mut theme = None;
    // The breakpoints every theme the app has makes, with the file of the `tokens!` that reads it.
    let mut made: Vec<(String, String, String)> = Vec::new();
    // Those made by naming another (`"wide": "{md}"`), each with its file: a hint names none.
    let mut named: Vec<(String, String)> = Vec::new();
    // The files that are resolvers, whose breakpoint lines go in one of their sets.
    let mut resolvers: Vec<String> = Vec::new();
    for (path, text) in app.iter().filter(|(path, text)| !is_kit_file(path, text) && text.contains(TOKENS_CALL)) {
        match own_theme(root, text) {
            Ok(Some(found)) => {
                let file = tokens_path(text).unwrap_or_else(|| path.clone());
                made.extend(found.breakpoints.iter().map(|(name, width)| (file.clone(), name.clone(), width.clone())));
                named.extend(found.named.iter().map(|name| (file.clone(), name.clone())));
                if found.resolver {
                    resolvers.push(file.clone());
                }
                if found.colors && theme.is_none() && !kit_theme {
                    theme = Some((path.clone(), found));
                }
            }
            Ok(None) => {}
            Err(why) if !kit_theme => {
                return Err(format!(
                    "cannot read the theme {path}'s tokens! names ({why}), so the tokens it lacks cannot be named: \
                         fix it and run this again, or run corten ui init --kit-theme to add the kit's theme beside it"
                ));
            }
            Err(_) => {}
        }
    }
    let mut files: Vec<(String, String)> = match &theme {
        None => INIT.iter().map(|(path, text)| (path.to_string(), stamped(text))).collect(),
        Some(_) => vec![("src/ui.rs".to_string(), stamped(OWN_THEME_MODULE))],
    };
    let mut said: Vec<String> = files.iter().map(|(path, _)| format!("  wrote {path}")).collect();
    let mut todo: Vec<String> = Vec::new();
    match wire_app(&app) {
        Ok(edits) => {
            for (path, text) in edits {
                let was = app.iter().find(|(p, _)| *p == path).map_or("", |(_, t)| t.as_str());
                let added: Vec<&str> =
                    text.lines().map(str::trim).filter(|l| is_wiring(l) && !was.lines().any(|w| w.trim() == *l)).collect();
                said.push(format!("  edited {path}: {}", added.join(" and ")));
                files.push((path, text));
            }
        }
        Err(why) => todo.push(why),
    }
    match (&theme, std::fs::read_to_string(root.join("static/style.css"))) {
        (Some(_), _) => {}
        (None, Ok(text)) if text.contains("color-scheme") => todo.push(
            "static/style.css sets color-scheme already, so it is left as it is: give the page the theme's colors \
             (:root { background: var(--background); color: var(--foreground); }) and follow data-theme as kit/page.css does"
                .to_string(),
        ),
        (None, Ok(text)) => {
            let sep = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
            files.push(("static/style.css".into(), format!("{text}{sep}{}", stamped(PAGE_CSS))));
            said.push("  edited static/style.css: the page's colors from the theme".into());
        }
        (None, Err(_)) => {
            todo.push("copy the page colors from corten ui into your page stylesheet (see docs/guide/kit.md)".to_string())
        }
    }
    // src/ui.rs and the App's lines laid out as the app's code, so `corten check` passes after.
    todo.extend(not_laid_out(&lay_out_own(root, &mut files, &app)));
    apply(root, &files)?;
    for line in said {
        println!("{line}");
    }
    for step in &todo {
        println!("  to do: {step}");
    }
    match theme {
        None => {
            println!(
                "\nThe theme is light and dark (data-theme=\"dark\", or the system's). Add components with corten ui add <name>;\ncorten ui list names them."
            );
            for note in breakpoint_notes(false, &made, &named, &resolvers) {
                println!("{note}");
            }
        }
        Some((path, theme)) => {
            let missing: Vec<String> = role_tokens().into_iter().filter(|t| !theme.properties.contains(t)).collect();
            let taken: Vec<&String> = missing.iter().filter(|t| theme.groups.contains(t)).collect();
            if missing.is_empty() {
                println!(
                    "\nThe components read their colors and sizes from your theme ({path}), which has every token they read."
                );
            } else {
                println!(
                    "\nThe components read their colors and sizes from your theme ({path}), which lacks these. Declare each at\n\
                     the top of a token file, most as a reference to one of yours, so it follows your other themes too\n\
                     (\"card\": {{ \"$type\": \"color\", \"$value\": \"{{color.surface}}\" }}; a size as the kit's theme has it,\n\
                     \"control-height\": {{ \"$type\": \"dimension\", \"$value\": {{ \"value\": 2.25, \"unit\": \"rem\" }} }}):\n  {}\n\
                     The app does not start while a component reads one no stylesheet declares, and says which.",
                    missing.join(", ")
                );
            }
            if !taken.is_empty() {
                let first = taken[0];
                println!(
                    "Your theme has {} named {}: give {} a $root token, which is the group's own property\n\
                     (\"{first}\": {{ \"$root\": {{ \"$value\": \"{{..}}\" }}, .. }} declares --{first}).",
                    if taken.len() == 1 { "a group" } else { "groups" },
                    names_of(&taken),
                    if taken.len() == 1 { "it" } else { "each" }
                );
            }
            for note in breakpoint_notes(true, &made, &named, &resolvers) {
                println!("{note}");
            }
            println!("To take the kit's theme instead, beside yours: corten ui init --kit-theme.");
            println!("Add components with corten ui add <name>; corten ui list names them.");
        }
    }
    println!(
        "\nA rule in static/style.css that weighs more than an element (button[data-primary], .sidebar a) can restyle\n\
         a kit control too; docs/guide/kit.md (The app's own stylesheet) says how to keep it from doing so."
    );
    Ok(())
}

/// The tokens the kit's components read: every one of its theme, in the theme's order.
fn role_tokens() -> Vec<String> {
    match crate::json::parse(INIT[0].1) {
        Ok(crate::json::Value::Object(fields)) => {
            fields.into_iter().map(|(name, _)| name).filter(|n| !n.starts_with('$')).collect()
        }
        _ => unreachable!("the kit's theme is a JSON object"),
    }
}

/// What `init` says of the kit's breakpoints, given the breakpoints the app's themes make (each
/// `tokens!` file, name and width). With the app's own theme (`own`), each the kit's components
/// name that it does not make; with the kit's theme written beside the app's, each the kit's
/// components name that the two make at different widths, since the app does not start while a
/// component names one of those.
fn breakpoint_notes(
    own: bool,
    made: &[(String, String, String)],
    named: &[(String, String)],
    resolvers: &[String],
) -> Vec<String> {
    let kit = kit_breakpoints();
    if own {
        let makes = |n: &str| made.iter().any(|(_, m, _)| m == n);
        let unmade: Vec<String> = kit_named().into_iter().filter(|n| !makes(n)).collect();
        if unmade.is_empty() {
            return Vec::new();
        }
        return vec![format!(
            "The components that lay themselves out for a phone (NavBar, Stats, Steps, Table) do so below your theme's\n\
             {} breakpoint, which it does not make: add it to $extensions.\"run.corten\".breakpoints on a token file's\n\
             root group ({}). It may name another of your breakpoints in braces instead, as one at a width your theme\n\
             already makes must (two never share a width): a theme with Tailwind's names (sm 40rem, md 48rem) that lays\n\
             out for a phone below md writes \"wide\": \"{{md}}\". A width goes in its place, smallest first. Once one of\n\
             them is added, the app does not start until your theme makes it.",
            names_of(&unmade.iter().collect::<Vec<_>>()),
            unmade.iter().map(|name| missing_breakpoint(name, made, named, resolvers, None)).collect::<Vec<_>>().join(", ")
        )];
    }
    let mut notes = Vec::new();
    let named = kit_named();
    for (name, width) in kit.into_iter().filter(|(name, _)| named.contains(name)) {
        for (file, _, other) in made.iter().filter(|(_, n, w)| *n == name && *w != width) {
            notes.push(format!(
                "Your theme ({file}) makes the breakpoint {name} at {other}, and the kit's theme at {width}. The components\n\
                 that switch at it (NavBar, Stats, Steps, Table) do not start the app while the two differ: remove\n\
                 {name} from {} to keep yours, or change yours.",
                INIT[0].0
            ));
        }
    }
    notes
}

/// The breakpoints a token file's root group makes (`$extensions."run.corten".breakpoints`): each
/// name and its width as CSS (`40rem`), the number read as a number so `40` and `40.0` agree. One
/// that names another (`"wide": "{md}"`) is kept as written (`{md}`): [`resolve_breakpoints`]
/// gives it the other's width once every set of a resolver is read, since it may name one another
/// set makes, or one a later set gives another width.
fn breakpoints_of(root: &crate::json::Value) -> Vec<(String, String)> {
    let made = root.get("$extensions").and_then(|e| e.get("run.corten")).and_then(|c| c.get("breakpoints"));
    let Some(crate::json::Value::Object(fields)) = made else { return Vec::new() };
    let width = |v: &crate::json::Value| match (v.get("value"), v.get("unit").and_then(|u| u.as_str())) {
        (Some(crate::json::Value::Number(n)), Some(unit)) => {
            n.parse::<f64>().map_or_else(|_| format!("{n}{unit}"), |n| format!("{n}{unit}"))
        }
        _ => v.as_str().unwrap_or("?").to_string(),
    };
    fields.iter().map(|(name, v)| (name.clone(), width(v))).collect()
}

/// Gives each breakpoint that names another (`{md}`, as [`breakpoints_of`] reads it) that one's
/// width, the last one's where several make it, as `tokens!` merges a resolver's sets.
fn resolve_breakpoints(made: &mut [(String, String)]) {
    let widths: Vec<(String, String)> = made.iter().filter(|(_, w)| !w.starts_with('{')).cloned().collect();
    for (_, width) in made.iter_mut() {
        let other = width.strip_prefix('{').and_then(|w| w.strip_suffix('}'));
        if let Some((_, w)) = other.and_then(|other| widths.iter().rev().find(|(n, _)| n == other)) {
            *width = w.clone();
        }
    }
}

/// The breakpoints the kit's theme makes, which its components' `@media` rules name.
fn kit_breakpoints() -> Vec<(String, String)> {
    let mut made = breakpoints_of(&crate::json::parse(INIT[0].1).expect("the kit's theme is JSON"));
    resolve_breakpoints(&mut made);
    made
}

/// The breakpoints the kit's stylesheets name (`wide`), which the kit's theme makes.
fn kit_named() -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for (_, text) in KIT.iter().flat_map(|p| p.files.iter()).filter(|(file, _)| file.ends_with(".css")) {
        for name in media_names(text) {
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    names
}

/// A breakpoint as the kit's theme writes it, `"wide": { "value": 40, "unit": "rem" }`.
fn kit_breakpoint(name: &str) -> String {
    let theme = crate::json::parse(INIT[0].1).expect("the kit's theme is JSON");
    let made = theme.get("$extensions").and_then(|e| e.get("run.corten")).and_then(|c| c.get("breakpoints"));
    match made.and_then(|b| b.get(name)).map(|w| (w.get("value"), w.get("unit").and_then(|u| u.as_str()))) {
        Some((Some(crate::json::Value::Number(value)), Some(unit))) => {
            format!("\"{name}\": {{ \"value\": {value}, \"unit\": \"{unit}\" }}")
        }
        _ => panic!("the kit's theme makes the breakpoint {name} as a value and a unit"),
    }
}

/// The line that makes a breakpoint of the kit's an app's theme lacks: the name of one the theme
/// already makes with a width, the kit's (`"wide": "{sm}"`, for a theme an earlier `init` wrote,
/// or a Tailwind theme's `sm`), since two breakpoints never share a width, else the kit's own
/// line. A name reaches only its own `tokens!` file, so with `file` (the one the line goes in)
/// only that file's are named, and without it the line says which file it goes in.
fn missing_breakpoint(
    name: &str,
    made: &[(String, String, String)],
    named: &[(String, String)],
    resolvers: &[String],
    file: Option<&str>,
) -> String {
    let kit = kit_breakpoints();
    let width = kit.iter().find(|(n, _)| n == name).map(|(_, w)| w.as_str()).unwrap_or_default();
    let found = made.iter().find(|(f, other, w)| {
        other != name && w == width && file.is_none_or(|file| f == file) && !named.iter().any(|(nf, n)| nf == f && n == other)
    });
    match found {
        Some((_, other, _)) if file.is_some() => format!("\"{name}\": \"{{{other}}}\""),
        Some((f, other, _)) if resolvers.contains(f) => format!("\"{name}\": \"{{{other}}}\" in a set of {f}"),
        Some((f, other, _)) => format!("\"{name}\": \"{{{other}}}\" in {f}"),
        None => kit_breakpoint(name),
    }
}

/// The breakpoints `css`'s `@media` rules name, `sm` for `@media not (--sm)`, as `tokens!` reads
/// them.
fn media_names(css: &str) -> Vec<String> {
    let code = code_of(css);
    let mut names = Vec::new();
    for rule in code.split("@media").skip(1) {
        let prelude = rule.split('{').next().unwrap_or_default();
        for named in prelude.split('(').skip(1) {
            let Some(name) = named.trim_start().strip_prefix("--") else { continue };
            let name: String = name.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
            if !name.is_empty() && !names.contains(&name) {
                names.push(name);
            }
        }
    }
    names
}

/// What an app's own theme declares, from the files its `tokens!` names (a resolver's sources too).
#[derive(Clone, Debug, Default, PartialEq)]
struct Theme {
    /// Each custom property its tokens make, without the `--`: `radius-sm` for `radius.sm`, and
    /// `radius` for that group's `$root`.
    properties: Vec<String>,
    /// The groups at the top of its token sources (`radius`): one of the kit's tokens with a
    /// group's name is that group's `$root`.
    groups: Vec<String>,
    /// Whether any token is a color.
    colors: bool,
    /// The breakpoints its root groups make (`$extensions."run.corten".breakpoints`), which a
    /// component's `@media` rule names (`not (--sm)`), each with its width (`40rem`).
    breakpoints: Vec<(String, String)>,
    /// Those of them made by naming another (`"wide": "{md}"`).
    named: Vec<String>,
    /// Whether the file is a resolver (a `resolutionOrder` array, whatever its name), so a line
    /// goes in one of its sets.
    resolver: bool,
}

/// The path in the first `tokens!(..)` call of `code` outside comments, as `styled_components`
/// reads code: `tokens/app.tokens.json`.
fn tokens_path(code: &str) -> Option<String> {
    // Comments go first, line by line; the call itself may span lines (rustfmt wraps a long path).
    let code: String = code.lines().map(|line| line.split("//").next().unwrap_or("")).collect::<Vec<_>>().join("\n");
    let at = code.find(TOKENS_CALL)? + TOKENS_CALL.len();
    code[at..].trim_start().strip_prefix('"')?.split('"').next().map(str::to_string)
}

/// The theme the `tokens!` call in `code` names, read as `tokens!` reads it: a token file, or
/// a resolver (a `resolutionOrder` array) whose sets and modifier contexts hold token groups
/// inline or by `$ref` (`file.json`, `file.json#/pointer`, `#/sets/base`). None when `code`
/// has no call; an error, naming the file, when a file it reaches cannot be read, is not JSON or
/// has nothing where a pointer says, so nothing is guessed.
fn own_theme(root: &Path, code: &str) -> Result<Option<Theme>, String> {
    let Some(path) = tokens_path(code) else { return Ok(None) };
    let mut reader = ThemeReader { root, docs: Vec::new(), theme: Theme::default(), steps: 0, open: Vec::new() };
    let file = root.join(&path);
    let file = std::fs::canonicalize(&file).unwrap_or(file);
    let doc = reader.load(&file)?;
    let is_resolver = matches!(&doc, crate::json::Value::Object(f) if f.iter().any(|(k, v)| k == "resolutionOrder" && matches!(v, crate::json::Value::Array(_))));
    if is_resolver {
        if let Some(crate::json::Value::Array(order)) = field_of(&doc, "resolutionOrder") {
            for entry in order {
                reader.entry(entry, &file, &doc)?;
            }
        }
    } else {
        tokens(&doc, &mut Vec::new(), &mut reader.theme);
    }
    // The sets merge into one group, as `tokens!` reads them: a later set's breakpoint of a name
    // replaces an earlier's, and a name another set makes has that set's width.
    let mut merged: Vec<(String, String)> = Vec::new();
    for (name, width) in std::mem::take(&mut reader.theme.breakpoints) {
        merged.retain(|(n, _)| *n != name);
        merged.push((name, width));
    }
    reader.theme.named = merged.iter().filter(|(_, w)| w.starts_with('{')).map(|(n, _)| n.clone()).collect();
    resolve_breakpoints(&mut merged);
    reader.theme.breakpoints = merged;
    reader.theme.resolver = is_resolver;
    Ok(Some(reader.theme))
}

/// Reads a resolver's sets and modifiers into a [`Theme`].
struct ThemeReader<'a> {
    root: &'a Path,
    /// Each file read, by path.
    docs: Vec<(PathBuf, crate::json::Value)>,
    theme: Theme,
    /// References followed: a loop is the macro's to report, so this only stops.
    steps: usize,
    /// The sets being read, by (file, pointer): one that includes itself is read once.
    open: Vec<(PathBuf, String)>,
}

impl ThemeReader<'_> {
    fn shown(&self, file: &Path) -> String {
        let canonical = std::fs::canonicalize(self.root).ok();
        let relative = canonical.as_deref().and_then(|root| file.strip_prefix(root).ok());
        slash(relative.or_else(|| file.strip_prefix(self.root).ok()).unwrap_or(file))
    }

    fn load(&mut self, file: &Path) -> Result<crate::json::Value, String> {
        if let Some((_, value)) = self.docs.iter().find(|(p, _)| p == file) {
            return Ok(value.clone());
        }
        let shown = self.shown(file);
        let text = std::fs::read_to_string(file).map_err(|e| format!("{shown}: {e}"))?;
        let value = crate::json::parse(&text).map_err(|e| format!("{shown}: {e}"))?;
        self.docs.push((file.to_path_buf(), value.clone()));
        Ok(value)
    }

    /// What a `$ref` names, from the document at `file`: (its file, that file's root, the value).
    fn follow(
        &mut self,
        target: &str,
        file: &Path,
        doc: &crate::json::Value,
    ) -> Result<(PathBuf, crate::json::Value, crate::json::Value), String> {
        let (path, pointer) = target.split_once('#').unwrap_or((target, ""));
        let (file, doc) = if path.is_empty() {
            (file.to_path_buf(), doc.clone())
        } else {
            let next = file.parent().map(Path::to_path_buf).unwrap_or_default().join(path);
            // One path per file, as the macro resolves it, so `../tokens/x.json` is `x.json`.
            let next = std::fs::canonicalize(&next).unwrap_or(next);
            let loaded = self.load(&next)?;
            (next, loaded)
        };
        let value = part(&doc, pointer).ok_or_else(|| format!("{}#{pointer} names nothing", self.shown(&file)))?.clone();
        Ok((file, doc, value))
    }

    /// An entry of `resolutionOrder`: a set or a modifier, inline or by `$ref`.
    fn entry(&mut self, entry: &crate::json::Value, file: &Path, doc: &crate::json::Value) -> Result<(), String> {
        self.steps += 1;
        if self.steps > 10_000 {
            return Ok(());
        }
        let target = field_of(entry, "$ref").and_then(|r| r.as_str());
        let (file, doc, value) = match target {
            Some(target) => self.follow(target, file, doc)?,
            None => (file.to_path_buf(), doc.clone(), entry.clone()),
        };
        if let Some(sources) = field_of(&value, "sources") {
            let key = (file.clone(), target.and_then(|t| t.split_once('#')).map_or("", |(_, p)| p).to_string());
            self.open.push(key);
            let read = self.sources(sources, &file, &doc);
            self.open.pop();
            read?;
        }
        if let Some(crate::json::Value::Object(contexts)) = field_of(&value, "contexts") {
            for (_, sources) in contexts {
                self.sources(sources, &file, &doc)?;
            }
        }
        Ok(())
    }

    /// A set's or a context's sources: token groups inline, files and parts of files, and sets.
    fn sources(&mut self, list: &crate::json::Value, file: &Path, doc: &crate::json::Value) -> Result<(), String> {
        let crate::json::Value::Array(list) = list else { return Ok(()) };
        for source in list {
            self.steps += 1;
            if self.steps > 10_000 {
                return Ok(());
            }
            let Some(target) = field_of(source, "$ref").and_then(|r| r.as_str()) else {
                tokens(source, &mut Vec::new(), &mut self.theme);
                continue;
            };
            let (file, doc, value) = self.follow(target, file, doc)?;
            // A set (its sources array) is read in its place; anything else is tokens.
            match field_of(&value, "sources") {
                Some(sources @ crate::json::Value::Array(_)) => {
                    let key = (file.clone(), target.split_once('#').map_or("", |(_, p)| p).to_string());
                    if self.open.contains(&key) {
                        continue;
                    }
                    self.open.push(key);
                    let read = self.sources(sources, &file, &doc);
                    self.open.pop();
                    read?;
                }
                _ => tokens(&value, &mut Vec::new(), &mut self.theme),
            }
        }
        Ok(())
    }
}

/// A pointer's step with its `%XX` escapes read (`Brand%20Theme`), as a URI fragment is. None when
/// one is malformed or the result is not UTF-8.
fn percent_decoded(step: &str) -> Option<String> {
    let bytes = step.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The value of `key` in an object.
fn field_of<'a>(value: &'a crate::json::Value, key: &str) -> Option<&'a crate::json::Value> {
    match value {
        crate::json::Value::Object(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

/// A line `init` adds to the app's code: the module, or the list on the `App`.
fn is_wiring(line: &str) -> bool {
    line == "pub mod ui;" || line == ".components(ui::COMPONENTS)" || line == ".components(crate::ui::COMPONENTS)"
}

/// `a`, `a and b`, `a, b and c`.
fn names_of(names: &[&String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.iter().map(|n| n.as_str()).collect::<Vec<_>>().join(", ")),
    }
}

/// A token name as its custom property writes it, as `tokens!` does (`slug` in corten-macros'
/// `dtcg.rs`): `Brand Primary` and `brandPrimary` are `brand-primary`, `FONT-SIZE` is `font-size`.
fn css_name(name: &str) -> String {
    let mut out = String::new();
    let mut previous: Option<char> = None;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            if c.is_ascii_uppercase() && previous.is_some_and(|p| p.is_ascii_lowercase()) && !out.ends_with('-') {
                out.push('-');
            }
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        previous = Some(c);
    }
    out.trim_end_matches('-').to_string()
}

/// The value a JSON pointer (`/sets/base`, or empty for the whole) names in `value`.
fn part<'a>(value: &'a crate::json::Value, pointer: &str) -> Option<&'a crate::json::Value> {
    let mut at = value;
    for step in pointer.split('/').skip(1).filter(|s| !s.is_empty()) {
        let step = percent_decoded(step)?.replace("~1", "/").replace("~0", "~");
        at = match at {
            crate::json::Value::Object(fields) => &fields.iter().find(|(k, _)| *k == step)?.1,
            crate::json::Value::Array(items) => items.get(step.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(at)
}

/// Adds what a token file's group at `path` declares to `theme`: a token's custom property (its
/// path joined by `-`, a group's `$root` the group's own), each group at the top, and whether a
/// `$type` is a color.
fn tokens(value: &crate::json::Value, path: &mut Vec<String>, theme: &mut Theme) {
    let crate::json::Value::Object(fields) = value else { return };
    if path.is_empty() {
        theme.breakpoints.extend(breakpoints_of(value));
    }
    for (key, v) in fields {
        if key == "$type" && v.as_str() == Some("color") {
            theme.colors = true;
        }
        let crate::json::Value::Object(inner) = v else { continue };
        let token = inner.iter().any(|(k, _)| k == "$value" || k == "$ref");
        if key == "$root" && token && !path.is_empty() {
            theme.properties.push(path.iter().map(|p| css_name(p)).collect::<Vec<_>>().join("-"));
        }
        if key.starts_with('$') {
            continue;
        }
        path.push(key.clone());
        if token {
            theme.properties.push(path.iter().map(|p| css_name(p)).collect::<Vec<_>>().join("-"));
            if inner.iter().any(|(k, t)| k == "$type" && t.as_str() == Some("color")) {
                theme.colors = true;
            }
        } else {
            if path.len() == 1 {
                theme.groups.push(css_name(key));
            }
            tokens(v, path, theme);
        }
        path.pop();
    }
}

/// `pub mod ui;` in the crate's root (`src/lib.rs`, else `src/main.rs`) and `.components(..)`
/// on the one `App::new(..)` the crate has, wherever it is: each changed file. An error says
/// what to do by hand when one cannot be placed; a second run changes nothing.
fn wire_app(app: &[(String, String)]) -> Result<Vec<(String, String)>, String> {
    let by_hand = |why: &str| {
        format!("{why}: declare pub mod ui; in src/lib.rs (or src/main.rs) and add .components(ui::COMPONENTS) to the App")
    };
    let root = ["src/lib.rs", "src/main.rs"]
        .into_iter()
        .find(|p| app.iter().any(|(path, _)| path == p))
        .ok_or_else(|| by_hand("there is no src/lib.rs or src/main.rs"))?;
    let news: Vec<&str> = app
        .iter()
        .filter(|(path, text)| !is_kit_file(path, text) && text.lines().any(|l| l.trim_start().starts_with("App::new(")))
        .map(|(path, _)| path.as_str())
        .collect();
    let at = match news[..] {
        [one] => one,
        [] => return Err(by_hand("no file in src/ has an App::new( line")),
        _ => return Err(by_hand(&format!("{} have App::new( lines", news.join(" and ")))),
    };
    let text_of = |p: &str| app.iter().find(|(path, _)| path == p).map(|(_, t)| t.clone()).unwrap_or_default();
    let mut edits: Vec<(String, String)> = Vec::new();
    let root_text = text_of(root);
    if let Some(text) = declare_ui(&root_text) {
        edits.push((root.to_string(), text));
    } else if !root_text.lines().any(|l| matches!(l.trim(), "mod ui;" | "pub mod ui;")) {
        return Err(by_hand(&format!("{root} has no mod lines to put pub mod ui; among")));
    }
    // A binary's file (`src/main.rs` beside `src/lib.rs`, `src/bin/`) reaches the library by its
    // crate's name, which is the app's to write.
    if root == "src/lib.rs" && (at == "src/main.rs" || at.starts_with("src/bin/")) {
        return Err(by_hand(&format!("{at} builds the App outside the library that declares ui")));
    }
    let path = if at == root { "ui::COMPONENTS" } else { "crate::ui::COMPONENTS" };
    let app_text = edits.iter().find(|(p, _)| p == at).map(|(_, t)| t.clone()).unwrap_or_else(|| text_of(at));
    if !app_text.contains(".components(ui::COMPONENTS)") && !app_text.contains(".components(crate::ui::COMPONENTS)") {
        let text =
            list_on_app(&app_text, path).ok_or_else(|| by_hand(&format!("{at}'s App::new( line goes on past its line")))?;
        match edits.iter_mut().find(|(p, _)| p == at) {
            Some(edit) => edit.1 = text,
            None => edits.push((at.to_string(), text)),
        }
    }
    Ok(edits)
}

/// Writes every file, or none. Each text is first written to a new file next to its own
/// (`.<name>.corten-ui`; refused if the app has one by that name), which touches nothing the app
/// has; only when all are written does each replace its file (`rename`, which replaces an
/// existing file on Windows too), and
/// when one cannot, those replaced before it are put back as they were (a new one removed), so a
/// retry starts where the first try did. A file that cannot be put back is named in the error.
/// Each path is relative to `root`.
fn apply(root: &Path, files: &[(String, String)]) -> Result<(), String> {
    let mut made: Vec<PathBuf> = Vec::new();
    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (path, text) in files {
        let path = root.join(path);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let temp = path.with_file_name(format!(".{name}.corten-ui"));
        if let Err(error) = make_dirs(&path, &mut made) {
            let left = undo(&[], &staged, &made);
            return Err(rolled_back(&error, &left));
        }
        // Only a file this call created is staged, so only it is removed on the way back.
        match stage(&temp, text) {
            Ok(()) => staged.push((path, temp)),
            Err((error, created)) => {
                if created {
                    staged.push((path, temp));
                }
                let left = undo(&[], &staged, &made);
                return Err(rolled_back(&error, &left));
            }
        }
    }
    let mut done: Vec<(PathBuf, Option<Vec<u8>>)> = Vec::new();
    for (path, temp) in &staged {
        let before = std::fs::read(path).ok();
        if let Err(error) = std::fs::rename(temp, path) {
            let left = undo(&done, &staged, &made);
            return Err(rolled_back(&format!("{}: {error}", path.display()), &left));
        }
        done.push((path.clone(), before));
    }
    Ok(())
}

/// Writes `text` to `temp`, a file that must not exist yet. The error says whether the file was
/// created (and so is this call's to remove).
fn stage(temp: &Path, text: &str) -> Result<(), (String, bool)> {
    use std::io::Write;
    let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(temp).map_err(|e| {
        let why = if e.kind() == std::io::ErrorKind::AlreadyExists {
            "is in the way of the file this command writes beside its own; move it and run it again".to_string()
        } else {
            e.to_string()
        };
        (format!("{}: {why}", temp.display()), false)
    })?;
    out.write_all(text.as_bytes()).and_then(|()| out.sync_all()).map_err(|e| (format!("{}: {e}", temp.display()), true))
}

/// Creates the directories `path` needs, adding each one made to `made`, outermost first.
fn make_dirs(path: &Path, made: &mut Vec<PathBuf>) -> Result<(), String> {
    let Some(parent) = path.parent() else { return Ok(()) };
    let mut missing: Vec<PathBuf> =
        parent.ancestors().take_while(|d| !d.as_os_str().is_empty() && !d.exists()).map(Path::to_path_buf).collect();
    missing.reverse();
    for dir in missing {
        std::fs::create_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        made.push(dir);
    }
    Ok(())
}

/// Puts back each replaced file (`done`, with what it held), removes the staged texts and the
/// directories made for them, and returns the paths it could not restore.
fn undo(done: &[(PathBuf, Option<Vec<u8>>)], staged: &[(PathBuf, PathBuf)], made: &[PathBuf]) -> Vec<PathBuf> {
    let mut left = Vec::new();
    for (path, before) in done.iter().rev() {
        let back = match before {
            Some(bytes) => std::fs::write(path, bytes),
            None => std::fs::remove_file(path),
        };
        if back.is_err() {
            left.push(path.clone());
        }
    }
    for (_, temp) in staged {
        if temp.exists() && std::fs::remove_file(temp).is_err() {
            left.push(temp.clone());
        }
    }
    for dir in made.iter().rev() {
        if dir.exists() && std::fs::remove_dir(dir).is_err() {
            left.push(dir.clone());
        }
    }
    left
}

fn rolled_back(error: &str, left: &[PathBuf]) -> String {
    if left.is_empty() {
        return format!("{error}; nothing was changed");
    }
    let names: Vec<String> = left.iter().map(|p| p.display().to_string()).collect();
    format!("{error}; these could not be put back as they were, so fix them by hand: {}", names.join(", "))
}

/// The file with `pub mod ui;` among its `mod` lines, in name order as rustfmt sorts them. None
/// when it declares it already or has no `mod` line to place it by.
fn declare_ui(text: &str) -> Option<String> {
    if text.lines().any(|l| matches!(l.trim(), "mod ui;" | "pub mod ui;")) {
        return None;
    }
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let last = lines.iter().rposition(|l| is_mod_line(l))?;
    let mut first = last;
    while first > 0 && is_mod_line(&lines[first - 1]) {
        first -= 1;
    }
    let name = |l: &str| l.trim_start_matches("pub ").trim_start_matches("mod ").trim_end_matches(';').to_string();
    let mod_at = (first..=last).find(|&i| name(&lines[i]).as_str() > "ui").unwrap_or(last + 1);
    lines.splice(mod_at..mod_at, [MODULE_DOC.to_string(), "pub mod ui;".to_string()]);
    Some(joined(&lines, text))
}

/// The file with `.components(<list>)` on its one `App::new(..)` line, which ends on that line.
fn list_on_app(text: &str, list: &str) -> Option<String> {
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let news: Vec<usize> =
        lines.iter().enumerate().filter(|(_, l)| l.trim_start().starts_with("App::new(")).map(|(i, _)| i).collect();
    let [at] = news[..] else { return None };
    // `App::new(..)` alone on its line, so the method goes on the next one.
    let line = &lines[at];
    if !line.trim_end().ends_with(')') || line.matches('(').count() != line.matches(')').count() {
        return None;
    }
    let indent = line.len() - line.trim_start().len();
    lines.insert(at + 1, format!("{}.components({list})", " ".repeat(indent + 4)));
    Some(joined(&lines, text))
}

/// The lines as one text, ending as `was` ends.
fn joined(lines: &[String], was: &str) -> String {
    let mut out = lines.join("\n");
    if was.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn is_mod_line(line: &str) -> bool {
    let rest = line.strip_prefix("pub ").unwrap_or(line);
    rest.strip_prefix("mod ")
        .is_some_and(|name| name.ends_with(';') && name[..name.len() - 1].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
}

fn add(root: &Path, args: &[String]) -> Result<(), String> {
    add_to(root, args, &mut std::io::stdout())
}

/// `add`, saying what it did and what is left to do in `out`.
fn add_to(root: &Path, args: &[String], out: &mut dyn Write) -> Result<(), String> {
    let force = args.iter().any(|a| a == "--force");
    let merge = args.iter().any(|a| a == "--merge");
    if force && merge {
        return Err("--force replaces a copy and --merge keeps its edits: give one".to_string());
    }
    let names: Vec<&str> = args.iter().map(String::as_str).filter(|a| !a.starts_with("--")).collect();
    let pieces: Vec<&Piece> = if args.iter().any(|a| a == "--all") {
        KIT.iter().collect()
    } else {
        if names.is_empty() {
            return Err(USAGE.to_string());
        }
        let mut found = Vec::new();
        for name in &names {
            let piece =
                KIT.iter().find(|p| p.name == *name).ok_or_else(|| format!("the kit has no {name:?}; it has:\n{}", list()))?;
            if !found.iter().any(|p: &&Piece| p.name == piece.name) {
                found.push(piece);
            }
        }
        found
    };
    let module = std::fs::read_to_string(root.join("src/ui.rs"))
        .map_err(|_| "src/ui.rs is missing: run corten ui init first".to_string())?;
    // The files this writes are the kit's whatever they hold now (a copy whose stamp line was lost).
    let writes: Vec<String> =
        pieces.iter().flat_map(|p| p.files.iter().map(|(file, _)| slash(&PathBuf::from("src/ui").join(file)))).collect();
    let app: Vec<(String, String)> = sources(root).into_iter().filter(|(path, _)| !writes.contains(path)).collect();
    let clash = clashes(&app, &pieces);
    if !clash.is_empty() {
        let mut why = String::from(
            "a component's classes are named after it, for the whole page, so two with one name and a stylesheet each do not link:\n",
        );
        for (path, name, piece) in &clash {
            why.push_str(&format!("  {path} has {name}, as the kit's {piece} does\n"));
        }
        why.push_str(
            "rename the app's component and run this again, or leave the kit's out (corten ui add with the other names)",
        );
        return Err(why);
    }
    // Every file is checked, and every change worked out, before any is written.
    if !force && !merge {
        for piece in &pieces {
            for (file, _) in piece.files {
                let path = PathBuf::from("src/ui").join(file);
                if root.join(&path).exists() {
                    return Err(format!(
                        "{} exists; corten ui add --merge {} takes the kit's changes and keeps its edits, --force replaces it",
                        slash(&path),
                        piece.name
                    ));
                }
            }
        }
    }
    let mut files = Vec::new();
    let mut said = Vec::new();
    let mut todo = Vec::new();
    let mut listed = Ok(module.clone());
    let mut conflicted: Vec<String> = Vec::new();
    // Each copy's text, worked out at once: laying one out as the app's code starts a rustfmt.
    let mut jobs: Vec<(String, &str, String, Option<String>)> = Vec::new();
    for piece in &pieces {
        for (file, text) in piece.files {
            let path = slash(&PathBuf::from("src/ui").join(file));
            let copy = match merge && root.join(&path).exists() {
                true => Some(
                    std::fs::read_to_string(root.join(&path))
                        .map_err(|e| format!("{path}: {e}, so its edits cannot be merged"))?,
                ),
                false => None,
            };
            jobs.push((path, *file, stamped(text), copy));
        }
    }
    let texts = par_map(&jobs, |(path, file, kit, copy)| match copy {
        Some(copy) => merged(root, path, file, copy, kit),
        None => {
            let (text, laid) = as_apps(root, path, kit);
            Ok((text, 0, laid))
        }
    });
    let mut unlaid = Vec::new();
    let mut texts = jobs.into_iter().map(|(path, ..)| path).zip(texts);
    for piece in &pieces {
        let mut written = Vec::new();
        for _ in piece.files {
            let (path, text) = texts.next().expect("a text for each file");
            let (text, conflicts, laid) = text?;
            if conflicts > 0 {
                conflicted.push(format!(
                    "{path}: {conflicts} place{} where this copy and the kit both changed, between <<<<<<< this copy and >>>>>>> the kit: keep what each should, then corten fmt",
                    if conflicts == 1 { "" } else { "s" }
                ));
            }
            if !laid {
                unlaid.push(path.clone());
            }
            files.push((path.clone(), text));
            written.push(path);
        }
        said.push(format!("  added {}: {}", piece.name, written.join(", ")));
        listed = listed.and_then(|m| list_in(&m, piece));
    }
    let copies = files.len();
    match listed {
        Ok(text) if text != module => {
            files.push(("src/ui.rs".into(), text));
            said.push("  edited src/ui.rs".into());
        }
        Ok(_) => {}
        Err(why) => {
            todo.push(format!("{why}, so it is unchanged"));
            todo.extend(pieces.iter().filter_map(|piece| lacks(&module, piece)));
        }
    }
    // A component that styles a corten-ui widget needs the widget: the dependency, and its
    // components listed, as the app's own are.
    if let Some(widget) = pieces.iter().find_map(|p| p.styles) {
        match depend_on_ui_at(root) {
            Ok(edits) => {
                for (path, text) in edits {
                    let table = if path == "Cargo.toml" { "" } else { " [workspace.dependencies]" };
                    said.push(format!("  edited {path}:{table} corten-ui, the widgets these components style"));
                    files.push((path, text));
                }
            }
            Err(why) => todo.push(format!(
                "add corten-ui to Cargo.toml's [dependencies], from where corten comes ({why}): corten_ui::{widget} is what the component styles"
            )),
        }
        let listed = app.iter().any(|(path, text)| !is_kit_file(path, text) && text.contains("corten_ui::COMPONENTS"));
        match app.iter().find_map(|(path, text)| Some((path, list_ui_widgets(text)?))) {
            _ if listed => {}
            Some((path, text)) => {
                said.push(format!("  edited {path}: .components(corten_ui::COMPONENTS) on the App"));
                files.push((path.clone(), text));
            }
            None => {
                todo.push("add .components(corten_ui::COMPONENTS) to each App that renders these, after its own list".to_string())
            }
        }
    }
    for (path, name, piece) in namesakes(&app, &pieces) {
        said.push(namesake_note(&path, &name, piece));
    }
    let lacking = undeclared(root, &app, &pieces);
    if !lacking.breakpoints.is_empty() {
        todo.push(format!(
            "these name breakpoints your theme does not make{}: add each to $extensions.\"run.corten\".breakpoints on the\n    \
             root group of {}, a width in its place, smallest first, or the name of another in braces (\"wide\": \"{{md}}\"),\n    \
             as one at a width the theme already makes must be; the app does not start while one is missing\n    {}",
            if lacking.kit_theme { " (an older kit set it up)" } else { "" },
            if lacking.kit_theme { INIT[0].0 } else { "a token file" },
            lacking
                .breakpoints
                .iter()
                .map(|name| missing_breakpoint(name, &lacking.made, &lacking.named, &lacking.resolvers, lacking.kit_theme.then_some(INIT[2].0)))
                .collect::<Vec<_>>()
                .join(",\n    ")
        ));
    }
    for (name, widths) in &lacking.differing {
        todo.push(format!(
            "these name the breakpoint {name}, which your token files make at different widths ({}): keep it in one\n    \
             file, or give it one width; the app does not start while they differ",
            widths.iter().map(|(file, width)| format!("{file} {width}")).collect::<Vec<_>>().join(", ")
        ));
    }
    if !lacking.sizes.is_empty() {
        todo.push(format!(
            "these read sizes or type your theme does not declare{}: add each to it\n    \
             as the kit's theme has it; the app does not start while one is missing\n    {}",
            if lacking.kit_theme { " (one an older kit set up lacks the newer ones)" } else { "" },
            lacking.sizes.join(",\n    ")
        ));
    }
    if let Some(first) = lacking.colors.first() {
        let kit_line = |theme: &str, name: &str| {
            let line = theme.lines().map(str::trim).find(|l| l.starts_with(&format!("\"{name}\":")));
            line.unwrap_or_default().trim_end_matches(',').to_string()
        };
        todo.push(if lacking.kit_theme {
            let lines = |theme: &str| lacking.colors.iter().map(|c| kit_line(theme, c)).collect::<Vec<_>>().join(",\n    ");
            format!(
                "these read colors the kit's theme you have does not declare (an older kit set it up): add each as the kit\n    \
                 has it, to {}:\n    {}\n  and to {}:\n    {}\n  the app does not start while one is missing",
                INIT[0].0,
                lines(INIT[0].1),
                INIT[1].0,
                lines(INIT[1].1)
            )
        } else {
            format!(
                "these read colors your theme does not declare: add each as a reference to one of your colors, so it follows\n    \
                 every theme you have (\"{first}\": {{ \"$type\": \"color\", \"$value\": \"{{..}}\" }}); the app does not start\n    \
                 while one is missing\n    {}",
                lacking.colors.join(", ")
            )
        });
    }
    // The app's own files this edits (src/ui.rs's list, the App's line) laid out as its code too.
    unlaid.extend(lay_out_own(root, &mut files[copies..], &app));
    todo.extend(not_laid_out(&unlaid));
    apply(root, &files)?;
    for line in said {
        let _ = writeln!(out, "{line}");
    }
    for step in todo {
        let _ = writeln!(out, "  to do: {step}");
    }
    if !conflicted.is_empty() {
        // Written, as git writes a merge it could not finish, and a failure, as git's is.
        return Err(format!("merged with conflicts to resolve:\n  {}", conflicted.join("\n  ")));
    }
    Ok(())
}

/// The kit's tokens that `pieces'` stylesheets read and the app declares nowhere: not in a theme
/// (every `tokens!` it has) nor in a stylesheet under `static/`, which the app's startup check
/// counts too. Empty when no theme can be read: `tokens!` refuses one it cannot read when the app
/// compiles, naming the file.
#[derive(Debug, Default, PartialEq)]
struct Lacking {
    /// The kit theme's line for each size, weight or tracking (`"control-height": { .. }`), the
    /// same in every theme, which a theme takes as it is.
    sizes: Vec<String>,
    /// Each color's name: an app's own theme gives it as a reference to one of its colors, so it
    /// follows the app's dark theme too, where the kit's light value would not.
    colors: Vec<String>,
    /// Whether the theme is the kit's (`init`'s resolver), whose light and dark files take each
    /// color as the kit's have it.
    kit_theme: bool,
    /// Each breakpoint of the kit's theme a stylesheet's `@media` rule names (`sm`) that no theme
    /// makes.
    breakpoints: Vec<String>,
    /// Each breakpoint a stylesheet's `@media` rule names that the app's token files make at
    /// different widths, with each file and its width.
    differing: Vec<(String, Vec<(String, String)>)>,
    /// Each breakpoint the app's token files make: its file, name and width.
    made: Vec<(String, String, String)>,
    /// Those made by naming another, with the file.
    named: Vec<(String, String)>,
    /// The token files that are resolvers.
    resolvers: Vec<String>,
}

fn undeclared(root: &Path, app: &[(String, String)], pieces: &[&Piece]) -> Lacking {
    let mut declared: Option<Vec<String>> = None;
    let mut made: Vec<(String, String, String)> = Vec::new();
    let mut named: Vec<(String, String)> = Vec::new();
    let mut resolvers: Vec<String> = Vec::new();
    let mut kit_theme = false;
    for (path, text) in app.iter().filter(|(_, text)| text.contains(TOKENS_CALL)) {
        if let Ok(Some(theme)) = own_theme(root, text) {
            declared.get_or_insert_with(Vec::new).extend(theme.properties);
            let file = tokens_path(text).unwrap_or_else(|| path.clone());
            made.extend(theme.breakpoints.into_iter().map(|(name, width)| (file.clone(), name, width)));
            named.extend(theme.named.into_iter().map(|name| (file.clone(), name)));
            if theme.resolver {
                resolvers.push(file.clone());
            }
            kit_theme |= tokens_path(text).as_deref() == Some(INIT[2].0);
        }
    }
    let Some(mut declared) = declared else { return Lacking::default() };
    declared.extend(static_declarations(&root.join("static")));
    let kit = role_tokens();
    let kit_breakpoints: Vec<String> = kit_breakpoints().into_iter().map(|(name, _)| name).collect();
    let mut out = Lacking { kit_theme, made: made.clone(), named, resolvers, ..Lacking::default() };
    for (file, text) in pieces.iter().flat_map(|p| p.files.iter()) {
        if !file.ends_with(".css") {
            continue;
        }
        for name in media_names(text) {
            let widths: Vec<(String, String)> =
                made.iter().filter(|(_, n, _)| *n == name).map(|(file, _, width)| (file.clone(), width.clone())).collect();
            if widths.is_empty() {
                if kit_breakpoints.contains(&name) && !out.breakpoints.contains(&name) {
                    out.breakpoints.push(name);
                }
            } else if widths.iter().any(|(_, w)| *w != widths[0].1) && !out.differing.iter().any(|(n, _)| *n == name) {
                out.differing.push((name, widths));
            }
        }
        for read in text.split("var(--").skip(1) {
            let name: String = read.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
            if !kit.contains(&name) || declared.contains(&name) {
                continue;
            }
            let line = INIT[0].1.lines().map(str::trim).find(|l| l.starts_with(&format!("\"{name}\":")));
            let line = line.unwrap_or_default().trim_end_matches(',').to_string();
            if line.contains("\"$type\": \"color\"") {
                if !out.colors.contains(&name) {
                    out.colors.push(name);
                }
            } else if !out.sizes.contains(&line) {
                out.sizes.push(line);
            }
        }
    }
    out
}

/// `css` with each comment and string a space, so a `/*` in a string starts no comment and
/// a `--name:` in either declares nothing.
fn code_of(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut chars = css.chars().peekable();
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
                out.push(' ');
            }
            '"' | '\'' => {
                while let Some(s) = chars.next() {
                    if s == '\\' {
                        chars.next();
                    } else if s == c || s == '\n' {
                        break;
                    }
                }
                out.push(' ');
            }
            c => out.push(c),
        }
    }
    out
}

/// The custom properties the stylesheets under `dir` declare (`--name:`, `@property --name`),
/// without the `--`, comments skipped, as the app's startup check reads them.
fn static_declarations(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(static_declarations(&path));
            continue;
        }
        if path.extension().is_none_or(|e| e != "css") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let css = code_of(&text);
        for (at, _) in css.match_indices("--") {
            let before = &css[..at];
            if before.ends_with(|c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
                continue;
            }
            let rest = &css[at + 2..];
            let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
            let declared = rest[name.len()..].trim_start().starts_with(':') || before.trim_end().ends_with("@property");
            if !name.is_empty() && declared {
                out.push(name);
            }
        }
    }
    out
}

/// `Cargo.toml` with `corten-ui` after `corten` in `[dependencies]`, from the same place, as the
/// two must be one source for their `Component`s to be one type: the `corten-ui` next to a local
/// `corten` (`--corten-path`), the same repository and revision as a Git `corten`, else this
/// command's release, which `corten`'s is too. None when it is there already; an error saying
/// why it cannot be placed.
fn depend_on_ui(text: &str) -> Result<Option<String>, String> {
    depend_in(text, "[dependencies]", None)
}

/// The manifests `ui add` edits for `corten-ui`, each by its path from the app's root: the
/// app's `Cargo.toml` (`depend_on_ui`), or, for a member whose `corten` comes from the workspace,
/// the member's `corten-ui` from the workspace too, and the workspace's `corten-ui` beside its
/// `corten`, from the same place, when it has none. Empty when there is nothing to add.
fn depend_on_ui_at(root: &Path) -> Result<Vec<(String, String)>, String> {
    let member = std::fs::read_to_string(root.join("Cargo.toml")).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = member.lines().collect();
    let Some(line) = corten_at(&lines, "[dependencies]")?.map(|at| lines[at]) else {
        return Ok(depend_on_ui(&member)?.map(|text| ("Cargo.toml".to_string(), text)).into_iter().collect());
    };
    let Some(ui) = from_workspace(line)? else {
        return Ok(depend_on_ui(&member)?.map(|text| ("Cargo.toml".to_string(), text)).into_iter().collect());
    };
    let (path, workspace) = workspace_manifest(root)?;
    let in_workspace = |why: String| {
        format!("{path}: {why}; add corten-ui to its [workspace.dependencies] from where its corten comes, beside it")
    };
    let workspace_now = depend_in(&workspace, "[workspace.dependencies]", None).map_err(in_workspace)?;
    if path == "Cargo.toml" {
        // The package is its workspace's root: both lines go into its one manifest.
        let text = workspace_now.unwrap_or(workspace);
        let both = depend_in(&text, "[dependencies]", Some(ui))?;
        return Ok(match both.or(Some(text).filter(|t| *t != member)) {
            Some(text) => vec![(path, text)],
            None => Vec::new(),
        });
    }
    let mut edits = Vec::new();
    if let Some(text) = workspace_now {
        edits.push((path, text));
    }
    if let Some(text) = depend_in(&member, "[dependencies]", Some(ui))? {
        edits.push(("Cargo.toml".to_string(), text));
    }
    Ok(edits)
}

/// The manifest of `root`'s workspace, as cargo finds it (`[workspace]` in the package's own
/// `Cargo.toml` or one above, `package.workspace`, `exclude`), by its path from `root`
/// (`../Cargo.toml`, or `Cargo.toml` when the package is its root), and its text.
fn workspace_manifest(root: &Path) -> Result<(String, String), String> {
    let output = std::process::Command::new("cargo")
        .args(["locate-project", "--workspace", "--message-format", "plain", "--manifest-path"])
        .arg(root.join("Cargo.toml"))
        .output()
        .map_err(|e| format!("could not run cargo locate-project to find its workspace: {e}"))?;
    if !output.status.success() {
        return Err(format!("cargo could not find its workspace: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let found = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    let canonical = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let (found, root) = (canonical(&found), canonical(root));
    let text = std::fs::read_to_string(&found).map_err(|e| format!("{}: {e}", found.display()))?;
    let mut up = String::new();
    for dir in root.ancestors() {
        if found.parent() == Some(dir) {
            return Ok((format!("{up}Cargo.toml"), text));
        }
        up.push_str("../");
    }
    Ok((found.display().to_string(), text))
}

/// Whether `corten`'s line is a key of the table (`corten = ..`, `corten.workspace = ..`), by its
/// name in the code or by its package (`corten-run = ..`, as `cargo add corten-run` writes, which
/// the code still calls `corten`).
fn is_corten_line(line: &str) -> bool {
    corten_key(line).is_some()
}

/// The key `corten`'s line starts with, `corten` or its package's name; None for another line.
fn corten_key(line: &str) -> Option<&'static str> {
    let line = line.trim_start();
    ["corten", crate::pin::PACKAGES[0]]
        .into_iter()
        .find(|key| line.strip_prefix(key).is_some_and(|rest| rest.starts_with([' ', '=', '.'])))
}

/// Why `table` of `lines` has no `corten` line this reads: `otherwise`, unless corten is a table of
/// its own (`[workspace.dependencies.corten]`, or keyed by its package), which this does not read.
fn lacking(lines: &[&str], table: &str, otherwise: String) -> String {
    let within = table.trim_end_matches(']');
    let own = ["corten", crate::pin::PACKAGES[0]].map(|key| format!("{within}.{key}]"));
    match own.iter().find(|own| lines.iter().any(|l| header(l) == own.as_str())) {
        Some(own) => format!("its corten is a table of its own, {own}, which this does not read"),
        None => otherwise,
    }
}

/// A manifest line without its comment and the spaces around it, so a table's header is the same
/// with a comment after it (`[workspace.dependencies] # shared`).
fn header(line: &str) -> &str {
    line.split('#').next().unwrap_or_default().trim()
}

/// The index of `corten`'s line in `table` of `lines`; None when it has none. An error when it
/// has no such table.
fn corten_at(lines: &[&str], table: &str) -> Result<Option<usize>, String> {
    let start =
        lines.iter().position(|l| header(l) == table).ok_or_else(|| lacking(lines, table, format!("it has no {table}")))?;
    let end = lines[start + 1..].iter().position(|l| l.trim_start().starts_with('[')).map_or(lines.len(), |i| start + 1 + i);
    Ok(lines[start + 1..end].iter().position(|l| is_corten_line(l)).map(|i| start + 1 + i))
}

/// The member's `corten-ui` line when `corten`'s comes from the workspace, in the same form
/// (`corten.workspace = true`, or a table with `workspace = true`); None when it does not. An
/// error for another dotted key (`corten.git = ..`), which this does not read.
fn from_workspace(line: &str) -> Result<Option<&'static str>, String> {
    let key = line.trim_start().split(['=', ' ']).next().unwrap_or_default();
    let dotted = corten_key(line).and_then(|name| key.strip_prefix(name)?.strip_prefix('.'));
    if dotted == Some("workspace") {
        return Ok(Some("corten-ui.workspace = true"));
    }
    if let Some(name) = corten_key(line).filter(|_| dotted.is_some()) {
        return Err(format!("corten's line is a dotted key other than {name}.workspace"));
    }
    let fields = dependency_fields(line)?;
    Ok(fields.iter().any(|(k, v)| k == "workspace" && v == "true").then_some("corten-ui = { workspace = true }"))
}

/// `text` with `corten-ui` after `corten`'s line in `table`: `ui` when given (a member's line from
/// the workspace), else from `corten`'s own source. None when `corten-ui` is there already.
fn depend_in(text: &str, table: &str, ui: Option<&str>) -> Result<Option<String>, String> {
    let lines: Vec<&str> = text.lines().collect();
    let start =
        lines.iter().position(|l| header(l) == table).ok_or_else(|| lacking(&lines, table, format!("it has no {table}")))?;
    let end = lines[start + 1..].iter().position(|l| l.trim_start().starts_with('[')).map_or(lines.len(), |i| start + 1 + i);
    let section = &lines[start + 1..end];
    if section.iter().any(|l| l.trim_start().starts_with("corten-ui")) {
        return Ok(None);
    }
    let at = corten_at(&lines, table)?.ok_or_else(|| lacking(&lines, table, format!("it has no corten line in {table}")))?;
    let dependency = match ui {
        Some(line) => line.to_string(),
        None => ui_from(lines[at])?,
    };
    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    out.insert(at + 1, dependency);
    let mut text_out = out.join("\n");
    if text.ends_with('\n') {
        text_out.push('\n');
    }
    Ok(Some(text_out))
}

/// `corten-ui`'s line from where `corten`'s `line` takes it.
fn ui_from(line: &str) -> Result<String, String> {
    if corten_key(line).is_some_and(|name| line.trim_start()[name.len()..].starts_with('.')) {
        return Err("corten's line is a dotted key, which this does not read".into());
    }
    let fields = dependency_fields(line)?;
    let get = |key: &str| fields.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
    let dependency = if let Some(path) = get("path") {
        // The value as written, quotes and escapes kept: `corten` is its last segment.
        let (quote, body) = path.split_at(1);
        let parent = body
            .strip_suffix(quote)
            .and_then(|p| p.strip_suffix("corten"))
            .ok_or("corten's path does not end at the corten crate")?;
        format!("corten-ui = {{ path = {quote}{parent}corten-ui{quote} }}")
    } else if let Some(git) = get("git") {
        let mut keys = vec![format!("git = {git}")];
        keys.extend(["branch", "tag", "rev"].into_iter().filter_map(|key| get(key).map(|v| format!("{key} = {v}"))));
        format!("corten-ui = {{ {} }}", keys.join(", "))
    } else if get("workspace").is_some() || get("registry").is_some() {
        return Err("corten comes from the workspace or another registry, so corten-ui must come from the same place".into());
    } else {
        format!("corten-ui = \"{}\"", env!("CARGO_PKG_VERSION"))
    };
    Ok(dependency)
}

/// The keys of a `corten = ..` line, each with its value as written (a string with its quotes):
/// none for a version alone (`corten = "0.1"`). A comment is not read. An error for what this
/// does not read exactly, a table that goes on past its line among them, so the caller says to
/// add `corten-ui` by hand rather than add the wrong one.
fn dependency_fields(line: &str) -> Result<Vec<(String, String)>, String> {
    let parts = split_outside_quotes(line, '#')?;
    let code = parts[0].trim();
    let value = code.split_once('=').map(|(_, v)| v.trim()).ok_or("corten's line has no value")?;
    if value.starts_with(['"', '\'']) {
        return Ok(Vec::new());
    }
    let inner = value
        .strip_prefix('{')
        .and_then(|v| v.strip_suffix('}'))
        .ok_or("corten's table goes on past its line, or is not an inline table")?;
    let mut fields = Vec::new();
    for part in split_outside_quotes(inner, ',')? {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (key, value) =
            part.split_once('=').ok_or_else(|| format!("corten's table has {part:?}, which is not key = value"))?;
        let key = key.trim().trim_matches(['"', '\'']).to_string();
        fields.push((key, value.trim().to_string()));
    }
    Ok(fields)
}

/// `text` split at each `at` outside a string or an array (`[..]`, as `features` is). An error
/// when a string is not closed.
fn split_outside_quotes(text: &str, at: char) -> Result<Vec<&str>, String> {
    let (mut parts, mut start, mut quote, mut depth) = (Vec::new(), 0, None, 0usize);
    let mut chars = text.char_indices();
    while let Some((i, c)) = chars.next() {
        match (quote, c) {
            // A basic string's escape: the next character is part of it.
            (Some('"'), '\\') => {
                chars.next();
            }
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '[') => depth += 1,
            (None, ']') => depth = depth.saturating_sub(1),
            (None, c) if c == at && depth == 0 => {
                parts.push(&text[start..i]);
                start = i + c.len_utf8();
                if at == '#' {
                    // A comment runs to the end of the line.
                    return Ok(parts);
                }
            }
            _ => {}
        }
    }
    if quote.is_some() {
        return Err("corten's line has a string that is not closed".into());
    }
    parts.push(&text[start..]);
    Ok(parts)
}

/// The file with `.components(corten_ui::COMPONENTS)` after its `.components(ui::COMPONENTS)`
/// (or `crate::ui::COMPONENTS`) line; None when it has no such line.
fn list_ui_widgets(text: &str) -> Option<String> {
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let at =
        lines.iter().position(|l| matches!(l.trim(), ".components(ui::COMPONENTS)" | ".components(crate::ui::COMPONENTS)"))?;
    let indent = lines[at].len() - lines[at].trim_start().len();
    lines.insert(at + 1, format!("{}.components(corten_ui::COMPONENTS)", " ".repeat(indent)));
    Some(joined(&lines, text))
}

/// For each copied file of the components named (all that `src/ui/` has, by default): whether
/// the app edited it and whether the kit changed it since the copy, each as its own diff from the
/// kit's text the copy was made from, laid out as the app lays out its code, so a layout alone
/// (`corten fmt` with the app's `rustfmt.toml`) is not an edit. Writes nothing.
fn diff(root: &Path, args: &[String]) -> Result<(), String> {
    let names: Vec<&str> = args.iter().map(String::as_str).filter(|a| !a.starts_with("--")).collect();
    for name in &names {
        if !KIT.iter().any(|p| p.name == *name) {
            return Err(format!("the kit has no {name:?}; it has:\n{}", list()));
        }
    }
    let mut seen = 0;
    for piece in KIT.iter().filter(|p| names.is_empty() || names.contains(&p.name)) {
        for (file, kit) in piece.files {
            let path = PathBuf::from("src/ui").join(file);
            let copy = match std::fs::read_to_string(root.join(&path)) {
                Ok(copy) => copy,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    if !names.is_empty() {
                        println!("{}: not copied (corten ui add {})", slash(&path), piece.name);
                    }
                    continue;
                }
                Err(e) => {
                    println!("{}: {e}, so it is not compared", slash(&path));
                    continue;
                }
            };
            seen += 1;
            print!("{}", report(root, &slash(&path), piece.name, file, &copy, kit));
        }
    }
    if seen == 0 && names.is_empty() {
        println!("src/ui/ has no kit components (corten ui add <name>)");
    }
    Ok(())
}

/// The kit's text of `file` whose copies carry `hash`: this command's, or an earlier kit's
/// (`kit/was/`), so a copy's base is known whichever kit it came from.
fn kit_text(file: &str, hash: u64) -> Option<&'static str> {
    let current = KIT.iter().flat_map(|p| p.files.iter()).find(|(f, _)| *f == file).map(|(_, t)| *t);
    current
        .filter(|text| stamp_of(&stamped(text)).is_some_and(|(_, h)| h == hash))
        .or_else(|| WAS.iter().find(|(f, h, _)| *f == file && u64::from_str_radix(h, 16) == Ok(hash)).map(|(_, _, t)| *t))
}

/// A kit file's text after its stamp line, as the app lays out its code: a Rust file through
/// rustfmt with the app's settings and `corten fmt`'s markup layout, a stylesheet as it is. An
/// error when rustfmt cannot lay out a Rust file, as a layout would then read as an edit.
fn as_app(root: &Path, path: &str, text: &str) -> Result<String, String> {
    let body = text.split_once('\n').map_or("", |(_, rest)| rest).replace("\r\n", "\n");
    if !path.ends_with(".rs") {
        return Ok(body);
    }
    crate::fmt::laid_out(root, &root.join(path), &body).ok_or_else(|| {
        format!(
            "rustfmt could not lay out {path} as the app does: it does not parse (a conflict's markers left in it?), or rustfmt is missing (rustup component add rustfmt)"
        )
    })
}

/// The kit's `kit` (stamped) as the app's copy at `path`: its first line the kit's, the rest laid
/// out as the app lays out its code (`as_app`), so `corten check` passes straight after it in an
/// app whose `rustfmt.toml` lays code out otherwise than rustfmt's defaults, as the kit is. As
/// shipped, and `false`, when rustfmt cannot lay it out.
fn as_apps(root: &Path, path: &str, kit: &str) -> (String, bool) {
    let head = kit.split_once('\n').map_or(kit, |(head, _)| head).trim_end_matches('\r');
    match as_app(root, path, kit) {
        Ok(body) => (format!("{head}\n{body}"), true),
        Err(_) => (kit.to_string(), false),
    }
}

/// The app's own Rust file at `path` (`src/ui.rs`, the file with the `App`) after this command
/// edits it (`text`; `was` before, if it was there), laid out as the app lays out its code, its
/// line ends kept. One the app had not laid out keeps its layout, so the edit changes only its own
/// lines. As it is, and `false`, when rustfmt cannot lay it out.
fn as_apps_own(root: &Path, path: &str, text: &str, was: Option<&str>) -> (String, bool) {
    let lay = |text: &str| crate::fmt::laid_out(root, &root.join(path), text);
    if let Some(was) = was {
        match lay(was) {
            None => return (text.to_string(), false),
            Some(laid) if laid != was.replace("\r\n", "\n") => return (text.to_string(), true),
            Some(_) => {}
        }
    }
    match lay(text) {
        Some(laid) => (if text.contains("\r\n") { laid.replace('\n', "\r\n") } else { laid }, true),
        None => (text.to_string(), false),
    }
}

/// Each of the app's own Rust files among `files` laid out as its code (`as_apps_own`, `app`
/// holding each as it was), at once; returns those rustfmt could not lay out.
fn lay_out_own(root: &Path, files: &mut [(String, String)], app: &[(String, String)]) -> Vec<String> {
    let was = |path: &str| app.iter().find(|(p, _)| p == path).map(|(_, text)| text.as_str());
    let laid = par_map(files, |(path, text)| path.ends_with(".rs").then(|| as_apps_own(root, path, text, was(path))));
    let mut not = Vec::new();
    for ((path, text), laid) in files.iter_mut().zip(laid) {
        match laid {
            Some((laid, true)) => *text = laid,
            Some((_, false)) => not.push(path.clone()),
            None => {}
        }
    }
    not
}

/// What to do about the files rustfmt could not lay out as the app does, written as they were.
fn not_laid_out(paths: &[String]) -> Option<String> {
    let (it, them) = if paths.len() == 1 { ("it is", "it") } else { ("they are", "them") };
    (!paths.is_empty()).then(|| {
        format!(
            "rustfmt could not lay out {} as the app lays out its code (rustup component add rustfmt, and a rustfmt.toml it reads), so {it} as written: corten fmt lays {them} out",
            paths.join(", ")
        )
    })
}

/// `f` of each item, in their order, on as many threads as the machine runs at once: laying a
/// file out starts a rustfmt, and `corten ui add --all` lays out dozens.
fn par_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    let next = AtomicUsize::new(0);
    let out: Mutex<Vec<Option<R>>> = Mutex::new((0..items.len()).map(|_| None).collect());
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get()).min(items.len());
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(item) = items.get(i) else { break };
                    let value = f(item);
                    out.lock().unwrap_or_else(|e| e.into_inner())[i] = Some(value);
                }
            });
        }
    });
    out.into_inner().unwrap_or_else(|e| e.into_inner()).into_iter().map(|r| r.expect("each item mapped")).collect()
}

/// What `diff` says about one file: `copy` as the app has it, `kit` as this command has it.
fn report(root: &Path, path: &str, piece: &str, file: &str, copy: &str, kit: &str) -> String {
    let lf = |t: &str| t.replace("\r\n", "\n");
    let body = |t: &str| t.split_once('\n').map_or(String::new(), |(_, rest)| lf(rest));
    let kit = stamped(kit);
    let Some((_, hash)) = stamp_of(copy) else {
        // Without the line, all of the copy is the app's: compare it whole.
        return format!(
            "{path}: no corten ui line at its top, so where it came from is unknown (- this copy, + the kit's):\n{}",
            unified(&lf(copy), &body(&kit))
        );
    };
    let written = fnv(&body(copy)) != hash;
    let kit_changed = stamp_of(&kit).is_some_and(|(_, now)| now != hash);
    if !written && !kit_changed {
        return format!("{path}: as copied, the same as the kit\n");
    }
    let Some(base) = kit_text(file, hash) else {
        // A kit this command does not know (a newer one, or a stamp edited by hand): the copy
        // against the kit, both ways at once.
        return format!(
            "{path}: {}, from a kit whose text this command does not have, so its edits and the kit's are one diff (- this copy, + the kit's):\n{}",
            if written { "edited here" } else { "not edited here" },
            unified(&body(copy), &body(&kit))
        );
    };
    let laid = as_app(root, path, &stamped(base)).and_then(|was| Ok((was, as_app(root, path, copy)?, as_app(root, path, &kit)?)));
    let (was, mine, theirs) = match laid {
        Ok(three) => three,
        // Without rustfmt, a layout reads as an edit: said, and compared as written.
        Err(why) => {
            let unlaid = format!("{path}: {why}, so a layout of the app's reads as an edit here\n");
            return unlaid
                + &report_as(path, piece, (written, written), kit_changed, &body(&stamped(base)), &body(copy), &body(&kit));
        }
    };
    let edited = written && mine != was;
    report_as(path, piece, (written, edited), kit_changed, &was, &mine, &theirs)
}

/// What `report` says, from the three texts laid out alike: the kit's the copy was made from
/// (`was`), the copy (`mine`) and the kit's now (`theirs`). `written` is whether the copy's text
/// differs from what was copied, `edited` whether more than its layout does.
fn report_as(
    path: &str,
    piece: &str,
    (written, edited): (bool, bool),
    kit_changed: bool,
    was: &str,
    mine: &str,
    theirs: &str,
) -> String {
    let theirs = || theirs.to_string();
    match (edited, kit_changed) {
        // Laid out as the app's code only: --merge and --force both take the kit's change laid out so.
        (false, true) if written => format!(
            "{path}: changed in the kit since the copy, laid out here but not edited, so corten ui add --merge {piece} takes it in the app's layout (- as copied, + the kit's now):\n{}",
            unified(was, &theirs())
        ),
        (false, false) => format!("{path}: as copied, laid out as the app's code, the same as the kit\n"),
        (true, false) => {
            format!("{path}: edited here; the kit has not changed it since (- as copied, + this copy):\n{}", unified(was, mine))
        }
        (false, true) => format!(
            "{path}: changed in the kit since the copy, not edited here, so corten ui add --force {piece} takes it (- as copied, + the kit's now):\n{}",
            unified(was, &theirs())
        ),
        (true, true) => format!(
            "{path}: edited here and changed in the kit since: corten ui add --merge {piece} takes the kit's changes and keeps these edits, marking a line both changed.\nThis copy's edits (- as copied, + this copy):\n{}The kit's changes (- as copied, + the kit's now):\n{}",
            unified(was, mine),
            unified(was, &theirs())
        ),
    }
}

/// `copy` (a copy of the kit's `base`) with what changed from `base` to `kit` too, all three
/// laid out alike: a stretch only one side changed takes that side's lines, and one both changed
/// differently is marked as git marks a conflict. Returns the text and the number of conflicts.
fn merge3(base: &str, copy: &str, kit: &str) -> (String, usize) {
    let (o, a, b): (Vec<&str>, Vec<&str>, Vec<&str>) = (base.lines().collect(), copy.lines().collect(), kit.lines().collect());
    let (to_a, to_b) = (matches(&o, &a), matches(&o, &b));
    let (mut out, mut conflicts) = (String::new(), 0);
    let push = |out: &mut String, lines: &[&str]| {
        for line in lines {
            out.push_str(line);
            out.push('\n');
        }
    };
    let (mut i, mut ja, mut jb) = (0, 0, 0);
    loop {
        // The next base line both sides kept, or the end.
        let next = (i..o.len()).find_map(|k| Some((k, to_a[k]?, to_b[k]?)));
        let (k, ka, kb) = next.unwrap_or((o.len(), a.len(), b.len()));
        let (was, mine, theirs) = (&o[i..k], &a[ja..ka], &b[jb..kb]);
        if mine == was || mine == theirs {
            push(&mut out, theirs);
        } else if theirs == was {
            push(&mut out, mine);
        } else {
            conflicts += 1;
            out.push_str("<<<<<<< this copy\n");
            push(&mut out, mine);
            out.push_str("=======\n");
            push(&mut out, theirs);
            out.push_str(">>>>>>> the kit\n");
        }
        if next.is_none() {
            break;
        }
        push(&mut out, &o[k..=k]);
        (i, ja, jb) = (k + 1, ka + 1, kb + 1);
    }
    (out, conflicts)
}

/// The kit's `kit` (stamped) for the app's `copy` at `path`, with the copy's edits since the kit's
/// text it came from merged in (`merge3`), laid out as the app's code, and its first line the
/// kit's, so `diff` compares it with this kit from now on. A copy not edited is the kit's, laid out
/// as the app's code too, as the kit ships it (and `false`) when rustfmt cannot lay it out.
fn merged(root: &Path, path: &str, file: &str, copy: &str, kit: &str) -> Result<(String, usize, bool), String> {
    let Some((_, hash)) = stamp_of(copy) else {
        return Err(format!(
            "{path} has no corten ui line at its top, so what it was copied from is unknown: corten ui add --force replaces it"
        ));
    };
    let body = |t: &str| t.split_once('\n').map_or(String::new(), |(_, rest)| rest.replace("\r\n", "\n"));
    // The copy's line ends, as `corten fmt` keeps them.
    let ends = |text: String| if copy.contains("\r\n") { text.replace('\n', "\r\n") } else { text };
    if fnv(&body(copy)) == hash {
        let (text, laid) = as_apps(root, path, &kit.replace("\r\n", "\n"));
        return Ok((ends(text), 0, laid));
    }
    let Some(base) = kit_text(file, hash) else {
        return Err(format!(
            "{path} came from a kit whose text this command does not have, so it cannot be merged: corten ui diff shows it against this kit"
        ));
    };
    let (was, mine, theirs) = (as_app(root, path, &stamped(base))?, as_app(root, path, copy)?, as_app(root, path, kit)?);
    let (text, conflicts) = merge3(&was, &mine, &theirs);
    let head = kit.split_once('\n').map_or(kit, |(head, _)| head).trim_end_matches('\r');
    Ok((ends(format!("{head}\n{text}")), conflicts, true))
}

/// For each line of `a`, the line of `b` it is in their longest common subsequence, if any.
fn matches(a: &[&str], b: &[&str]) -> Vec<Option<usize>> {
    // From the end: kit files are a few hundred lines at most.
    let mut lcs = vec![vec![0u32; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i][j] = if a[i] == b[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    let mut out = vec![None; a.len()];
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            out[i] = Some(j);
            (i, j) = (i + 1, j + 1);
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    out
}

/// A unified diff of two texts' lines, from `old` to `new`, with three lines of context.
fn unified(old: &str, new: &str) -> String {
    let (a, b): (Vec<&str>, Vec<&str>) = (old.lines().collect(), new.lines().collect());
    // The longest common subsequence, from the end: kit files are a few hundred lines at most.
    let mut lcs = vec![vec![0u32; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i][j] = if a[i] == b[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    // Each line: ' ' in both, '-' only in old, '+' only in new.
    let mut ops: Vec<(char, &str)> = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            ops.push((' ', a[i]));
            (i, j) = (i + 1, j + 1);
        } else if i < a.len() && (j == b.len() || lcs[i + 1][j] >= lcs[i][j + 1]) {
            // A removal first, as git writes a replaced line.
            ops.push(('-', a[i]));
            i += 1;
        } else {
            ops.push(('+', b[j]));
            j += 1;
        }
    }
    let changed: Vec<usize> = ops.iter().enumerate().filter(|(_, (op, _))| *op != ' ').map(|(k, _)| k).collect();
    let mut out = String::new();
    let mut k = 0;
    while k < changed.len() {
        // A hunk: the changes within six lines of each other, with three lines around them.
        let start = changed[k].saturating_sub(3);
        let mut end = changed[k];
        while k < changed.len() && changed[k] <= end + 6 {
            end = changed[k];
            k += 1;
        }
        let end = (end + 4).min(ops.len());
        let count = |kind: char| ops[start..end].iter().filter(|(op, _)| *op == ' ' || *op == kind).count();
        // A side's first line; for a side with no lines, the line before the hunk, as diff writes it.
        let line = |kind: char| {
            let before = ops[..start].iter().filter(|(op, _)| *op == ' ' || *op == kind).count();
            before + usize::from(count(kind) > 0)
        };
        out.push_str(&format!("@@ -{},{} +{},{} @@\n", line('-'), count('-'), line('+'), count('+')));
        for (op, text) in &ops[start..end] {
            out.push_str(&format!("{op}{text}\n"));
        }
    }
    out
}

/// Why `src/ui.rs` cannot be edited here: its list is not in the shape `init` wrote.
fn shape() -> String {
    format!("src/ui.rs has no list in the shape corten ui init writes (`{COMPONENTS} &[..];`)")
}

/// Where `src/ui.rs`'s components list starts and ends (after its `];`), and its items, when it
/// has the shape `corten ui init` writes.
fn components_in(module: &str) -> Result<(usize, usize, Vec<String>), String> {
    let start = module.find(COMPONENTS).ok_or_else(shape)?;
    if start > 0 && !module[..start].ends_with('\n') {
        return Err(shape());
    }
    // `= &[` and the items on the line, or one a line.
    let after = &module[start + COMPONENTS.len()..];
    let body_start = start + COMPONENTS.len() + (after.len() - after.trim_start().len()) + "&[".len();
    if !after.trim_start().starts_with("&[") {
        return Err(shape());
    }
    let end = body_start + module[body_start..].find("];").ok_or_else(shape)?;
    let items: Vec<String> = module[body_start..end].split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if items.iter().any(|i| !i.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b':')) {
        return Err(shape());
    }
    Ok((start, end + 2, items))
}

/// What to add to `src/ui.rs` by hand for `piece` when `list_in` cannot: its `pub mod` line and
/// its entry in the list, each unless the file has it (a declaration on a line of its own, an
/// entry among the list's items, not text anywhere in the file). A list this cannot read is not
/// said to lack the entry: the app checks it.
fn lacks(module: &str, piece: &Piece) -> Option<String> {
    let (decl, entry) = (format!("pub mod {};", piece.name), format!("{}::{}", piece.name, piece.owner));
    let has_decl = module.lines().any(|l| l == decl);
    let listed = components_in(module).ok().map(|(_, _, items)| items.contains(&entry));
    Some(match (has_decl, listed) {
        (true, Some(true)) => return None,
        (true, Some(false)) => format!("add {entry} in COMPONENTS to src/ui.rs"),
        (false, Some(true)) => format!("add {decl} to src/ui.rs"),
        (false, Some(false)) => format!("add {decl} and {entry} in COMPONENTS to src/ui.rs"),
        (true, None) => format!("check that src/ui.rs's COMPONENTS lists {entry}"),
        (false, None) => format!("add {decl} to src/ui.rs, and check that its COMPONENTS lists {entry}"),
    })
}

/// `src/ui.rs` with `pub mod <name>;` and `<name>::<Owner>` in `COMPONENTS`, each in name order and laid out as
/// rustfmt lays them out, so `corten check` passes. Why not, for the app to edit it by hand, when
/// the file is not in the shape `init` wrote.
fn list_in(module: &str, piece: &Piece) -> Result<String, String> {
    let (start, end, mut items) = components_in(module)?;
    let entry = format!("{}::{}", piece.name, piece.owner);
    if !items.contains(&entry) {
        items.push(entry);
    }
    // The tokens first, as the stylesheet needs them before the rules that read them.
    let (mut first, mut rest): (Vec<String>, Vec<String>) = items.into_iter().partition(|i| !i.contains("::"));
    rest.sort();
    first.append(&mut rest);
    let mut out = String::with_capacity(module.len() + 64);
    out.push_str(&module[..start]);
    out.push_str(&layout(&first));
    out.push_str(&module[end..]);
    // The module declaration, among the others in name order.
    let decl = format!("pub mod {};", piece.name);
    if out.lines().any(|l| l == decl) {
        return Ok(out);
    }
    let mut lines: Vec<&str> = out.lines().collect();
    let mods: Vec<usize> =
        lines.iter().enumerate().filter(|(_, l)| l.starts_with("pub mod ") && l.ends_with(';')).map(|(i, _)| i).collect();
    // A module's attributes, doc comment and comments, on the lines above it, are its own: the
    // first of them.
    let head = |i: usize| {
        let mut s = i;
        let own = |l: &str| l.starts_with("#[") || (l.trim_start().starts_with("//") && !l.trim_start().starts_with("//!"));
        while s > 0 && own(lines[s - 1]) {
            s -= 1;
        }
        s
    };
    // An attribute over several lines (`#[cfg(any(`, ..) above the module the new one goes before
    // would end up above the new one: say so instead. Its lines above a module's head lead up to
    // its `#[`, where any other line ends a statement or is a comment (a trailing comment does
    // not count). Another module's is left where it is.
    let next = mods.iter().find(|&&i| lines[i] > decl.as_str()).copied();
    if let Some(m) = next {
        let mut s = head(m);
        while s > 0 {
            let line = lines[s - 1].trim();
            let code = line.find(" //").map_or(line, |i| line[..i].trim_end());
            // A comment line inside an attribute is stepped over, as one above a statement is.
            if code.starts_with("//") {
                s -= 1;
                continue;
            }
            if code.is_empty() || code.ends_with([';', '}']) || code.starts_with("/*") || code.ends_with("*/") {
                break;
            }
            if code.starts_with("#[") {
                return Err(format!(
                    "src/ui.rs has an attribute over several lines (`{code}`, above `{}`), which corten ui add does not lay out",
                    lines[m]
                ));
            }
            s -= 1;
        }
    }
    // The attributes every module has (`#[rustfmt::skip]`), which the new one gets too: two at
    // least, so one module's own are not taken for the file's, and never a `#[path]`, which is a
    // module's own file.
    let attrs: Vec<&str> = match mods.as_slice() {
        [first, _, ..] => lines[head(*first)..*first]
            .iter()
            .filter(|a| a.starts_with("#[") && !a.starts_with("#[path") && mods.iter().all(|&o| lines[head(o)..o].contains(a)))
            .copied()
            .collect(),
        _ => Vec::new(),
    };
    let at = match next {
        Some(i) => head(i),
        None => match mods.last() {
            Some(&i) => i + 1,
            // The first: before the tokens, apart from them, or before the list and its comment.
            None => {
                let list = lines.iter().position(|l| l.starts_with(COMPONENTS)).ok_or_else(shape)?;
                let doc = if list > 0 && lines[list - 1].starts_with("///") { list - 1 } else { list };
                let at = lines.iter().position(|l| l.starts_with(TOKENS_LINE)).unwrap_or(doc);
                lines.insert(at, "");
                at
            }
        },
    };
    lines.insert(at, &decl);
    for attr in attrs.into_iter().rev() {
        lines.insert(at, attr);
    }
    let mut text = lines.join("\n");
    text.push('\n');
    Ok(text)
}

/// The list as rustfmt writes it with its default settings: on one line when the array is at most
/// 60 columns (its `array_width`) and the line fits in 100, else one item a line.
fn layout(items: &[String]) -> String {
    let array = format!("&[{}]", items.join(", "));
    let one = format!("{COMPONENTS} {array};");
    if array.len() <= 60 && one.len() <= 100 {
        return one;
    }
    let mut out = format!("{COMPONENTS} &[\n");
    for item in items {
        out.push_str(&format!("    {item},\n"));
    }
    out.push_str("];");
    out
}

fn slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Every `.rs` file under `src/`, as (its path from the root, with `/`, and its text), in path
/// order.
fn sources(root: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut dirs = vec![root.join("src")];
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for path in entries.flatten().map(|e| e.path()) {
            if path.is_dir() {
                dirs.push(path);
            } else if path.extension().is_some_and(|e| e == "rs")
                && let (Ok(text), Ok(at)) = (std::fs::read_to_string(&path), path.strip_prefix(root))
            {
                out.push((slash(at), text));
            }
        }
    }
    out.sort();
    out
}

/// What `add` says of an app type with a kit component's or prop type's name.
fn namesake_note(path: &str, name: &str, piece: &str) -> String {
    format!(
        "  note: {path} declares {name}, as the kit's {piece} does: a file that uses both imports the kit's under\n    \
         another name (use crate::ui::{piece}::{{{name} as Kit{name}}};), and the classes stay the kit's"
    )
}

/// For each name a piece's component or prop type has (`Progress`, `ProgressSize`) that a type or
/// component of the app's own also has (`struct Progress` in its domain): (the app's file, the
/// name, the piece). Not a clash: the two only meet in a file that uses both, where the compiler
/// refuses one (E0252 for two named imports; with a glob import of the kit's, the app's name wins
/// and the error is on the app's type, E0560), so `add` says how to import the kit's under another
/// name.
fn namesakes(app: &[(String, String)], pieces: &[&Piece]) -> Vec<(String, String, &'static str)> {
    let kit: Vec<(String, &'static str)> = pieces
        .iter()
        .flat_map(|piece| {
            piece
                .files
                .iter()
                .filter(|(f, _)| f.ends_with(".rs"))
                .flat_map(move |(_, text)| types_of(text).into_iter().map(move |n| (n, piece.name)))
        })
        .collect();
    let mut out = Vec::new();
    for (path, text) in app.iter().filter(|(path, text)| !is_kit_file(path, text)) {
        for name in types_of(text) {
            if let Some((_, piece)) = kit.iter().find(|(n, _)| *n == name) {
                out.push((path.clone(), name, *piece));
            }
        }
    }
    out
}

/// The names a file declares that start with a capital: each `struct`, `enum`, `type`, `trait` and
/// `union`, and each function (a component). Comments are not read.
fn types_of(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut rest = line.split("//").next().unwrap_or("").trim();
        if let Some(after) = rest.strip_prefix("pub") {
            rest = match after.trim_start().strip_prefix('(') {
                Some(scope) => scope.split_once(')').map_or("", |(_, r)| r),
                None => after,
            }
            .trim_start();
        }
        let Some(rest) = ["struct ", "enum ", "type ", "trait ", "union ", "fn "].iter().find_map(|k| rest.strip_prefix(k))
        else {
            continue;
        };
        let name: String = rest.trim_start().chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
        if name.starts_with(|c: char| c.is_ascii_uppercase()) && !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// The kit's files in the app: `src/ui.rs` and each copy `corten ui add` wrote, which starts with
/// its stamp (`// corten ui 0.1.0: button ..`) wherever the app keeps it.
fn is_kit_file(path: &str, text: &str) -> bool {
    path == "src/ui.rs" || text.starts_with("// corten ui ")
}

/// The components a file declares with a stylesheet of their own (`#[component(css)]`, with
/// `js` or not, by any path to the attribute): each styles the classes its name makes and exports a
/// symbol of that name, so two of one name in a program fail to link. A part (`css = Owner`)
/// styles its owner's. Comments (a doc example) are not read.
fn styled_components(text: &str) -> Vec<String> {
    let code = |line: &str| line.split("//").next().unwrap_or("").trim().to_string();
    let mut out = Vec::new();
    let mut lines = text.lines().map(code);
    while let Some(line) = lines.next() {
        let attr = line.strip_prefix("#[").and_then(|l| l.strip_suffix("]")).map(|l| l.trim_start_matches("::"));
        let Some(args) = attr
            .and_then(|a| a.strip_prefix("corten::").or(Some(a)))
            .and_then(|a| a.strip_prefix("component("))
            .and_then(|a| a.strip_suffix(')'))
        else {
            continue;
        };
        if !args.split(',').any(|a| a.trim() == "css") {
            continue;
        }
        // The function after its attributes.
        let Some(item) = lines.find(|l| !l.is_empty() && !l.starts_with("#[")) else { break };
        let mut rest = item.as_str();
        if let Some(after) = rest.strip_prefix("pub") {
            rest = match after.trim_start().strip_prefix('(') {
                Some(scope) => scope.split_once(')').map_or("", |(_, r)| r),
                None => after,
            }
            .trim_start();
        }
        let Some(rest) = rest.strip_prefix("fn ") else { continue };
        let name: String = rest.trim_start().chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
        if !name.is_empty() {
            out.push(name);
        }
    }
    out
}

/// For each component the pieces bring that an app's own component of the same name, with its
/// own stylesheet, would clash with: (the app's file, the name, the kit's piece).
fn clashes(app: &[(String, String)], pieces: &[&Piece]) -> Vec<(String, String, &'static str)> {
    let mine: Vec<(String, &str)> = app
        .iter()
        .filter(|(path, text)| !is_kit_file(path, text))
        .flat_map(|(path, text)| styled_components(text).into_iter().map(move |name| (name, path.as_str())))
        .collect();
    let mut out = Vec::new();
    for piece in pieces {
        for (_, text) in piece.files.iter().filter(|(f, _)| f.ends_with(".rs")) {
            for name in styled_components(text) {
                for (_, path) in mine.iter().filter(|(n, _)| *n == name) {
                    out.push((path.to_string(), name.clone(), piece.name));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        INIT, KIT, Lacking, OWN_THEME_MODULE, Piece, WAS, apply, clashes, depend_on_ui, depend_on_ui_at, fnv, from_workspace,
        is_corten_line, kit_text, lacks, list_in, list_ui_widgets, merge3, merged, namesake_note, namesakes, own_theme, report,
        role_tokens, sources, stamp_of, stamped, styled_components, undeclared, unified, wire_app,
    };

    fn piece(name: &str) -> &'static Piece {
        KIT.iter().find(|p| p.name == name).unwrap()
    }

    #[test]
    fn add_lists_each_component_in_name_order_after_the_tokens() {
        let mut module = stamped(include_str!("../kit/ui.rs"));
        for name in ["card", "alert", "button", "card"] {
            module = list_in(&module, piece(name)).unwrap();
        }
        assert!(
            module
                .contains("use corten::Component;\n\npub mod alert;\npub mod button;\npub mod card;\n\ncorten::style::tokens!("),
            "{module}"
        );
        assert!(
            module.contains("pub const COMPONENTS: &[Component] = &[TOKENS, alert::Alert, button::Button, card::Card];\n"),
            "{module}"
        );
    }

    /// A module's attributes and doc comment stay with it, and one every module has (`#[rustfmt::skip]`)
    /// the new one gets too, before the next module or after the last (#586).
    #[test]
    fn a_new_module_goes_before_the_next_ones_attributes_and_takes_the_common_ones() {
        let module = "use corten::Component;\n\n#[rustfmt::skip]\n#[path = \"kit/badge.rs\"]\npub mod badge;\n/// Cards.\n#[rustfmt::skip]\npub mod card;\n\npub const COMPONENTS: &[Component] = &[badge::Badge, card::Card];\n";
        let module = list_in(module, piece("button")).unwrap();
        assert!(
            module.contains("pub mod badge;\n#[rustfmt::skip]\npub mod button;\n/// Cards.\n#[rustfmt::skip]\npub mod card;\n"),
            "{module}"
        );
        let module = list_in(&module, piece("table")).unwrap();
        assert!(module.contains("pub mod card;\n#[rustfmt::skip]\npub mod table;\n\npub const"), "{module}");
        // None in common: the new one has none.
        let module = "use corten::Component;\n\n#[cfg(test)]\npub mod badge;\npub mod card;\n\npub const COMPONENTS: &[Component] = &[badge::Badge, card::Card];\n";
        let module = list_in(module, piece("alert")).unwrap();
        assert!(module.contains("use corten::Component;\n\npub mod alert;\n#[cfg(test)]\npub mod badge;\n"), "{module}");
        // One module: its attributes are its own, not the file's.
        let one = "use corten::Component;\n\n#[cfg(test)]\n#[path = \"kit/badge.rs\"]\npub mod badge;\n\npub const COMPONENTS: &[Component] = &[badge::Badge];\n";
        let module = list_in(one, piece("button")).unwrap();
        assert!(module.contains("pub mod badge;\npub mod button;\n"), "{module}");
        // A `#[path]`, even one every module has, is each module's own: not copied.
        let paths = "use corten::Component;\n\n#[path = \"kit/badge.rs\"]\npub mod badge;\n#[path = \"kit/badge.rs\"]\npub mod card;\n\npub const COMPONENTS: &[Component] = &[badge::Badge, card::Card];\n";
        let module = list_in(paths, piece("table")).unwrap();
        assert!(module.contains("pub mod card;\npub mod table;\n"), "{module}");
        // An attribute over several lines is not laid out: the command says what to add by hand.
        let wide = "use corten::Component;\n\n#[cfg(any(\n    feature = \"a\",\n))]\n#[rustfmt::skip]\npub mod card;\n\npub const COMPONENTS: &[Component] = &[card::Card];\n";
        let why = list_in(wide, piece("button")).unwrap_err();
        assert!(
            why.contains("an attribute over several lines (`#[cfg(any(`, above `pub mod card;`), which corten ui add"),
            "{why}"
        );
        // One over a module the new one does not go before stays where it is.
        let module = list_in(wide, piece("table")).unwrap();
        assert!(module.contains("))]\n#[rustfmt::skip]\npub mod card;\npub mod table;\n"), "{module}");
        // A comment inside such an attribute does not hide it.
        let commented = wide.replace("#[cfg(any(\n", "#[cfg(any(\n    // the desktop build\n");
        assert!(list_in(&commented, piece("button")).is_err(), "{commented}");
        // The to-do then names what the file lacks: an entry is one of the list's items, not the
        // name in a comment, and a declaration a line of its own, not one inside another module.
        assert_eq!(lacks(wide, piece("card")), None);
        assert_eq!(lacks(wide, piece("button")).unwrap(), "add pub mod button; and button::Button in COMPONENTS to src/ui.rs");
        let mentioned =
            wide.replace("pub mod card;", "// see button::Button\nmod inner {\n    pub mod button;\n}\npub mod card;");
        assert_eq!(
            lacks(&mentioned, piece("button")).unwrap(),
            "add pub mod button; and button::Button in COMPONENTS to src/ui.rs"
        );
        let declared = wide.replace("pub mod card;", "pub mod button;\npub mod card;");
        assert_eq!(lacks(&declared, piece("button")).unwrap(), "add button::Button in COMPONENTS to src/ui.rs");
        // A list this cannot read is not said to lack what it may have.
        let unread = declared.replace("pub const COMPONENTS: &[Component]", "pub static COMPONENTS: &[Component]");
        assert_eq!(lacks(&unread, piece("card")).unwrap(), "check that src/ui.rs's COMPONENTS lists card::Card");
        assert_eq!(
            lacks(&unread, piece("table")).unwrap(),
            "add pub mod table; to src/ui.rs, and check that its COMPONENTS lists table::Table"
        );
        // A section's comment over its first module is that module's, so a module sorting before
        // it goes above the comment (the text cannot tell the two apart).
        let sections = "use corten::Component;\n\n// Display.\npub mod badge;\npub mod card;\n\npub const COMPONENTS: &[Component] = &[badge::Badge, card::Card];\n";
        let module = list_in(sections, piece("alert")).unwrap();
        assert!(module.contains("\npub mod alert;\n// Display.\npub mod badge;\n"), "{module}");
        // A comment between a module's attribute and the module goes with it, and so does the attribute.
        let between = "use corten::Component;\n\n#[rustfmt::skip]\n// The kit's field.\npub mod field;\n\npub const COMPONENTS: &[Component] = &[field::Field];\n";
        let module = list_in(between, piece("card")).unwrap();
        assert!(module.contains("\npub mod card;\n#[rustfmt::skip]\n// The kit's field.\npub mod field;\n"), "{module}");
        // A comment or a statement above a module is not such an attribute.
        for above in [
            "pub mod alert; // the first",
            "pub mod alert;   ",
            "/* Forms. */",
            "//! The kit.",
            "use corten::Component;",
            "// Kit.",
        ] {
            let module =
                format!("{above}\n#[rustfmt::skip]\npub mod card;\n\npub const COMPONENTS: &[Component] = &[card::Card];\n");
            let module = list_in(&module, piece("dialog")).unwrap_or_else(|why| panic!("{above}: {why}"));
            assert!(module.contains("pub mod card;\npub mod dialog;\n"), "{above}: {module}");
        }
    }

    #[test]
    fn a_long_list_is_laid_out_as_rustfmt_does() {
        let mut module = stamped(include_str!("../kit/ui.rs"));
        for piece in KIT {
            module = list_in(&module, piece).unwrap();
        }
        assert!(module.contains("pub const COMPONENTS: &[Component] = &[\n    TOKENS,\n    accordion::Accordion,\n"), "{module}");
        assert!(module.ends_with("    visually_hidden::VisuallyHidden,\n];\n"), "{module}");
    }

    fn app(files: &[(&str, &str)]) -> Vec<(String, String)> {
        files.iter().map(|(p, t)| (p.to_string(), t.to_string())).collect()
    }

    #[test]
    fn init_declares_the_module_in_order_and_lists_it_on_the_app() {
        let lib =
            "mod alpha;\nmod views;\n\npub fn app() -> App {\n    App::new(url::router())\n        .assets(views::Static)\n}\n";
        let edits = wire_app(&app(&[("src/lib.rs", lib)])).unwrap();
        assert_eq!(
            edits,
            [(
                "src/lib.rs".to_string(),
                "mod alpha;\n/// The UI kit (`corten ui`): public, so a component not used yet is not a warning.\npub mod ui;\nmod views;\n\npub fn app() -> App {\n    App::new(url::router())\n        .components(ui::COMPONENTS)\n        .assets(views::Static)\n}\n"
                    .to_string()
            )]
        );
        assert_eq!(wire_app(&app(&[("src/lib.rs", &edits[0].1)])).unwrap(), [], "a second run changes nothing");
    }

    /// An app that builds its `App` in another module (`src/app.rs`) gets the module declared in
    /// its root and the list on that `App`, by its path from there.
    #[test]
    fn init_finds_the_app_where_it_is_built() {
        let main = "mod app;\nmod views;\n\nfn main() {}\n";
        let built = "use corten::App;\n\npub fn app() -> App {\n    App::new(url::router())\n        .components(corten_ui::COMPONENTS)\n}\n";
        let files = app(&[("src/app.rs", built), ("src/main.rs", main)]);
        let edits = wire_app(&files).unwrap();
        assert_eq!(edits.len(), 2, "{edits:?}");
        assert!(edits[0].0 == "src/main.rs" && edits[0].1.contains("mod app;\n/// The UI kit"), "{edits:?}");
        assert!(
            edits[1].0 == "src/app.rs"
                && edits[1].1.contains("        .components(crate::ui::COMPONENTS)\n        .components(corten_ui")
        );
        let again = app(&[("src/app.rs", &edits[1].1), ("src/main.rs", &edits[0].1)]);
        assert_eq!(wire_app(&again).unwrap(), [], "a second run changes nothing");
        let two = app(&[("src/a.rs", built), ("src/b.rs", built), ("src/main.rs", main)]);
        assert!(wire_app(&two).unwrap_err().contains("src/a.rs and src/b.rs have App::new( lines"));
        assert!(wire_app(&app(&[("src/main.rs", main)])).unwrap_err().contains("no file in src/ has an App::new( line"));
        let lib = "mod views;\n";
        let binary = app(&[("src/lib.rs", lib), ("src/main.rs", built)]);
        assert!(wire_app(&binary).unwrap_err().contains("src/main.rs builds the App outside the library"), "by hand");
    }

    /// An app with a theme of its own gets the kit's module without the kit's tokens, and the names
    /// of the tokens the components read; add lists components in it as in the kit's.
    #[test]
    fn an_app_with_its_own_theme_keeps_it() {
        let names = role_tokens();
        for name in ["background", "card", "card-foreground", "success", "warning-foreground", "ring", "radius", "control-height"]
        {
            assert!(names.iter().any(|n| n == name), "{names:?}");
        }
        assert_eq!(names.len(), 49, "{names:?}");
        let module = list_in(&stamped(OWN_THEME_MODULE), piece("card")).unwrap();
        let module = list_in(&module, piece("alert")).unwrap();
        assert!(module.contains("use corten::Component;\n\npub mod alert;\npub mod card;\n\n/// Each component"), "{module}");
        assert!(module.contains("pub const COMPONENTS: &[Component] = &[alert::Alert, card::Card];\n"), "{module}");
        assert!(!module.contains("tokens!"));
    }

    /// The app's theme is read from the files its `tokens!` names, a resolver's sources (a part of a
    /// file, `#/pointer`) included: the custom properties its tokens make, as `tokens!` names them,
    /// its top groups, and whether it has colors. A group's name is not a token of that name.
    #[test]
    fn init_reads_the_apps_own_theme() {
        let dir = std::env::temp_dir().join(format!("corten-ui-theme-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("tokens")).unwrap();
        let base = r##"{ "color": { "$type": "color", "ink": { "$value": "#000" }, "brand": { "$root": { "$value": "#00f" } } },
            "card": { "$type": "color", "$value": "{color.ink}" }, "mutedForeground": { "$type": "color", "$value": "{color.ink}" },
            "radius": { "$type": "dimension", "sm": { "$value": { "value": 4, "unit": "px" } } },
            "$extensions": { "run.corten": { "x": { "$ref": "nowhere.json" } } } }"##;
        std::fs::write(dir.join("tokens/base.tokens.json"), base).unwrap();
        std::fs::write(
            dir.join("tokens/dark.tokens.json"),
            r##"{ "theme": { "border": { "$type": "color", "$value": "#111" } } }"##,
        )
        .unwrap();
        std::fs::write(
            dir.join("tokens/theme.resolver.json"),
            r##"{ "sets": { "base": { "sources": [{ "$ref": "base.tokens.json#/" }] } },
                "modifiers": { "theme": { "contexts": { "light": [], "dark": [{ "$ref": "dark.tokens.json#/theme" }] } } },
                "resolutionOrder": [{ "$ref": "#/sets/base" }, { "$ref": "#/modifiers/theme" }] }"##,
        )
        .unwrap();
        std::fs::write(
            dir.join("tokens/space.tokens.json"),
            r##"{ "space": { "$type": "dimension", "1": { "$value": { "value": 4, "unit": "px" } } } }"##,
        )
        .unwrap();
        let theme = own_theme(&dir, "corten::style::tokens!(\"tokens/theme.resolver.json\");").unwrap().unwrap();
        assert!(theme.colors);
        for name in ["color-ink", "color-brand", "card", "muted-foreground", "radius-sm", "border"] {
            assert!(theme.properties.iter().any(|p| p == name), "{name}: {theme:?}");
        }
        assert!(!theme.properties.iter().any(|p| p == "radius" || p == "color"), "a group is not a token: {theme:?}");
        assert_eq!(theme.groups, ["color", "radius"]);
        assert!(theme.resolver);
        let space = own_theme(&dir, "tokens!(\"tokens/space.tokens.json\");").unwrap().unwrap();
        assert!(!space.colors && space.properties == ["space-1"] && !space.resolver, "{space:?}");
        assert_eq!(own_theme(&dir, "// no theme here").unwrap(), None);
        let missing = own_theme(&dir, "tokens!(\"tokens/missing.json\");").unwrap_err();
        assert!(missing.starts_with("tokens/missing.json: "), "{missing}");
        std::fs::write(dir.join("tokens/r.json"), r##"{ "resolutionOrder": [{ "$ref": "base.tokens.json#/nope" }] }"##).unwrap();
        assert!(own_theme(&dir, "tokens!(\"tokens/r.json\");").unwrap_err().contains("base.tokens.json#/nope names nothing"));
        // Inline sources, a set by pointer, a percent-escaped pointer and a group's `$root`, as
        // `tokens!` reads them; a token file's group named `contexts` or `sources` is tokens.
        std::fs::write(
            dir.join("tokens/parts.json"),
            r##"{ "Brand Theme": { "radius": { "$type": "dimension", "$root": { "$value": { "value": 6, "unit": "px" } } } } }"##,
        )
        .unwrap();
        std::fs::write(
            dir.join("tokens/inline.resolver.json"),
            r##"{ "sets": { "base": { "sources": [{ "ink": { "$type": "color", "$value": "#000" } }, { "$ref": "parts.json#/Brand%20Theme" }] } },
                "resolutionOrder": [{ "$ref": "#/sets/base" }, { "type": "modifier", "name": "m", "contexts": { "a": [{ "ring": { "$type": "color", "$value": "#111" } }] } }] }"##,
        )
        .unwrap();
        let inline = own_theme(&dir, "tokens!(\"tokens/inline.resolver.json\");").unwrap().unwrap();
        assert!(inline.colors, "{inline:?}");
        assert_eq!(inline.properties, ["ink", "radius", "ring"]);
        std::fs::write(
            dir.join("tokens/contexts.json"),
            r##"{ "contexts": { "ink": { "$type": "color", "$value": "#000" } } }"##,
        )
        .unwrap();
        let file = own_theme(&dir, "tokens!(\"tokens/contexts.json\");").unwrap().unwrap();
        assert!(file.colors && file.properties == ["contexts-ink"], "{file:?}");
        let commented = "//! Use `tokens!(\"tokens/missing.json\")`.\ncorten::style::tokens!(\"tokens/contexts.json\");";
        assert_eq!(own_theme(&dir, commented).unwrap(), Some(file.clone()), "a comment is not the call");
        let wrapped = "corten::style::tokens!(\n    // the theme\n    \"tokens/contexts.json\"\n);";
        assert_eq!(own_theme(&dir, wrapped).unwrap(), Some(file), "rustfmt puts a long path on its own line");
        // A set that includes itself is the macro's to report: it is read once, not followed forever.
        std::fs::write(
            dir.join("tokens/loop.resolver.json"),
            r##"{ "sets": { "base": { "sources": [{ "$ref": "space.tokens.json" }, { "$ref": "#/sets/base" }] } },
                "resolutionOrder": [{ "$ref": "#/sets/base" }] }"##,
        )
        .unwrap();
        let looped = own_theme(&dir, "tokens!(\"tokens/loop.resolver.json\");").unwrap().unwrap();
        assert_eq!(looped.groups, ["space"], "{looped:?}");
        // Two files that include each other by a path that grows (`../tokens/..`) are one file each.
        std::fs::write(
            dir.join("tokens/far.resolver.json"),
            r##"{ "sets": { "a": { "sources": [{ "$ref": "space.tokens.json" }, { "$ref": "../tokens/near.json#/sets/x" }] } },
                "resolutionOrder": [{ "$ref": "#/sets/a" }] }"##,
        )
        .unwrap();
        std::fs::write(
            dir.join("tokens/near.json"),
            r##"{ "sets": { "x": { "sources": [{ "$ref": "../tokens/far.resolver.json#/sets/a" }] } } }"##,
        )
        .unwrap();
        let far = own_theme(&dir, "tokens!(\"tokens/far.resolver.json\");").unwrap().unwrap();
        assert_eq!(far.groups, ["space"], "{far:?}");
        std::fs::write(
            dir.join("tokens/r2.json"),
            r##"{ "resolutionOrder": [{ "$ref": "../tokens/base.tokens.json#/nope" }] }"##,
        )
        .unwrap();
        let named = own_theme(&dir, "tokens!(\"tokens/r2.json\");").unwrap_err();
        assert!(named.starts_with("tokens/base.tokens.json#/nope names nothing"), "{named}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// In an app whose lock pins another corten than the command was built from, `add` and `init`
    /// copy nothing and say which to install or where to move the app; `diff` says what it compares
    /// with, and the rest print the note.
    #[test]
    fn add_and_init_refuse_the_kit_of_another_corten() {
        let rev = "dd028b94ad0f63d687ef65b157117fa53caab41c";
        let dir = scratch("other-pin");
        let sha = "0".repeat(40);
        let lock = format!(
            "[[package]]\nname = \"corten\"\nversion = \"0.1.0\"\nsource = \"git+https://github.com/corten-run/corten?rev={sha}#{sha}\"\n"
        );
        std::fs::write(dir.join("Cargo.lock"), lock).unwrap();
        let note = || crate::pin::note(&dir, "0.1.0", rev, None);
        assert!(note().is_some_and(|n| n.text.contains(&format!("--rev {sha} corten-cli --locked\n"))));
        for sub in ["add", "init"] {
            let error = super::pinned(Some(sub), note()).unwrap_err();
            assert!(error.starts_with("not copying: this corten command was built from corten dd028b94"), "{error}");
            assert!(
                error.ends_with(&format!(
                    "move the app to its corten first: package = \"corten-run\", rev = \"{rev}\" for corten in Cargo.toml, then cargo update -p corten"
                )),
                "{error}"
            );
        }
        let diff = super::pinned(Some("diff"), note()).unwrap().unwrap();
        assert!(diff.ends_with(
            "ui diff compares the copies with this command's kit, not the pin's, and ui add refuses until the two match"
        ));
        let text = || note().map(|n| n.text);
        assert_eq!(super::pinned(Some("list"), note()), Ok(text()));
        assert_eq!(super::pinned(None, note()), Ok(text()));
        // With a target directory of the user's, the install builds in one of its own under it:
        // cargo can hand back another revision's build in a shared one.
        let shared = std::path::Path::new("D:/target");
        let line = crate::pin::note(&dir, "0.1.0", rev, Some(shared)).unwrap().text;
        let own = shared.join("corten-cli-00000000").display().to_string();
        assert!(line.contains(&format!("--rev {sha} corten-cli --locked --target-dir {own}\n")), "{line}");
        assert!(line.ends_with("can hand back that build"), "{line}");
        // A directory with a space is quoted, so the line can be pasted.
        let spaced = std::path::Path::new("D:/Shared Target");
        let line = crate::pin::note(&dir, "0.1.0", rev, Some(spaced)).unwrap().text;
        let own = spaced.join("corten-cli-00000000").display().to_string();
        assert!(line.contains(&format!("--target-dir \"{own}\"\n")), "{line}");
        // A release: the app names this command's version, under the package name the lock gives it.
        let release = "[[package]]\nname = \"corten-run\"\nversion = \"0.0.9\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n";
        std::fs::write(dir.join("Cargo.lock"), release).unwrap();
        let error = super::pinned(Some("add"), crate::pin::note(&dir, "0.1.0", rev, Some(shared))).unwrap_err();
        assert!(error.contains("cargo install corten-cli --version 0.0.9 --locked\n"), "{error}");
        assert!(
            error.ends_with(&format!(
                "package = \"corten-run\" with version = \"0.1.0\" if this command is that release, or with git = corten's repository and rev = \"{rev}\" for corten in Cargo.toml, then cargo update -p corten-run"
            )),
            "{error}"
        );
        // The pin's own command, or an app with no pin: nothing to say.
        assert_eq!(crate::pin::note(&dir, "0.0.9", rev, None), None);
        assert_eq!(super::pinned(Some("add"), None), Ok(None));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// `init` in an app with a theme it cannot read writes nothing and says so; `--kit-theme` writes
    /// the kit's theme beside it; another flag is a usage error. `add --force` replaces a copy
    /// whose stamp line was lost, which is the kit's, not the app's own component.
    #[test]
    fn init_refuses_a_theme_it_cannot_read_and_add_force_replaces_a_copy() {
        let dir = std::env::temp_dir().join(format!("corten-ui-init-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let lib = "mod views;\n\npub fn app() -> App {\n    App::new(url::router())\n}\n";
        std::fs::write(dir.join("src/lib.rs"), lib).unwrap();
        std::fs::write(dir.join("src/views.rs"), "corten::style::tokens!(\"tokens/gone.json\");\n").unwrap();
        let error = super::init(&dir, &[]).unwrap_err();
        assert!(error.contains("tokens/gone.json") && error.contains("--kit-theme"), "{error}");
        assert!(!dir.join("src/ui.rs").exists() && std::fs::read_to_string(dir.join("src/lib.rs")).unwrap() == lib);
        assert!(super::init(&dir, &["--kit".to_string()]).unwrap_err().starts_with("usage:"));
        super::init(&dir, &["--kit-theme".to_string()]).unwrap();
        assert!(dir.join("tokens/ui.tokens.json").exists() && dir.join("src/ui.rs").exists());
        super::add(&dir, &["card".to_string()]).unwrap();
        let copy = std::fs::read_to_string(dir.join("src/ui/card.rs")).unwrap();
        std::fs::write(dir.join("src/ui/card.rs"), copy.split_once('\n').unwrap().1).unwrap();
        assert!(super::add(&dir, &["card".to_string()]).unwrap_err().contains("exists"));
        super::add(&dir, &["card".to_string(), "--force".to_string()]).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("src/ui/card.rs")).unwrap(), copy);
        // A src/ui.rs it cannot lay out is left as it is, and the component's files are written.
        let listed = std::fs::read_to_string(dir.join("src/ui.rs")).unwrap();
        let module = listed.replace("pub const COMPONENTS", "pub static COMPONENTS");
        assert!(module.contains("pub static COMPONENTS"), "{module}");
        std::fs::write(dir.join("src/ui.rs"), &module).unwrap();
        super::add(&dir, &["button".to_string()]).unwrap();
        assert!(dir.join("src/ui/button.rs").exists());
        assert_eq!(std::fs::read_to_string(dir.join("src/ui.rs")).unwrap(), module, "src/ui.rs unchanged");
        std::fs::write(dir.join("src/ui.rs"), &listed).unwrap();
        // The kit's theme declares every token its components read.
        let app_now = sources(&dir);
        let all = KIT.iter().collect::<Vec<_>>();
        let lacking = undeclared(&dir, &app_now, &all);
        assert_eq!(lacking.made, [("tokens/ui.resolver.json".to_string(), "wide".to_string(), "40rem".to_string())]);
        let resolvers = vec!["tokens/ui.resolver.json".to_string()];
        assert_eq!(lacking, Lacking { kit_theme: true, made: lacking.made.clone(), resolvers, ..Lacking::default() });
        // A theme an older kit wrote, without the sizes: add names each one a copy reads, as the
        // kit's theme has it.
        let theme = std::fs::read_to_string(dir.join("tokens/ui.tokens.json")).unwrap();
        let old: String = theme
            .lines()
            .filter(|l| {
                !l.contains("\"control-")
                    && !l.contains("-font-size\"")
                    && !l.contains("\"card-padding\"")
                    && !l.contains("\"stat-")
                    && !l.contains("\"choice-")
                    && !l.contains("\"tab-")
                    && !l.contains("\"status-dot-")
            })
            .collect::<Vec<_>>()
            .join("\n");
        let old = format!("{}\n}}\n", old.trim_end().trim_end_matches('}').trim_end().trim_end_matches(','));
        std::fs::write(dir.join("tokens/ui.tokens.json"), &old).unwrap();
        let mut card = undeclared(&dir, &app_now, &[piece("card")]).sizes;
        card.sort();
        assert_eq!(
            card,
            [
                r#""card-heading-font-size": { "$type": "dimension", "$value": { "value": 1, "unit": "rem" } }"#,
                r#""card-padding": { "$type": "dimension", "$value": { "value": 1.5, "unit": "rem" } }"#
            ],
            "{old}"
        );
        assert!(undeclared(&dir, &app_now, &[piece("button")]).sizes.iter().any(|l| l.starts_with("\"control-height-sm\": ")));
        // The two choice lists each read the same two sizes, named once for both.
        let both = [
            r#""choice-list-gap": { "$type": "dimension", "$value": { "value": 0.75, "unit": "rem" } }"#,
            r#""choice-list-legend-gap": { "$type": "dimension", "$value": { "value": 0.75, "unit": "rem" } }"#,
        ];
        for pieces in [&[piece("checkboxes")][..], &[piece("radio_group")], &[piece("checkboxes"), piece("radio_group")]] {
            assert_eq!(undeclared(&dir, &app_now, pieces).sizes, both, "{}", pieces.len());
        }
        // A figure's weights and tracking are named with its sizes; its face and its label's case,
        // which the stylesheet reads with a fallback, are the app's to declare or not.
        let stats = undeclared(&dir, &app_now, &[piece("stats")]).sizes;
        let names: Vec<&str> = stats.iter().map(|l| l.split('"').nth(1).unwrap()).collect();
        assert_eq!(
            names,
            [
                "stat-label-font-size",
                "stat-label-font-weight",
                "stat-label-tracking",
                "stat-value-font-size",
                "stat-value-font-weight",
                "stat-value-tracking",
                "stat-value-font-size-narrow"
            ],
            "{stats:?}"
        );
        assert!(
            stats.contains(&r#""stat-value-font-weight": { "$type": "fontWeight", "$value": 600 }"#.to_string()),
            "{stats:?}"
        );
        // A status dot's size, read by StatusDot and LiveDot through the one rule they share.
        assert_eq!(
            undeclared(&dir, &app_now, &[piece("status_dot")]).sizes,
            [r#""status-dot-size": { "$type": "dimension", "$value": { "value": 0.5, "unit": "rem" } }"#]
        );
        // A tab's and a segmented choice's weight and chosen color, read by both, named once: the
        // weight as the kit's theme has it, the color by name, as each theme gives it.
        let dark = std::fs::read_to_string(dir.join("tokens/ui-dark.tokens.json")).unwrap();
        let untabbed: String = dark.lines().filter(|l| !l.contains("\"tab-")).collect::<Vec<_>>().join("\n");
        let untabbed = untabbed.trim_end().trim_end_matches('}').trim_end().trim_end_matches(',');
        std::fs::write(dir.join("tokens/ui-dark.tokens.json"), format!("{untabbed}\n}}\n")).unwrap();
        for pieces in [&[piece("tabs")][..], &[piece("segmented")], &[piece("tabs"), piece("segmented")]] {
            let lacking = undeclared(&dir, &app_now, pieces);
            let tab = |l: &&String| l.contains("\"tab-");
            assert_eq!(
                lacking.sizes.iter().filter(tab).collect::<Vec<_>>(),
                [r#""tab-font-weight": { "$type": "fontWeight", "$value": 500 }"#],
                "{lacking:?}"
            );
            assert_eq!(lacking.colors, ["tab-selected-color"], "{lacking:?}");
        }
        // One a stylesheet under static/ declares is declared, as the app's startup check counts it.
        std::fs::create_dir_all(dir.join("static/css")).unwrap();
        let css =
            ":root { --card-padding : 2rem; color: var(--card-heading-font-size); }\n/* --card-heading-font-size: not here */\n";
        std::fs::write(dir.join("static/css/app.css"), css).unwrap();
        let card = undeclared(&dir, &app_now, &[piece("card")]).sizes;
        let heading = r#""card-heading-font-size": { "$type": "dimension", "$value": { "value": 1, "unit": "rem" } }"#;
        assert_eq!(card, [heading], "a comment declares nothing");
        let property = format!("{css}@property --card-heading-font-size {{ syntax: '*'; inherits: true; }}\n");
        std::fs::write(dir.join("static/css/app.css"), property).unwrap();
        assert_eq!(undeclared(&dir, &app_now, &[piece("card")]).sizes, Vec::<String>::new(), "@property declares one");
        // A `/*` in a string starts no comment; a declaration in a string is none.
        let quoted = ".a::before { content: \"/*\" }\n:root { --card-heading-font-size: 1rem; --card-padding: 1rem; }\n.b::after { content: \"*/\" }\n";
        std::fs::write(dir.join("static/css/app.css"), quoted).unwrap();
        assert_eq!(undeclared(&dir, &app_now, &[piece("card")]).sizes, Vec::<String>::new(), "{quoted}");
        assert_eq!(
            super::code_of("a { content: \"--x: 1\\\" --y: 2\" } /* --z: 3 */ b { --w: 4 }"),
            "a { content:   }   b { --w: 4 }"
        );
        // A color the kit's theme lacks is named with the kit's line; one an app's own theme lacks,
        // by name, for a reference to one of the app's colors.
        for file in ["tokens/ui.tokens.json", "tokens/ui-dark.tokens.json"] {
            let theme = std::fs::read_to_string(dir.join(file)).unwrap();
            let colorless: String = theme.lines().filter(|l| !l.contains("\"ring\"")).collect::<Vec<_>>().join("\n");
            let colorless = colorless.trim_end().trim_end_matches('}').trim_end().trim_end_matches(',');
            std::fs::write(dir.join(file), format!("{colorless}\n}}\n")).unwrap();
        }
        let lacking = undeclared(&dir, &app_now, &[piece("button")]);
        assert!(lacking.kit_theme && lacking.colors == ["ring"], "{lacking:?}");
        let own: Vec<(String, String)> = app_now
            .iter()
            .map(|(p, t)| (p.clone(), t.replace("tokens!(\"tokens/ui.resolver.json\")", "tokens!(\"tokens/ui.tokens.json\")")))
            .collect();
        let lacking = undeclared(&dir, &own, &[piece("button")]);
        assert!(!lacking.kit_theme && lacking.colors == ["ring"], "{lacking:?}");
        // A breakpoint a stylesheet names (`@media not (--sm)`) and no theme makes is named with
        // the kit's line; button names none.
        assert_eq!(undeclared(&dir, &own, &[piece("table")]).breakpoints, Vec::<String>::new());
        let theme = std::fs::read_to_string(dir.join("tokens/ui.tokens.json")).unwrap();
        let flat: String = theme.lines().filter(|l| !l.contains("\"$extensions\"")).collect::<Vec<_>>().join("\n");
        let flat = flat.trim_end().trim_end_matches('}').trim_end().trim_end_matches(',');
        std::fs::write(dir.join("tokens/ui.tokens.json"), format!("{flat}\n}}\n")).unwrap();
        assert_eq!(undeclared(&dir, &own, &[piece("table"), piece("steps"), piece("button")]).breakpoints, ["wide"]);
        assert_eq!(super::kit_breakpoint("wide"), r#""wide": { "value": 40, "unit": "rem" }"#);
        // Two token files that give one a stylesheet names different widths are named with each;
        // the same width written two ways (40, 40.0) is one width.
        std::fs::write(dir.join("tokens/ui.tokens.json"), &theme).unwrap();
        let mut two = own.clone();
        two.push(("src/narrow.rs".to_string(), "corten::style::tokens!(\"tokens/narrow.tokens.json\");".to_string()));
        let narrow = |name: &str, value: &str| {
            let made = format!(
                r#"{{ "$extensions": {{ "run.corten": {{ "breakpoints": {{ "{name}": {{ "value": {value}, "unit": "rem" }} }} }} }} }}"#
            );
            std::fs::write(dir.join("tokens/narrow.tokens.json"), made).unwrap();
            undeclared(&dir, &two, &[piece("table"), piece("steps"), piece("button")])
        };
        let lacking = narrow("wide", "36");
        assert_eq!(
            lacking.differing,
            [(
                "wide".to_string(),
                vec![
                    ("tokens/ui.tokens.json".to_string(), "40rem".to_string()),
                    ("tokens/narrow.tokens.json".to_string(), "36rem".to_string())
                ]
            )]
        );
        assert!(lacking.breakpoints.is_empty(), "{lacking:?}");
        assert_eq!(narrow("wide", "40.0").differing, Vec::new());
        // sm at any width does not matter: the kit's theme does not make it.
        assert_eq!(narrow("sm", "36").differing, Vec::new());
        // init says which breakpoint an own theme lacks, and which one beside the kit's has another
        // width.
        let made = |name: &str, width: &str| vec![("tokens/app.tokens.json".to_string(), name.to_string(), width.to_string())];
        let unmade = super::breakpoint_notes(true, &[], &[], &[]);
        assert!(
            unmade.len() == 1 && unmade[0].contains("below your theme's\nwide breakpoint, which it does not make"),
            "{unmade:?}"
        );
        assert!(unmade[0].contains(r#"("wide": { "value": 40, "unit": "rem" })"#), "{unmade:?}");
        assert!(unmade[0].contains(r#"writes "wide": "{md}""#), "{unmade:?}");
        let at_48 = super::breakpoint_notes(true, &made("sm", "48rem"), &[], &[]);
        assert!(
            at_48.len() == 1 && at_48[0].contains(r#"("wide": { "value": 40, "unit": "rem" })"#),
            "sm is not wide: {at_48:?}"
        );
        // A theme that already makes 40rem (an earlier init's sm, a Tailwind theme's) is told to
        // name it, since two breakpoints never share a width.
        let at_40 = super::breakpoint_notes(true, &made("sm", "40rem"), &[], &[]);
        assert!(at_40.len() == 1 && at_40[0].contains(r#"("wide": "{sm}" in tokens/app.tokens.json)"#), "{at_40:?}");
        assert_eq!(
            super::missing_breakpoint("wide", &made("sm", "40rem"), &[], &[], Some("tokens/app.tokens.json")),
            r#""wide": "{sm}""#
        );
        assert_eq!(super::missing_breakpoint("wide", &[], &[], &[], None), r#""wide": { "value": 40, "unit": "rem" }"#);
        // Only a breakpoint with a width, in the file the line goes into: another file's 40rem is
        // out of reach of the name, and one made by naming another would make a chain.
        let two = [
            ("tokens/app.tokens.json".to_string(), "phone".to_string(), "40rem".to_string()),
            ("tokens/ui.resolver.json".to_string(), "sm".to_string(), "40rem".to_string()),
        ];
        assert_eq!(super::missing_breakpoint("wide", &two, &[], &[], Some("tokens/ui.resolver.json")), r#""wide": "{sm}""#);
        assert_eq!(super::missing_breakpoint("wide", &two, &[], &[], None), r#""wide": "{phone}" in tokens/app.tokens.json"#);
        let resolved = [("tokens/app.resolver.json".to_string(), "sm".to_string(), "40rem".to_string())];
        let resolvers = ["tokens/app.resolver.json".to_string()];
        assert_eq!(
            super::missing_breakpoint("wide", &resolved, &[], &resolvers, None),
            r#""wide": "{sm}" in a set of tokens/app.resolver.json"#
        );
        // A resolver is one by its resolutionOrder, not its name.
        let theme = [("tokens/theme.json".to_string(), "sm".to_string(), "40rem".to_string())];
        assert_eq!(
            super::missing_breakpoint("wide", &theme, &[], &["tokens/theme.json".to_string()], None),
            r#""wide": "{sm}" in a set of tokens/theme.json"#
        );
        assert_eq!(super::missing_breakpoint("wide", &resolved, &[], &[], None), r#""wide": "{sm}" in tokens/app.resolver.json"#);
        let alias = [("tokens/app.tokens.json".to_string(), "phone".to_string())];
        assert_eq!(
            super::missing_breakpoint("wide", &two, &alias, &[], Some("tokens/app.tokens.json")),
            r#""wide": { "value": 40, "unit": "rem" }"#
        );
        assert_eq!(super::breakpoint_notes(true, &made("wide", "36rem"), &[], &[]), Vec::<String>::new(), "any width makes it");
        let beside = super::breakpoint_notes(false, &made("wide", "36rem"), &[], &[]);
        assert!(
            beside.len() == 1
                && beside[0].starts_with(
                    "Your theme (tokens/app.tokens.json) makes the breakpoint wide at 36rem, and the kit's theme at 40rem."
                ),
            "{beside:?}"
        );
        assert_eq!(super::breakpoint_notes(false, &made("wide", "40rem"), &[], &[]), Vec::<String>::new());
        assert_eq!(
            super::breakpoint_notes(false, &made("sm", "36rem"), &[], &[]),
            Vec::<String>::new(),
            "the kit's theme makes no sm"
        );
        // A breakpoint that names one in another of a resolver's sets has its width: the kit's
        // theme beside a theme whose wide is its md, in another file, at 40rem, is one width.
        std::fs::write(
            dir.join("tokens/base.tokens.json"),
            r#"{ "$extensions": { "run.corten": { "breakpoints": { "md": { "value": 40, "unit": "rem" } } } } }"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("tokens/brand.tokens.json"),
            r#"{ "$extensions": { "run.corten": { "breakpoints": { "wide": "{md}" } } } }"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("tokens/brand.resolver.json"),
            r#"{ "version": "2025.10", "resolutionOrder": [{ "type": "set", "sources": [{ "$ref": "base.tokens.json" }, { "$ref": "brand.tokens.json" }] }] }"#,
        )
        .unwrap();
        let theme = own_theme(&dir, "corten::style::tokens!(\"tokens/brand.resolver.json\");").unwrap().unwrap();
        assert_eq!(theme.breakpoints, [("md".to_string(), "40rem".to_string()), ("wide".to_string(), "40rem".to_string())]);
        assert_eq!(
            super::media_names(
                "@media not ( --sm ) {}\n/* @media (--x) */ .a { content: \"(--y)\" }\n@media (--md) and (hover) {}"
            ),
            ["sm", "md"]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A kit component and an app's of one name, each with a stylesheet, would style one class
    /// prefix and fail to link: add says which before it writes anything. One without a
    /// stylesheet, a part (`css = Owner`), a doc example and the app's copies of the kit do not count.
    #[test]
    fn add_refuses_a_component_the_app_has_by_that_name() {
        let layout = "use corten::prelude::*;\n\n#[component(css)]\npub fn Field(label: &str) -> impl Render {\n    html! { <div class={Field}></div> }\n}\n\n#[component(js, css)]\n#[allow(unused)]\nfn CardHeader() -> impl Render {}\n";
        assert_eq!(styled_components(layout), ["Field", "CardHeader"]);
        let forms = "#[corten::component(css)]\npub(crate) fn Table() {}\n#[::corten::component(js, css)] // the sort\npub(super) fn Tabs() {}\n#[component(css)]\n/// Docs between.\n#[allow(dead_code)]\nfn Badge() {}\n";
        assert_eq!(styled_components(forms), ["Table", "Tabs", "Badge"]);
        let copy = stamped(piece("field").files[0].1);
        let files = app(&[("src/layout.rs", layout), ("src/views/ui/field.rs", &copy), ("src/ui/mine.rs", layout)]);
        let found = clashes(&files, &[piece("field"), piece("card"), piece("button")]);
        assert_eq!(
            found,
            [
                ("src/layout.rs".to_string(), "Field".to_string(), "field"),
                ("src/ui/mine.rs".to_string(), "Field".to_string(), "field")
            ],
            "a copy of the kit's is not the app's, wherever it is; an app's own in src/ui/ is; CardHeader is a part of Card"
        );
        let plain = "#[component]\npub fn Field() -> impl Render {}\n/// #[component(css)]\n/// fn Button() -> impl Render {}\n#[component(css = Panel)]\nfn Card() {}\n";
        assert_eq!(clashes(&app(&[("src/a.rs", plain)]), &[piece("field"), piece("button"), piece("card")]), []);
    }

    #[test]
    fn add_names_an_app_type_a_kit_component_shares_its_name_with() {
        let domain = "pub struct Progress {\n    pub done: u32,\n}\n// struct Table is in a comment\npub(crate) enum ProgressSize { Big }\nfn progress() {}\n";
        let copy = stamped(piece("progress").files[0].1);
        let files = app(&[("src/batches.rs", domain), ("src/ui/progress.rs", &copy)]);
        assert_eq!(
            namesakes(&files, &[piece("progress"), piece("table")]),
            [
                ("src/batches.rs".to_string(), "Progress".to_string(), "progress"),
                ("src/batches.rs".to_string(), "ProgressSize".to_string(), "progress")
            ],
            "a struct and an enum of the app's; not a comment, a lowercase fn or the kit's own copy"
        );
        assert_eq!(namesakes(&files, &[piece("card")]), []);
        assert_eq!(
            namesake_note("src/batches.rs", "Progress", "progress"),
            "  note: src/batches.rs declares Progress, as the kit's progress does: a file that uses both imports the kit's under\n    \
             another name (use crate::ui::progress::{Progress as KitProgress};), and the classes stay the kit's"
        );
    }

    #[test]
    fn a_widget_component_brings_corten_ui_from_where_corten_comes() {
        let local = "[package]\nname = \"a\"\n\n[dependencies]\ncorten = { path = \"D:\\\\src\\\\crates\\\\corten\", features = [\"compress\"] }\nserde = \"1\"\n";
        let text = depend_on_ui(local).unwrap().unwrap();
        assert!(text.contains("compress\"] }\ncorten-ui = { path = \"D:\\\\src\\\\crates\\\\corten-ui\" }\nserde"), "{text}");
        assert_eq!(depend_on_ui(&text).unwrap(), None, "a second run changes nothing");
        let release = "[dependencies]\ncorten = { version = \"0.1.0\", features = [\"compress\"] }\n\n[dev-dependencies]\ntower = \"0.5\"\n";
        let text = depend_on_ui(release).unwrap().unwrap();
        assert!(text.contains(&format!("corten-ui = \"{}\"\n\n[dev-dependencies]", env!("CARGO_PKG_VERSION"))), "{text}");
        // The line `corten new` writes, which names the package: corten-ui's own name is its package.
        let named = "[dependencies]\ncorten = { package = \"corten-run\", version = \"0.2.0\", features = [\"compress\"] }\n";
        let text = depend_on_ui(named).unwrap().unwrap();
        assert!(text.ends_with(&format!("}}\ncorten-ui = \"{}\"\n", env!("CARGO_PKG_VERSION"))), "{text}");
        assert!(depend_on_ui("[dependencies]\nserde = \"1\"\n").is_err());
        // A line keyed by the package, as cargo add corten-run writes it, is corten's too.
        let by_package = depend_on_ui("[dependencies]\ncorten-run = \"0.2.0\"\n").unwrap().unwrap();
        assert_eq!(
            by_package,
            format!("[dependencies]\ncorten-run = \"0.2.0\"\ncorten-ui = \"{}\"\n", env!("CARGO_PKG_VERSION"))
        );
        let by_path = depend_on_ui("[dependencies]\ncorten-run = { path = \"../corten/crates/corten\" }\n").unwrap().unwrap();
        assert!(by_path.ends_with("}\ncorten-ui = { path = \"../corten/crates/corten-ui\" }\n"), "{by_path}");
        assert_eq!(from_workspace("corten-run.workspace = true"), Ok(Some("corten-ui.workspace = true")));
        assert_eq!(
            from_workspace("corten-run.git = \"x\""),
            Err("corten's line is a dotted key other than corten-run.workspace".into())
        );
        assert!(!is_corten_line("corten-ui = \"0.2.0\""));
        let git = "[dependencies]\ncorten = { git = \"https://github.com/corten-run/corten\", rev = \"abc123\", features = [\"compress\"] }\n";
        let text = depend_on_ui(git).unwrap().unwrap();
        assert!(
            text.ends_with("}\ncorten-ui = { git = \"https://github.com/corten-run/corten\", rev = \"abc123\" }\n"),
            "a Git corten brings corten-ui from the same revision: {text}"
        );
        let branch = "[dependencies]\ncorten = { git = \"https://example.com/c\", branch = \"main\" }\n";
        assert!(
            depend_on_ui(branch).unwrap().unwrap().contains("corten-ui = { git = \"https://example.com/c\", branch = \"main\" }")
        );
        assert!(depend_on_ui("[dependencies]\ncorten = { workspace = true }\n").is_err());
        let quoted = "[dependencies]\ncorten = { git = 'https://example.com/c', tag = 'v0.2' } # path = \"nope\"\n";
        assert!(
            depend_on_ui(quoted).unwrap().unwrap().contains("\ncorten-ui = { git = 'https://example.com/c', tag = 'v0.2' }\n"),
            "single quotes, and a comment is not read"
        );
        let commented = "[dependencies]\ncorten = \"0.1\" # { git = \"https://example.com/c\" }\n";
        assert!(depend_on_ui(commented).unwrap().unwrap().contains(&format!("corten-ui = \"{}\"", env!("CARGO_PKG_VERSION"))));
        // What this does not read exactly is the app's to write, never a guess.
        let spans = "[dependencies]\ncorten = { git = \"https://example.com/c\",\n    rev = \"abc\" }\n";
        assert!(depend_on_ui(spans).is_err(), "a table that goes on past its line");
        assert!(depend_on_ui("[dependencies]\n\n[dependencies.corten]\ngit = \"https://example.com/c\"\n").is_err());
        let features = "[dependencies]\ncorten = { path = \"../corten\", features = [\"a\", \"b\"] }\n";
        assert!(depend_on_ui(features).unwrap().unwrap().contains("corten-ui = { path = \"../corten-ui\" }"));
        let lib = "    App::new(url::router())\n        .components(ui::COMPONENTS)\n        .assets(views::Static)\n";
        let text = list_ui_widgets(lib).unwrap();
        assert!(text.contains(".components(ui::COMPONENTS)\n        .components(corten_ui::COMPONENTS)\n"), "{text}");
        let elsewhere = list_ui_widgets("    App::new(url::router())\n        .components(crate::ui::COMPONENTS)\n").unwrap();
        assert!(
            elsewhere.ends_with(".components(crate::ui::COMPONENTS)\n        .components(corten_ui::COMPONENTS)\n"),
            "{elsewhere}"
        );
        assert_eq!(list_ui_widgets("fn app() {}\n"), None);
    }

    /// A member whose corten comes from the workspace takes corten-ui from it too, and the
    /// workspace gets corten-ui beside its corten when it has none (#564).
    #[test]
    fn a_member_takes_corten_ui_from_its_workspace() {
        let dir = std::env::temp_dir().join(format!("corten-ui-workspace-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let member = dir.join("crates/platform");
        std::fs::create_dir_all(member.join("src")).unwrap();
        std::fs::write(member.join("src/lib.rs"), "").unwrap();
        let package = "[package]\nname = \"platform\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n";
        let workspace = "[workspace]\nmembers = [\"crates/*\"]\n\n[workspace.dependencies]\ncorten = { git = \"https://example.com/c\", rev = \"abc\" }\nserde = \"1\"\n";
        std::fs::write(dir.join("Cargo.toml"), workspace).unwrap();
        let dotted = format!("{package}[dependencies]\ncorten.workspace = true\n");
        std::fs::write(member.join("Cargo.toml"), &dotted).unwrap();
        let edits = depend_on_ui_at(&member).unwrap();
        assert_eq!(edits.len(), 2, "{edits:?}");
        assert_eq!(edits[0].0, "../../Cargo.toml");
        assert!(
            edits[0].1.contains("corten = { git = \"https://example.com/c\", rev = \"abc\" }\ncorten-ui = { git = \"https://example.com/c\", rev = \"abc\" }\nserde"),
            "{}",
            edits[0].1
        );
        assert_eq!(
            edits[1],
            (
                "Cargo.toml".to_string(),
                dotted.replace("corten.workspace = true\n", "corten.workspace = true\ncorten-ui.workspace = true\n")
            )
        );
        // A workspace that has it already: only the member, in the member's form.
        std::fs::write(dir.join("Cargo.toml"), &edits[0].1).unwrap();
        let inline = format!("{package}[dependencies]\ncorten = {{ workspace = true, features = [\"json\"] }}\n");
        std::fs::write(member.join("Cargo.toml"), &inline).unwrap();
        let edits = depend_on_ui_at(&member).unwrap();
        assert_eq!(edits, [("Cargo.toml".to_string(), format!("{inline}corten-ui = {{ workspace = true }}\n"))]);
        std::fs::write(member.join("Cargo.toml"), &edits[0].1).unwrap();
        assert_eq!(depend_on_ui_at(&member).unwrap(), [], "a second run changes nothing");
        // Another dotted key is not read.
        std::fs::write(member.join("Cargo.toml"), format!("{package}[dependencies]\ncorten.git = \"https://example.com/c\"\n"))
            .unwrap();
        assert!(depend_on_ui_at(&member).unwrap_err().contains("dotted key"));
        // A header with a comment after it is the same table.
        std::fs::write(dir.join("Cargo.toml"), workspace.replace("dependencies]\n", "dependencies] # shared\n")).unwrap();
        std::fs::write(member.join("Cargo.toml"), &dotted).unwrap();
        let edits = depend_on_ui_at(&member).unwrap();
        assert!(edits[0].1.contains("rev = \"abc\" }\ncorten-ui = { git"), "{edits:?}");
        // A workspace whose corten this does not read names its manifest and what to add there.
        std::fs::write(
            dir.join("Cargo.toml"),
            "[workspace]\nmembers = [\"crates/*\"]\n\n[workspace.dependencies.corten] # shared\ngit = \"https://example.com/c\"\n",
        )
        .unwrap();
        std::fs::write(member.join("Cargo.toml"), &dotted).unwrap();
        let why = depend_on_ui_at(&member).unwrap_err();
        assert!(why.starts_with("../../Cargo.toml: ") && why.contains("add corten-ui to its [workspace.dependencies]"), "{why}");
        assert!(why.contains("its corten is a table of its own, [workspace.dependencies.corten]"), "the reason is true: {why}");
        // A package that is its workspace's root: both lines in its one manifest.
        let alone = dir.join("alone");
        std::fs::create_dir_all(alone.join("src")).unwrap();
        std::fs::write(alone.join("src/lib.rs"), "").unwrap();
        let own = "[package]\nname = \"alone\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[workspace]\n\n[workspace.dependencies]\ncorten = { path = \"../corten\" }\n\n[dependencies]\ncorten.workspace = true\n";
        std::fs::write(alone.join("Cargo.toml"), own).unwrap();
        let both = own
            .replace(
                "corten = { path = \"../corten\" }\n",
                "corten = { path = \"../corten\" }\ncorten-ui = { path = \"../corten-ui\" }\n",
            )
            .replace("corten.workspace = true\n", "corten.workspace = true\ncorten-ui.workspace = true\n");
        assert_eq!(depend_on_ui_at(&alone).unwrap(), [("Cargo.toml".to_string(), both.clone())]);
        // Keyed by the package, as cargo add corten-run writes it: the same lines beside it.
        let own_run = own.replace("corten = {", "corten-run = {").replace("corten.workspace", "corten-run.workspace");
        std::fs::write(alone.join("Cargo.toml"), &own_run).unwrap();
        let both_run = both.replace("corten = {", "corten-run = {").replace("corten.workspace", "corten-run.workspace");
        assert_eq!(depend_on_ui_at(&alone).unwrap(), [("Cargo.toml".to_string(), both_run)]);
        let workspace_run = workspace.replace("corten = {", "corten-run = {");
        std::fs::write(dir.join("Cargo.toml"), &workspace_run).unwrap();
        let dotted_run = dotted.replace("corten.workspace", "corten-run.workspace");
        std::fs::write(member.join("Cargo.toml"), &dotted_run).unwrap();
        let edits = depend_on_ui_at(&member).unwrap();
        assert!(
            edits[0].1.contains("corten-run = { git = \"https://example.com/c\", rev = \"abc\" }\ncorten-ui = { git = \"https://example.com/c\", rev = \"abc\" }\nserde"),
            "{edits:?}"
        );
        assert_eq!(
            edits[1].1,
            dotted_run.replace("corten-run.workspace = true\n", "corten-run.workspace = true\ncorten-ui.workspace = true\n")
        );
        std::fs::write(
            dir.join("Cargo.toml"),
            "[workspace]\nmembers = [\"crates/*\"]\n\n[workspace.dependencies.corten-run]\ngit = \"https://example.com/c\"\n",
        )
        .unwrap();
        let why = depend_on_ui_at(&member).unwrap_err();
        assert!(why.contains("its corten is a table of its own, [workspace.dependencies.corten-run]"), "{why}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_write_replaces_a_file_that_is_there_and_leaves_nothing_beside_it() {
        let dir = std::env::temp_dir().join(format!("corten-ui-replace-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "old").unwrap();
        apply(&dir, &[("a.txt".to_string(), "new".to_string()), ("b/c.txt".to_string(), "made".to_string())]).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(dir.join("b/c.txt")).unwrap(), "made");
        let mut names: Vec<String> =
            std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["a.txt", "b"]);
        // A file of the app's where one is staged is refused, and kept as it was.
        std::fs::write(dir.join(".a.txt.corten-ui"), "the app's").unwrap();
        let error = apply(&dir, &[("a.txt".to_string(), "newer".to_string())]).unwrap_err();
        assert!(error.contains("is in the way") && error.contains("nothing was changed"), "{error}");
        assert_eq!(std::fs::read_to_string(dir.join(".a.txt.corten-ui")).unwrap(), "the app's");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "new");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_write_that_fails_puts_back_what_the_command_wrote_before_it() {
        let dir = std::env::temp_dir().join(format!("corten-ui-apply-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("taken")).unwrap();
        std::fs::write(dir.join("old.txt"), "old").unwrap();
        // A directory where the last file goes: that write fails.
        let files = [
            ("old.txt".to_string(), "new".to_string()),
            ("made.txt".to_string(), "x".to_string()),
            ("taken".to_string(), "y".to_string()),
        ];
        let error = apply(&dir, &files).unwrap_err();
        assert!(error.contains("nothing was changed"), "{error}");
        assert_eq!(std::fs::read_to_string(dir.join("old.txt")).unwrap(), "old");
        assert!(!dir.join("made.txt").exists());
        assert!(dir.join("taken").is_dir());
        // A file that cannot be staged (its directory is a file): nothing is replaced, and the
        // directory made for an earlier one is gone.
        let files = [("new/a.txt".to_string(), "x".to_string()), ("old.txt/b".to_string(), "y".to_string())];
        let error = apply(&dir, &files).unwrap_err();
        assert!(error.contains("nothing was changed"), "{error}");
        assert!(!dir.join("new").exists());
        let mut names: Vec<String> =
            std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["old.txt", "taken"], "no staged text is left behind");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The properties a kit stylesheet reads that the app may declare and the kit's theme does
    /// not: a figure's face and its label's case.
    const OPTIONAL: [&str; 2] = ["stat-value-font-family", "stat-label-text-transform"];

    #[test]
    fn every_property_a_component_reads_is_a_token_of_the_theme() {
        let tokens = |path: &str| INIT.iter().find(|(p, _)| *p == path).unwrap().1;
        let (light, dark) = (tokens("tokens/ui.tokens.json"), tokens("tokens/ui-dark.tokens.json"));
        for name in OPTIONAL {
            let read = KIT.iter().flat_map(|p| p.files.iter()).any(|(_, t)| t.contains(&format!("var(--{name},")));
            assert!(read, "no kit stylesheet reads --{name}: rename it in OPTIONAL and the kit guide too");
        }
        for piece in KIT {
            for (file, text) in piece.files.iter().filter(|(f, _)| f.ends_with(".css")) {
                for read in text.split("var(--").skip(1) {
                    let name = &read[..read.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-')).unwrap()];
                    // One the stylesheet sets itself (a badge's `--kit-tone`) is not the theme's.
                    if text.contains(&format!("--{name}:")) {
                        continue;
                    }
                    let line = light.lines().find(|l| l.starts_with(&format!("  \"{name}\": ")));
                    // The app's alone, read with a fallback, since no token's value says "the
                    // page's" (the guide names each): never in the kit's theme, so never asked for.
                    if OPTIONAL.contains(&name) {
                        assert!(line.is_none() && read[name.len()..].trim_start().starts_with(','), "{file} reads --{name}");
                        continue;
                    }
                    assert!(line.is_some(), "{file} reads --{name}, which the theme lacks");
                    // Only a color differs in the dark theme: a size (`radius`, a control's
                    // height), a weight or a figure's tracking is the same in both.
                    if line.is_some_and(|l| l.contains("\"$type\": \"color\"")) {
                        assert!(dark.contains(&format!("\n  \"{name}\": ")), "{file} reads --{name}, which the dark theme lacks");
                    }
                }
            }
        }
    }

    /// The theme's text on its backgrounds meets WCAG AA in both themes, as the guide says: each
    /// `-foreground` on its color (4.5:1), a tone's text on a card (an alert's), the muted text on
    /// the page and a card, the chosen tab's text on its raised surface, and a field's border on the
    /// page (3:1, a control's boundary).
    #[test]
    fn the_themes_text_meets_wcag_aa() {
        let tokens = |path: &str| INIT.iter().find(|(p, _)| *p == path).unwrap().1;
        for file in ["tokens/ui.tokens.json", "tokens/ui-dark.tokens.json"] {
            let text = tokens(file);
            // A color that is a reference to another (`"{foreground}"`) is that one's.
            let hex = |name: &str| {
                let mut name = name.to_string();
                for _ in 0..8 {
                    let line = text
                        .lines()
                        .find(|l| l.starts_with(&format!("  \"{name}\": ")))
                        .unwrap_or_else(|| panic!("{file} has no {name}"));
                    if let Some(at) = line.find("\"$value\": \"{") {
                        let to = &line[at + "\"$value\": \"{".len()..];
                        name = to[..to.find('}').unwrap()].to_string();
                        continue;
                    }
                    let at = line.find("\"hex\": \"#").unwrap() + "\"hex\": \"#".len();
                    return u32::from_str_radix(&line[at..at + 6], 16).unwrap();
                }
                panic!("{file}: {name} is a reference eight deep, or one that goes round in a circle")
            };
            let luminance = |rgb: u32| {
                let channel = |c: u32| {
                    let c = f64::from(c & 255) / 255.0;
                    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
                };
                0.2126 * channel(rgb >> 16) + 0.7152 * channel(rgb >> 8) + 0.0722 * channel(rgb)
            };
            let ratio = |a: &str, b: &str| {
                let (x, y) = (luminance(hex(a)), luminance(hex(b)));
                (x.max(y) + 0.05) / (x.min(y) + 0.05)
            };
            let mut pairs: Vec<(String, String, f64)> = Vec::new();
            for line in text.lines() {
                if let Some(name) =
                    line.trim_start().strip_prefix('"').and_then(|l| l.split_once("-foreground\"")).map(|(n, _)| n)
                {
                    pairs.push((format!("{name}-foreground"), name.to_string(), 4.5));
                }
            }
            for tone in ["info", "success", "warning", "destructive"] {
                pairs.push((tone.into(), "card".into(), 4.5));
            }
            pairs.push(("muted-foreground".into(), "background".into(), 4.5));
            pairs.push(("muted-foreground".into(), "card".into(), 4.5));
            pairs.push(("input".into(), "background".into(), 3.0));
            // The chosen tab's or segmented choice's text, on its raised surface.
            pairs.push(("tab-selected-color".into(), "background".into(), 4.5));
            assert!(pairs.len() > 12, "{file}: {pairs:?}");
            for (text_color, on, least) in pairs {
                let r = ratio(&text_color, &on);
                assert!(r >= least, "{file}: {text_color} on {on} is {r:.2}:1, under {least}:1");
            }
            // A badge's text, in each tone (`--kit-tone` in badge.css) and emphasis: solid is the tone's
            // `-foreground` pair above; soft is 85% of the tone in the foreground on 12% of it in the
            // card, mixed in sRGB as `color-mix(in srgb, ..)` mixes; outline is the tone on the page
            // and on a card.
            let channels = |rgb: u32| [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255].map(|c| f64::from(c) / 255.0);
            let linear = |c: f64| if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) };
            let lum = |c: [f64; 3]| 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
            let contrast = |a: [f64; 3], b: [f64; 3]| {
                let (x, y) = (lum(a), lum(b));
                (x.max(y) + 0.05) / (x.min(y) + 0.05)
            };
            let badge = include_str!("../kit/badge.css");
            assert!(
                badge.contains(".soft { background: color-mix(in srgb, var(--kit-tone) 12%, var(--card)); color: color-mix(in srgb, var(--kit-tone) 85%, var(--foreground)); }"),
                "the soft badge's mix is the one checked here"
            );
            for tone in ["neutral", "primary", "info", "success", "warning", "destructive"] {
                let rule = badge.lines().find(|l| l.starts_with(&format!(".{tone} {{ --kit-tone: var(--"))).expect(tone);
                let color = &rule[rule.find("var(--").unwrap() + 6..rule.find(");").unwrap()];
                let (ink, card, fg) = (channels(hex(color)), channels(hex("card")), channels(hex("foreground")));
                let soft = [0, 1, 2].map(|i| ink[i] * 0.12 + card[i] * 0.88);
                let soft_text = [0, 1, 2].map(|i| ink[i] * 0.85 + fg[i] * 0.15);
                for (name, r) in [
                    ("a soft badge", contrast(soft_text, soft)),
                    ("the page", contrast(ink, channels(hex("background")))),
                    ("a card", contrast(ink, card)),
                ] {
                    assert!(r >= 4.5, "{file}: a {tone} badge's text on {name} is {r:.2}:1, under 4.5:1");
                }
            }
            // An alert's tones and its soft and solid emphases are the badge's, checked above; an
            // outline alert's text is the tone on the card (the pairs above), and its paragraph 85% of
            // the tone in the foreground, on the card. A list in an alert is colored as its paragraph is.
            let alert = include_str!("../kit/alert.css");
            for rule in [
                ".soft { background: color-mix(in srgb, var(--kit-tone) 12%, var(--card)); color: color-mix(in srgb, var(--kit-tone) 85%, var(--foreground));",
                ".solid { background: var(--kit-tone-fill); color: var(--kit-tone-text);",
                ".outline > :is(p, ol, ul) { color: color-mix(in srgb, var(--kit-tone) 85%, var(--foreground)); }",
                ".outline { background: var(--card); color: var(--kit-tone);",
                ".neutral.solid { border-color: var(--border); }",
                ".neutral.outline { color: var(--card-foreground);",
                ".neutral.outline > :is(p, ol, ul) { color: var(--muted-foreground); }",
                ".alert > p { margin: 0; color: inherit; }",
                // A list takes the paragraph's color in every emphasis, so it is checked with it.
                ".alert > :is(ol, ul), .alert li > :is(ol, ul) { color: inherit;",
            ] {
                assert!(
                    alert.contains(rule)
                        && (rule.starts_with(".outline")
                            || rule.starts_with(".neutral")
                            || rule.starts_with(".alert")
                            || badge.contains(rule)),
                    "the alert's rule checked here: {rule}"
                );
            }
            // A neutral outline's paragraph is the muted text on the card, one of the pairs above.
            for tone in ["neutral", "info", "success", "warning", "destructive"] {
                let rule = alert.lines().find(|l| l.starts_with(&format!(".{tone} {{ --kit-tone: var(--"))).expect(tone);
                assert!(badge.contains(rule), "an alert's {tone} tone is the badge's");
                let color = &rule[rule.find("var(--").unwrap() + 6..rule.find(");").unwrap()];
                let (ink, card, fg) = (channels(hex(color)), channels(hex("card")), channels(hex("foreground")));
                let text = [0, 1, 2].map(|i| ink[i] * 0.85 + fg[i] * 0.15);
                let r = contrast(text, card);
                assert!(
                    tone == "neutral" || r >= 4.5,
                    "{file}: an outline {tone} alert's paragraph is {r:.2}:1 on a card, under 4.5:1"
                );
            }
            // The Toaster's failed text is a soft destructive one on the popover: 85% of the tone in the
            // popover's foreground on 12% of it in the popover, its button in the same color.
            let toasts = include_str!("../kit/toasts.css");
            assert!(
                toasts.contains("background: color-mix(in srgb, var(--destructive) 12%, var(--popover)); color: color-mix(in srgb, var(--destructive) 85%, var(--popover-foreground));")
                    && toasts.contains("[role=\"status\"] + button:not(:hover) { color: inherit;"),
                "the failed toast's mix is the one checked here"
            );
            let (ink, popover, fg) =
                (channels(hex("destructive")), channels(hex("popover")), channels(hex("popover-foreground")));
            let r =
                contrast([0, 1, 2].map(|i| ink[i] * 0.85 + fg[i] * 0.15), [0, 1, 2].map(|i| ink[i] * 0.12 + popover[i] * 0.88));
            assert!(r >= 4.5, "{file}: the failed toast's text is {r:.2}:1, under 4.5:1");
        }
    }

    /// A meter's fill, in each state's color, stands out from its track by 3:1 in both themes, the
    /// contrast a part that shows a value needs (WCAG 1.4.11), and each engine's rule for each state
    /// fills with that state's color.
    #[test]
    fn a_meters_fill_stands_out_from_its_track() {
        let meter = include_str!("../kit/meter.css");
        let rule =
            |start: &str| meter.lines().find(|l| l.starts_with(start)).unwrap_or_else(|| panic!("meter.css has no {start}"));
        assert!(rule(".meter::-webkit-meter-bar {").ends_with("background: var(--border); }"), "the track");
        let block = &meter[meter.find(".meter {").unwrap()..];
        assert!(block[..block.find('}').unwrap()].contains("background: var(--border);"), "the track Firefox draws");
        let states = [
            (".meter::-webkit-meter-optimum-value {", "primary"),
            (".meter:is([low], [high])::-webkit-meter-optimum-value {", "success"),
            (".meter::-webkit-meter-suboptimum-value {", "warning"),
            (".meter::-webkit-meter-even-less-good-value {", "destructive"),
            (".meter::-moz-meter-bar {", "primary"),
            (".meter:is([low], [high]):-moz-meter-optimum::-moz-meter-bar {", "success"),
            (".meter:-moz-meter-sub-optimum::-moz-meter-bar {", "warning"),
            (".meter:-moz-meter-sub-sub-optimum::-moz-meter-bar {", "destructive"),
        ];
        for (state, fill) in states {
            assert!(rule(state).ends_with(&format!("background: var(--{fill}); }}")), "{state} fills with {fill}");
        }
        let tokens = |path: &str| INIT.iter().find(|(p, _)| *p == path).unwrap().1;
        for file in ["tokens/ui.tokens.json", "tokens/ui-dark.tokens.json"] {
            let text = tokens(file);
            let luminance = |name: &str| {
                let line = text.lines().find(|l| l.starts_with(&format!("  \"{name}\": "))).unwrap();
                let at = line.find("\"hex\": \"#").unwrap() + "\"hex\": \"#".len();
                let rgb = u32::from_str_radix(&line[at..at + 6], 16).unwrap();
                let channel = |c: u32| {
                    let c = f64::from(c & 255) / 255.0;
                    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
                };
                0.2126 * channel(rgb >> 16) + 0.7152 * channel(rgb >> 8) + 0.0722 * channel(rgb)
            };
            for (_, fill) in states {
                let (x, y) = (luminance(fill), luminance("border"));
                let r = (x.max(y) + 0.05) / (x.min(y) + 0.05);
                assert!(r >= 3.0, "{file}: a {fill} meter on its track is {r:.2}:1, under 3:1");
            }
        }
    }

    /// A progress bar is drawn in every engine with its track in the border color and its fill in its
    /// tone's color (primary, info, success, warning or destructive), each 3:1 against the track in
    /// both themes, as a meter's fill is; with no value, the band is the element's own background,
    /// the engines' parts cleared, and it moves only when the reader has not asked for less motion.
    #[test]
    fn a_progress_bar_is_drawn_in_the_meters_colors() {
        let css = include_str!("../kit/progress.css");
        let rule =
            |start: &str| css.lines().find(|l| l.starts_with(start)).unwrap_or_else(|| panic!("progress.css has no {start}"));
        let block = &css[css.find(".progress {").unwrap()..];
        let block = &block[..block.find('}').unwrap()];
        assert!(block.contains("background: var(--border);"), "the track");
        assert!(block.contains("--kit-tone: var(--primary);"), "a bar's tone is primary unless it names another");
        // Each tone's rule comes after the bar's, so it wins at the same specificity, and its color
        // stands out from the track by 3:1 in both themes, as a meter's fill does.
        let tones = ["info", "success", "warning", "destructive"];
        for tone in tones {
            let at = css.find(&format!(".{tone} {{ --kit-tone: var(--{tone}); }}")).unwrap_or_else(|| panic!("no {tone} tone"));
            assert!(at > css.find(".progress {").unwrap(), "the {tone} tone comes after .progress");
        }
        assert_eq!(css.matches("--kit-tone: var(--").count(), tones.len() + 1, "a rule for each tone and the default");
        let tokens = |path: &str| INIT.iter().find(|(p, _)| *p == path).unwrap().1;
        for file in ["tokens/ui.tokens.json", "tokens/ui-dark.tokens.json"] {
            let text = tokens(file);
            let luminance = |name: &str| {
                let line = text.lines().find(|l| l.starts_with(&format!("  \"{name}\": "))).unwrap();
                let at = line.find("\"hex\": \"#").unwrap() + "\"hex\": \"#".len();
                let rgb = u32::from_str_radix(&line[at..at + 6], 16).unwrap();
                let channel = |c: u32| {
                    let c = f64::from(c & 255) / 255.0;
                    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
                };
                0.2126 * channel(rgb >> 16) + 0.7152 * channel(rgb >> 8) + 0.0722 * channel(rgb)
            };
            for fill in std::iter::once("primary").chain(tones) {
                let (x, y) = (luminance(fill), luminance("border"));
                let r = (x.max(y) + 0.05) / (x.min(y) + 0.05);
                assert!(r >= 3.0, "{file}: a {fill} progress bar on its track is {r:.2}:1, under 3:1");
            }
        }
        assert!(rule(".progress::-webkit-progress-bar {").ends_with("background: var(--border); }"));
        assert!(rule(".progress::-webkit-progress-value {").ends_with("background: var(--kit-tone); }"));
        assert!(rule(".progress::-moz-progress-bar {").ends_with("background: var(--kit-tone); }"));
        assert_eq!(css.matches("var(--primary)").count(), 1, "every fill and band is the tone's, primary only its default");
        assert!(rule(".progress:indeterminate::-webkit-progress-bar {").ends_with("background: transparent; }"));
        assert!(rule(".progress:indeterminate::-moz-progress-bar {").ends_with("background: transparent; }"));
        assert!(
            rule(".progress:indeterminate {")
                .contains("repeating-linear-gradient(-45deg, var(--kit-tone) 0 .25rem, var(--border) .25rem .5rem)"),
            "stripes with no motion, in the tone on the track"
        );
        assert!(
            css.contains(
                "background: linear-gradient(var(--kit-tone), var(--kit-tone)) no-repeat 0 0 / 30% 100%, var(--border);"
            ),
            "the moving band, in the tone on the track"
        );
        let motion = &css[css.find("@media (prefers-reduced-motion: no-preference) {").expect("the band moves only here")..];
        assert!(motion[..motion.find("}\n}").unwrap()].contains("animation: progress-sweep"));
        assert_eq!(css.matches("animation:").count(), 1, "no animation outside the media query");
        // Forced colors keeps a bar: the parts in the system's colors, which the engine does not
        // replace.
        let forced = &css[css.find("@media (forced-colors: active) {").expect("a forced-colors block")..];
        let forced = &forced[..forced.find("}\n}").unwrap()];
        for part in [
            "forced-color-adjust: none;",
            "-webkit-progress-value { background: Highlight; }",
            "-moz-progress-bar { background: Highlight; }",
            "Highlight 0 .25rem, Canvas",
        ] {
            assert!(forced.contains(part), "forced colors: {part}");
        }
    }

    /// A filled segmented control is a grid of equal parts across its box, and its rules are one class
    /// more than the track's and the choices', so they win wherever the stylesheets are linked; its
    /// choices may wrap, at least a control's height (#1060).
    #[test]
    fn a_filled_segmented_control_outranks_its_track() {
        let css = include_str!("../kit/segmented.css");
        let block = |start: &str| {
            let at = css.find(start).unwrap_or_else(|| panic!("segmented.css has no {start}"));
            &css[at..at + css[at..].find('}').unwrap()]
        };
        let track = block(".segmented.fill [role=\"radiogroup\"], .links.fill, .radios.fill > .track {");
        for part in [
            "display: grid;",
            "grid-auto-flow: column;",
            "grid-auto-columns: minmax(0, 1fr);",
            "box-sizing: border-box; width: 100%;",
        ] {
            assert!(track.contains(part), "the filled track: {part}");
        }
        let choice = block(".segmented.fill [role=\"radio\"], .links.fill > a, .radios.fill .choice {");
        for part in [
            "min-width: 0; height: auto; min-height: var(--control-height-sm);",
            "white-space: normal;",
            "overflow-wrap: anywhere;",
        ] {
            assert!(choice.contains(part), "a filled choice: {part}");
        }
        assert!(
            css.contains(
                ".segmented.fill [role=\"radio\"] > *, .links.fill > a > *, .radios.fill .choice > span { min-width: 0; }"
            ),
            "a choice's text shrinks"
        );
        assert!(css.contains(".segmented [role=\"radiogroup\"], .links, .track {"), "the track the fill outranks");
        let fieldset = css
            .find(".radios.fill { box-sizing: border-box; width: 100%; justify-items: stretch; }")
            .expect("the fieldset fills");
        assert!(fieldset > css.find(".radios {").unwrap(), "after .radios");
    }

    /// A stack's children take its width whatever the app's element rules say (a new app's
    /// `form { align-items: end }`): `.stack` is one class, which beats an element. Its margin rule
    /// has no specificity, so the app's own margin rules win, and leaves a dialog or popover alone.
    /// And a figure is the same surface as a card (and a panel).
    #[test]
    fn a_stack_stretches_and_a_figure_is_a_card() {
        let block = |css: &'static str, start: &str| {
            let at = css.find(start).unwrap_or_else(|| panic!("no {start}"));
            let rest = &css[at + start.len()..];
            rest[..rest.find('}').unwrap()].to_string()
        };
        let stack = include_str!("../kit/stack.css");
        assert!(stack.lines().any(|l| l.starts_with(".stack {") && l.contains("align-items: stretch;")));
        // A dialog or popover child keeps the browser's margin: auto and width, which center it in
        // the top layer (#1124).
        assert!(stack.lines().any(|l| l == ":where(.stack, .cluster) > :where(:not(dialog, [popover])) { margin-block: 0; }"));
        // StackStart keeps a stack's children their own width: it writes the stack's classes and its
        // own, two classes, so it beats .stack; its cap on a child's width, the word break and a
        // picture's shape have no specificity, so an app's rule on a child wins.
        assert!(stack.contains(".stack.start { align-items: flex-start; }"), "StackStart's rule");
        assert!(
            stack.contains(":where(.stack.start) > * { overflow-wrap: anywhere; }")
                && stack.contains(":where(.stack.start) > :where(:not(dialog, [popover])) { max-width: 100%; }"),
            "a child is at most the stack's width, a dialog's or popover's long words break too"
        );
        assert!(
            stack.contains(":where(.stack.start) > :where(img, video, canvas) { height: auto; }"),
            "a picture keeps its shape"
        );
        let (stat, card) =
            (block(include_str!("../kit/stats.css"), ".stat {"), block(include_str!("../kit/card.css"), ".card, .panel {"));
        let declarations =
            |b: &str| -> Vec<String> { b.split(';').map(|d| d.trim().to_string()).filter(|d| !d.is_empty()).collect() };
        for property in ["background:", "color:", "border:", "border-radius:", "box-shadow:"] {
            let of = |b: &str| declarations(b).into_iter().find(|d| d.starts_with(property));
            assert_eq!(of(&stat), of(&card), "a figure's {property} is a card's");
        }
    }

    /// Every corten-ui component the app sees drawn has a kit look (#610): corten-ui ships no CSS,
    /// so a widget without one renders bare in every app (a ChoiceGroup's links run together).
    /// The others draw nothing of their own, or take the app's look as a `class`.
    #[test]
    fn every_corten_ui_widget_drawn_has_a_kit_look() {
        const UNDRAWN: &[(&str, &str)] = &[
            ("CopyButton", "takes a class: the kit's Button look"),
            ("LocalTime", "text in a <time>"),
            ("PrintButton", "takes a class: the kit's Button look"),
            ("RelativeTime", "text in a <time>"),
            ("RequiredWhen", "attributes on the app's own controls"),
            ("ShownFor", "shows or hides the app's parts, drawing none"),
            ("Toast", "one of the Toaster's, drawn by its look"),
        ];
        let src = concat!(env!("CARGO_MANIFEST_DIR"), "/../corten-ui/src");
        let mut widgets = Vec::new();
        for entry in std::fs::read_dir(src).unwrap() {
            let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
            for line in text.lines() {
                let Some(rest) = line.strip_prefix("pub fn ") else { continue };
                let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
                if name.starts_with(|c: char| c.is_ascii_uppercase()) {
                    widgets.push(name);
                }
            }
        }
        assert!(widgets.len() >= 10, "corten-ui's components read: {widgets:?}");
        for widget in &widgets {
            let styled = KIT.iter().any(|p| p.styles == Some(widget.as_str()));
            let undrawn = UNDRAWN.iter().any(|(name, _)| name == widget);
            assert!(
                styled || undrawn,
                "corten-ui's {widget} has no kit look: add a piece that styles it, or say in UNDRAWN why it needs none"
            );
            assert!(!(styled && undrawn), "{widget} has a look and is listed as needing none");
        }
        for (name, _) in UNDRAWN {
            assert!(widgets.iter().any(|w| w == name), "UNDRAWN names {name}, which corten-ui no longer has");
        }
    }

    /// Every selector of a stylesheet, comments dropped and lists split, wherever the lines break.
    /// A rule's selector is the text after the `{` or `;` before its body, so one inside
    /// `@media` or `@supports` is read, and so is one nested in another rule's body.
    fn selectors(css: &str) -> Vec<String> {
        let mut text = String::new();
        let mut rest = css;
        while let Some(at) = rest.find("/*") {
            text.push_str(&rest[..at]);
            rest = &rest[at + rest[at..].find("*/").unwrap() + 2..];
        }
        text.push_str(rest);
        let mut selectors = Vec::new();
        for block in text.split('}') {
            if let Some(open) = block.rfind('{') {
                let start = block[..open].rfind(['{', ';']).map_or(0, |at| at + 1);
                selectors.extend(block[start..open].split(',').map(|s| s.split_whitespace().collect::<Vec<_>>().join(" ")));
            }
        }
        selectors.retain(|s| !s.is_empty() && !s.starts_with('@'));
        selectors
    }

    /// Each selector of a look's stylesheet is the look's own (`root` or one of `whole`), or
    /// draws its input: `input` then only that input's own states (pseudo-classes, pseudo-elements,
    /// attributes), with no combinator past it. It reads rules written flat, as the kit writes
    /// them: a list in `:is(..)`, a nested `&` rule or another state of the root is refused, not
    /// read, so the stylesheet spells each out.
    fn draws_only(css: &str, root: &str, input: &str, whole: &[&str]) {
        let selectors = selectors(css);
        assert!(selectors.len() >= 5, "{selectors:?}");
        for selector in &selectors {
            if selector == root || whole.contains(&selector.as_str()) {
                continue;
            }
            let state = selector.strip_prefix(input).unwrap_or_else(|| panic!("{selector} draws more than {input}"));
            let own = state.starts_with([':', '[']) || state.is_empty();
            assert!(own && !state.contains([' ', '>', '+', '~']), "{selector} draws more than {input}");
        }
    }

    /// A switch is drawn only on a checkbox whose role says it is one, so a missing role is seen on
    /// the page rather than heard only by a screen reader.
    #[test]
    fn a_switch_is_drawn_only_with_its_role() {
        let css = include_str!("../kit/switch.css");
        draws_only(css, ".switch", ".switch > input[role=\"switch\"]", &[".switch:has(> input:disabled)"]);
    }

    /// A checkbox whose role makes it a switch is not drawn as a checkbox.
    #[test]
    fn a_checkbox_is_not_drawn_on_a_switch() {
        let css = include_str!("../kit/checkbox.css");
        draws_only(css, ".checkbox", ".checkbox > input:not([role=\"switch\"])", &[".checkbox:has(> input:disabled)"]);
    }

    /// The check reads what a stylesheet could draw an input with.
    #[test]
    fn draws_only_refuses_what_draws_more() {
        let whole = [".switch:has(> input:disabled)"];
        let input = ".switch > input[role=\"switch\"]";
        let base = include_str!("../kit/switch.css");
        for drawn in [
            ".switch > input { color: red; }",
            ".switch input:checked { color: red; }",
            ".switch [type=\"checkbox\"] { color: red; }",
            ".switch :checked { color: red; }",
            ".switch * { color: red; }",
            ".switch::before { content: \"\"; }",
            ".switch > input[role=\"switch\"] ~ input { color: red; }",
            ".switch { color: red; > [type=checkbox] { color: red; } }",
            "@media (forced-colors: active) { .switch > input:checked { color: red; } }",
            ":where(.switch) > input { color: red; }",
        ] {
            let css = format!("{base}\n{drawn}\n");
            let refused = std::panic::catch_unwind(|| draws_only(&css, ".switch", input, &whole)).is_err();
            assert!(refused, "{drawn} passed");
        }
    }

    /// `corten check` in an app runs `corten fmt --check`, so each kit file is laid out as
    /// `corten fmt` lays it out at rustfmt's default width. (rustfmt's own layout is checked by the
    /// `corten new` check, which formats an app with every component.)
    #[test]
    fn every_kit_file_is_laid_out_as_corten_fmt_does() {
        for piece in KIT {
            for (file, text) in piece.files.iter().filter(|(f, _)| f.ends_with(".rs")) {
                let (formatted, warnings) = crate::fmt::format_source(text, 100);
                assert!(warnings.is_empty(), "{file}: {warnings:?}");
                assert!(formatted == *text, "{file} is not laid out as corten fmt does");
            }
        }
    }

    #[test]
    fn a_copy_says_where_it_came_from_and_what_it_was() {
        let text = stamped(include_str!("../kit/button.rs"));
        let first = text.lines().next().unwrap();
        let (version, hash) = stamp_of(&text).unwrap();
        assert_eq!(version, env!("CARGO_PKG_VERSION"));
        assert!(first.starts_with(&format!("// corten ui {version}: button ")), "{first}");
        assert_eq!(hash, fnv(text.split_once('\n').unwrap().1));
        let css = stamped(include_str!("../kit/button.css"));
        assert!(css.lines().next().unwrap().ends_with(&format!(" {hash:016x} */", hash = stamp_of(&css).unwrap().1)));
        // A checkout that turned the line ends into CRLF has not edited it.
        assert_eq!(fnv("a\r\nb\r\n"), fnv("a\nb\n"));
    }

    /// A scratch app directory for one test.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("corten-ui-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `kit/was/` keeps the text of every hash a kit file's copies may carry, the current one's too,
    /// so a copy from any kit has its base, and a change to a kit file adds its new text there and
    /// removes none (#599).
    #[test]
    fn the_kit_keeps_the_text_of_every_hash_its_copies_carry() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("kit/was");
        let kept: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        for (file, text) in KIT.iter().flat_map(|p| p.files.iter()) {
            let now = format!("{file}.{:016x}", stamp_of(&stamped(text)).unwrap().1);
            assert!(
                kept.contains(&now),
                "{file} changed: copy crates/corten-cli/kit/{file} to crates/corten-cli/kit/was/{now}, and keep its earlier texts there"
            );
            assert_eq!(std::fs::read_to_string(dir.join(&now)).unwrap(), *text, "kit/was/{now} is not kit/{file}");
        }
        for name in &kept {
            let (file, hash) = name.rsplit_once('.').unwrap();
            let text = std::fs::read_to_string(dir.join(name)).unwrap();
            assert_eq!(format!("{:016x}", stamp_of(&stamped(&text)).unwrap().1), hash, "kit/was/{name} is another text");
            assert!(KIT.iter().flat_map(|p| p.files.iter()).any(|(f, _)| *f == file), "kit/was/{name} is no kit file's");
        }
        // Each earlier text is carried; the current one is the kit's file itself.
        for (file, hash, _) in WAS {
            assert!(kit_text(file, u64::from_str_radix(hash, 16).unwrap()).is_some(), "{file}.{hash}");
        }
        assert_eq!(WAS.len() + KIT.iter().map(|p| p.files.len()).sum::<usize>(), kept.len());
    }

    #[test]
    fn merge3_takes_each_sides_changes_and_marks_a_line_both_changed() {
        let base = "a\nb\nc\nd\ne\n";
        assert_eq!(merge3(base, "a\nB\nc\nd\ne\n", "a\nb\nc\nD\ne\n"), ("a\nB\nc\nD\ne\n".to_string(), 0));
        assert_eq!(merge3(base, "a\nb\nc\nd\ne\nf\n", "z\na\nb\nc\nd\ne\n"), ("z\na\nb\nc\nd\ne\nf\n".to_string(), 0));
        assert_eq!(merge3(base, "a\nc\nd\ne\n", base), ("a\nc\nd\ne\n".to_string(), 0), "a line the copy removed");
        assert_eq!(merge3(base, "a\nX\nc\nd\ne\n", "a\nX\nc\nd\ne\n"), ("a\nX\nc\nd\ne\n".to_string(), 0), "one change on both");
        let (text, conflicts) = merge3(base, "a\nmine\nc\nd\ne\n", "a\ntheirs\nc\nd\ne\n");
        assert_eq!(conflicts, 1);
        assert_eq!(text, "a\n<<<<<<< this copy\nmine\n=======\ntheirs\n>>>>>>> the kit\nc\nd\ne\n");
    }

    /// `diff` shows a copy's edits and the kit's changes as two diffs from the kit's text the copy
    /// was made from, and `add --merge` keeps the edits in the kit's new text (#599).
    #[test]
    fn diff_tells_the_apps_edits_from_the_kits_changes_and_merge_keeps_both() {
        let dir = scratch("diff");
        let (file, path) = ("alert.css", "src/ui/alert.css");
        let kit = include_str!("../kit/alert.css");
        let (_, _, base) = WAS.iter().find(|(f, _, _)| *f == file).expect("an earlier alert.css");
        let copy = stamped(base);
        let said = report(&dir, path, "alert", file, &copy, kit);
        assert!(
            said.contains("changed in the kit since the copy, not edited here, so corten ui add --force alert takes it"),
            "{said}"
        );
        assert!(report(&dir, path, "alert", file, &stamped(kit), kit).ends_with("as copied, the same as the kit\n"));
        // The copy's rule goes after the `.alert` block, which the kit's changes leave alone.
        let with_mine = |text: &str| {
            let at = text.find("\n.alert > :is").expect("the .alert block") + 1;
            format!("{}.mine {{ margin: 0; }}\n{}", &text[..at], &text[at..])
        };
        let mine = with_mine(&stamped(kit));
        let said = report(&dir, path, "alert", file, &mine, kit);
        assert!(
            said.contains("edited here; the kit has not changed it since") && said.contains("+.mine { margin: 0; }\n"),
            "{said}"
        );
        let both = with_mine(&copy);
        let said = report(&dir, path, "alert", file, &both, kit);
        let (edits, changes) = said.split_once("The kit's changes").expect(&said);
        assert!(edits.contains("edited here and changed in the kit since: corten ui add --merge alert"), "{said}");
        assert!(edits.contains("\n+.mine { margin: 0; }\n") && !edits.contains("\n-"), "only the copy's line: {edits}");
        let changed = changes.lines().skip(1).any(|l| l.starts_with(['+', '-']));
        assert!(!changes.contains(".mine") && changed, "the kit's changes alone: {said}");
        // Merged: the kit's text with the copy's rule, stamped as the kit's, so it reads as edited.
        let (text, conflicts, _) = merged(&dir, path, file, &both, &stamped(kit)).unwrap();
        assert_eq!((text, conflicts), (with_mine(&stamped(kit)), 0));
        assert_eq!(
            merged(&dir, path, file, &copy, &stamped(kit)).unwrap(),
            (stamped(kit), 0, true),
            "a copy not edited is the kit's"
        );
        let crlf = merged(&dir, path, file, &copy.replace('\n', "\r\n"), &stamped(kit)).unwrap();
        assert_eq!(crlf, (stamped(kit).replace('\n', "\r\n"), 0, true), "and keeps its CRLF");
        // A stamp this command has no text for, and no stamp: the copy against the kit whole.
        let stranger = stamped("/* corten ui 9.9.9: alert */\n.x {}\n");
        let said = report(&dir, path, "alert", file, &stranger, kit);
        assert!(said.contains("from a kit whose text this command does not have"), "{said}");
        assert!(
            merged(&dir, path, file, &format!("{stranger}.y {{}}\n"), &stamped(kit)).unwrap_err().contains("cannot be merged")
        );
        let said = report(&dir, path, "alert", file, "no stamp\nline\n", kit);
        assert!(said.contains("where it came from is unknown") && said.contains("-no stamp\n"), "{said}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// `add --merge` writes nothing over a copy it cannot read, and fails after writing a merge with
    /// conflicts, as git does.
    #[test]
    fn merge_refuses_a_copy_it_cannot_read_and_fails_on_a_conflict() {
        let dir = scratch("merge-add");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/lib.rs"), "pub fn app() -> App {\n    App::new(url::router())\n}\n").unwrap();
        super::init(&dir, &["--kit-theme".to_string()]).unwrap();
        super::add(&dir, &["alert".to_string()]).unwrap();
        let path = dir.join("src/ui/alert.css");
        std::fs::write(&path, b"/* corten ui 0.1.0: alert 0000000000000000 */\n.mine { content: \"\x93\"; }\n").unwrap();
        let before = std::fs::read(&path).unwrap();
        let why = super::add(&dir, &["alert".to_string(), "--merge".to_string()]).unwrap_err();
        assert!(why.contains("cannot be merged"), "{why}");
        assert_eq!(std::fs::read(&path).unwrap(), before, "nothing written");
        // A copy of an earlier alert.css with a line both changed.
        let (_, _, base) = WAS.iter().find(|(f, _, _)| *f == "alert.css").unwrap();
        let line = base.lines().nth(2).unwrap();
        std::fs::write(&path, stamped(base).replacen(line, "/* mine */", 1)).unwrap();
        let kit = include_str!("../kit/alert.css");
        if kit.lines().any(|l| l == line) {
            // The kit kept that line: a clean merge.
            super::add(&dir, &["alert".to_string(), "--merge".to_string()]).unwrap();
        } else {
            let why = super::add(&dir, &["alert".to_string(), "--merge".to_string()]).unwrap_err();
            assert!(why.contains("conflicts to resolve") && why.contains("src/ui/alert.css"), "{why}");
        }
        assert!(std::fs::read_to_string(&path).unwrap().contains("/* mine */"), "written either way");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A copy `corten fmt` laid out with the app's `rustfmt.toml` is not an edit (#568).
    #[test]
    fn a_copy_laid_out_with_the_apps_rustfmt_settings_is_not_edited() {
        let dir = scratch("layout");
        std::fs::write(dir.join("Cargo.toml"), "[package]\nname = \"app\"\nedition = \"2024\"\n").unwrap();
        std::fs::write(dir.join("rustfmt.toml"), "max_width = 60\n").unwrap();
        let (file, path) = ("button.rs", "src/ui/button.rs");
        let kit = include_str!("../kit/button.rs");
        let stamp = stamped(kit);
        let (head, body) = stamp.split_once('\n').unwrap();
        let laid = crate::fmt::laid_out(&dir, &dir.join(path), body).expect("rustfmt runs");
        assert_ne!(laid, body, "60 columns lays it out otherwise");
        let copy = format!("{head}\n{laid}");
        let said = report(&dir, path, "button", file, &copy, kit);
        assert!(said.ends_with("as copied, laid out as the app's code, the same as the kit\n"), "{said}");
        let edited = copy.replacen("pub ", "pub(crate) ", 1);
        assert!(report(&dir, path, "button", file, &edited, kit).contains("edited here;"));
        // A member's edition from its workspace: 2021 lays out `use` lines otherwise.
        std::fs::write(
            dir.join("Cargo.toml"),
            "[package]\nname = \"app\"\nedition.workspace = true\n\n[workspace.package]\nedition = \"2021\"\n\n[workspace]\n",
        )
        .unwrap();
        assert_eq!(crate::fmt::edition(&dir).as_deref(), Some("2021"));
        std::fs::write(
            dir.join("Cargo.toml"),
            "[package]\nname = \"app\"\nedition = { workspace = true }\n\n[workspace.package]\nedition = \"2021\"\n\n[workspace]\n",
        )
        .unwrap();
        assert_eq!(crate::fmt::edition(&dir).as_deref(), Some("2021"), "the inline table too");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// `init`, `add`, `add --merge` and `add --force` write a copy, and `src/ui.rs`, laid out as
    /// the app's code, so `corten check` passes straight after them in an app whose `rustfmt.toml`
    /// differs from rustfmt's defaults, as the kit's layout is (#900).
    #[test]
    fn add_writes_a_copy_laid_out_as_the_apps_code() {
        let dir = scratch("add-layout");
        std::fs::write(dir.join("Cargo.toml"), "[package]\nname = \"app\"\nedition = \"2024\"\n").unwrap();
        std::fs::write(dir.join("rustfmt.toml"), "max_width = 60\n").unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/lib.rs"), "pub fn app() -> App {\n    App::new(url::router())\n}\n").unwrap();
        super::init(&dir, &["--kit-theme".to_string()]).unwrap();
        let path = "src/ui/button.rs";
        let stamp = stamped(include_str!("../kit/button.rs"));
        let (head, body) = stamp.split_once('\n').unwrap();
        let laid = format!("{head}\n{}", crate::fmt::laid_out(&dir, &dir.join(path), body).expect("rustfmt runs"));
        assert_ne!(laid, stamp, "60 columns lays it out otherwise");
        let read = || std::fs::read_to_string(dir.join(path)).unwrap();
        // What `corten check` runs: rustfmt with the app's settings, then `corten fmt`'s markup.
        let checked = |files: &[&str], when: &str| {
            let out = std::process::Command::new("rustfmt")
                .args(["--check", "--edition", "2024"])
                .args(files)
                .current_dir(&dir)
                .output()
                .expect("rustfmt runs");
            assert!(out.status.success(), "{when}: {}", String::from_utf8_lossy(&out.stdout));
            for file in files {
                let text = std::fs::read_to_string(dir.join(file)).unwrap();
                assert_eq!(crate::fmt::format_source(&text, 60).0, text, "{when}: {file}");
            }
        };
        checked(&["src/ui.rs"], "init");
        let add = |flag: Option<&str>| {
            super::add(&dir, &["button".to_string()].into_iter().chain(flag.map(String::from)).collect::<Vec<_>>())
        };
        add(None).unwrap();
        assert_eq!(read(), laid, "a first copy");
        checked(&["src/ui.rs", path], "a first copy");
        add(Some("--merge")).unwrap();
        assert_eq!(read(), laid, "merged again, unchanged");
        // A copy as the kit ships it, never edited (its text hashes to its stamp).
        std::fs::write(dir.join(path), &stamp).unwrap();
        add(Some("--merge")).unwrap();
        assert_eq!(read(), laid, "an unedited copy merged");
        add(Some("--force")).unwrap();
        assert_eq!(read(), laid, "replaced");
        checked(&["src/ui.rs", path], "replaced");
        std::fs::remove_dir_all(&dir).unwrap();
    }
    /// A file of the app's own it had not laid out keeps its layout when this edits it, and one
    /// rustfmt cannot lay out (a `rustfmt.toml` it cannot read) is written as it is and named once
    /// (#900).
    #[test]
    fn an_own_file_not_laid_out_and_one_rustfmt_cannot_lay_out_are_left_as_written() {
        let dir = scratch("own-layout");
        std::fs::write(dir.join("Cargo.toml"), "[package]\nname = \"app\"\nedition = \"2024\"\n").unwrap();
        let (path, was) = ("src/lib.rs", "pub mod a;\nfn  app()  {}\n");
        let edited = "pub mod a;\npub mod ui;\nfn  app()  {}\n";
        let app = vec![(path.to_string(), was.to_string())];
        let mut files = vec![(path.to_string(), edited.to_string())];
        assert_eq!(super::lay_out_own(&dir, &mut files, &app), Vec::<String>::new());
        assert_eq!(files[0].1, edited, "not laid out before, so only the edit");
        let mut files = vec![
            (path.to_string(), "pub mod a;\npub mod ui;\nfn app() {}\n".to_string()),
            ("src/x.rs".into(), "fn  x() {}\n".into()),
        ];
        super::lay_out_own(&dir, &mut files, &[(path.to_string(), "pub mod a;\nfn app() {}\n".to_string())]);
        assert_eq!(files[1].1, "fn x() {}\n", "a new file is laid out");
        std::fs::write(dir.join("rustfmt.toml"), "max_width = \"wide\"\n").unwrap();
        let stamp = stamped(include_str!("../kit/button.rs"));
        assert_eq!(super::as_apps(&dir, "src/ui/button.rs", &stamp), (stamp.clone(), false), "as shipped");
        let mut files = vec![("src/ui.rs".to_string(), "fn  ui() {}\n".to_string())];
        assert_eq!(super::lay_out_own(&dir, &mut files, &[]), ["src/ui.rs"]);
        assert_eq!(files[0].1, "fn  ui() {}\n");
        // `add` writes the copy as shipped and names it, and src/ui.rs, in one line.
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/lib.rs"), "pub fn app() -> App {\n    App::new(url::router())\n}\n").unwrap();
        super::init(&dir, &["--kit-theme".to_string()]).unwrap();
        let mut out = Vec::new();
        super::add_to(&dir, &["button".to_string()], &mut out).unwrap();
        let out = String::from_utf8(out).unwrap();
        let line = out.lines().find(|l| l.contains("rustfmt could not lay out")).unwrap_or_else(|| panic!("{out}"));
        assert!(line.contains("src/ui/button.rs, src/ui.rs"), "{line}");
        assert_eq!(std::fs::read_to_string(dir.join("src/ui/button.rs")).unwrap(), stamp);
        let said = super::not_laid_out(&["src/ui/button.rs".into(), "src/ui.rs".into()]).unwrap();
        assert!(said.contains("src/ui/button.rs, src/ui.rs") && said.contains("they are as written"), "{said}");
        assert_eq!(super::not_laid_out(&[]), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unified_shows_each_change_with_its_context() {
        let old = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\n";
        let new = old.replace("b\n", "B\n").replace("m\n", "");
        assert_eq!(unified(old, &new), "@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n d\n e\n@@ -10,5 +10,4 @@\n j\n k\n l\n-m\n n\n");
        assert_eq!(unified("x\n", "x\n"), "");
        assert_eq!(unified("", "a\n"), "@@ -0,0 +1,1 @@\n+a\n", "an empty side starts at line 0");
        assert_eq!(unified("a\n", ""), "@@ -1,1 +0,0 @@\n-a\n");
    }
}
