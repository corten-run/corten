//! `#[derive(Row)]`: a feed row's `id`, the field marked `#[row(id)]`. The impl is the one an
//! app writes by hand (`fn id(&self) -> &str { &self.id }`); the row's `Clone` and `Serialize`
//! stay in its derive list, where Rust checks them and the trait's `Send`, `Sync` and
//! `'static` bounds.

use proc_macro::{Delimiter, Group, Ident, Literal, Punct, Spacing, Span, TokenStream, TokenTree};

use crate::{
    component::split,
    derive::parse_item,
    to_json::{field_rule, serde_args_for, type_params, Arg, Value, RULES},
    tokens::{err, is_ident, is_punct, q, string_value, Error},
};

const USAGE: &str = "Row is derived for a struct, and its id is the field marked #[row(id)]: a String, or another type that derefs to str (implement Row by hand for an enum)";

/// Tokens with each invisible group (`Delimiter::None`, which a `macro_rules!` wraps a `$v:vis`,
/// `$m:meta` or `$t:ty` it passes in) opened in place.
fn opened(tokens: Vec<TokenTree>) -> Vec<TokenTree> {
    let mut out = Vec::with_capacity(tokens.len());
    for token in tokens {
        match token {
            TokenTree::Group(g) if g.delimiter() == Delimiter::None => out.extend(opened(g.stream().into_iter().collect())),
            other => out.push(other),
        }
    }
    out
}

/// The serde attribute keys on the id field that leave it out of the JSON a script reads the key
/// from, write it as something other than the text `id()` returns, or read it back as something
/// else in a replica.
const ID_SERDE: [&str; 8] = [
    "skip",
    "skip_serializing",
    "skip_serializing_if",
    "skip_deserializing",
    "with",
    "serialize_with",
    "deserialize_with",
    "flatten",
];

/// The serde attribute keys on the struct that write the row as another value, so its id field is
/// not a member of its JSON, or read it as another value converted, so a replica's row need not
/// have the id the patches name.
const ROW_SERDE: [&str; 4] = ["into", "transparent", "from", "try_from"];

/// An attribute's contents with its invisible groups opened, as a `#[..]`'s brackets again.
fn opened_attr(attr: &Group) -> Group {
    Group::new(Delimiter::Bracket, opened(attr.stream().into_iter().collect()).into_iter().collect())
}

/// What a `rename` or `rename_all` names for writing: `key = "x"` or `key(serialize = "x")`.
fn written(arg: &Arg) -> Option<String> {
    match &arg.value {
        Value::Str(s) => Some(s.clone()),
        Value::Group(inner) => split(inner.clone(), ',').into_iter().map(opened).find_map(|part| match part.as_slice() {
            [TokenTree::Ident(k), TokenTree::Punct(p), TokenTree::Literal(l)]
                if k.to_string() == "serialize" && p.as_char() == '=' =>
            {
                string_value(l)
            }
            _ => None,
        }),
        Value::Bare => None,
    }
}

/// The first of `keys` a `#[serde(..)]` attribute's contents name, if any.
fn serde_key(inner: &[TokenTree], keys: &[&'static str]) -> Option<&'static str> {
    if !is_ident(inner.first(), "serde") {
        return None;
    }
    let Some(TokenTree::Group(args)) = inner.get(1) else { return None };
    split(args.stream(), ',').into_iter().map(opened).find_map(|arg| keys.iter().copied().find(|key| is_ident(arg.first(), key)))
}

pub fn expand(input: TokenStream) -> Result<TokenStream, Error> {
    let item = parse_item(input, "Row", true)?;
    let (fields, named) = match (&item.body, &item.tuple, item.is_enum) {
        (Some(body), _, false) => (body, true),
        (_, Some(tuple), false) => (tuple, false),
        (None, None, false) => {
            return err(
                item.name.span(),
                "Row is derived for a struct with a field that identifies the row, marked #[row(id)]; a unit struct has none",
            )
        }
        _ => return err(item.name.span(), USAGE),
    };
    for attr in &item.attrs {
        let inner = opened(attr.stream().into_iter().collect());
        if is_ident(inner.first(), "row") {
            return err(attr.span(), "#[row(id)] goes on the field that identifies the row, not on the struct");
        }
        match serde_key(&inner, &ROW_SERDE) {
            Some(key @ ("into" | "transparent")) => {
                return err(attr.span(), format!("#[serde({key})] writes the row as another value, so its id is not a member of the JSON a script reads the key from: a feed of the type it is written as derives Row on that type"));
            }
            Some(key) => {
                return err(attr.span(), format!("#[serde({key})] reads the row as another value and converts it, so a replica's row can hold an id other than the one its patches name: a feed of the type it is read as derives Row on that type"));
            }
            None => {}
        }
    }
    // The struct's `rename_all` and `tag` as serde writes them; a malformed one is serde's to report.
    let container: Vec<Arg> = serde_args_for(&item.attrs.iter().map(opened_attr).collect::<Vec<_>>(), "Row").unwrap_or_default();
    let rule = container.iter().filter(|a| a.key == "rename_all").find_map(written).filter(|r| RULES.contains(&r.as_str()));
    let tag = container.iter().find(|a| a.key == "tag").and_then(written);
    // Each other written field's JSON key, to find one that takes the id's place.
    let mut keys: Vec<(String, Span)> = Vec::new();
    let mut id_key: Option<(String, Span)> = None;
    let mut id: Option<(TokenTree, String)> = None;
    for (index, field) in split(fields.stream(), ',').into_iter().enumerate() {
        let field = opened(field);
        let mut j = 0;
        let mut marked: Option<Span> = None;
        let mut skipped: Option<(Span, &str)> = None;
        let mut attrs: Vec<Group> = Vec::new();
        loop {
            match field.get(j) {
                Some(TokenTree::Punct(p)) if p.as_char() == '#' => {
                    if let Some(TokenTree::Group(g)) = field.get(j + 1) {
                        let inner = opened(g.stream().into_iter().collect());
                        if is_ident(inner.first(), "row") {
                            match (inner.get(1), inner.len()) {
                                (Some(TokenTree::Group(args)), 2)
                                    if args.delimiter() == Delimiter::Parenthesis && args.stream().to_string() == "id" =>
                                {
                                    if marked.is_some() {
                                        return err(g.span(), "this field is already marked #[row(id)]");
                                    }
                                    marked = Some(g.span())
                                }
                                _ => return err(g.span(), "expected #[row(id)], on the field that identifies the row"),
                            }
                        } else if let Some(key) = serde_key(&inner, &ID_SERDE) {
                            skipped = Some((g.span(), key));
                        }
                        attrs.push(opened_attr(g));
                    }
                    j += 2;
                }
                Some(TokenTree::Ident(word)) if word.to_string() == "pub" => {
                    j += 1;
                    if matches!(field.get(j), Some(TokenTree::Group(g)) if g.delimiter() == Delimiter::Parenthesis) {
                        j += 1;
                    }
                }
                _ => break,
            }
        }
        // The field's JSON key, when it has one of its own (named, written, not flattened).
        let key = match (named, field.get(j)) {
            (true, Some(TokenTree::Ident(name))) => {
                let args = serde_args_for(&attrs, "Row").unwrap_or_default();
                let left_out = args.iter().any(|a| matches!(a.key.as_str(), "skip" | "skip_serializing" | "flatten"));
                let name = name.to_string();
                let name = name.strip_prefix("r#").unwrap_or(&name);
                let key = args.iter().filter(|a| a.key == "rename").find_map(written).unwrap_or_else(|| match &rule {
                    Some(rule) => field_rule(name, rule),
                    None => name.to_string(),
                });
                (!left_out).then(|| (key, field.get(j).map_or_else(Span::call_site, TokenTree::span)))
            }
            _ => None,
        };
        let Some(span) = marked else {
            keys.extend(key);
            continue;
        };
        id_key = key;
        if let Some((at, key)) = skipped {
            return err(at, format!("#[serde({key})] on the id: the id is the key a script and a replica read from the row's JSON, as the text `id()` returns, so serde writes and reads it as it is"));
        }
        // The member as the code names it, spanned at the field so a wrong type is reported there.
        let member = if named {
            match (field.get(j), is_punct(field.get(j + 1), ':')) {
                (Some(TokenTree::Ident(name)), true) => TokenTree::Ident(name.clone()),
                _ => return err(span, "expected a named field after #[row(id)]"),
            }
        } else {
            let mut index = Literal::usize_unsuffixed(index);
            index.set_span(field.get(j).map_or(span, TokenTree::span));
            TokenTree::Literal(index)
        };
        let name = member.to_string();
        if let Some((_, first)) = &id {
            return err(span, format!("a row has one id, and `{first}` is already marked #[row(id)]"));
        }
        id = Some((member, name));
    }
    let Some((member, _)) = id else {
        return err(item.name.span(), "mark the field that identifies a row #[row(id)]: the key its upserts and removes name");
    };
    if let Some((id_key, _)) = &id_key {
        if let Some((_, at)) = keys.iter().find(|(key, _)| key == id_key) {
            return err(*at, format!("this field is written as \"{id_key}\" too, the id's key, so a script reads it in the id's place: rename one of them"));
        }
        if tag.as_ref() == Some(id_key) {
            return err(item.name.span(), format!("#[serde(tag = \"{id_key}\")] writes the struct's name as \"{id_key}\", the id's key, so a script reads it in the id's place: rename one of them"));
        }
    }
    let mut body = q("#[inline] fn id(&self) -> &str", &[]);
    // `&self.<field>`, at the field, so an id that is not text is reported there; `self` has the
    // method's hygiene (located at the field), so a row a `macro_rules!` declares reads it too.
    let at = member.span();
    let mut and = Punct::new('&', Spacing::Alone);
    and.set_span(at);
    let mut dot = Punct::new('.', Spacing::Alone);
    dot.set_span(at);
    let get: TokenStream = [
        TokenTree::Punct(and),
        TokenTree::Ident(Ident::new("self", Span::call_site().located_at(at))),
        TokenTree::Punct(dot),
        member,
    ]
    .into_iter()
    .collect();
    body.extend([TokenTree::Group(Group::new(Delimiter::Brace, get))]);
    if type_params(&item.impl_generics).is_empty() {
        return Ok(item.impl_block("::corten::feed::Row", body));
    }
    // A generic row is one for each type argument that makes it what the trait asks, so its
    // parameters need no bounds on the struct; a feed of a row that is not is refused where it is
    // built.
    let mut bounds: TokenStream = [TokenTree::Ident(item.name.clone())].into_iter().collect();
    bounds.extend(item.type_generics.clone());
    bounds.extend(q(
        ": ::corten::__private::serde::Serialize + ::core::clone::Clone + ::core::marker::Send + ::core::marker::Sync + 'static,",
        &[],
    ));
    Ok(item.impl_block_where("::corten::feed::Row", bounds, body))
}
