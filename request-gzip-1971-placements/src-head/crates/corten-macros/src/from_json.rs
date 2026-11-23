//! `#[derive(FromJson)]`: a struct, or an enum of unit variants, read from JSON by Corten's reader,
//! with serde_json reading the text instead wherever the reader gives up.
//!
//! The generated `__read` matches each key against the field names (after `rename`, `rename_all`
//! and `alias`), reads a known field's value straight into its type and skips the rest. A
//! duplicate or missing field without a default gives up, so serde_json's answer (an error, or
//! `None` for an `Option`) is the one returned.
//!
//! `#[serde(...)]` is read once, by [`crate::deserialize::read_from_json`], and the reader and the
//! `Deserialize` it falls back to are both written from that reading, so the value is what that
//! `Deserialize` makes; an attribute that changes how serde reads in a way this does not follow is
//! a compile error.

use proc_macro::{Delimiter, Group, Ident, Literal, Span, TokenStream, TokenTree};

use crate::{
    derive::{parse_item, Item},
    deserialize::{read_from_json, transparent_field, Container, Field, Reading, Shape, UnitVariant},
    schema::{left_out, Body as Schema, DefaultValue, SchemaField, SchemaVariant, VShape},
    to_json::bounded,
    tokens::{err, q, Error},
};

pub fn expand(input: TokenStream) -> Result<TokenStream, Error> {
    let item = parse_item(input, "FromJson", true)?;
    let reading = read_from_json(&item, false)?;
    let mut out = impls(&item, &reading, false)?;
    // serde's `Deserialize`, the fallback, from the same reading: the type needs no
    // `#[derive(Deserialize)]` beside this one.
    out.extend(crate::deserialize::for_from_json(&item, &reading)?);
    Ok(out)
}

/// What `#[derive(Fields)]` and `#[derive(UrlValue)]` add, since they write the type's
/// `Deserialize` already: its `FromJson` (with corten's feature `json`) and schema (with
/// `types`), so the type is read from JSON with no derive beside theirs. A generic type's
/// `FromJson` is the trait's own body, which hands the text to serde_json, under the bounds that
/// make the type `DeserializeOwned`: the ones serde infers (`T: Default` for a defaulted `T`,
/// a bound on `T::Assoc`) are not one per parameter, and a reader written against them would
/// need each of them. Nothing for one whose `Deserialize` borrows from its input (a `FromJson`
/// is read into owned values), or one `FromJson` cannot read (an attribute it does not follow).
pub fn beside_deserialize(item: &Item) -> TokenStream {
    if crate::deserialize::struct_lends(item) {
        return TokenStream::new();
    }
    match read_from_json(item, true).and_then(|reading| impls(item, &reading, !item.impl_generics.is_empty())) {
        Ok(code) => q("::corten::__if_json! { __A0 }", &[code]),
        Err(_) => TokenStream::new(),
    }
}

/// The `FromJson` impl and its schema (feature `types`); with `by_serde`, the `FromJson` impl is
/// the trait's own body (serde_json reads the text) and its bounds are only the type's own. A
/// generic type's impl also asks for `Self: DeserializeOwned`, the trait's supertrait, on either
/// path: the bounds inferred for its `Deserialize` (`T: Default` for a defaulted `Vec<T>`) need
/// not follow from the ones here, the derive's own `Deserialize` included.
fn impls(item: &Item, reading: &Reading, by_serde: bool) -> Result<TokenStream, Error> {
    let container = &reading.container;
    let (body, schema) = match &reading.shape {
        Shape::Enum(variants) => {
            let (code, described) = enumeration(variants);
            // With `#[serde(other)]`, any word is one of the enum's.
            let schema = if variants.iter().any(|v| v.other) {
                Schema::Value(q("::std::string::String", &[]))
            } else {
                Schema::Enum { tagging: crate::schema::Tagging::External, variants: described }
            };
            (code, schema)
        }
        Shape::Named(fields) | Shape::Tuple(fields) if container.transparent => {
            let one = transparent_field(item, fields)?;
            (transparent(fields, one), Schema::Value(ty(one)))
        }
        Shape::Tuple(fields) => {
            let read: Vec<TokenStream> = fields.iter().filter(|f| !f.skip).map(ty).collect();
            let schema = match (fields.len() == 1, read.as_slice()) {
                (true, [only]) => Schema::Value(only.clone()),
                _ => Schema::Tuple(read),
            };
            (tuple(fields, item.name.span())?, schema)
        }
        Shape::Named(fields) => (
            object(container, fields),
            Schema::Object { fields: schema_fields(container, fields), deny_unknown: container.deny_unknown_fields },
        ),
        Shape::Unit => (
            q("if __r.null() { ::core::result::Result::Ok(Self) } else { ::core::result::Result::Err(::corten::json::__read::Fallback) }", &[]),
            Schema::Unit,
        ),
    };
    // Each type parameter must be FromJson itself (and describe itself, for the schema).
    let mut where_clause = if by_serde {
        item.where_clause.clone()
    } else {
        bounded(&item.impl_generics, &item.where_clause, "::corten::json::FromJson")
    };
    if !item.impl_generics.is_empty() {
        let last = where_clause.clone().into_iter().last();
        where_clause.extend(q(
            match last {
                None => "where",
                Some(TokenTree::Punct(p)) if p.as_char() == ',' => "",
                Some(_) => ",",
            },
            &[],
        ));
        where_clause.extend(q("Self: ::corten::__private::serde::de::DeserializeOwned", &[]));
    }
    let schema_where = bounded(&item.impl_generics, &item.where_clause, "::corten::json::schema::FromJsonSchema");
    let schema = crate::schema::expand(
        crate::schema::Side::Read,
        &item.name,
        &item.impl_generics,
        &item.type_generics,
        &schema_where,
        &crate::schema::doc(&item.attrs),
        &schema,
    );
    let mut out = q("#[automatically_derived] impl", &[]);
    out.extend(item.impl_generics.clone());
    out.extend(q("::corten::json::FromJson for", &[]));
    out.extend([TokenTree::Ident(item.name.clone())]);
    out.extend(item.type_generics.clone());
    out.extend(where_clause);
    out.extend([TokenTree::Group(Group::new(
        Delimiter::Brace,
        if by_serde {
            TokenStream::new()
        } else {
            q(
                "#[allow(unused_mut, unused_variables, unused_imports, clippy::all)]
            fn __read(__r: &mut ::corten::json::__read::Reader<'_>)
                -> ::core::result::Result<Self, ::corten::json::__read::Fallback> {
                use ::corten::json::__read::{ViaDeserialize as _, ViaFromJson as _};
                __A0
            }",
                &[body],
            )
        },
    ))]);
    out.extend(schema);
    // Naming a deprecated item warns no more than the item itself does, as serde_derive's.
    if crate::deserialize::allows_deprecated(&item.attrs) {
        return Ok(q("#[allow(deprecated)] const _: () = { __A0 };", &[out]));
    }
    Ok(out)
}

fn ty(field: &Field) -> TokenStream {
    field.written.clone()
}

fn var(index: usize) -> TokenStream {
    TokenTree::Ident(Ident::new(&format!("__f{index}"), Span::mixed_site())).into()
}

/// Reads the field's value: by its `FromJson` impl, or by serde_json from its text.
fn read(field: &Field) -> TokenStream {
    q("(&::corten::json::__read::Read::<__A0>::new()).__read(__r)?", &[ty(field)])
}

/// What a field the object leaves out (or a skipped one) is: its own default, the container's,
/// or (not skipped) what serde makes of a missing field.
fn fallback_value(container: &Container, field: &Field) -> TokenStream {
    let member: TokenStream = field.member.clone().into();
    match (&field.default, &container.default) {
        (Some(DefaultValue::Trait), _) => q("::core::default::Default::default()", &[]),
        (Some(DefaultValue::Path(path)), _) => q("__A0()", std::slice::from_ref(path)),
        (None, Some(_)) => q("__default.__A0", &[member]),
        (None, None) if field.skip => q("::core::default::Default::default()", &[]),
        (None, None) => q("::corten::json::__read::missing::<__A0>()?", &[ty(field)]),
    }
}

fn container_default(container: &Container) -> TokenStream {
    match &container.default {
        Some(DefaultValue::Trait) => q("let __default: Self = ::core::default::Default::default();", &[]),
        Some(DefaultValue::Path(path)) => q("let __default: Self = __A0();", std::slice::from_ref(path)),
        None => TokenStream::new(),
    }
}

/// The fields a read takes, as the schema describes them: by key, with what a left-out one is.
fn schema_fields(container: &Container, fields: &[Field]) -> Vec<SchemaField> {
    fields
        .iter()
        .filter(|f| !f.skip)
        .map(|f| SchemaField {
            key: f.primary.clone(),
            ty: ty(f),
            doc: f.doc.clone(),
            default: left_out(f.default.as_ref(), container.default.as_ref(), &ty(f), &f.member.clone().into()),
            skip_if: None,
            flatten: false,
        })
        .collect()
}

/// A key or a variant's word: its own name, or any of its aliases.
fn pattern(name: &str, aliases: &[String]) -> TokenStream {
    let mut pattern: TokenStream = TokenTree::Literal(Literal::byte_string(name.as_bytes())).into();
    for alias in aliases {
        pattern.extend(q("|", &[]));
        pattern.extend([TokenTree::Literal(Literal::byte_string(alias.as_bytes()))]);
    }
    pattern
}

/// A struct with named fields, from an object.
fn object(container: &Container, fields: &[Field]) -> TokenStream {
    if container.default.is_some() {
        return object_over_default(container, fields);
    }
    let mut vars = TokenStream::new();
    let mut arms = TokenStream::new();
    let mut build = TokenStream::new();
    for (index, field) in fields.iter().enumerate() {
        let member: TokenStream = field.member.clone().into();
        if field.skip {
            build.extend(q("__A0: __A1,", &[member, fallback_value(container, field)]));
            continue;
        }
        vars.extend(q("let mut __A0: ::core::option::Option<__A1> = ::core::option::Option::None;", &[var(index), ty(field)]));
        arms.extend(q(
            "__A0 => {
                if __A1.is_some() {
                    return ::core::result::Result::Err(::corten::json::__read::Fallback);
                }
                __A1 = ::core::option::Option::Some(__A2);
            }",
            &[pattern(&field.primary, &field.aliases), var(index), read(field)],
        ));
        build.extend(q(
            "__A0: match __A1 { ::core::option::Option::Some(v) => v, ::core::option::Option::None => __A2 },",
            &[member, var(index), fallback_value(container, field)],
        ));
    }
    let unknown = if container.deny_unknown_fields {
        q("_ => return ::core::result::Result::Err(::corten::json::__read::Fallback),", &[])
    } else {
        q("_ => __r.skip()?,", &[])
    };
    arms.extend(unknown);
    q(
        "__A0
        if __r.object()? {
            loop {
                match __r.key()? { __A1 }
                if !__r.more()? {
                    break;
                }
            }
        }
        __A2
        ::core::result::Result::Ok(Self { __A3 })",
        &[vars, arms, container_default(container), build],
    )
}

/// A struct with a container default, read over that default: each field the object has is
/// written in place, and one it leaves out keeps the default's value (or takes its own default).
fn object_over_default(container: &Container, fields: &[Field]) -> TokenStream {
    let mut vars = TokenStream::new();
    let mut arms = TokenStream::new();
    let mut after = TokenStream::new();
    for (index, field) in fields.iter().enumerate() {
        let member: TokenStream = field.member.clone().into();
        let own_default = match &field.default {
            Some(DefaultValue::Trait) => Some(q("::core::default::Default::default()", &[])),
            Some(DefaultValue::Path(path)) => Some(q("__A0()", std::slice::from_ref(path))),
            None => None,
        };
        if field.skip {
            if let Some(value) = own_default {
                after.extend(q("__out.__A0 = __A1;", &[member, value]));
            }
            continue;
        }
        vars.extend(q("let mut __A0 = false;", &[var(index)]));
        arms.extend(q(
            "__A0 => {
                if __A1 {
                    return ::core::result::Result::Err(::corten::json::__read::Fallback);
                }
                __A1 = true;
                __out.__A2 = __A3;
            }",
            &[pattern(&field.primary, &field.aliases), var(index), member.clone(), read(field)],
        ));
        if let Some(value) = own_default {
            after.extend(q("if !__A0 { __out.__A1 = __A2; }", &[var(index), member, value]));
        }
    }
    let unknown = if container.deny_unknown_fields {
        q("_ => return ::core::result::Result::Err(::corten::json::__read::Fallback),", &[])
    } else {
        q("_ => __r.skip()?,", &[])
    };
    arms.extend(unknown);
    let start = match &container.default {
        Some(DefaultValue::Path(path)) => q("__A0()", std::slice::from_ref(path)),
        _ => q("::core::default::Default::default()", &[]),
    };
    q(
        "let mut __out: Self = __A0;
        __A1
        if __r.object()? {
            loop {
                match __r.key()? { __A2 }
                if !__r.more()? {
                    break;
                }
            }
        }
        __A3
        ::core::result::Result::Ok(__out)",
        &[start, vars, arms, after],
    )
}

/// A tuple struct: one field is its value (serde's newtype), more are an array of exactly that
/// many.
fn tuple(fields: &[Field], span: Span) -> Result<TokenStream, Error> {
    if fields.iter().any(|f| f.skip || f.default.is_some()) {
        return err(span, "FromJson: skip and default in a tuple struct are not supported; derive Deserialize alone");
    }
    let mut build = TokenStream::new();
    if let [field] = fields {
        build.extend(q("0: __A0,", &[read(field)]));
        return Ok(q("::core::result::Result::Ok(Self { __A0 })", &[build]));
    }
    let mut steps = TokenStream::new();
    for (index, field) in fields.iter().enumerate() {
        let more = if index + 1 < fields.len() {
            q("if !__r.more_items()? { return ::core::result::Result::Err(::corten::json::__read::Fallback); }", &[])
        } else {
            q("if __r.more_items()? { return ::core::result::Result::Err(::corten::json::__read::Fallback); }", &[])
        };
        steps.extend(q("let __A0 = __A1; __A2", &[var(index), read(field), more]));
        build.extend(q("__A0: __A1,", &[field.member.clone().into(), var(index)]));
    }
    Ok(q(
        "if !__r.array()? {
            return ::core::result::Result::Err(::corten::json::__read::Fallback);
        }
        __A0
        ::core::result::Result::Ok(Self { __A1 })",
        &[steps, build],
    ))
}

/// `#[serde(transparent)]`: `one` (its [`transparent_field`]) is the value; each other field is
/// its default (a `PhantomData`'s is `PhantomData`).
fn transparent(fields: &[Field], one: &Field) -> TokenStream {
    let mut build = TokenStream::new();
    for field in fields {
        let value = if std::ptr::eq(field, one) {
            read(field)
        } else {
            match &field.default {
                Some(DefaultValue::Path(path)) => q("__A0()", std::slice::from_ref(path)),
                _ => q("::core::default::Default::default()", &[]),
            }
        };
        build.extend(q("__A0: __A1,", &[field.member.clone().into(), value]));
    }
    q("::core::result::Result::Ok(Self { __A0 })", &[build])
}

/// An enum of unit variants, from its name as a string, and each variant as the schema describes
/// it. A `UrlValue`'s `#[serde(other)]` variant is read by its own name: any other word gives up,
/// and serde's `Deserialize` reads it as that variant.
fn enumeration(variants: &[UnitVariant]) -> (TokenStream, Vec<SchemaVariant>) {
    let mut arms = TokenStream::new();
    let mut described = Vec::new();
    for v in variants {
        described.push(SchemaVariant { name: v.name.clone(), doc: v.doc.clone(), shape: VShape::Unit });
        arms.extend(q(
            "__A0 => ::core::result::Result::Ok(Self::__A1),",
            &[pattern(&v.name, &v.aliases), TokenTree::Ident(v.ident.clone()).into()],
        ));
    }
    let code = q(
        "match __r.name()? {
            __A0
            _ => ::core::result::Result::Err(::corten::json::__read::Fallback),
        }",
        &[arms],
    );
    (code, described)
}
