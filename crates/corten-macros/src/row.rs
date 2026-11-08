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

pub fn expand(input: TokenStream) -> Result<TokenStream, Error> {
    let item = parse_item(input, "Row", true)?;
    let (fields, named) = match (&item.body, &item.tuple, item.is_enum) {
        (Some(body), _, false) => (body, true),
        (_, Some(tuple), false) => (tuple, false),
        _ => return err(item.name.span(), USAGE),
    };
    if let Some(on_type) = item.attrs.iter().find(|g| is_ident(g.stream().into_iter().next().as_ref(), "row")) {
        return err(on_type.span(), "#[row(id)] goes on the field that identifies the row, not on the struct");
    }
    let mut id: Option<(TokenTree, String)> = None;
    for (index, field) in split(fields.stream(), ',').into_iter().enumerate() {
        let mut j = 0;
        let mut marked: Option<Span> = None;
        loop {
            match field.get(j) {
                Some(TokenTree::Punct(p)) if p.as_char() == '#' => {
                    if let Some(TokenTree::Group(g)) = field.get(j + 1) {
                        let inner: Vec<TokenTree> = g.stream().into_iter().collect();
                        if is_ident(inner.first(), "row") {
                            match (inner.get(1), inner.len()) {
                                (Some(TokenTree::Group(args)), 2)
                                    if args.delimiter() == Delimiter::Parenthesis && args.stream().to_string() == "id" =>
                                {
                                    marked = Some(g.span())
                                }
                                _ => return err(g.span(), "expected #[row(id)], on the field that identifies the row"),
                            }
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
    let mut this = TokenStream::from(TokenTree::Ident(item.name.clone()));
    this.extend(item.type_generics.clone());
    let mut out = q("#[automatically_derived] impl", &[]);
    out.extend(item.impl_generics.clone());
    out.extend(q("::corten::feed::Row for __A0", &[this]));
    out.extend(item.where_clause.clone());
    let mut body = q("#[inline] fn id(&self) -> &str", &[]);
    // `&self.<field>`, at the field, so an id that is not text is reported there; `self` is the
    // method's own, so a row a `macro_rules!` declares reads its field too.
    let at = member.span();
    let mut and = Punct::new('&', Spacing::Alone);
    and.set_span(at);
    let mut dot = Punct::new('.', Spacing::Alone);
    dot.set_span(at);
    let get: TokenStream =
        [TokenTree::Punct(and), TokenTree::Ident(Ident::new("self", Span::call_site())), TokenTree::Punct(dot), member]
            .into_iter()
            .collect();
    body.extend([TokenTree::Group(Group::new(Delimiter::Brace, get))]);
    out.extend([TokenTree::Group(Group::new(Delimiter::Brace, body))]);
    Ok(out)
}
