//! JSON Schema (draft 2020-12) of the JSON a type writes ([`ToJsonSchema`]) or reads
//! ([`FromJsonSchema`]), from the same reading of `#[serde(..)]` that `#[derive(ToJson)]` and
//! `#[derive(FromJson)]` lay the bytes out with, so a description cannot disagree with the
//! JSON. `corten::types` writes TypeScript from it and `corten::agent` gives it to agents as a tool's
//! `inputSchema` and `outputSchema`.
//!
//! A type the derives describe is named under `$defs` and referred to by `$ref`; a recursive
//! type refers to itself the same way. A field of a type with no schema (another crate's, which the
//! derives write or read through serde) is any JSON (`true`, `unknown` in TypeScript): true of
//! its JSON, but saying nothing more. To describe it, implement the trait for a newtype around it.

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
    note = "derive ToJson on it; for another crate's type, implement ToJsonSchema for a newtype around it"
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
    note = "derive FromJson on it; for another crate's type, implement FromJsonSchema for a newtype around it"
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
}

/// The definitions the schemas of one document refer to (`$defs`), named after their Rust
/// types; a second type of one name (two instances of a generic) is numbered, `Name2`.
#[derive(Default)]
pub struct Generator {
    /// By the type's id: its name, and its schema once made (`None` while it is being made).
    by_id: HashMap<&'static str, String>,
    defs: BTreeMap<String, Option<Value>>,
}

impl Generator {
    pub fn new() -> Self {
        Self::default()
    }

    /// A `$ref` to the type `id` names (its Rust path and arguments), made by `make` under
    /// `name` the first time. Not a public API: what the derives call.
    #[doc(hidden)]
    pub fn define(&mut self, id: &'static str, name: &str, make: impl FnOnce(&mut Generator) -> Value) -> Value {
        if let Some(name) = self.by_id.get(id) {
            return reference(name);
        }
        let mut unique = name.to_string();
        let mut n = 2;
        while self.defs.contains_key(&unique) {
            unique = format!("{name}{n}");
            n += 1;
        }
        self.by_id.insert(id, unique.clone());
        self.defs.insert(unique.clone(), None);
        let schema = make(self);
        self.defs.insert(unique.clone(), Some(schema));
        reference(&unique)
    }

    /// Every definition made, by name.
    pub fn definitions(&self) -> BTreeMap<String, Value> {
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
    /// `$defs` for the types it refers to.
    pub fn root_for_write<T: ToJsonSchema + ?Sized>() -> Value {
        let mut generator = Generator::new();
        let schema = T::json_schema(&mut generator);
        generator.root(schema)
    }

    /// [`Generator::root_for_write`] for what `T` reads.
    pub fn root_for_read<T: FromJsonSchema + ?Sized>() -> Value {
        let mut generator = Generator::new();
        let schema = T::json_schema(&mut generator);
        generator.root(schema)
    }

    fn root(mut self, schema: Value) -> Value {
        let name = schema.get("$ref").and_then(Value::as_str).and_then(|r| r.strip_prefix("#/$defs/")).map(str::to_string);
        let mut root = match &name {
            Some(name) => {
                // Inlined as the root unless a definition still refers to it (a recursive type).
                let needle = Value::String(format!("#/$defs/{name}"));
                let referred =
                    self.defs.iter().any(|(other, def)| other != name && def.as_ref().is_some_and(|d| mentions(d, &needle)))
                        || self.defs.get(name).and_then(Option::as_ref).is_some_and(|d| mentions(d, &needle));
                if referred {
                    schema
                } else {
                    self.defs.remove(name).flatten().unwrap_or(schema)
                }
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

fn mentions(schema: &Value, needle: &Value) -> bool {
    match schema {
        Value::Object(map) => map.iter().any(|(k, v)| (k == "$ref" && v == needle) || mentions(v, needle)),
        Value::Array(items) => items.iter().any(|v| mentions(v, needle)),
        _ => false,
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

    /// A field's type, asked for its schema as `(&&Probe::<T>::new()).__write(g)` (or `__read`,
    /// `__write_inline`, `__read_inline`, `__optional`): method resolution takes the
    /// receiver as it is (`&&Probe`, when `T` has a schema) before one dereference of it (`&Probe`,
    /// any `T`). A type the derives cannot see into (another crate's, written or read by serde) is
    /// any JSON, which is true of its JSON though it says nothing more.
    pub struct Probe<T: ?Sized>(core::marker::PhantomData<fn() -> *const T>);

    impl<T: ?Sized> Probe<T> {
        #[allow(clippy::new_without_default)]
        pub const fn new() -> Self {
            Probe(core::marker::PhantomData)
        }
    }

    pub trait Described {
        fn __write(self, g: &mut super::Generator) -> Value;
        fn __write_inline(self, g: &mut super::Generator) -> Value;
    }

    impl<T: super::ToJsonSchema + ?Sized> Described for &&Probe<T> {
        fn __write(self, g: &mut super::Generator) -> Value {
            T::json_schema(g)
        }
        fn __write_inline(self, g: &mut super::Generator) -> Value {
            T::__inline(g)
        }
    }

    pub trait ReadDescribed {
        fn __read(self, g: &mut super::Generator) -> Value;
        fn __read_inline(self, g: &mut super::Generator) -> Value;
    }

    impl<T: super::FromJsonSchema + ?Sized> ReadDescribed for &&Probe<T> {
        fn __read(self, g: &mut super::Generator) -> Value {
            T::json_schema(g)
        }
        fn __read_inline(self, g: &mut super::Generator) -> Value {
            T::__inline(g)
        }
    }

    pub trait AnyJson {
        fn __write(self, g: &mut super::Generator) -> Value;
        fn __write_inline(self, g: &mut super::Generator) -> Value;
        fn __read(self, g: &mut super::Generator) -> Value;
        fn __read_inline(self, g: &mut super::Generator) -> Value;
    }

    impl<T: ?Sized> AnyJson for &Probe<T> {
        fn __write(self, _: &mut super::Generator) -> Value {
            Value::Bool(true)
        }
        fn __write_inline(self, _: &mut super::Generator) -> Value {
            Value::Bool(true)
        }
        fn __read(self, _: &mut super::Generator) -> Value {
            Value::Bool(true)
        }
        fn __read_inline(self, _: &mut super::Generator) -> Value {
            Value::Bool(true)
        }
    }

    /// Whether a field may be left out when read: an `Option` of any type, which serde reads as
    /// `None`.
    pub trait IsOption {
        fn __optional(self) -> bool;
    }

    impl<T> IsOption for &&Probe<Option<T>> {
        fn __optional(self) -> bool {
            true
        }
    }

    pub trait NotOption {
        fn __optional(self) -> bool;
    }

    impl<T: ?Sized> NotOption for &Probe<T> {
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
    impl for Cow<'_, str> => |g| json!({ "type": "string" });
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

    #[derive(Serialize, Deserialize, ToJson, FromJson)]
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

    #[derive(Serialize, Deserialize, Default, ToJson, FromJson)]
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

    #[derive(Serialize, Deserialize, ToJson, FromJson)]
    struct Generic<T> {
        t: T,
    }

    #[derive(Serialize, Deserialize, ToJson, FromJson)]
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
        let root = Generator::root_for_read::<Uses>();
        assert_eq!(root["$ref"], "#/$defs/Uses", "{root}");
    }

    /// A type from "another crate": serde only, written and read by serde_json inside derived types.
    #[derive(Serialize, Deserialize)]
    struct Foreign {
        at: String,
    }

    #[derive(Serialize, Deserialize, ToJson, FromJson)]
    struct HoldsForeign {
        when: Foreign,
        maybe: Option<Foreign>,
    }

    #[test]
    fn a_field_with_no_schema_is_any_json() {
        let written = write::<HoldsForeign>().1;
        assert_eq!(written["HoldsForeign"]["properties"], json!({ "maybe": true, "when": true }));
        let read_ = read::<HoldsForeign>().1;
        assert_eq!(read_["HoldsForeign"]["required"], json!(["when"]), "an Option of any type may be left out");
        let _ = (Foreign { at: String::new() }.at, ());
    }
}
