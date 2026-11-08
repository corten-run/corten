//! JSON Schema (draft 2020-12) of the JSON a type writes ([`ToJsonSchema`]) or reads
//! ([`FromJsonSchema`]), from the same reading of `#[serde(..)]` that `#[derive(ToJson)]` and
//! `#[derive(FromJson)]` lay the bytes out with, so a description cannot disagree with the
//! JSON. `corten::types` writes TypeScript from it and `corten::agent` gives it to agents as a tool's
//! `inputSchema` and `outputSchema`.
//!
//! A type the derives describe is named under `$defs` and referred to by `$ref`; a recursive
//! type refers to itself the same way.
//!
//! A derived type may hold a field of any type serde writes or reads (another crate's, through
//! serde), so the derives compile for it. Describing such a type fails instead, at startup or in
//! the test that writes the declarations: [`crate::types::Types`] and an MCP tool's schemas panic
//! naming each field type with no schema, so a description never says less than the JSON. For
//! another crate's type, implement the trait for a `#[serde(transparent)]` newtype around it.
//!
//! ```should_panic
//! #[derive(serde::Serialize)]
//! struct Foreign { at: String }
//! #[derive(serde::Serialize, corten::ToJson)]
//! struct Row { when: Foreign }
//! let _ = corten::types::Types::new().add::<Row>();
//! ```
//!
//! [`crate::types::Types::add`] takes a type with a written schema:
//!
//! ```compile_fail,E0277
//! #[derive(serde::Serialize)]
//! struct Row { at: String }
//! let _ = corten::types::Types::new().add::<Row>();
//! ```

use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque},
    rc::Rc,
    sync::Arc,
};

use serde_json::{json, Map, Value};

/// The schema of the JSON a type writes: what `#[derive(ToJson)]` implements (feature `types`).
#[diagnostic::on_unimplemented(
    message = "`{Self}` has no JSON Schema for what it writes",
    note = "derive ToJson on it; for another crate's type, implement ToJsonSchema for a #[serde(transparent)] newtype around it"
)]
pub trait ToJsonSchema {
    /// The schema, or a `$ref` to it after adding it to `generator`'s definitions.
    fn json_schema(generator: &mut Generator) -> Value;

    /// The schema itself, never a `$ref`: what a `#[serde(flatten)]` field adds. Not a public API.
    #[doc(hidden)]
    fn __inline(generator: &mut Generator) -> Value {
        let schema = Self::json_schema(generator);
        generator.resolve(&schema).clone()
    }
}

/// The schema of the JSON a type reads: what `#[derive(FromJson)]` implements (feature `types`).
#[diagnostic::on_unimplemented(
    message = "`{Self}` has no JSON Schema for what it reads",
    note = "derive FromJson on it (a generic Fields or UrlValue type, which cannot, implements FromJsonSchema by hand); for another crate's type, implement FromJsonSchema for a #[serde(transparent)] newtype around it"
)]
pub trait FromJsonSchema {
    /// The schema, or a `$ref` to it after adding it to `generator`'s definitions.
    fn json_schema(generator: &mut Generator) -> Value;

    /// The schema itself, never a `$ref`. Not a public API.
    #[doc(hidden)]
    fn __inline(generator: &mut Generator) -> Value {
        let schema = Self::json_schema(generator);
        generator.resolve(&schema).clone()
    }

    /// Whether a field of this type may be left out when read (an `Option`, which serde reads as
    /// `None`). Not a public API.
    #[doc(hidden)]
    fn __optional() -> bool {
        false
    }
}

/// The definitions the schemas of one document refer to (`$defs`), named after their Rust
/// types; a second type of one name (two instances of a generic) is numbered, `Name2`.
#[derive(Default)]
pub struct Generator {
    /// By the side (`true` for what is read) and the type's id: its name.
    by_id: HashMap<(bool, &'static str), String>,
    /// By name: the schema once made (`None` while it is being made).
    defs: BTreeMap<String, Option<Value>>,
    /// Field types met with no schema for the side they were asked for (`true` for read).
    missing: BTreeSet<(&'static str, bool)>,
}

impl Generator {
    pub fn new() -> Self {
        Self::default()
    }

    /// A `$ref` to the type `id` names (its Rust path and arguments) as it is read (`read`) or
    /// written, made by `make` under `name` the first time. A type described on both sides in one
    /// document has two definitions (`Name` and `Name2`). Not a public API: what the derives call.
    #[doc(hidden)]
    pub fn define(&mut self, read: bool, id: &'static str, name: &str, make: impl FnOnce(&mut Generator) -> Value) -> Value {
        if let Some(name) = self.by_id.get(&(read, id)) {
            return reference(name);
        }
        let mut unique = name.to_string();
        let mut n = 2;
        while self.defs.contains_key(&unique) {
            unique = format!("{name}{n}");
            n += 1;
        }
        self.by_id.insert((read, id), unique.clone());
        self.defs.insert(unique.clone(), None);
        let schema = make(self);
        self.defs.insert(unique.clone(), Some(schema));
        reference(&unique)
    }

    /// Records a field type with no schema on the side asked for. Not a public API.
    #[doc(hidden)]
    pub fn miss(&mut self, ty: &'static str, read: bool) -> Value {
        self.missing.insert((ty, read));
        Value::Bool(true)
    }

    /// Panics, naming them, when a field met so far has a type with no schema for its side: a
    /// description that said only "any JSON" there would say less than the JSON. `what` names the
    /// document for the message.
    pub fn missing(&self, what: &str) {
        if self.missing.is_empty() {
            return;
        }
        let list = |read: bool| self.missing.iter().filter(|m| m.1 == read).map(|m| m.0).collect::<Vec<_>>().join(", ");
        let (written, read) = (list(false), list(true));
        let mut why = format!("{what}: fields of types with no JSON Schema:");
        if !written.is_empty() {
            why.push_str(&format!(" written {written} (needs ToJson derived or ToJsonSchema implemented)"));
        }
        if !read.is_empty() {
            why.push_str(&format!(" read {read} (needs FromJson derived, which a Fields or UrlValue type already is unless generic, or FromJsonSchema implemented)"));
        }
        why.push_str(
            ". Each type named, or one inside it (`Foreign` in `Option<Foreign>`), lacks it: for another \
             crate's type, implement it for a #[serde(transparent)] newtype around the type. In a \
             generic type, a field type that has it only under a bound the type does not declare \
             (`Cow<'a, [T]>` needs `T: Clone`) is named here too: add that bound to the type's where \
             clause",
        );
        panic!("{why}");
    }

    /// Every definition made, by name. Panics as [`Generator::missing`] does.
    pub fn definitions(&self) -> BTreeMap<String, Value> {
        self.missing("Generator::definitions");
        self.defs.iter().filter_map(|(name, schema)| Some((name.clone(), schema.clone()?))).collect()
    }

    /// The definition a `$ref` names.
    pub fn resolve<'a>(&'a self, schema: &'a Value) -> &'a Value {
        match schema.get("$ref").and_then(Value::as_str).and_then(|r| r.strip_prefix("#/$defs/")) {
            Some(name) => self.defs.get(name).and_then(Option::as_ref).unwrap_or(schema),
            None => schema,
        }
    }

    /// `T` as the root of a document (an MCP tool's schema): its definition itself, with
    /// `$defs` for the types it refers to. Panics as [`Generator::missing`] does.
    pub fn root_for_write<T: ToJsonSchema + ?Sized>() -> Value {
        let mut generator = Generator::new();
        let schema = T::json_schema(&mut generator);
        generator.missing(core::any::type_name::<T>());
        generator.root(schema)
    }

    /// [`Generator::root_for_write`] for what `T` reads.
    pub fn root_for_read<T: FromJsonSchema + ?Sized>() -> Value {
        let mut generator = Generator::new();
        let schema = T::json_schema(&mut generator);
        generator.missing(core::any::type_name::<T>());
        generator.root(schema)
    }

    fn root(mut self, schema: Value) -> Value {
        let name = schema.get("$ref").and_then(Value::as_str).and_then(|r| r.strip_prefix("#/$defs/")).map(str::to_string);
        let mut root = match &name {
            // The root's definition is the document itself; a recursive type refers to it as `#`.
            Some(name) => {
                let mut root = self.defs.remove(name).flatten().unwrap_or(schema);
                let from = Value::String(format!("#/$defs/{name}"));
                rewrite(&mut root, &from);
                for def in self.defs.values_mut().flatten() {
                    rewrite(def, &from);
                }
                root
            }
            None => schema,
        };
        let defs: Map<String, Value> = self.defs.into_iter().filter_map(|(k, v)| Some((k, v?))).collect();
        if !defs.is_empty() {
            if let Value::Object(map) = &mut root {
                map.insert("$defs".into(), Value::Object(defs));
            }
        }
        root
    }
}

/// Every `$ref` to `from` in `schema` made a `$ref` to the document's root.
fn rewrite(schema: &mut Value, from: &Value) {
    match schema {
        Value::Object(map) => {
            for (key, value) in map.iter_mut() {
                if key == "$ref" && value == from {
                    *value = Value::String("#".into());
                } else {
                    rewrite(value, from);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| rewrite(v, from)),
        _ => {}
    }
}

fn reference(name: &str) -> Value {
    json!({ "$ref": format!("#/$defs/{name}") })
}

/// Not a public API: the pieces the derives build schemas from.
#[doc(hidden)]
pub mod __private {
    use serde_json::{Map, Value};

    pub use serde_json::{json, Value as JsonValue};

    /// `schema` with `description` (a doc comment) and `title` (its first line when that
    /// starts with `#`), as schemars writes them.
    pub fn described(mut schema: Value, doc: &str) -> Value {
        let doc = doc.trim_ascii();
        let (title, description) = match doc.strip_prefix('#') {
            Some(_) => {
                let end = doc.find('\n').unwrap_or(doc.len());
                (doc[..end].trim_start_matches('#').trim_ascii(), doc[end..].trim_ascii())
            }
            None => ("", doc),
        };
        if title.is_empty() && description.is_empty() {
            return schema;
        }
        let Value::Object(map) = &mut schema else { return schema };
        // A `$ref` described stays a `$ref` with the text beside it.
        if !title.is_empty() {
            map.insert("title".into(), title.into());
        }
        if !description.is_empty() {
            map.insert("description".into(), description.into());
        }
        schema
    }

    /// `T | null`: `null` added to the schema's `type`, or `anyOf` with it when the schema
    /// has no single `type` to add to.
    pub fn nullable(schema: Value) -> Value {
        if let Value::Object(map) = &schema {
            let plain = !map.contains_key("$ref") && !map.contains_key("const") && !map.contains_key("enum");
            match map.get("type") {
                Some(Value::String(kind)) if plain => {
                    let mut map = map.clone();
                    if kind != "null" {
                        map.insert("type".into(), json!([kind, "null"]));
                    }
                    return Value::Object(map);
                }
                Some(Value::Array(kinds)) if plain => {
                    let mut map = map.clone();
                    if !kinds.iter().any(|k| k == "null") {
                        let mut kinds = kinds.clone();
                        kinds.push("null".into());
                        map.insert("type".into(), Value::Array(kinds));
                    }
                    return Value::Object(map);
                }
                _ => {}
            }
        }
        if schema == Value::Bool(true) {
            return schema;
        }
        json!({ "anyOf": [schema, { "type": "null" }] })
    }

    /// An object of named properties, in the order given, and those it requires.
    pub fn object(properties: Vec<(&str, Value)>, required: Vec<&str>, deny_unknown: bool) -> Value {
        let mut map = Map::new();
        if deny_unknown {
            map.insert("additionalProperties".into(), false.into());
        }
        let properties: Map<String, Value> = properties.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        map.insert("properties".into(), Value::Object(properties));
        if !required.is_empty() {
            map.insert("required".into(), required.into_iter().map(Value::from).collect());
        }
        map.insert("type".into(), "object".into());
        Value::Object(map)
    }

    /// An object's properties and required names joined with those a flattened field adds.
    pub fn flatten(mut into: Value, from: Value) -> Value {
        let (Value::Object(into_map), Value::Object(from_map)) = (&mut into, from) else { return into };
        if let Some(Value::Object(props)) = from_map.get("properties") {
            let target = into_map.entry("properties").or_insert_with(|| Value::Object(Map::new()));
            if let Value::Object(target) = target {
                for (k, v) in props {
                    target.insert(k.clone(), v.clone());
                }
            }
        }
        if let Some(Value::Array(required)) = from_map.get("required") {
            let target = into_map.entry("required").or_insert_with(|| Value::Array(Vec::new()));
            if let Value::Array(target) = target {
                target.extend(required.iter().cloned());
            }
        }
        into
    }

    /// The schema a flattened field adds to its object: its definition, without a `$ref`.
    pub fn members(generator: &super::Generator, schema: Value) -> Value {
        generator.resolve(&schema).clone()
    }

    /// An array of exactly these items (a tuple).
    pub fn tuple(items: Vec<Value>) -> Value {
        let n = items.len();
        json!({ "maxItems": n, "minItems": n, "prefixItems": items, "type": "array" })
    }

    /// A string that is one of `names`.
    pub fn names(names: Vec<&str>) -> Value {
        json!({ "enum": names, "type": "string" })
    }

    /// The string `name` alone.
    pub fn constant(name: &str) -> Value {
        json!({ "const": name, "type": "string" })
    }

    /// One of `options` exactly.
    pub fn one_of(options: Vec<Value>) -> Value {
        json!({ "oneOf": options })
    }

    /// Any of `options` (an untagged enum).
    pub fn any_of(options: Vec<Value>) -> Value {
        json!({ "anyOf": options })
    }

    /// `{ name: schema }`, nothing else (a variant tagged by its key).
    pub fn keyed(name: &str, schema: Value) -> Value {
        json!({ "additionalProperties": false, "properties": { name: schema }, "required": [name], "type": "object" })
    }

    /// `schema` with `{ tag: name }` in it (a variant tagged inside the object).
    pub fn tagged(tag: &str, name: &str, schema: Value) -> Value {
        let Value::Object(mut map) = schema else { return schema };
        let props = map.entry("properties").or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(props) = props {
            props.insert(tag.into(), constant(name));
        }
        let required = map.entry("required").or_insert_with(|| Value::Array(Vec::new()));
        if let Value::Array(required) = required {
            required.insert(0, tag.into());
        }
        map.entry("type").or_insert_with(|| "object".into());
        Value::Object(map)
    }

    /// `schema` with `default` set to the value written as JSON (`#[serde(default)]`).
    pub fn with_default(schema: Value, default: Option<Value>) -> Value {
        match (schema, default) {
            (Value::Object(mut map), Some(default)) => {
                map.insert("default".into(), default);
                Value::Object(map)
            }
            (schema, _) => schema,
        }
    }

    /// The value `Default::default()` gives a type, when the type has one where the derive is
    /// expanded: `(&&Defaulted::<T>::new()).__value()`. In a generic impl that does not say
    /// `T: Default`, it is `None`, and the schema carries no `default` rather than not compiling.
    pub struct Defaulted<T>(core::marker::PhantomData<fn() -> T>);

    impl<T> Defaulted<T> {
        #[allow(clippy::new_without_default)]
        pub const fn new() -> Self {
            Defaulted(core::marker::PhantomData)
        }
    }

    pub trait HasDefault<T> {
        fn __value(self) -> Option<T>;
    }

    impl<T: Default> HasDefault<T> for &&Defaulted<T> {
        fn __value(self) -> Option<T> {
            Some(T::default())
        }
    }

    pub trait NoDefault<T> {
        fn __value(self) -> Option<T>;
    }

    impl<T> NoDefault<T> for &Defaulted<T> {
        fn __value(self) -> Option<T> {
            None
        }
    }

    /// A field's type, asked for its schema as `(&&Probe::<T>::new()).__write(g)` (or `__read`,
    /// `__write_inline`, `__read_inline`, `__optional`): method resolution takes the receiver as
    /// it is (`&&Probe`, when `T` has the schema, through `T`'s own impl, so a generic field is
    /// decided for each instance) before one dereference of it (`&Probe`, any `T`). A type with no
    /// schema is recorded on the generator, which refuses the document (`Generator::missing`):
    /// the derives compile for every field type serde takes, and a description that would say
    /// less than the JSON fails at startup or in the test that writes it. In a generic impl the
    /// choice is made against the impl's bounds, not the instance's: a field type that has a
    /// schema only under a bound the type does not declare (`Cow<'a, [T]>` needs `T: Clone`) is
    /// recorded as missing for every instance, and the message says to add that bound.
    pub struct Probe<T: ?Sized>(core::marker::PhantomData<fn() -> *const T>);

    impl<T: ?Sized> Probe<T> {
        #[allow(clippy::new_without_default)]
        pub const fn new() -> Self {
            Probe(core::marker::PhantomData)
        }
    }

    pub trait Written {
        fn __write(self, g: &mut super::Generator) -> Value;
        fn __write_inline(self, g: &mut super::Generator) -> Value;
    }

    impl<T: super::ToJsonSchema + ?Sized> Written for &&Probe<T> {
        fn __write(self, g: &mut super::Generator) -> Value {
            T::json_schema(g)
        }
        fn __write_inline(self, g: &mut super::Generator) -> Value {
            T::__inline(g)
        }
    }

    pub trait Read {
        fn __read(self, g: &mut super::Generator) -> Value;
        fn __read_inline(self, g: &mut super::Generator) -> Value;
        fn __optional(self) -> bool;
    }

    impl<T: super::FromJsonSchema + ?Sized> Read for &&Probe<T> {
        fn __read(self, g: &mut super::Generator) -> Value {
            T::json_schema(g)
        }
        fn __read_inline(self, g: &mut super::Generator) -> Value {
            T::__inline(g)
        }
        fn __optional(self) -> bool {
            T::__optional()
        }
    }

    pub trait Missing {
        fn __write(self, g: &mut super::Generator) -> Value;
        fn __write_inline(self, g: &mut super::Generator) -> Value;
        fn __read(self, g: &mut super::Generator) -> Value;
        fn __read_inline(self, g: &mut super::Generator) -> Value;
        fn __optional(self) -> bool;
    }

    impl<T: ?Sized> Missing for &Probe<T> {
        fn __write(self, g: &mut super::Generator) -> Value {
            g.miss(core::any::type_name::<T>(), false)
        }
        fn __write_inline(self, g: &mut super::Generator) -> Value {
            g.miss(core::any::type_name::<T>(), false)
        }
        fn __read(self, g: &mut super::Generator) -> Value {
            g.miss(core::any::type_name::<T>(), true)
        }
        fn __read_inline(self, g: &mut super::Generator) -> Value {
            g.miss(core::any::type_name::<T>(), true)
        }
        fn __optional(self) -> bool {
            false
        }
    }

    /// A field's default as JSON, for its schema's `default`: written by `ToJson` when it has it,
    /// else by serde, else none (schemars leaves it out then too). Called as
    /// `(&&Maybe(&value)).__json()`, so method resolution picks the first that applies: the
    /// receiver as it is (`&&Maybe`), then each dereference of it.
    pub struct Maybe<'a, T>(pub &'a T);

    impl<T> Clone for Maybe<'_, T> {
        fn clone(&self) -> Self {
            *self
        }
    }

    impl<T> Copy for Maybe<'_, T> {}

    pub trait MaybeToJson {
        fn __json(self) -> Option<Value>;
    }

    impl<T: crate::json::ToJson> MaybeToJson for &&Maybe<'_, T> {
        fn __json(self) -> Option<Value> {
            let mut out = Vec::new();
            self.0.write_json(&mut out);
            serde_json::from_slice(&out).ok()
        }
    }

    pub trait MaybeSerialize {
        fn __json(self) -> Option<Value>;
    }

    impl<T: serde::Serialize> MaybeSerialize for &Maybe<'_, T> {
        fn __json(self) -> Option<Value> {
            serde_json::to_value(self.0).ok()
        }
    }

    pub trait MaybeNot {
        fn __json(self) -> Option<Value>;
    }

    impl<T> MaybeNot for Maybe<'_, T> {
        fn __json(self) -> Option<Value> {
            None
        }
    }
}

// ---- Rust's types, as serde writes and reads them ----

macro_rules! both {
    ($(impl$(<$($p:ident $(: $b:path)?),*>)? for $t:ty => |$g:ident| $body:expr;)*) => {$(
        impl$(<$($p $(: $b)?),*>)? ToJsonSchema for $t {
            fn json_schema($g: &mut Generator) -> Value { let _ = &$g; $body }
        }
        impl$(<$($p $(: $b)?),*>)? FromJsonSchema for $t {
            fn json_schema($g: &mut Generator) -> Value { let _ = &$g; $body }
        }
    )*};
}

both! {
    impl for str => |g| json!({ "type": "string" });
    impl for String => |g| json!({ "type": "string" });
    impl for char => |g| json!({ "maxLength": 1, "minLength": 1, "type": "string" });
    impl for bool => |g| json!({ "type": "boolean" });
    impl for () => |g| json!({ "type": "null" });
    impl for u8 => |g| json!({ "format": "uint8", "maximum": 255, "minimum": 0, "type": "integer" });
    impl for u16 => |g| json!({ "format": "uint16", "maximum": 65535, "minimum": 0, "type": "integer" });
    impl for u32 => |g| json!({ "format": "uint32", "minimum": 0, "type": "integer" });
    impl for u64 => |g| json!({ "format": "uint64", "minimum": 0, "type": "integer" });
    impl for usize => |g| json!({ "format": "uint", "minimum": 0, "type": "integer" });
    impl for u128 => |g| json!({ "format": "uint128", "minimum": 0, "type": "integer" });
    impl for i8 => |g| json!({ "format": "int8", "maximum": 127, "minimum": -128, "type": "integer" });
    impl for i16 => |g| json!({ "format": "int16", "maximum": 32767, "minimum": -32768, "type": "integer" });
    impl for i32 => |g| json!({ "format": "int32", "type": "integer" });
    impl for i64 => |g| json!({ "format": "int64", "type": "integer" });
    impl for isize => |g| json!({ "format": "int", "type": "integer" });
    impl for i128 => |g| json!({ "format": "int128", "type": "integer" });
    impl for f32 => |g| json!({ "format": "float", "type": "number" });
    impl for f64 => |g| json!({ "format": "double", "type": "number" });
    impl for crate::i18n::Day => |g| json!({ "format": "date", "type": "string" });
    impl for serde_json::Value => |g| Value::Bool(true);
    impl for serde_json::Number => |g| json!({ "type": "number" });
    impl for serde_json::Map<String, Value> => |g| json!({ "additionalProperties": true, "type": "object" });
    impl for serde_json::value::RawValue => |g| Value::Bool(true);
    impl for std::path::Path => |g| json!({ "type": "string" });
    impl for std::path::PathBuf => |g| json!({ "type": "string" });
    impl for std::net::IpAddr => |g| json!({ "format": "ip", "type": "string" });
    impl for std::net::Ipv4Addr => |g| json!({ "format": "ipv4", "type": "string" });
    impl for std::net::Ipv6Addr => |g| json!({ "format": "ipv6", "type": "string" });
    impl for std::net::SocketAddr => |g| json!({ "type": "string" });
    impl for std::net::SocketAddrV4 => |g| json!({ "type": "string" });
    impl for std::net::SocketAddrV6 => |g| json!({ "type": "string" });
    impl for std::num::NonZeroU8 => |g| nonzero(<u8 as ToJsonSchema>::json_schema(g), false);
    impl for std::num::NonZeroU16 => |g| nonzero(<u16 as ToJsonSchema>::json_schema(g), false);
    impl for std::num::NonZeroU32 => |g| nonzero(<u32 as ToJsonSchema>::json_schema(g), false);
    impl for std::num::NonZeroU64 => |g| nonzero(<u64 as ToJsonSchema>::json_schema(g), false);
    impl for std::num::NonZeroU128 => |g| nonzero(<u128 as ToJsonSchema>::json_schema(g), false);
    impl for std::num::NonZeroUsize => |g| nonzero(<usize as ToJsonSchema>::json_schema(g), false);
    impl for std::num::NonZeroI8 => |g| nonzero(<i8 as ToJsonSchema>::json_schema(g), true);
    impl for std::num::NonZeroI16 => |g| nonzero(<i16 as ToJsonSchema>::json_schema(g), true);
    impl for std::num::NonZeroI32 => |g| nonzero(<i32 as ToJsonSchema>::json_schema(g), true);
    impl for std::num::NonZeroI64 => |g| nonzero(<i64 as ToJsonSchema>::json_schema(g), true);
    impl for std::num::NonZeroI128 => |g| nonzero(<i128 as ToJsonSchema>::json_schema(g), true);
    impl for std::num::NonZeroIsize => |g| nonzero(<isize as ToJsonSchema>::json_schema(g), true);
    // Written and read alike, so one definition serves both sides.
    impl for std::time::Duration => |g| g.define(false, std::any::type_name::<std::time::Duration>(), "Duration", |g| {
        let secs = <u64 as ToJsonSchema>::json_schema(g);
        let nanos = <u32 as ToJsonSchema>::json_schema(g);
        __private::object(vec![("nanos", nanos), ("secs", secs)], vec!["secs", "nanos"], false)
    });
    impl for std::time::SystemTime => |g| g.define(false, std::any::type_name::<std::time::SystemTime>(), "SystemTime", |g| {
        let secs = <u64 as ToJsonSchema>::json_schema(g);
        let nanos = <u32 as ToJsonSchema>::json_schema(g);
        __private::object(vec![("nanos_since_epoch", nanos), ("secs_since_epoch", secs)], vec!["secs_since_epoch", "nanos_since_epoch"], false)
    });
}

impl<T: ?Sized> ToJsonSchema for core::marker::PhantomData<T> {
    fn json_schema(_: &mut Generator) -> Value {
        json!({ "type": "null" })
    }
}

impl<T: ?Sized> FromJsonSchema for core::marker::PhantomData<T> {
    fn json_schema(_: &mut Generator) -> Value {
        json!({ "type": "null" })
    }
}

/// A non-zero integer: an unsigned one starts at 1, a signed one is anything but 0.
fn nonzero(schema: Value, signed: bool) -> Value {
    let Value::Object(mut map) = schema else { return schema };
    if signed {
        map.insert("not".into(), json!({ "const": 0 }));
    } else {
        map.insert("minimum".into(), 1.into());
    }
    Value::Object(map)
}

/// Text the app wrote, sent as it is: any JSON.
impl ToJsonSchema for crate::json::Raw {
    fn json_schema(_: &mut Generator) -> Value {
        Value::Bool(true)
    }
}

macro_rules! containers {
    ($trait:ident) => {
        impl<T: $trait> $trait for Option<T> {
            fn json_schema(g: &mut Generator) -> Value {
                __private::nullable(T::json_schema(g))
            }
            containers!(@option $trait);
        }
        impl<T: $trait> $trait for Vec<T> {
            fn json_schema(g: &mut Generator) -> Value {
                json!({ "items": T::json_schema(g), "type": "array" })
            }
        }
        impl<T: $trait> $trait for [T] {
            fn json_schema(g: &mut Generator) -> Value {
                json!({ "items": T::json_schema(g), "type": "array" })
            }
        }
        impl<T: $trait> $trait for VecDeque<T> {
            fn json_schema(g: &mut Generator) -> Value {
                json!({ "items": T::json_schema(g), "type": "array" })
            }
        }
        impl<T: $trait> $trait for BTreeSet<T> {
            fn json_schema(g: &mut Generator) -> Value {
                json!({ "items": T::json_schema(g), "type": "array", "uniqueItems": true })
            }
        }
        impl<T: $trait, S> $trait for HashSet<T, S> {
            fn json_schema(g: &mut Generator) -> Value {
                json!({ "items": T::json_schema(g), "type": "array", "uniqueItems": true })
            }
        }
        impl<T: $trait, const N: usize> $trait for [T; N] {
            fn json_schema(g: &mut Generator) -> Value {
                json!({ "items": T::json_schema(g), "maxItems": N, "minItems": N, "type": "array" })
            }
        }
        impl<K, V: $trait> $trait for BTreeMap<K, V> {
            fn json_schema(g: &mut Generator) -> Value {
                json!({ "additionalProperties": V::json_schema(g), "type": "object" })
            }
        }
        impl<K, V: $trait, S> $trait for HashMap<K, V, S> {
            fn json_schema(g: &mut Generator) -> Value {
                json!({ "additionalProperties": V::json_schema(g), "type": "object" })
            }
        }
        impl<T: $trait + ?Sized> $trait for &T {
            fn json_schema(g: &mut Generator) -> Value {
                T::json_schema(g)
            }
        }
        impl<T: $trait + ?Sized> $trait for &mut T {
            fn json_schema(g: &mut Generator) -> Value {
                T::json_schema(g)
            }
        }
        impl<T: $trait + ToOwned + ?Sized> $trait for Cow<'_, T> {
            fn json_schema(g: &mut Generator) -> Value {
                T::json_schema(g)
            }
        }
        impl<T: $trait + ?Sized> $trait for Box<T> {
            fn json_schema(g: &mut Generator) -> Value {
                T::json_schema(g)
            }
        }
        impl<T: $trait + ?Sized> $trait for Rc<T> {
            fn json_schema(g: &mut Generator) -> Value {
                T::json_schema(g)
            }
        }
        impl<T: $trait + ?Sized> $trait for Arc<T> {
            fn json_schema(g: &mut Generator) -> Value {
                T::json_schema(g)
            }
        }
        containers!(@tuples $trait (A), (A, B), (A, B, C), (A, B, C, D), (A, B, C, D, E), (A, B, C, D, E, F));
    };
    (@option ToJsonSchema) => {};
    (@option FromJsonSchema) => {
        fn __optional() -> bool {
            true
        }
    };
    (@tuples $trait:ident $(($($n:ident),*)),*) => {$(
        impl<$($n: $trait),*> $trait for ($($n,)*) {
            fn json_schema(g: &mut Generator) -> Value {
                __private::tuple(vec![$($n::json_schema(g)),*])
            }
        }
    )*};
}
containers!(ToJsonSchema);
containers!(FromJsonSchema);

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde::{Deserialize, Serialize};
    use serde_json::{json, Value};

    use super::{FromJsonSchema, Generator, ToJsonSchema};
    use crate::json::{FromJson, ToJson};

    // The expected schemas are what schemars 1.2.3 makes of the same types (`for_serialize` for
    // the written side, `for_deserialize` for the read side), which the TypeScript and MCP
    // schemas came from before.

    fn write<T: ToJsonSchema>() -> (Value, Value) {
        let mut g = Generator::new();
        let root = T::json_schema(&mut g);
        (root, Value::Object(g.definitions().into_iter().collect()))
    }

    fn read<T: FromJsonSchema>() -> (Value, Value) {
        let mut g = Generator::new();
        let root = T::json_schema(&mut g);
        (root, Value::Object(g.definitions().into_iter().collect()))
    }

    #[derive(Serialize, ToJson, FromJson)]
    struct Inner {
        a: u8,
    }

    /// Doc of a struct.
    ///
    /// Second paragraph.
    #[derive(Serialize, ToJson)]
    #[allow(dead_code)]
    struct Fields {
        /// The id.
        id: String,
        opt: Option<String>,
        /// Doc on an optional ref.
        opt_ref: Option<Inner>,
        #[serde(skip_serializing_if = "Option::is_none")]
        skipped_if: Option<u8>,
        #[serde(skip)]
        hidden: u8,
        #[serde(rename = "Renamed")]
        renamed: (u8, char),
        map: BTreeMap<String, Inner>,
        #[serde(flatten)]
        flat: Flat,
    }

    #[derive(Serialize, ToJson)]
    struct Flat {
        /// flat doc
        f1: u8,
        #[serde(skip_serializing_if = "Option::is_none")]
        f2: Option<u8>,
    }

    #[test]
    fn a_struct_is_described_as_it_is_written() {
        let (root, defs) = write::<Fields>();
        assert_eq!(root, json!({ "$ref": "#/$defs/Fields" }));
        let u8_ = json!({ "format": "uint8", "maximum": 255, "minimum": 0, "type": "integer" });
        assert_eq!(
            defs["Fields"],
            json!({
                "description": "Doc of a struct.\n\nSecond paragraph.",
                "properties": {
                    "Renamed": { "maxItems": 2, "minItems": 2, "prefixItems": [u8_, { "maxLength": 1, "minLength": 1, "type": "string" }], "type": "array" },
                    "f1": { "description": "flat doc", "format": "uint8", "maximum": 255, "minimum": 0, "type": "integer" },
                    "f2": { "format": "uint8", "maximum": 255, "minimum": 0, "type": ["integer", "null"] },
                    "id": { "description": "The id.", "type": "string" },
                    "map": { "additionalProperties": { "$ref": "#/$defs/Inner" }, "type": "object" },
                    "opt": { "type": ["string", "null"] },
                    "opt_ref": { "anyOf": [{ "$ref": "#/$defs/Inner" }, { "type": "null" }], "description": "Doc on an optional ref." },
                    "skipped_if": { "format": "uint8", "maximum": 255, "minimum": 0, "type": ["integer", "null"] },
                },
                "required": ["id", "opt", "opt_ref", "Renamed", "map", "f1"],
                "type": "object",
            })
        );
        assert_eq!(defs["Inner"], json!({ "properties": { "a": u8_ }, "required": ["a"], "type": "object" }));
    }

    #[derive(Serialize, Default, ToJson, FromJson)]
    #[serde(default)]
    struct AllDefault {
        a: u8,
        b: Option<u8>,
    }

    /// The read side requires neither an `Option` nor a defaulted field, and both carry the default.
    #[test]
    fn a_default_is_shown_and_not_required_when_read() {
        let a = json!({ "default": 0, "format": "uint8", "maximum": 255, "minimum": 0, "type": "integer" });
        let b = json!({ "default": null, "format": "uint8", "maximum": 255, "minimum": 0, "type": ["integer", "null"] });
        assert_eq!(
            write::<AllDefault>().1["AllDefault"],
            json!({ "properties": { "a": a, "b": b }, "required": ["a", "b"], "type": "object" })
        );
        assert_eq!(read::<AllDefault>().1["AllDefault"], json!({ "properties": { "a": a, "b": b }, "type": "object" }));
    }

    /// External doc.
    #[derive(Serialize, ToJson)]
    #[allow(dead_code)]
    enum External {
        U,
        /// newtype doc
        N(u8),
        S {
            b: Option<String>,
        },
        R(Inner),
    }

    #[derive(Serialize, ToJson)]
    #[serde(tag = "kind")]
    #[allow(dead_code)]
    enum Internal {
        U,
        S { a: bool },
    }

    #[derive(Serialize, ToJson)]
    #[serde(tag = "t", content = "c")]
    #[allow(dead_code)]
    enum Adjacent {
        U,
        N(bool),
    }

    #[derive(Serialize, ToJson)]
    #[serde(untagged)]
    #[allow(dead_code)]
    enum Untagged {
        U,
        N(bool),
        R(Inner),
    }

    #[test]
    fn each_enum_tagging_is_described_as_serde_writes_it() {
        let defs = write::<External>().1;
        assert_eq!(
            defs["External"],
            json!({ "description": "External doc.", "oneOf": [
                { "enum": ["U"], "type": "string" },
                { "additionalProperties": false, "description": "newtype doc", "properties": { "N": { "format": "uint8", "maximum": 255, "minimum": 0, "type": "integer" } }, "required": ["N"], "type": "object" },
                { "additionalProperties": false, "properties": { "S": { "properties": { "b": { "type": ["string", "null"] } }, "required": ["b"], "type": "object" } }, "required": ["S"], "type": "object" },
                { "additionalProperties": false, "properties": { "R": { "$ref": "#/$defs/Inner" } }, "required": ["R"], "type": "object" },
            ] })
        );
        assert_eq!(
            write::<Internal>().1["Internal"],
            json!({ "oneOf": [
                { "properties": { "kind": { "const": "U", "type": "string" } }, "required": ["kind"], "type": "object" },
                { "properties": { "a": { "type": "boolean" }, "kind": { "const": "S", "type": "string" } }, "required": ["kind", "a"], "type": "object" },
            ] })
        );
        assert_eq!(
            write::<Adjacent>().1["Adjacent"],
            json!({ "oneOf": [
                { "properties": { "t": { "const": "U", "type": "string" } }, "required": ["t"], "type": "object" },
                { "properties": { "c": { "type": "boolean" }, "t": { "const": "N", "type": "string" } }, "required": ["t", "c"], "type": "object" },
            ] })
        );
        assert_eq!(
            write::<Untagged>().1["Untagged"],
            json!({ "anyOf": [{ "type": "null" }, { "type": "boolean" }, { "$ref": "#/$defs/Inner" }] })
        );
    }

    #[derive(Serialize, ToJson, FromJson)]
    struct Generic<T> {
        t: T,
    }

    #[derive(Serialize, ToJson, FromJson)]
    struct Uses {
        g: Generic<String>,
        h: Generic<Inner>,
        /// A recursive type refers to itself.
        children: Vec<Uses>,
    }

    #[test]
    fn generic_instances_are_numbered_and_a_recursive_type_refers_to_itself() {
        let defs = read::<Uses>().1;
        assert_eq!(defs["Generic"]["properties"]["t"], json!({ "type": "string" }));
        assert_eq!(defs["Generic2"]["properties"]["t"], json!({ "$ref": "#/$defs/Inner" }));
        assert_eq!(defs["Uses"]["properties"]["children"]["items"], json!({ "$ref": "#/$defs/Uses" }));
        // As a document's root (a tool's schema) the type is inlined, unless something refers to it.
        let root = Generator::root_for_read::<Generic<Inner>>();
        assert_eq!(
            root,
            json!({ "$defs": { "Inner": defs["Inner"] }, "properties": { "t": { "$ref": "#/$defs/Inner" } }, "required": ["t"], "type": "object" })
        );
        // A recursive root refers to itself as the document, `#`.
        let root = Generator::root_for_read::<Uses>();
        assert_eq!(root["properties"]["children"]["items"], json!({ "$ref": "#" }), "{root}");
        assert!(root["$defs"].get("Uses").is_none(), "{root}");
    }

    #[derive(Serialize, ToJson, FromJson)]
    struct Maybe<T> {
        t: T,
    }

    #[derive(Serialize, ToJson, FromJson)]
    struct UsesMaybe {
        a: Maybe<Option<String>>,
        b: Maybe<u8>,
    }

    /// Whether a generic field may be left out is decided for each instance, as serde reads it.
    #[test]
    fn a_generic_option_field_is_optional_in_that_instance_alone() {
        let defs = read::<UsesMaybe>().1;
        assert_eq!(defs["Maybe"]["properties"]["t"], json!({ "type": ["string", "null"] }));
        assert!(defs["Maybe"].get("required").is_none(), "{defs}");
        assert_eq!(defs["Maybe2"]["required"], json!(["t"]));
    }

    fn shelf() -> Shelf {
        Shelf { name: "s".into(), size: 3, seven_if: 7, kept: 0 }
    }

    fn seven() -> u8 {
        7
    }

    fn is_seven(v: &u8) -> bool {
        *v == 7
    }

    #[derive(Serialize, ToJson, FromJson)]
    #[serde(deny_unknown_fields, default = "shelf")]
    struct Shelf {
        name: String,
        #[serde(default = "seven")]
        size: u8,
        #[serde(skip_serializing_if = "is_seven", default = "seven")]
        seven_if: u8,
        #[serde(skip)]
        kept: u8,
    }

    /// A container default from a path gives each field its value; a field's own default wins; a
    /// default the field would not be written with is left out of the written side, and shown on
    /// the read side, where a missing field takes it. schemars 1.2.3 leaves it out of both sides;
    /// the read schema differs from it here on purpose.
    #[test]
    fn defaults_from_paths_and_unknown_fields() {
        let u8_ = |default: Option<u8>| {
            let mut s = json!({ "format": "uint8", "maximum": 255, "minimum": 0, "type": "integer" });
            if let Some(d) = default {
                s["default"] = d.into();
            }
            s
        };
        let written = write::<Shelf>().1;
        assert_eq!(
            written["Shelf"],
            json!({
                "additionalProperties": false,
                "properties": { "name": { "default": "s", "type": "string" }, "seven_if": u8_(None), "size": u8_(Some(7)) },
                "required": ["name", "size"],
                "type": "object",
            })
        );
        let read_ = read::<Shelf>().1;
        assert_eq!(
            read_["Shelf"],
            json!({
                "additionalProperties": false,
                "properties": { "name": { "default": "s", "type": "string" }, "seven_if": u8_(Some(7)), "size": u8_(Some(7)) },
                "type": "object",
            })
        );
    }

    /// `Default` holds only for `T: Default`, which the schema's impl does not require.
    #[derive(Default, Serialize, ToJson)]
    #[serde(default)]
    struct Paged<T> {
        items: Vec<T>,
        more: bool,
    }

    /// A container default on a type that implements `Drop`, so its fields cannot be moved out.
    #[derive(Default, Serialize, ToJson)]
    #[serde(default)]
    struct Dropping {
        n: u8,
    }

    impl Drop for Dropping {
        fn drop(&mut self) {}
    }

    #[derive(Serialize, ToJson)]
    #[serde(default = "dropping_path")]
    struct DroppingPath {
        n: u8,
    }

    impl Drop for DroppingPath {
        fn drop(&mut self) {}
    }

    fn dropping_path() -> DroppingPath {
        DroppingPath { n: 4 }
    }

    /// A generic type's container default is left out where the impl cannot make it, for every
    /// instance (schemars gives `Paged<u8>` `[]` and `false`), and a container default is
    /// borrowed, so a type that implements `Drop` still has one.
    #[test]
    fn container_defaults_of_generic_and_dropping_types() {
        let paged = write::<Paged<u8>>().1;
        assert_eq!(paged["Paged"]["properties"]["more"], json!({ "type": "boolean" }));
        assert_eq!(paged["Paged"]["required"], json!(["items", "more"]));
        assert_eq!(write::<Dropping>().1["Dropping"]["properties"]["n"]["default"], json!(0));
        assert_eq!(write::<DroppingPath>().1["DroppingPath"]["properties"]["n"]["default"], json!(4));
    }

    /// # A title
    ///
    /// The description.
    #[derive(Serialize, ToJson, FromJson)]
    #[serde(rename_all = "kebab-case")]
    #[allow(dead_code)]
    enum Doc {
        /// first
        OneA,
        TwoB,
    }

    #[derive(Serialize, ToJson, FromJson)]
    struct Newtype(u8);

    #[derive(Serialize, ToJson, FromJson)]
    struct Pair(u8, String);

    /// Transparent doc.
    #[derive(Serialize, ToJson, FromJson)]
    #[serde(transparent)]
    struct Transparent {
        inner: String,
    }

    #[derive(Serialize, ToJson, FromJson)]
    struct Unit;

    #[test]
    fn titles_newtypes_tuples_and_units() {
        assert_eq!(
            read::<Doc>().1["Doc"],
            json!({ "description": "The description.", "oneOf": [
                { "enum": ["two-b"], "type": "string" },
                { "const": "one-a", "description": "first", "type": "string" },
            ], "title": "A title" })
        );
        let u8_ = json!({ "format": "uint8", "maximum": 255, "minimum": 0, "type": "integer" });
        assert_eq!(write::<Newtype>().1["Newtype"], u8_);
        assert_eq!(
            read::<Pair>().1["Pair"],
            json!({ "maxItems": 2, "minItems": 2, "prefixItems": [u8_, { "type": "string" }], "type": "array" })
        );
        assert_eq!(write::<Transparent>().1["Transparent"], json!({ "description": "Transparent doc.", "type": "string" }));
        assert_eq!(read::<Unit>().1["Unit"], json!({ "type": "null" }));
    }

    #[derive(Serialize, ToJson)]
    #[serde(tag = "t", content = "c")]
    #[allow(dead_code)]
    enum Adjacent2 {
        S {
            a: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            b: Option<bool>,
        },
        T(bool, bool),
    }

    #[derive(ToJson)]
    #[allow(dead_code)]
    struct Std {
        a: [bool; 2],
        s: std::collections::BTreeSet<String>,
        d: std::time::Duration,
        nz: std::num::NonZeroU32,
        nzi: std::num::NonZeroI16,
        ip: std::net::IpAddr,
        p: std::path::PathBuf,
        raw: Box<serde_json::value::RawValue>,
        text: crate::json::Raw,
    }

    #[test]
    fn adjacent_variants_and_std_types() {
        let bool_ = json!({ "type": "boolean" });
        assert_eq!(
            write::<Adjacent2>().1["Adjacent2"],
            json!({ "oneOf": [
                { "properties": { "c": { "properties": { "a": bool_, "b": { "type": ["boolean", "null"] } }, "required": ["a"], "type": "object" }, "t": { "const": "S", "type": "string" } }, "required": ["t", "c"], "type": "object" },
                { "properties": { "c": { "maxItems": 2, "minItems": 2, "prefixItems": [bool_, bool_], "type": "array" }, "t": { "const": "T", "type": "string" } }, "required": ["t", "c"], "type": "object" },
            ] })
        );
        let (_, defs) = write::<Std>();
        let props = &defs["Std"]["properties"];
        assert_eq!(props["a"], json!({ "items": bool_, "maxItems": 2, "minItems": 2, "type": "array" }));
        assert_eq!(props["s"], json!({ "items": { "type": "string" }, "type": "array", "uniqueItems": true }));
        assert_eq!(props["d"], json!({ "$ref": "#/$defs/Duration" }));
        assert_eq!(defs["Duration"]["required"], json!(["secs", "nanos"]));
        assert_eq!(props["nz"], json!({ "format": "uint32", "minimum": 1, "type": "integer" }));
        assert_eq!(props["nzi"]["not"], json!({ "const": 0 }));
        assert_eq!(props["ip"], json!({ "format": "ip", "type": "string" }));
        assert_eq!(props["p"], json!({ "type": "string" }));
        assert_eq!((&props["raw"], &props["text"]), (&json!(true), &json!(true)));
    }

    /// A type from "another crate": serde only, written and read by serde_json inside derived types.
    #[derive(Serialize, Deserialize)]
    struct Foreign {
        at: String,
    }

    /// Derives for every field type serde takes, so a type nothing describes compiles.
    #[derive(Serialize, ToJson, FromJson)]
    struct HoldsForeign {
        when: Foreign,
        maybe: Option<Foreign>,
    }

    #[test]
    #[should_panic(
        expected = "fields of types with no JSON Schema: written core::option::Option<corten::json::schema::tests::Foreign>, corten::json::schema::tests::Foreign"
    )]
    fn describing_a_field_with_no_written_schema_panics() {
        let _ = Generator::root_for_write::<HoldsForeign>();
    }

    #[test]
    #[should_panic(
        expected = "read core::option::Option<corten::json::schema::tests::Foreign>, corten::json::schema::tests::Foreign (needs FromJson derived"
    )]
    fn describing_a_field_with_no_read_schema_panics() {
        let _ = Generator::root_for_read::<HoldsForeign>();
    }

    #[test]
    #[should_panic(expected = "Types::add::<corten::json::schema::tests::HoldsForeign>(): fields of types with no JSON Schema")]
    fn types_refuse_a_field_with_no_schema() {
        let _ = crate::types::Types::new().add::<HoldsForeign>();
    }
}
