//! TypeScript declarations for the data scripts read, generated from the Rust types (feature
//! `types`), so handler code is type-checked against the server.
//!
//! Every value that crosses into the browser as JSON is a Rust type: a handler's arguments, a
//! typed event's fields, a feed's rows, a screen's data. Derive `ToJson` on them (which describes
//! the JSON from the same reading of `#[serde(..)]` it writes it by, see [`crate::json::schema`]),
//! list them and the app's components once, and keep the generated file in sync from a test:
//!
//! ```ignore
//! #[test]
//! fn script_types_match_the_server() {
//!     corten::types::Types::new().add::<Card>().components(views::COMPONENTS).sync(concat!(env!("CARGO_MANIFEST_DIR"), "/types/app.d.ts"));
//! }
//! ```
//!
//! `sync` rewrites the file when the Rust types changed and fails the test, so CI (which runs on
//! a clean checkout) fails until the new file is committed. The app's typed events (`#[event]`)
//! are declared as the classes of the module `corten/events`, with their fields, so a script
//! that dispatches `new RowToggled({ id, selected })` is checked against the Rust struct. Other
//! types are imported in JSDoc (`/** @typedef {import("../types/app").Card} Card */`). `tsc
//! --checkJs` then fails on a renamed or retyped field, not the page in production. Handler
//! calls are checked against the handler's own JSDoc when the crate compiles, and
//! [`Types::components`] collects any named JSON argument types those signatures use. The file
//! holds types only; the browser never loads it.
//!
//! Types describe the JSON as the server writes it (`skip_serializing_if` fields are optional,
//! `Option` is `T | null`). [`Types::json_schema`] gives the same definitions as JSON Schema,
//! for native code generators.

use std::{
    borrow::Cow,
    collections::BTreeMap,
    fmt::Write as _,
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
};

use serde_json::{Map, Value};

use crate::json::schema::{Generator, ToJsonSchema};
use crate::script::{
    __private::{HandlerType, TsType},
    EventDef,
};

/// The set of types one app sends to the browser.
pub struct Types {
    // Preserve eager registration until the first handler, when the output file matters.
    base: Declarations,
    // Replay the original order after reserving any names needed by this file's handlers.
    registrations: Vec<Registration>,
    handlers: Vec<(&'static str, HandlerType)>,
    /// Each view's class in `corten/views`, by name.
    views: BTreeMap<&'static str, &'static str>,
}

#[derive(Clone, Default)]
struct Declarations {
    generator: Generator,
    /// Each typed event's class in `corten/events`, by name.
    events: BTreeMap<&'static str, String>,
}

#[derive(Clone, Copy)]
enum Registration {
    Add(TsType, &'static str),
    Event(EventDef),
}

enum Output<'a> {
    JsonSchema,
    TypeScript(Option<&'a Path>),
}

impl Default for Types {
    fn default() -> Self {
        Self::new()
    }
}

impl Types {
    pub fn new() -> Self {
        Types { base: Declarations::default(), registrations: Vec::new(), handlers: Vec::new(), views: BTreeMap::new() }
    }

    /// Adds `T` and every type it refers to, under their Rust names. Use this for types
    /// [`Types::components`] does not already collect, such as feed rows. `T` is a type that
    /// derives `ToJson` (a declaration of its own); one that has none, such as `Vec<Row>` or
    /// `String`, panics: add the type it holds instead. So does a type with a field, at any depth,
    /// whose type has no schema ([`crate::json::schema`]). After handler arguments have been
    /// collected, those checks wait until the declarations are generated.
    pub fn add<T: ToJsonSchema>(mut self) -> Self {
        self.register(Registration::Add(T::json_schema, std::any::type_name::<T>()));
        self
    }

    fn register(&mut self, entry: Registration) {
        if self.handlers.is_empty() {
            self.base.register(entry);
        }
        self.registrations.push(entry);
    }

    /// Adds the typed events among the app's components (the list it gives `App::components`)
    /// and those their scripts import, to `corten/events`, with the types of their fields, and the
    /// views (`#[component(view)]`) to `corten/views`. Also adds the named `ToJson` types the
    /// scripts' checked handler parameters use, and the types those refer to.
    /// [`Types::sync`] skips a handler only if its import resolves to a different file. TypeScript
    /// generation panics if a checked handler imports a different name from the one assigned to its
    /// Rust type.
    pub fn components(mut self, components: &[crate::Component]) -> Self {
        for view in components.iter().filter_map(|c| c.view) {
            self.views.insert(view.class, view.ts);
        }
        for script in components.iter().filter_map(|c| c.script.as_ref()) {
            self.handlers.extend(script.types.iter().map(|ty| (script.file, *ty)));
        }
        let imported = components.iter().filter_map(|c| c.script).flat_map(|s| s.events);
        for event in components.iter().chain(imported).filter_map(|c| c.event) {
            self.register(Registration::Event(event));
        }
        self
    }

    fn declarations(&self, output: Output<'_>) -> Cow<'_, Declarations> {
        if self.handlers.is_empty() {
            return Cow::Borrowed(&self.base);
        }
        let (target, check_names) = match output {
            Output::JsonSchema => (None, false),
            Output::TypeScript(path) => (path.and_then(|path| fs::canonicalize(path).ok()), true),
        };
        let mut out = Declarations::default();
        for &(file, (name, import, describe)) in &self.handlers {
            if target
                .as_ref()
                .is_some_and(|target| import.and_then(resolve_declarations_import).is_some_and(|path| path != *target))
            {
                continue;
            }
            if check_names {
                out.add_handler(file, name, describe);
            } else {
                describe(&mut out.generator);
            }
        }
        for &entry in &self.registrations {
            out.register(entry);
        }
        Cow::Owned(out)
    }

    /// Every definition as JSON Schema (draft 2020-12): `{"$defs": {...}}`.
    pub fn json_schema(&self) -> Value {
        let defs: Map<String, Value> = self.declarations(Output::JsonSchema).definitions().into_iter().collect();
        serde_json::json!({ "$schema": "https://json-schema.org/draft/2020-12/schema", "$defs": defs })
    }

    /// All collected declarations as one file: one `export` per type, in name order.
    pub fn typescript(&self) -> String {
        self.typescript_for(None)
    }

    fn typescript_for(&self, path: Option<&Path>) -> String {
        let declarations = self.declarations(Output::TypeScript(path));
        let mut out = String::from(
            "// Generated by corten::types from the Rust types; do not edit. The test that calls\n// Types::sync rewrites this file when they change.\n",
        );
        let mut blocks = BTreeMap::new();
        for (name, schema) in declarations.definitions() {
            let mut block = String::new();
            if let Some(text) = schema.get("description").and_then(Value::as_str) {
                doc(&mut block, "", text);
            }
            let is_interface = schema.get("type") == Some(&Value::from("object"))
                && schema.get("properties").is_some()
                && schema.get("additionalProperties").is_none_or(|v| v == &Value::Bool(false));
            if is_interface {
                let _ = writeln!(block, "export interface {name} {}", object(&schema, ""));
            } else {
                let _ = writeln!(block, "export type {name} = {};", ts(&schema, ""));
            }
            blocks.insert(name, block);
        }
        for block in blocks.values() {
            out.push('\n');
            out.push_str(block);
        }
        if !declarations.events.is_empty() {
            out.push_str("\n/** The app's typed events (#[event]), dispatched by scripts and listened for with on:Name. */\ndeclare module \"corten/events\" {\n");
            for entry in declarations.events.values() {
                out.push_str(entry);
            }
            out.push_str("}\n");
        }
        if !self.views.is_empty() {
            out.push_str("\n/** The app's views (#[component(view)]): each one's holes, read from and written to the page. */\ndeclare module \"corten/views\" {\n");
            for ts in self.views.values() {
                out.push_str(ts);
            }
            out.push_str("}\n");
        }
        if !declarations.events.is_empty() || !self.views.is_empty() {
            out.push_str("\nexport {};\n");
        }
        out
    }

    /// Writes the declarations to `path` when they differ from what is there, and then panics
    /// with the file name, so a test that calls it fails until the new file is committed.
    /// Handler arguments are checked here unless their import resolves to a different file. Line
    /// endings do not count: a checkout that writes the file with CRLF (Git's `core.autocrlf`
    /// on Windows) has it as committed.
    pub fn sync(&self, path: impl AsRef<Path>) {
        let path = path.as_ref();
        let text = self.typescript_for(Some(path));
        if fs::read_to_string(path).is_ok_and(|was| was.replace("\r\n", "\n") == text) {
            return;
        }
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).expect("create the types directory");
        }
        fs::write(path, &text).expect("write the types file");
        panic!(
            "{} was out of date with the app's Rust types, or with how this Corten release declares them, and has been rewritten; run npm run check and commit it",
            path.display()
        );
    }
}

impl Declarations {
    fn register(&mut self, entry: Registration) {
        match entry {
            Registration::Add(describe, name) => {
                self.add_schema(describe, &format!("Types::add::<{name}>()"));
            }
            Registration::Event(event) => self.add_event(event),
        }
    }

    fn add_handler(&mut self, file: &str, name: &str, describe: TsType) {
        let source = format!("{file}: handler argument {name}");
        let schema = self.add_schema(describe, &source);
        let declared = schema["$ref"]
            .as_str()
            .and_then(|reference| reference.strip_prefix("#/$defs/"))
            .filter(|declared| self.generator.has_definition(declared))
            .unwrap_or_else(|| panic!("{source}: the Rust type's schema has no local declaration ({})", schema["$ref"]));
        assert!(
            declared == name,
            "{source} resolves to `{declared}` instead of `{name}`; use an unambiguous Rust type name and import its generated declaration in JSDoc"
        );
    }

    fn add_schema(&mut self, describe: TsType, source: &str) -> Value {
        let schema = describe(&mut self.generator);
        self.generator.missing(source);
        assert!(schema.get("$ref").is_some(), "{source}: the type has no declaration of its own; use a type that derives ToJson");
        schema
    }

    fn add_event(&mut self, event: EventDef) {
        let mut fields = String::new();
        let mut init = Vec::new();
        for field in event.fields {
            let schema = (field.ts)(&mut self.generator);
            let ty = ts(&schema, "    ");
            let _ = write!(fields, "\n    readonly {}: {ty};", field.name);
            init.push(format!("{}: {ty}", field.name));
        }
        let init = if init.is_empty() { "init?: {}".to_string() } else { format!("init: {{ {} }}", init.join("; ")) };
        let entry = format!(
            "  /** The `{}` event, from #[event] {}. */\n  export class {} extends Event {{\n    constructor({init});{fields}\n  }}\n",
            event.name, event.class, event.class
        );
        self.events.insert(event.class, entry);
    }

    /// Every definition, after checking that each field met (an event's too) has a schema.
    fn definitions(&self) -> BTreeMap<String, Value> {
        self.generator.missing("corten::types");
        self.generator.definitions()
    }
}

/// For an extensionless import, TypeScript tries the declaration file before the index.
/// If we cannot identify the file on disk, the handler must still be checked.
fn resolve_declarations_import(import: &str) -> Option<PathBuf> {
    // TypeScript removes `dir/..` from the path before it looks on disk, so a symlinked `dir`
    // does not change which file `..` names.
    let lexical = lexically_normal(Path::new(import));
    let path = lexical.as_path();
    let index;
    let candidate = if import.ends_with(".d.ts") {
        path
    } else {
        let file = path.with_extension("d.ts");
        match fs::metadata(&file) {
            Ok(metadata) if metadata.is_file() => return fs::canonicalize(file).ok(),
            Err(error) if error.kind() != ErrorKind::NotFound => return None,
            _ => {}
        }
        index = path.join("index.d.ts");
        &index
    };
    if !fs::metadata(candidate).ok()?.is_file() {
        return None;
    }
    fs::canonicalize(candidate).ok()
}

/// `path` with `.` dropped and each `name/..` folded away, without reading the disk.
fn lexically_normal(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir if out.file_name().is_some() => {
                out.pop();
            }
            Component::ParentDir if out.has_root() => {}
            // Appended as text: `PathBuf::push` would read an interior `D:foo` as a new drive
            // on Windows, where TypeScript reads it as one more directory name.
            Component::Normal(name) if out.file_name().is_some() || out.ends_with("..") => {
                let text = out.as_mut_os_string();
                text.push(std::path::MAIN_SEPARATOR_STR);
                text.push(name);
            }
            other => out.push(other),
        }
    }
    out
}

fn doc(out: &mut String, indent: &str, text: &str) {
    let text = text.replace("*/", "*\\/");
    if text.contains('\n') {
        let _ = writeln!(out, "{indent}/**");
        for line in text.lines() {
            let _ = writeln!(out, "{indent} * {line}");
        }
        let _ = writeln!(out, "{indent} */");
    } else {
        let _ = writeln!(out, "{indent}/** {text} */");
    }
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

fn object(schema: &Value, indent: &str) -> String {
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let inner = format!("{indent}  ");
    let mut out = String::from("{\n");
    if let Some(Value::Object(properties)) = schema.get("properties") {
        for (name, property) in properties {
            if let Some(text) = property.get("description").and_then(Value::as_str) {
                doc(&mut out, &inner, text);
            }
            let key = if is_identifier(name) { name.clone() } else { serde_json::to_string(name).expect("a string serializes") };
            let optional = if required.contains(&name.as_str()) { "" } else { "?" };
            let _ = writeln!(out, "{inner}{key}{optional}: {};", ts(property, &inner));
        }
    }
    match schema.get("additionalProperties") {
        Some(Value::Bool(false)) | None => {}
        Some(Value::Bool(true)) => {
            let _ = writeln!(out, "{inner}[key: string]: unknown;");
        }
        Some(value) => {
            let _ = writeln!(out, "{inner}[key: string]: {};", ts(value, &inner));
        }
    }
    out.push_str(indent);
    out.push('}');
    out
}

/// One schema as a TypeScript type. Covers what [`crate::json::schema`] describes.
fn ts(schema: &Value, indent: &str) -> String {
    let schema = match schema {
        Value::Bool(true) => return "unknown".into(),
        Value::Bool(false) => return "never".into(),
        Value::Object(map) => map,
        _ => return "unknown".into(),
    };
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        return reference.rsplit('/').next().unwrap_or("unknown").to_string();
    }
    if let Some(value) = schema.get("const") {
        return serde_json::to_string(value).expect("JSON serializes");
    }
    if let Some(Value::Array(values)) = schema.get("enum") {
        return union(values.iter().map(|v| serde_json::to_string(v).expect("JSON serializes")).collect());
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(Value::Array(options)) = schema.get(key) {
            return union(options.iter().map(|o| ts(o, indent)).collect());
        }
    }
    if let Some(Value::Array(parts)) = schema.get("allOf") {
        return parts.iter().map(|p| ts(p, indent)).collect::<Vec<_>>().join(" & ");
    }
    let one = |kind: &str| -> String {
        match kind {
            "string" => "string".into(),
            "integer" | "number" => "number".into(),
            "boolean" => "boolean".into(),
            "null" => "null".into(),
            "array" => match (schema.get("prefixItems"), schema.get("items")) {
                (Some(Value::Array(items)), _) => {
                    format!("[{}]", items.iter().map(|i| ts(i, indent)).collect::<Vec<_>>().join(", "))
                }
                (_, Some(items)) => {
                    let item = ts(items, indent);
                    if item.contains(' ') {
                        format!("({item})[]")
                    } else {
                        format!("{item}[]")
                    }
                }
                _ => "unknown[]".into(),
            },
            "object" => {
                if schema.get("properties").is_some() {
                    object(&Value::Object(schema.clone()), indent)
                } else {
                    match schema.get("additionalProperties") {
                        Some(Value::Bool(false)) => "Record<string, never>".into(),
                        Some(value) if value != &Value::Bool(true) => format!("Record<string, {}>", ts(value, indent)),
                        _ => "Record<string, unknown>".into(),
                    }
                }
            }
            _ => "unknown".into(),
        }
    };
    match schema.get("type") {
        Some(Value::String(kind)) => one(kind),
        Some(Value::Array(kinds)) => union(kinds.iter().filter_map(Value::as_str).map(one).collect()),
        _ => "unknown".into(),
    }
}

fn union(mut parts: Vec<String>) -> String {
    parts.dedup();
    match parts.len() {
        0 => "never".into(),
        1 => parts.remove(0),
        _ => parts.join(" | "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::ToJson;

    const APP_DECLARATIONS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/type_tests/types/app.d.ts");
    const LIBRARY_DECLARATIONS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/type_tests/library/types/app.d.ts");

    /// A card on the watchlist.
    #[derive(ToJson)]
    #[allow(dead_code)]
    struct Card {
        id: String,
        /// Price in cents.
        price_cents: u32,
        rating: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<String>,
        tags: Vec<String>,
        kind: Kind,
        grades: BTreeMap<String, f64>,
        pair: (u8, String),
        #[serde(rename = "data-x")]
        data_x: bool,
    }

    #[derive(ToJson)]
    #[serde(rename_all = "snake_case")]
    #[allow(dead_code)]
    enum Kind {
        Single,
        SealedBox,
    }

    #[derive(ToJson)]
    #[serde(tag = "op", rename_all = "lowercase")]
    #[allow(dead_code)]
    enum Change {
        Upsert { id: String, value: Card },
        Remove { id: String },
    }

    #[crate::component(js)]
    #[allow(dead_code)]
    fn ReportChange(change: Change) -> impl crate::Render {
        crate::html! { <button type="button" on:click={js::report(change)}>"Report"</button> }
    }

    #[crate::component(js)]
    #[allow(dead_code)]
    fn ConfirmChange(change: Change) -> impl crate::Render {
        let button = refs();
        crate::html! {
            <button type="button" ref={button} on:click={js::confirm(js::Confirmation { button, change })}>"Confirm"</button>
        }
    }

    #[test]
    fn component_handler_arguments_declare_their_types() {
        let report = Types::new().components(&[ReportChange]);
        let types = report.typescript();
        assert!(types.contains("export type Change = "), "{types}");
        assert!(types.contains("value: Card;"), "{types}");
        assert!(types.contains("export interface Card {"), "{types}");
        assert!(types.contains("export type Kind = "), "{types}");
        assert_eq!(Types::new().components(&[ConfirmChange]).typescript(), types);
        assert_eq!(Types::new().components(&[ReportChange, ConfirmChange]).typescript(), types);
        assert_eq!(Types::new().add::<Change>().components(&[ReportChange, ConfirmChange]).typescript(), types);
        assert_eq!(Types::new().components(&[ReportChange, ConfirmChange]).add::<Change>().typescript(), types);
        report.sync(APP_DECLARATIONS);
    }

    mod alternative {
        #[derive(crate::ToJson)]
        pub(super) struct Change {
            applied: bool,
        }

        #[crate::component(js)]
        #[allow(dead_code)]
        pub(super) fn AlternativeChange(change: Change) -> impl crate::Render {
            crate::html! { <button type="button" on:click={js::report(change)}>"Report"</button> }
        }
    }

    mod library {
        #[derive(crate::ToJson)]
        pub(super) struct Change {
            applied: bool,
        }

        #[crate::script::event]
        #[allow(dead_code)]
        pub(super) struct LibraryChanged {
            change: Change,
        }

        crate::script::script!(mod report = "type_tests/library/src/library_change.js");

        // Model the served names of a component crate with a scripts prefix.
        const SCRIPT: crate::Script = crate::Script { name: "library.library_change", ..report::COMPONENT.script.unwrap() };
        pub(super) const REPORT: crate::Component =
            crate::Component { name: SCRIPT.name, script: Some(SCRIPT), ..report::COMPONENT };
    }

    #[test]
    fn a_prefixed_library_can_generate_its_own_handler_declarations() {
        let combined = Types::new().components(&[ConfirmChange, library::REPORT]);
        combined.sync(APP_DECLARATIONS);
        combined.sync(LIBRARY_DECLARATIONS);
        Types::new().components(&[library::REPORT]).components(&[ConfirmChange]).sync(APP_DECLARATIONS);
        Types::new().components(&[library::REPORT]).sync(LIBRARY_DECLARATIONS);
    }

    #[test]
    fn a_handler_import_resolves_to_the_file_before_the_directory_index() {
        let dir = crate::tests::Scratch::new("types-index");
        let import = dir.join("types/app");
        let direct = import.with_extension("d.ts");
        let index = import.join("index.d.ts");
        let component = confirm_change_importing(&import);
        let with_handler = Types::new().components(&[component]);

        std::fs::create_dir_all(&import).unwrap();
        std::fs::write(&index, with_handler.typescript()).unwrap();
        with_handler.sync(&index);

        std::fs::write(&direct, with_handler.typescript()).unwrap();
        let without_handler = Types::new().add::<library::Change>();
        std::fs::write(&index, without_handler.typescript()).unwrap();
        with_handler.sync(&direct);
        Types::new().add::<library::Change>().components(&[component]).sync(&index);
    }

    #[test]
    fn a_handler_import_folds_dot_dot_before_following_a_symlink() {
        assert_eq!(lexically_normal(Path::new("/a/./b/../c")), Path::new("/a/c"));
        assert_eq!(lexically_normal(Path::new("/../a")), Path::new("/a"));
        assert_eq!(lexically_normal(Path::new("../a/../../b")), Path::new("../../b"));
        #[cfg(windows)]
        assert_eq!(lexically_normal(Path::new(r"C:\src\D:foo\..\types\app")), Path::new(r"C:\src\types\app"));
        #[cfg(unix)]
        {
            let dir = crate::tests::Scratch::new("types-symlink");
            let lexical = dir.join("types/app.d.ts");
            let through_link = dir.join("real/types/app.d.ts");
            std::fs::create_dir_all(lexical.parent().unwrap()).unwrap();
            std::fs::create_dir_all(dir.join("real/sub")).unwrap();
            std::fs::create_dir_all(through_link.parent().unwrap()).unwrap();
            std::fs::write(&lexical, "").unwrap();
            std::fs::write(&through_link, "").unwrap();
            std::os::unix::fs::symlink(dir.join("real/sub"), dir.join("link")).unwrap();
            let import = dir.join("link/../types/app");
            let resolved = resolve_declarations_import(import.to_str().unwrap());
            assert_eq!(resolved, Some(std::fs::canonicalize(&lexical).unwrap()));
        }
    }

    fn confirm_change_importing(import: &Path) -> crate::Component {
        let mut script = ConfirmChange.script.unwrap();
        let (name, _, describe) = script.types[0];
        let path: &str = Box::leak(import.to_str().unwrap().to_owned().into_boxed_str());
        script.types = Box::leak(Box::new([(name, Some(path), describe)]));
        crate::Component { script: Some(script), ..ConfirmChange }
    }

    #[test]
    fn a_first_sync_checks_handlers_even_when_the_target_does_not_exist() {
        let dir = crate::tests::Scratch::new("types-first-sync");
        let target = dir.join("types/app.d.ts");
        let types = Types::new().components(&[ConfirmChange]);
        let stale = std::panic::catch_unwind(|| types.sync(&target));
        assert!(stale.is_err(), "a missing file fails once");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), types.typescript());

        let unresolved = confirm_change_importing(&dir.join("elsewhere/types/app"));
        Types::new().components(&[unresolved]).sync(&target);
    }

    #[test]
    fn events_keep_their_names_before_explicit_adds_without_an_in_file_handler() {
        let types = Types::new().components(&[library::LibraryChanged]).add::<Change>();
        let ts = types.typescript();
        assert!(ts.contains("export interface Change {\n  applied: boolean;"), "{ts}");
        assert!(ts.contains("export type Change2 = "), "{ts}");
        assert!(ts.contains("readonly change: Change;"), "{ts}");
        let schema = types.json_schema();
        assert_eq!(schema["$defs"]["Change"]["properties"]["applied"]["type"], "boolean", "{schema}");
        assert!(schema["$defs"]["Change2"]["oneOf"].is_array(), "{schema}");

        let with_external_handler = Types::new().components(&[library::LibraryChanged, library::REPORT]).add::<Change>();
        assert_eq!(with_external_handler.typescript_for(Some(Path::new(APP_DECLARATIONS))), ts);
    }

    #[cfg(windows)]
    #[test]
    fn a_handler_import_matches_a_windows_path_in_a_different_case() {
        let target = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/type_tests\\TYPES/App.d.ts"));
        let types = Types::new().components(&[ConfirmChange]);
        assert_eq!(types.typescript_for(Some(target)), types.typescript());
    }

    #[cfg(windows)]
    #[test]
    fn a_handler_import_matches_a_windows_verbatim_target() {
        let target = std::fs::canonicalize(APP_DECLARATIONS).unwrap();
        let types = Types::new().components(&[ConfirmChange]);
        assert_eq!(types.typescript_for(Some(&target)), types.typescript());
        types.sync(&target);
    }

    #[test]
    fn an_in_file_handler_claims_its_name_before_an_event_field() {
        let combined = Types::new().components(&[library::LibraryChanged]).components(&[library::REPORT, ConfirmChange]);
        let app = combined.typescript_for(Some(Path::new(APP_DECLARATIONS)));
        assert!(app.contains("export type Change = "), "{app}");
        assert!(app.contains("export interface Change2 {\n  applied: boolean;"), "{app}");
        assert!(app.contains("readonly change: Change2;"), "{app}");

        let library = combined.typescript_for(Some(Path::new(LIBRARY_DECLARATIONS)));
        assert!(library.contains("export interface Change {\n  applied: boolean;"), "{library}");
        assert!(library.contains("readonly change: Change;"), "{library}");
        assert!(!library.contains("Change2"), "{library}");
    }

    #[test]
    fn json_schema_exports_both_handler_types_with_the_same_name() {
        let combined = Types::new().components(&[ConfirmChange, library::REPORT]);
        let schema = combined.json_schema();
        assert!(schema["$defs"]["Change"]["oneOf"].is_array(), "{schema}");
        assert_eq!(schema["$defs"]["Change2"]["properties"]["applied"]["type"], "boolean", "{schema}");
    }

    #[test]
    fn same_named_handler_types_are_refused_in_either_order() {
        for (first, second, file) in [
            (ConfirmChange, alternative::AlternativeChange, "alternative_change.js"),
            (alternative::AlternativeChange, ConfirmChange, "confirm_change.js"),
        ] {
            let expected = format!("{file}: handler argument Change resolves to `Change2` instead of `Change`");
            assert_type_error(|| Types::new().components(&[first, second]).typescript(), &expected);
            assert_type_error(
                || Types::new().components(&[first, second]).typescript_for(Some(Path::new(APP_DECLARATIONS))),
                &expected,
            );
        }
    }

    #[test]
    fn a_handler_claims_its_name_before_an_added_or_nested_type() {
        #[derive(ToJson)]
        struct Envelope {
            change: alternative::Change,
        }

        let declarations = Types::new().components(&[ConfirmChange]).add::<Envelope>().typescript();
        assert!(declarations.contains("export type Change = "), "{declarations}");
        assert!(declarations.contains("export interface Change2 {\n  applied: boolean;"), "{declarations}");
        assert!(declarations.contains("change: Change2;"), "{declarations}");
        assert_eq!(Types::new().add::<Envelope>().components(&[ConfirmChange]).typescript(), declarations);
        assert_eq!(
            Types::new().add::<alternative::Change>().components(&[ConfirmChange]).typescript(),
            Types::new().components(&[ConfirmChange]).add::<alternative::Change>().typescript(),
        );
    }

    mod renamed {
        type Change = super::Card;

        #[crate::component(js)]
        #[allow(dead_code)]
        pub(super) fn AliasedChange(change: Change) -> impl crate::Render {
            crate::html! { <button type="button" on:click={js::report(change)}>"Report"</button> }
        }
    }

    #[test]
    fn a_renamed_handler_type_does_not_declare_an_alias() {
        assert_type_error(
            || Types::new().components(&[renamed::AliasedChange]).typescript(),
            "aliased_change.js: handler argument Change resolves to `Card` instead of `Change`",
        );
    }

    fn assert_type_error(generate: impl FnOnce() -> String + std::panic::UnwindSafe, expected: &str) {
        let error = std::panic::catch_unwind(generate).expect_err("declaration generation should fail");
        let message = error.downcast_ref::<String>().expect("a formatted diagnostic");
        assert!(message.contains(expected), "{message}");
    }

    #[test]
    fn declarations_follow_the_json_the_server_writes() {
        let ts = Types::new().add::<Change>().typescript();
        let expected = r#"
/** A card on the watchlist. */
export interface Card {
  "data-x": boolean;
  grades: Record<string, number>;
  id: string;
  kind: Kind;
  note?: string | null;
  pair: [number, string];
  /** Price in cents. */
  price_cents: number;
  rating: string | null;
  tags: string[];
}

export type Change = {
  id: string;
  op: "upsert";
  value: Card;
} | {
  id: string;
  op: "remove";
};

export type Kind = "single" | "sealed_box";
"#;
        let body = ts.split_once("change.\n").map(|(_, rest)| rest).unwrap_or(&ts);
        assert_eq!(body, expected, "{ts}");
        // A doc comment on the type becomes the declaration's doc comment.
        assert!(Types::new().add::<Card>().typescript().contains("/** A card on the watchlist. */\nexport interface Card {"));
        assert!(Types::new().add::<Card>().json_schema()["$defs"]["Kind"]["enum"].is_array());
    }

    /// A calendar day is its text in a row's declaration.
    #[test]
    fn a_day_is_a_string() {
        #[derive(ToJson)]
        #[allow(dead_code)]
        struct Week {
            start: crate::i18n::Day,
            end: Option<crate::i18n::Day>,
        }
        let ts = Types::new().add::<Week>().typescript();
        assert!(ts.contains("end: string | null;\n  start: string;"), "{ts}");
    }

    /// A card was picked (named apart from the script tests' `RowToggled`: one event of a name per program).
    #[crate::script::event]
    #[allow(dead_code)]
    struct CardPicked {
        id: String,
        kind: Kind,
    }

    #[test]
    fn typed_events_declare_their_classes() {
        let ts = Types::new().components(&[CardPicked]).typescript();
        let expected = r#"
/** The app's typed events (#[event]), dispatched by scripts and listened for with on:Name. */
declare module "corten/events" {
  /** The `card-picked` event, from #[event] CardPicked. */
  export class CardPicked extends Event {
    constructor(init: { id: string; kind: Kind });
    readonly id: string;
    readonly kind: Kind;
  }
}

export {};
"#;
        assert!(ts.ends_with(expected), "{ts}");
        assert!(ts.contains("export type Kind = "), "a field's type is declared with the rest: {ts}");
    }

    /// A price, shown by a view.
    #[crate::component(view)]
    #[allow(dead_code)]
    fn PriceTag(cents: u32) -> impl crate::Render {
        crate::html! { <b>{cents}</b> }
    }

    /// The app's file declares its own view classes only: `rows()`, `view()` and the types they
    /// take are the runtime's, in the `js/views.d.ts` that ships with the crate, so a release
    /// that changes them changes no app's file (#1020).
    #[test]
    fn views_declare_the_app_s_classes_and_not_the_runtime_s() {
        let ts = Types::new().components(&[PriceTag]).typescript();
        assert!(ts.contains("declare module \"corten/views\" {\n") && ts.contains("\n  export class PriceTag {\n"), "{ts}");
        let runtime = include_str!("../js/views.d.ts");
        for name in [
            "interface KeylessViewClass",
            "interface ViewClass",
            "type Holds",
            "function rows",
            "function view",
            "interface Rows",
        ] {
            assert!(!ts.contains(name), "{name} is the runtime's: {ts}");
            assert!(runtime.contains(&format!("export {name}")), "js/views.d.ts declares {name}");
        }
    }

    #[test]
    #[should_panic(expected = "the type has no declaration of its own")]
    fn a_type_without_a_declaration_of_its_own_is_refused() {
        let _ = Types::new().add::<Vec<Card>>();
    }

    #[test]
    fn sync_rewrites_a_stale_file_and_fails_then_passes() {
        let dir = crate::tests::Scratch::new("types");
        let path = dir.join("app.d.ts");
        let types = Types::new().add::<Card>();
        let stale = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| types.sync(&path)));
        assert!(stale.is_err(), "a missing file fails once");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), types.typescript());
        types.sync(&path);
        // A checkout with CRLF line endings (`core.autocrlf`) is the same file (#600).
        std::fs::write(&path, types.typescript().replace('\n', "\r\n")).unwrap();
        types.sync(&path);
        assert!(std::fs::read_to_string(&path).unwrap().contains("\r\n"), "left as it was");
        // CRLF does not hide a real change.
        std::fs::write(&path, "stale\r\n").unwrap();
        let crlf_stale = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| types.sync(&path)));
        assert!(crlf_stale.is_err(), "a CRLF file of other text is stale");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), types.typescript());
    }
}
