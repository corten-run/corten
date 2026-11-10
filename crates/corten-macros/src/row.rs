//! `#[derive(Row)]`: a feed row's `id`, the field marked `#[row(id)]`. The impl is the one an
//! app writes by hand (`fn id(&self) -> &str { &self.id }`); the row's `Clone` and `Serialize`
//! stay in its derive list, where Rust checks them and the trait's `Send`, `Sync` and
//! `'static` bounds.

use proc_macro::{Delimiter, Group, Ident, Literal, Punct, Spacing, Span, TokenStream, TokenTree};

use crate::{
    component::split,
    derive::parse_item,
    tokens::{err, is_ident, is_punct, q, Error},
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
/// not a member of its JSON.
const ROW_SERDE: [&str; 2] = ["into", "transparent"];

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
        if let Some(key) = serde_key(&inner, &ROW_SERDE) {
            return err(attr.span(), format!("#[serde({key})] writes the row as another value, so its id is not a member of the JSON a script reads the key from: a feed of the type it is written as derives Row on that type"));
        }
    }
    let mut id: Option<(TokenTree, String)> = None;
    for (index, field) in split(fields.stream(), ',').into_iter().enumerate() {
        let field = opened(field);
        let mut j = 0;
        let mut marked: Option<Span> = None;
        let mut skipped: Option<(Span, &str)> = None;
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
        let Some(span) = marked else { continue };
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
    Ok(item.impl_block("::corten::feed::Row", body))
}
