//! The JSON Schema impls `#[derive(ToJson)]` and `#[derive(FromJson)]` emit beside the code that
//! writes or reads the bytes, from the same fields, keys and variants those derives worked out, so
//! the description of a type cannot disagree with its JSON. Each impl is wrapped in
//! `::corten::__if_types!`, which keeps it only when corten's `types` feature is on.
//!
//! The impls have no bounds on the fields' types: a bound on a recursive type's own type overflows
//! trait resolution (E0275), and the impls are emitted for every derived type while `types` is on,
//! including types nothing describes whose fields serde alone writes. Each field's type is asked
//! for its schema through `__private::Probe`, which records one with none on the generator, and
//! describing the type then panics naming it (`Generator::missing`).

use proc_macro::{Group, Ident, TokenStream, TokenTree};

use crate::tokens::{is_ident, is_punct, literal, q, string_value};

/// Which side a schema describes.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Side {
    Write,
    Read,
}

impl Side {
    fn trait_path(self) -> TokenStream {
        match self {
            Side::Write => q("::corten::json::schema::ToJsonSchema", &[]),
            Side::Read => q("::corten::json::schema::FromJsonSchema", &[]),
        }
    }
}

/// `#[serde(default)]` or `#[serde(default = "path")]`, on a field or on its container.
pub(crate) enum DefaultValue {
    Trait,
    Path(TokenStream),
}

/// An expression of type `Option<ty>`: the value a field left out of the JSON takes, from its own
/// default or the container's, or `None` when that value cannot be made where the impl is (a
/// generic type's `Default` the impl does not require).
pub(crate) fn left_out(
    own: Option<&DefaultValue>,
    container: Option<&DefaultValue>,
    ty: &TokenStream,
    member: &TokenStream,
) -> Option<TokenStream> {
    Some(match (own, container) {
        (Some(DefaultValue::Trait), _) => q("(&&__s::Defaulted::<__A0>::new()).__value()", std::slice::from_ref(ty)),
        (Some(DefaultValue::Path(path)), _) => q("::core::option::Option::Some(__A0())", std::slice::from_ref(path)),
        (None, Some(DefaultValue::Trait)) => {
            q("(&&__s::Defaulted::<Self>::new()).__value().map(|__c| __c.__A0)", std::slice::from_ref(member))
        }
        (None, Some(DefaultValue::Path(path))) => {
            q("::core::option::Option::Some({ let __c: Self = __A0(); __c.__A1 })", &[path.clone(), member.clone()])
        }
        (None, None) => return None,
    })
}

pub(crate) struct SchemaField {
    /// The key it has in the JSON.
    pub key: String,
    pub ty: TokenStream,
    pub doc: String,
    /// What a left-out field is (`left_out`): the field's own default, or the container's.
    pub default: Option<TokenStream>,
    /// `skip_serializing_if` (written side): the field may be left out.
    pub skip_if: Option<TokenStream>,
    /// Whether the container has a default the field's value comes from.
    pub flatten: bool,
}

pub(crate) enum VShape {
    Unit,
    Newtype(TokenStream),
    Tuple(Vec<TokenStream>),
    Struct(Vec<SchemaField>),
}

pub(crate) struct SchemaVariant {
    pub name: String,
    pub doc: String,
    pub shape: VShape,
}

pub(crate) enum Tagging {
    External,
    Internal(String),
    Adjacent(String, String),
    Untagged,
}

pub(crate) enum Body {
    Object {
        fields: Vec<SchemaField>,
        deny_unknown: bool,
    },
    Tuple(Vec<TokenStream>),
    /// One value: a newtype or `#[serde(transparent)]`.
    Value(TokenStream),
    Unit,
    Enum {
        tagging: Tagging,
        variants: Vec<SchemaVariant>,
    },
}

/// The text of the `#[doc = ".."]` attributes among `attrs`, as rustdoc gives them to schemars:
/// one line each, without the space a `///` comment starts with.
pub(crate) fn doc(attrs: &[Group]) -> String {
    let mut lines = Vec::new();
    for attr in attrs {
        let tokens: Vec<TokenTree> = attr.stream().into_iter().collect();
        if !(is_ident(tokens.first(), "doc") && is_punct(tokens.get(1), '=')) {
            continue;
        }
        if let Some(TokenTree::Literal(l)) = tokens.get(2) {
            if let Some(text) = string_value(l) {
                lines.push(text.strip_prefix(' ').map(str::to_string).unwrap_or(text));
            }
        }
    }
    lines.join("\n")
}

fn schema_of(side: Side, ty: &TokenStream) -> TokenStream {
    let method = match side {
        Side::Write => "__write",
        Side::Read => "__read",
    };
    q(&format!("(&&__s::Probe::<__A0>::new()).{method}(__g)"), std::slice::from_ref(ty))
}

fn described(schema: TokenStream, doc: &str) -> TokenStream {
    if doc.trim().is_empty() {
        return schema;
    }
    q("__s::described(__A0, __A1)", &[schema, literal(doc)])
}

/// An object of `fields`: each one's schema (with its default and description), the
/// names it requires, then the members of flattened fields.
fn object(side: Side, fields: &[SchemaField], deny_unknown: bool) -> TokenStream {
    let mut steps = TokenStream::new();
    let mut flattens = TokenStream::new();
    for field in fields {
        if field.flatten {
            let method = match side {
                Side::Write => "__write_inline",
                Side::Read => "__read_inline",
            };
            flattens.extend(q(
                &format!("__o = __s::flatten(__o, (&&__s::Probe::<__A0>::new()).{method}(__g));"),
                std::slice::from_ref(&field.ty),
            ));
            continue;
        }
        let mut schema = schema_of(side, &field.ty);
        if let Some(default) = &field.default {
            let value = match &field.skip_if {
                Some(skip_if) => q(
                    "{
                        let __d: ::core::option::Option<__A0> = __A1;
                        __d.and_then(|__d| if __A2(&__d) { ::core::option::Option::None } else { (&&__s::Maybe(&__d)).__json() })
                    }",
                    &[field.ty.clone(), default.clone(), skip_if.clone()],
                ),
                None => q(
                    "{ let __d: ::core::option::Option<__A0> = __A1; __d.and_then(|__d| (&&__s::Maybe(&__d)).__json()) }",
                    &[field.ty.clone(), default.clone()],
                ),
            };
            schema = q("__s::with_default(__A0, __A1)", &[schema, value]);
        }
        let schema = described(schema, &field.doc);
        let key = literal(&field.key);
        steps.extend(q("__p.push((__A0, __A1));", &[key.clone(), schema]));
        let required = match side {
            Side::Write => {
                if field.skip_if.is_some() {
                    q("false", &[])
                } else {
                    q("true", &[])
                }
            }
            Side::Read => {
                if field.default.is_some() {
                    q("false", &[])
                } else {
                    q("!(&&__s::Probe::<__A0>::new()).__optional()", std::slice::from_ref(&field.ty))
                }
            }
        };
        steps.extend(q("if __A0 { __r.push(__A1); }", &[required, key]));
    }
    let deny = if deny_unknown { q("true", &[]) } else { q("false", &[]) };
    q(
        "{
            let mut __p: ::std::vec::Vec<(&str, __s::JsonValue)> = ::std::vec::Vec::new();
            let mut __r: ::std::vec::Vec<&str> = ::std::vec::Vec::new();
            __A0
            let mut __o = __s::object(__p, __r, __A1);
            __A2
            __o
        }",
        &[steps, deny, flattens],
    )
}

fn list(items: Vec<TokenStream>) -> TokenStream {
    let mut out = TokenStream::new();
    for item in items {
        out.extend(item);
        out.extend(q(",", &[]));
    }
    q("::std::vec![__A0]", &[out])
}

fn tuple(side: Side, types: &[TokenStream]) -> TokenStream {
    q("__s::tuple(__A0)", &[list(types.iter().map(|t| schema_of(side, t)).collect())])
}

fn enumeration(side: Side, tagging: &Tagging, variants: &[SchemaVariant]) -> TokenStream {
    let mut options = Vec::new();
    match tagging {
        Tagging::External => {
            // Unit variants without a description are one list of names; each other variant is
            // an option of its own.
            let names: Vec<&SchemaVariant> =
                variants.iter().filter(|v| matches!(v.shape, VShape::Unit) && v.doc.trim().is_empty()).collect();
            let names_schema = q("__s::names(__A0)", &[list(names.iter().map(|v| literal(&v.name)).collect())]);
            if names.len() == variants.len() {
                return names_schema;
            }
            if !names.is_empty() {
                options.push(names_schema);
            }
            for variant in variants {
                let name = literal(&variant.name);
                let schema = match &variant.shape {
                    VShape::Unit if variant.doc.trim().is_empty() => continue,
                    VShape::Unit => q("__s::constant(__A0)", &[name]),
                    VShape::Newtype(ty) => q("__s::keyed(__A0, __A1)", &[name, schema_of(side, ty)]),
                    VShape::Tuple(types) => q("__s::keyed(__A0, __A1)", &[name, tuple(side, types)]),
                    VShape::Struct(fields) => q("__s::keyed(__A0, __A1)", &[name, object(side, fields, false)]),
                };
                options.push(described(schema, &variant.doc));
            }
            q("__s::one_of(__A0)", &[list(options)])
        }
        Tagging::Internal(tag) => {
            for variant in variants {
                let inner = match &variant.shape {
                    VShape::Unit => q("__s::json!({ \"type\": \"object\" })", &[]),
                    VShape::Newtype(ty) => schema_of(side, ty),
                    VShape::Tuple(types) => tuple(side, types),
                    VShape::Struct(fields) => object(side, fields, false),
                };
                let schema = q("__s::tagged(__A0, __A1, __A2)", &[literal(tag), literal(&variant.name), inner]);
                options.push(described(schema, &variant.doc));
            }
            q("__s::one_of(__A0)", &[list(options)])
        }
        Tagging::Adjacent(tag, content) => {
            for variant in variants {
                let inner = match &variant.shape {
                    VShape::Unit => q("__s::json!({ \"type\": \"object\" })", &[]),
                    VShape::Newtype(ty) => q(
                        "__s::object(::std::vec![(__A0, __A1)], ::std::vec![__A0], false)",
                        &[literal(content), schema_of(side, ty)],
                    ),
                    VShape::Tuple(types) => q(
                        "__s::object(::std::vec![(__A0, __A1)], ::std::vec![__A0], false)",
                        &[literal(content), tuple(side, types)],
                    ),
                    VShape::Struct(fields) => q(
                        "__s::object(::std::vec![(__A0, __A1)], ::std::vec![__A0], false)",
                        &[literal(content), object(side, fields, false)],
                    ),
                };
                let schema = q("__s::tagged(__A0, __A1, __A2)", &[literal(tag), literal(&variant.name), inner]);
                options.push(described(schema, &variant.doc));
            }
            q("__s::one_of(__A0)", &[list(options)])
        }
        Tagging::Untagged => {
            for variant in variants {
                let schema = match &variant.shape {
                    VShape::Unit => q("__s::json!({ \"type\": \"null\" })", &[]),
                    VShape::Newtype(ty) => schema_of(side, ty),
                    VShape::Tuple(types) => tuple(side, types),
                    VShape::Struct(fields) => object(side, fields, false),
                };
                options.push(described(schema, &variant.doc));
            }
            q("__s::any_of(__A0)", &[list(options)])
        }
    }
}

/// The impl of `side`'s trait for the item, wrapped in `__if_types!`.
pub(crate) fn expand(
    side: Side,
    name: &Ident,
    impl_generics: &TokenStream,
    type_generics: &TokenStream,
    where_clause: &TokenStream,
    doc: &str,
    body: &Body,
) -> TokenStream {
    let inline = match body {
        Body::Object { fields, deny_unknown } => object(side, fields, *deny_unknown),
        Body::Tuple(types) => tuple(side, types),
        Body::Value(ty) => schema_of(side, ty),
        Body::Unit => q("__s::json!({ \"type\": \"null\" })", &[]),
        Body::Enum { tagging, variants } => enumeration(side, tagging, variants),
    };
    let inline = described(inline, doc);
    let mut item = q("#[automatically_derived] impl", &[]);
    item.extend(impl_generics.clone());
    item.extend(side.trait_path());
    item.extend(q("for", &[]));
    item.extend([TokenTree::Ident(name.clone())]);
    item.extend(type_generics.clone());
    item.extend(where_clause.clone());
    item.extend([TokenTree::Group(Group::new(
        proc_macro::Delimiter::Brace,
        q(
            "fn json_schema(__g: &mut ::corten::json::schema::Generator) -> ::corten::json::schema::__private::JsonValue {
                __g.define(__A3, ::core::any::type_name::<Self>(), __A0, |__g| <Self as __A1>::__inline(__g))
            }
            #[allow(unused_mut, unused_variables, clippy::all)]
            fn __inline(__g: &mut ::corten::json::schema::Generator) -> ::corten::json::schema::__private::JsonValue {
                use ::corten::json::schema::__private as __s;
                #[allow(unused_imports)]
                use ::corten::json::schema::__private::{
                    HasDefault as _, MaybeNot as _, MaybeSerialize as _, MaybeToJson as _, Missing as _, NoDefault as _, Read as _,
                    Written as _,
                };
                __A2
            }",
            &[
                literal(name.to_string().trim_start_matches("r#")),
                side.trait_path(),
                inline,
                q(if side == Side::Read { "true" } else { "false" }, &[]),
            ],
        ),
    ))]);
    q("::corten::__if_types! { __A0 }", &[item])
}
