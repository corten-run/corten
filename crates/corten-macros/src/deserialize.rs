//! serde's `Deserialize` for a `#[derive(Fields)]` struct and a `#[derive(UrlValue)]` enum, so neither
//! needs `#[derive(Deserialize)]` beside it and an app needs no serde derive of its own. The impl is the one
//! serde_derive writes for the attributes these derives read: the same names (`rename`,
//! `rename_all`, `alias`), defaults, skipped fields and `other`, read from a map or a sequence (a
//! struct) or an enum's variant (an enum), with the same errors. An attribute that changes reading
//! in a way this does not follow is a compile error that says where the reading goes instead.

use std::collections::BTreeSet;

use proc_macro::{Delimiter, Group, Ident, Literal, Spacing, TokenStream, TokenTree};

use crate::{
    component::split,
    derive::{named_fields, Item},
    schema::DefaultValue,
    to_json::{field_rule, serde_args_for, type_params, Arg, Value, RULES},
    tokens::{err, q, string_value, Error},
};

/// Generated code as text, with `__A0`, `__A1`, .. where tokens that keep their own spans go (a
/// field's type, a default's path), so an error in them points at the user's code.
#[derive(Default)]
struct Code {
    text: String,
    args: Vec<TokenStream>,
}

impl Code {
    fn push(&mut self, text: &str) {
        self.text.push(' ');
        self.text.push_str(text);
    }

    fn hole(&mut self, tokens: TokenStream) {
        self.text.push_str(&format!(" __A{} ", self.args.len()));
        self.args.push(tokens);
    }

    fn tokens(self) -> TokenStream {
        q(&self.text, &self.args)
    }
}

fn lit(text: &str) -> String {
    Literal::string(text).to_string()
}

fn byte_lit(text: &str) -> String {
    Literal::byte_string(text.as_bytes()).to_string()
}

fn default_arg(derive: &str, arg: &Arg) -> Result<DefaultValue, Error> {
    match &arg.value {
        Value::Bare => Ok(DefaultValue::Trait),
        Value::Str(path) => match path.parse::<TokenStream>() {
            Ok(path) => Ok(DefaultValue::Path(path)),
            Err(_) => err(arg.span, format!("{derive}: default takes a function's path")),
        },
        Value::Group(_) => err(arg.span, format!("{derive}: use #[serde(default)] or #[serde(default = \"path\")]")),
    }
}

fn string_arg(derive: &str, arg: &Arg) -> Result<String, Error> {
    match &arg.value {
        Value::Str(s) => Ok(s.clone()),
        _ => err(arg.span, format!("{derive}: use #[serde({} = \"...\")], one name for reading and writing", arg.key)),
    }
}

/// `bound = "T: Trait"`, or the `deserialize` half of `bound(serialize = "..", deserialize = "..")`:
/// the where predicates reading takes instead of the ones serde would infer. `None` when only
/// writing has one.
fn bound_arg(derive: &str, arg: &Arg) -> Result<Option<TokenStream>, Error> {
    let usage = format!("{derive}: use #[serde(bound = \"T: Trait\")] or #[serde(bound(deserialize = \"T: Trait\"))]");
    let text = match &arg.value {
        Value::Str(text) => Some(text.clone()),
        Value::Bare => return err(arg.span, usage),
        Value::Group(inner) => {
            let mut found = None;
            for part in split(inner.clone(), ',') {
                let (Some(TokenTree::Ident(key)), Some(TokenTree::Punct(eq)), Some(TokenTree::Literal(text)), 3) =
                    (part.first(), part.get(1), part.get(2), part.len())
                else {
                    return err(arg.span, usage);
                };
                let (Some(text), '=') = (string_value(text), eq.as_char()) else { return err(arg.span, usage) };
                match key.to_string().as_str() {
                    "deserialize" => found = Some(text),
                    "serialize" => {}
                    _ => return err(key.span(), usage),
                }
            }
            found
        }
    };
    match text.map(|text| text.parse::<TokenStream>()) {
        None => Ok(None),
        Some(Ok(predicates)) => Ok(Some(predicates)),
        Some(Err(_)) => err(arg.span, format!("{derive}: a bound is where predicates, as in \"T: Default\"")),
    }
}

fn rule_arg(derive: &str, arg: &Arg) -> Result<String, Error> {
    let rule = string_arg(derive, arg)?;
    if !RULES.contains(&rule.as_str()) {
        return err(arg.span, format!("{derive}: unknown rename_all rule {rule:?}; serde's are {}", RULES.join(", ")));
    }
    Ok(rule)
}

/// What the container's attributes say about reading it.
#[derive(Default)]
struct Container {
    rename_all: Option<String>,
    default: Option<DefaultValue>,
    deny_unknown_fields: bool,
    /// The name serde reads the type by (`rename`), passed to the deserializer.
    rename: Option<String>,
    expecting: Option<String>,
    /// `bound`: the impl's where predicates in place of the inferred ones.
    bound: Option<TokenStream>,
}

impl Container {
    fn read(derive: &str, attrs: &[Group], is_enum: bool, unsupported: &dyn Fn(&Arg) -> Error) -> Result<Self, Error> {
        let mut c = Container::default();
        for arg in serde_args_for(attrs, derive)? {
            match arg.key.as_str() {
                "rename_all" => c.rename_all = Some(rule_arg(derive, &arg)?),
                "default" if !is_enum => c.default = Some(default_arg(derive, &arg)?),
                "deny_unknown_fields" => c.deny_unknown_fields = true,
                "rename" => c.rename = Some(string_arg(derive, &arg)?),
                "expecting" => c.expecting = Some(string_arg(derive, &arg)?),
                "bound" => c.bound = bound_arg(derive, &arg)?,
                // serde's own path (Corten's impl names serde itself), and what only writing uses.
                "crate" | "into" => {}
                _ => return Err(unsupported(&arg)),
            }
        }
        Ok(c)
    }
}

/// The impl's pieces: `impl<'de: 'a, 'a, T>` (each lifetime outlived by `'de`, as a field that
/// borrows needs), the type with its arguments, and the where clause with `T: Deserialize<'de>`.
struct Generics {
    /// `'de` and its bounds, then the item's own parameters: what goes inside `impl<..>`.
    params: TokenStream,
    /// `'de` and the type's arguments: a visitor's.
    visitor_args: TokenStream,
    /// The type's arguments, `<'a, T>` or nothing.
    type_args: TokenStream,
    where_clause: TokenStream,
}

/// The lifetimes a field borrows from the input, as serde_derive finds them: each `&'a` in its
/// type (a `&str` or `&[u8]`), or every lifetime in it with a bare `#[serde(borrow)]`.
fn borrowed(ty: &TokenStream, all: bool, out: &mut BTreeSet<String>) {
    let tokens: Vec<TokenTree> = ty.clone().into_iter().collect();
    for (i, token) in tokens.iter().enumerate() {
        match token {
            TokenTree::Group(g) => borrowed(&g.stream(), all, out),
            TokenTree::Punct(p) if p.as_char() == '\'' => {
                let after_ref = i > 0 && matches!(&tokens[i - 1], TokenTree::Punct(r) if r.as_char() == '&');
                if let (true, Some(TokenTree::Ident(name))) = (all || after_ref, tokens.get(i + 1)) {
                    out.insert(format!("'{name}"));
                }
            }
            _ => {}
        }
    }
}

/// `ty` out of the invisible groups a `macro_rules!` `$t:ty` wraps it in.
fn ungroup(ty: &TokenStream) -> TokenStream {
    let mut tokens = ty.clone().into_iter();
    match (tokens.next(), tokens.next()) {
        (Some(TokenTree::Group(g)), None) if g.delimiter() == Delimiter::None => ungroup(&g.stream()),
        _ => ty.clone(),
    }
}

/// Whether `ty` is an associated type of a type parameter (`T::Assoc`), which serde bounds itself.
fn is_associated(ty: &TokenStream, params: &[Ident]) -> bool {
    let mut tokens = ungroup(ty).into_iter();
    match (tokens.next(), tokens.next()) {
        (Some(TokenTree::Ident(first)), Some(TokenTree::Punct(colon))) => {
            colon.as_char() == ':' && params.iter().any(|p| p.to_string() == first.to_string())
        }
        _ => false,
    }
}

/// Whether `ty` is `Cow<'a, str>` or `Cow<'a, [u8]>` (by any path), the two types a
/// `#[serde(borrow)]` reads borrowed itself; any other type borrows by its own `Deserialize`.
fn is_borrowed_cow(ty: &TokenStream) -> bool {
    let tokens: Vec<TokenTree> = ungroup(ty).into_iter().collect();
    let Some(at) = tokens.iter().rposition(|t| matches!(t, TokenTree::Ident(id) if id.to_string() == "Cow")) else {
        return false;
    };
    let punct = |i: usize, c: char| matches!(tokens.get(i), Some(TokenTree::Punct(p)) if p.as_char() == c);
    let elem = match tokens.get(at + 5) {
        Some(TokenTree::Ident(id)) => id.to_string() == "str",
        Some(TokenTree::Group(g)) if g.delimiter() == Delimiter::Bracket => g.stream().to_string().trim() == "u8",
        _ => false,
    };
    tokens.len() == at + 7
        && punct(at + 1, '<')
        && punct(at + 2, '\'')
        && matches!(tokens.get(at + 3), Some(TokenTree::Ident(_)))
        && punct(at + 4, ',')
        && elem
        && punct(at + 6, '>')
}

/// `ty` with each `Self` in it the type itself: inside the visitor `Self` is the visitor.
fn without_self(ty: TokenStream, this: &TokenStream) -> TokenStream {
    ty.into_iter()
        .flat_map(|token| match token {
            TokenTree::Ident(id) if id.to_string() == "Self" => this.clone(),
            TokenTree::Group(g) => {
                let mut inner = Group::new(g.delimiter(), without_self(g.stream(), this));
                inner.set_span(g.span());
                TokenTree::Group(inner).into()
            }
            other => other.into(),
        })
        .collect()
}

/// The type parameters `ty` names as a whole path segment, as serde_derive finds them: not inside
/// `PhantomData<..>`, which reads whatever its parameter is.
fn named_params(ty: &TokenStream, params: &[Ident], out: &mut BTreeSet<String>) {
    let tokens: Vec<TokenTree> = ty.clone().into_iter().collect();
    let joint_colon = |t: Option<&TokenTree>| matches!(t, Some(TokenTree::Punct(p)) if p.as_char() == ':');
    let mut i = 0;
    while i < tokens.len() {
        match &tokens[i] {
            TokenTree::Group(g) => named_params(&g.stream(), params, out),
            TokenTree::Ident(id) if id.to_string() == "PhantomData" => {
                // Past its `<..>`.
                let mut depth = 0;
                let mut j = i + 1;
                while j < tokens.len() {
                    if let TokenTree::Punct(p) = &tokens[j] {
                        let after_dash =
                            matches!(&tokens[j - 1], TokenTree::Punct(d) if d.as_char() == '-' && d.spacing() == Spacing::Joint);
                        match p.as_char() {
                            '<' => depth += 1,
                            '>' if !after_dash => depth -= 1,
                            _ => {}
                        }
                    }
                    if depth == 0 {
                        break;
                    }
                    j += 1;
                }
                i = j;
            }
            TokenTree::Ident(id) => {
                let lifetime = i > 0 && matches!(&tokens[i - 1], TokenTree::Punct(p) if p.as_char() == '\'');
                let in_path = (i > 0 && joint_colon(tokens.get(i - 1))) || joint_colon(tokens.get(i + 1));
                let name = id.to_string();
                if !lifetime && !in_path && params.iter().any(|p| p.to_string() == name) {
                    out.insert(name);
                }
            }
            _ => {}
        }
        i += 1;
    }
}

/// The where clause serde_derive gives the impl: the item's own, each field's `bound`, then the
/// container's `bound` if it has one, else the inferred ones: `T: Deserialize<'de>` for each type
/// parameter a read field names (and `T::Assoc: Deserialize<'de>` for a field of that type),
/// `T: Default` for one a field defaulted by `Default` names (and `T::Assoc: Default`), and
/// `Type: Default` for a container `default`.
fn where_clause(item: &Item, container: &Container, fields: &[Field], this: &TokenStream) -> TokenStream {
    let mut predicates: Vec<TokenStream> = fields.iter().filter_map(|f| f.bound.clone()).collect();
    if let Some(bound) = &container.bound {
        predicates.push(bound.clone());
    } else {
        if matches!(container.default, Some(DefaultValue::Trait)) {
            let mut p = this.clone();
            p.extend(q(": ::core::default::Default", &[]));
            predicates.push(p);
        }
        let params = type_params(&item.impl_generics);
        let (mut read, mut default) = (BTreeSet::new(), BTreeSet::new());
        let (mut associated, mut associated_default) = (Vec::new(), Vec::new());
        for f in fields {
            if !f.skip && f.bound.is_none() {
                named_params(&f.ty, &params, &mut read);
                if is_associated(&f.ty, &params) {
                    associated.push(f.ty.clone());
                }
            }
            let by_default =
                matches!(f.default, Some(DefaultValue::Trait)) || (f.skip && f.default.is_none() && container.default.is_none());
            if by_default {
                named_params(&f.ty, &params, &mut default);
                if is_associated(&f.ty, &params) {
                    associated_default.push(f.ty.clone());
                }
            }
        }
        for param in params.iter().filter(|p| read.contains(&p.to_string())) {
            predicates.push(q("__A0: _serde::Deserialize<'de>", &[TokenTree::Ident(param.clone()).into()]));
        }
        for ty in associated {
            predicates.push(q("__A0: _serde::Deserialize<'de>", &[ty]));
        }
        for param in params.iter().filter(|p| default.contains(&p.to_string())) {
            predicates.push(q("__A0: ::core::default::Default", &[TokenTree::Ident(param.clone()).into()]));
        }
        for ty in associated_default {
            predicates.push(q("__A0: ::core::default::Default", &[ty]));
        }
    }
    let mut out = item.where_clause.clone();
    let mut first = true;
    for p in predicates.into_iter().filter(|p| !p.is_empty()) {
        if first && out.is_empty() {
            out.extend(q("where", &[]));
        } else if first && !matches!(out.clone().into_iter().last(), Some(TokenTree::Punct(c)) if c.as_char() == ',') {
            out.extend(q(",", &[]));
        }
        first = false;
        out.extend(p);
        out.extend(q(",", &[]));
    }
    out
}

/// `#[allow(deprecated)]` on the generated code when the item is `#[deprecated]` or allows it, as
/// serde_derive does, so naming the item there warns no more than the item itself does.
fn allows_deprecated(attrs: &[Group]) -> bool {
    attrs.iter().any(|attr| {
        let mut tokens = attr.stream().into_iter();
        match (tokens.next(), tokens.next()) {
            (Some(TokenTree::Ident(id)), _) if id.to_string() == "deprecated" => true,
            (Some(TokenTree::Ident(id)), Some(TokenTree::Group(args))) if id.to_string() == "allow" => {
                args.stream().into_iter().any(|t| matches!(t, TokenTree::Ident(lint) if lint.to_string() == "deprecated"))
            }
            _ => false,
        }
    })
}

fn generics(item: &Item, borrowed: &BTreeSet<String>, where_clause: TokenStream) -> Generics {
    let inner = |generics: &TokenStream| -> TokenStream {
        let tokens: Vec<TokenTree> = generics.clone().into_iter().collect();
        if tokens.len() < 2 {
            return TokenStream::new();
        }
        tokens[1..tokens.len() - 1].iter().cloned().collect()
    };
    let own = inner(&item.impl_generics);
    let lifetimes: Vec<String> = split(own.clone(), ',')
        .into_iter()
        .filter_map(|param| match (param.first(), param.get(1)) {
            (Some(TokenTree::Punct(p)), Some(TokenTree::Ident(id))) if p.as_char() == '\'' => Some(format!("'{id}")),
            _ => None,
        })
        .filter(|lifetime| borrowed.contains(lifetime))
        // A `&'static str` reads only from input that lives for ever, as serde_derive's
        // `Deserialize<'static>` does.
        .chain(borrowed.contains("'static").then(|| "'static".to_string()))
        .collect();
    let mut params = if lifetimes.is_empty() {
        q("'de", &[])
    } else {
        format!("'de: {}", lifetimes.join(" + ")).parse().expect("lifetimes parse")
    };
    let type_inner = inner(&item.type_generics);
    let mut visitor_args = q("'de", &[]);
    if !own.is_empty() {
        params.extend(q(",", &[]));
        params.extend(own);
        visitor_args.extend(q(",", &[]));
        visitor_args.extend(type_inner);
    }
    Generics { params, visitor_args, type_args: item.type_generics.clone(), where_clause }
}

/// `const _: () = { use serde; impl Deserialize for Name { fn deserialize(..) { body } } };`
fn wrap(item: &Item, g: &Generics, body: TokenStream) -> TokenStream {
    let mut code = Code::default();
    let deprecated = if allows_deprecated(&item.attrs) { "#[allow(deprecated)]" } else { "" };
    code.push(&format!("#[doc(hidden)] #[allow(non_upper_case_globals, unused_attributes, unused_qualifications, clippy::all)] {deprecated} const _: () = {{ use ::corten::__private::serde as _serde; #[automatically_derived] impl <"));
    code.hole(g.params.clone());
    code.push("> _serde::Deserialize<'de> for");
    code.hole(TokenTree::Ident(item.name.clone()).into());
    code.hole(g.type_args.clone());
    code.hole(g.where_clause.clone());
    code.push(
        "{ fn deserialize<__D: _serde::Deserializer<'de>>(__deserializer: __D) -> ::core::result::Result<Self, __D::Error> {",
    );
    code.hole(body);
    code.push("} } };");
    code.tokens()
}

/// `struct __Visitor<'de, ..> { .. }` and the head of its `Visitor` impl, up to and including
/// `expecting`; the caller adds the visit methods and closes the impl's brace.
fn visitor_head(code: &mut Code, item: &Item, g: &Generics, expecting: &str) {
    code.push("#[doc(hidden)] struct __Visitor <");
    code.hole(g.params.clone());
    code.push(">");
    code.hole(g.where_clause.clone());
    code.push("{ marker: ::core::marker::PhantomData<");
    code.hole(TokenTree::Ident(item.name.clone()).into());
    code.hole(g.type_args.clone());
    code.push(">, lifetime: ::core::marker::PhantomData<&'de ()>, } #[automatically_derived] impl <");
    code.hole(g.params.clone());
    code.push("> _serde::de::Visitor<'de> for __Visitor <");
    code.hole(g.visitor_args.clone());
    code.push(">");
    code.hole(g.where_clause.clone());
    code.push("{ type Value =");
    code.hole(TokenTree::Ident(item.name.clone()).into());
    code.hole(g.type_args.clone());
    code.push(&format!(
        "; fn expecting(&self, __formatter: &mut ::core::fmt::Formatter<'_>) -> ::core::fmt::Result {{ __formatter.write_str({}) }}",
        lit(expecting)
    ));
}

/// The identifier enum serde reads a key or a variant's name into: `__field0`.. for each
/// entry's names, and the value an unknown one is (`Ok(..)`) or its error. `list` names the
/// `FIELDS` or `VARIANTS` constant.
fn identifier(entries: &[BTreeSet<String>], extra: Option<&str>, unknown: Option<&str>, is_variant: bool) -> String {
    let what = if is_variant { "variant" } else { "field" };
    let list = if is_variant { "VARIANTS" } else { "FIELDS" };
    let mut variants = String::new();
    let mut u64_arms = String::new();
    let mut str_arms = String::new();
    let mut bytes_arms = String::new();
    for (i, names) in entries.iter().enumerate() {
        variants += &format!("__field{i},");
        u64_arms += &format!("{i}u64 => ::core::result::Result::Ok(__Field::__field{i}),");
        for name in names {
            str_arms += &format!("{} => ::core::result::Result::Ok(__Field::__field{i}),", lit(name));
            bytes_arms += &format!("{} => ::core::result::Result::Ok(__Field::__field{i}),", byte_lit(name));
        }
    }
    if let Some(extra) = extra {
        variants += extra;
        variants += ",";
    }
    let (u64_other, str_other, bytes_other) = match unknown {
        Some(known) => (known.to_string(), known.to_string(), known.to_string()),
        None => (
            format!(
                "::core::result::Result::Err(_serde::de::Error::invalid_value(_serde::de::Unexpected::Unsigned(__value), &{}))",
                lit(&format!("{what} index 0 <= i < {}", entries.len()))
            ),
            format!("::core::result::Result::Err(_serde::de::Error::unknown_{what}(__value, {list}))"),
            format!(
                "{{ let __value = &::std::string::String::from_utf8_lossy(__value); ::core::result::Result::Err(_serde::de::Error::unknown_{what}(__value, {list})) }}"
            ),
        ),
    };
    format!(
        "#[allow(non_camel_case_types)] #[doc(hidden)] enum __Field {{ {variants} }}
        #[doc(hidden)] struct __FieldVisitor;
        #[automatically_derived] impl<'de> _serde::de::Visitor<'de> for __FieldVisitor {{
            type Value = __Field;
            fn expecting(&self, __formatter: &mut ::core::fmt::Formatter<'_>) -> ::core::fmt::Result {{
                __formatter.write_str({expecting})
            }}
            fn visit_u64<__E: _serde::de::Error>(self, __value: ::core::primitive::u64) -> ::core::result::Result<__Field, __E> {{
                match __value {{ {u64_arms} _ => {u64_other} }}
            }}
            fn visit_str<__E: _serde::de::Error>(self, __value: &::core::primitive::str) -> ::core::result::Result<__Field, __E> {{
                match __value {{ {str_arms} _ => {str_other} }}
            }}
            fn visit_bytes<__E: _serde::de::Error>(self, __value: &[::core::primitive::u8]) -> ::core::result::Result<__Field, __E> {{
                match __value {{ {bytes_arms} _ => {bytes_other} }}
            }}
        }}
        #[automatically_derived] impl<'de> _serde::Deserialize<'de> for __Field {{
            #[inline]
            fn deserialize<__D: _serde::Deserializer<'de>>(__deserializer: __D) -> ::core::result::Result<Self, __D::Error> {{
                _serde::Deserializer::deserialize_identifier(__deserializer, __FieldVisitor)
            }}
        }}",
        expecting = lit(&format!("{what} identifier")),
    )
}

/// A list constant of every entry's names, each entry's in serde's (sorted) order.
fn names_const(name: &str, entries: &[BTreeSet<String>]) -> String {
    let names: Vec<String> = entries.iter().flatten().map(|n| lit(n)).collect();
    format!("#[doc(hidden)] const {name}: &'static [&'static ::core::primitive::str] = &[{}];", names.join(", "))
}

struct Field {
    member: Ident,
    ty: TokenStream,
    /// Its own name, which errors give.
    primary: String,
    /// Every name it is read by, its own among them, sorted as serde sorts them.
    names: BTreeSet<String>,
    default: Option<DefaultValue>,
    skip: bool,
    /// `#[serde(borrow)]` on a `Cow<'a, str>` or `Cow<'a, [u8]>`: read through
    /// `form::__private::Borrow`, borrowed from the input where it can be.
    borrow: bool,
    /// The lifetimes it borrows from the input.
    lent: BTreeSet<String>,
    /// `bound`: its where predicates in place of the inferred ones.
    bound: Option<TokenStream>,
}

/// `Deserialize` for a struct with named fields, as `#[derive(Fields)]` reads it.
pub fn for_struct(item: &Item) -> Result<TokenStream, Error> {
    const DERIVE: &str = "Fields";
    let unsupported = |arg: &Arg| {
        (
            arg.span,
            format!(
                "Fields: #[serde({})] changes how serde reads the form in a way Fields does not follow; give the field a type of its own that implements Deserialize",
                arg.key
            ),
        )
    };
    let container = Container::read(DERIVE, &item.attrs, false, &unsupported)?;
    let Some(body) = &item.body else {
        return err(item.name.span(), "Fields can only be derived for a struct with named fields");
    };
    let mut this: TokenStream = TokenTree::Ident(item.name.clone()).into();
    this.extend(item.type_generics.clone());
    let mut fields = Vec::new();
    for field in named_fields(body)? {
        let mut f = Field {
            member: field.ident.clone(),
            ty: without_self(field.ty.iter().cloned().collect(), &this),
            primary: String::new(),
            names: BTreeSet::new(),
            default: None,
            skip: false,
            borrow: false,
            lent: BTreeSet::new(),
            bound: None,
        };
        let mut borrows = false;
        let mut rename = None;
        let mut aliases = Vec::new();
        for arg in serde_args_for(&field.attrs, DERIVE)? {
            match arg.key.as_str() {
                "rename" => rename = Some(string_arg(DERIVE, &arg)?),
                "alias" => aliases.push(string_arg(DERIVE, &arg)?),
                "default" => f.default = Some(default_arg(DERIVE, &arg)?),
                "skip" | "skip_deserializing" => f.skip = true,
                "borrow" => {
                    borrows = true;
                    match &arg.value {
                        Value::Bare => borrowed(&f.ty, true, &mut f.lent),
                        Value::Str(lifetimes) => {
                            let mut in_type = BTreeSet::new();
                            borrowed(&f.ty, true, &mut in_type);
                            for lifetime in lifetimes.split('+').map(str::trim) {
                                let named = lifetime.strip_prefix('\'').is_some_and(|n| !n.is_empty());
                                if !named {
                                    return err(
                                        arg.span,
                                        format!("{DERIVE}: borrow takes lifetimes, as in borrow = \"'a + 'b\""),
                                    );
                                }
                                if !in_type.contains(lifetime) {
                                    return err(arg.span, format!("{DERIVE}: field {} does not have lifetime {lifetime}", field.name));
                                }
                                if !f.lent.insert(lifetime.to_string()) {
                                    return err(arg.span, format!("{DERIVE}: duplicate borrowed lifetime {lifetime}"));
                                }
                            }
                        }
                        Value::Group(_) => {
                            return err(arg.span, format!("{DERIVE}: use #[serde(borrow)] or #[serde(borrow = \"'a\")]"))
                        }
                    }
                    if f.lent.is_empty() {
                        return err(arg.span, format!("{DERIVE}: field {} has no lifetimes to borrow", field.name));
                    }
                }
                "bound" => f.bound = bound_arg(DERIVE, &arg)?,
                // Writing only.
                "skip_serializing" | "skip_serializing_if" | "serialize_with" | "getter" => {}
                _ => return Err(unsupported(&arg)),
            }
        }
        f.primary = rename
            .unwrap_or_else(|| container.rename_all.as_deref().map_or(field.name.clone(), |rule| field_rule(&field.name, rule)));
        f.names = aliases.into_iter().collect();
        f.names.insert(f.primary.clone());
        if borrows {
            f.borrow = is_borrowed_cow(&f.ty);
        } else {
            borrowed(&f.ty, false, &mut f.lent);
        }
        fields.push(f);
    }
    let lent: BTreeSet<String> = fields.iter().filter(|f| !f.skip).flat_map(|f| f.lent.iter().cloned()).collect();
    let g = generics(item, &lent, where_clause(item, &container, &fields, &this));
    let read: Vec<&Field> = fields.iter().filter(|f| !f.skip).collect();
    let entries: Vec<BTreeSet<String>> = read.iter().map(|f| f.names.clone()).collect();
    // As written (`r#type` stays raw) for the code and serde's messages, as serde_derive writes
    // them; without `r#` for the name it passes the deserializer.
    let path = item.name.to_string();
    let type_name = path.strip_prefix("r#").unwrap_or(&path);
    let expecting = container.expecting.clone().unwrap_or_else(|| format!("struct {path}"));

    let mut code = Code::default();
    let (extra, unknown) = if container.deny_unknown_fields {
        (None, None)
    } else {
        (Some("__ignore"), Some("::core::result::Result::Ok(__Field::__ignore)"))
    };
    code.push(&identifier(&entries, extra, unknown, false));
    visitor_head(&mut code, item, &g, &expecting);

    let let_default = |code: &mut Code| match &container.default {
        Some(DefaultValue::Trait) => code.push("let __default: Self::Value = ::core::default::Default::default();"),
        Some(DefaultValue::Path(path)) => {
            code.push("let __default: Self::Value =");
            code.hole(path.clone());
            code.push("();");
        }
        None => {}
    };
    // A field's own default, else the container's value for it; `None` when it has neither.
    let defaulted = |code: &mut Code, f: &Field| -> bool {
        match (&f.default, &container.default) {
            (Some(DefaultValue::Trait), _) => code.push("::core::default::Default::default()"),
            (Some(DefaultValue::Path(path)), _) => {
                code.hole(path.clone());
                code.push("()");
            }
            (None, Some(_)) => code.push(&format!("__default.{}", f.member)),
            (None, None) => return false,
        }
        true
    };
    let build = |code: &mut Code, defaulted: &dyn Fn(&mut Code, &Field) -> bool| {
        code.push(&format!("::core::result::Result::Ok({path} {{"));
        let mut index = 0;
        for f in &fields {
            code.push(&format!(" {}: ", f.member));
            if f.skip {
                if !defaulted(code, f) {
                    code.push("::core::default::Default::default()");
                }
            } else {
                code.push(&format!("__field{index}"));
                index += 1;
            }
            code.push(",");
        }
        code.push("})");
    };
    let value_ty = |code: &mut Code, f: &Field| {
        if f.borrow {
            code.push("::corten::form::__private::Borrow<");
            code.hole(f.ty.clone());
            code.push(">");
        } else {
            code.hole(f.ty.clone());
        }
    };
    let unwrap_borrow = |f: &Field| if f.borrow { ".0" } else { "" };

    // visit_seq: the fields in order, as serde reads a struct sent as a list. Its error names how
    // many it reads, unless the container's `expecting` says otherwise.
    let seq_expecting = match (&container.expecting, read.len()) {
        (Some(own), _) => own.clone(),
        (None, 1) => format!("{expecting} with 1 element"),
        (None, n) => format!("{expecting} with {n} elements"),
    };
    code.push("#[inline] fn visit_seq<__A: _serde::de::SeqAccess<'de>>(self, mut __seq: __A) -> ::core::result::Result<Self::Value, __A::Error> {");
    let_default(&mut code);
    for (index, f) in read.iter().enumerate() {
        code.push(&format!("let __field{index} = match _serde::de::SeqAccess::next_element::<"));
        value_ty(&mut code, f);
        code.push(&format!(
            ">(&mut __seq)? {{ ::core::option::Option::Some(__value) => __value{}, ::core::option::Option::None =>",
            unwrap_borrow(f)
        ));
        if !defaulted(&mut code, f) {
            code.push(&format!(
                "return ::core::result::Result::Err(_serde::de::Error::invalid_length({index}usize, &{}))",
                lit(&seq_expecting)
            ));
        }
        code.push("};");
    }
    build(&mut code, &defaulted);
    code.push("}");

    // visit_map: by key, each at most once.
    code.push("#[inline] fn visit_map<__A: _serde::de::MapAccess<'de>>(self, mut __map: __A) -> ::core::result::Result<Self::Value, __A::Error> {");
    for (index, f) in read.iter().enumerate() {
        code.push(&format!("let mut __field{index}: ::core::option::Option<"));
        code.hole(f.ty.clone());
        code.push("> = ::core::option::Option::None;");
    }
    code.push(
        "while let ::core::option::Option::Some(__key) = _serde::de::MapAccess::next_key::<__Field>(&mut __map)? { match __key {",
    );
    for (index, f) in read.iter().enumerate() {
        code.push(&format!(
            "__Field::__field{index} => {{ if ::core::option::Option::is_some(&__field{index}) {{ return ::core::result::Result::Err(<__A::Error as _serde::de::Error>::duplicate_field({})); }} __field{index} = ::core::option::Option::Some(_serde::de::MapAccess::next_value::<",
            lit(&f.primary)
        ));
        value_ty(&mut code, f);
        code.push(&format!(">(&mut __map)?{}); }}", unwrap_borrow(f)));
    }
    if !container.deny_unknown_fields {
        code.push("_ => { let _ = _serde::de::MapAccess::next_value::<_serde::de::IgnoredAny>(&mut __map)?; }");
    }
    code.push("} }");
    let_default(&mut code);
    for (index, f) in read.iter().enumerate() {
        code.push(&format!("let __field{index} = match __field{index} {{ ::core::option::Option::Some(__value) => __value, ::core::option::Option::None =>"));
        if !defaulted(&mut code, f) {
            code.push(&format!("::corten::form::__private::missing_field::<_, __A::Error>({})?", lit(&f.primary)));
        }
        code.push("};");
    }
    build(&mut code, &defaulted);
    code.push("} }");

    code.push(&names_const("FIELDS", &entries));
    let deserialize_name = container.rename.clone().unwrap_or_else(|| type_name.to_string());
    code.push(&format!(
        "_serde::Deserializer::deserialize_struct(__deserializer, {}, FIELDS, __Visitor {{ marker: ::core::marker::PhantomData, lifetime: ::core::marker::PhantomData }})",
        lit(&deserialize_name)
    ));
    Ok(wrap(item, &g, code.tokens()))
}

/// A unit variant as `#[derive(UrlValue)]` reads it: its names, and whether it is `#[serde(other)]`.
pub struct Variant {
    pub ident: Ident,
    pub names: BTreeSet<String>,
    pub other: bool,
}

/// `Deserialize` for an enum of unit variants, each read by its names: `variants` as
/// `#[derive(UrlValue)]` read them (the container's attributes are read again here).
pub fn for_unit_enum(item: &Item, variants: &[Variant]) -> Result<TokenStream, Error> {
    let unsupported = |arg: &Arg| {
        (arg.span, format!("UrlValue: #[serde({})] changes the words serde reads in a way UrlValue does not follow", arg.key))
    };
    let container = Container::read("UrlValue", &item.attrs, true, &unsupported)?;
    let mut this: TokenStream = TokenTree::Ident(item.name.clone()).into();
    this.extend(item.type_generics.clone());
    let g = generics(item, &BTreeSet::new(), where_clause(item, &container, &[], &this));
    let path = item.name.to_string();
    let type_name = path.strip_prefix("r#").unwrap_or(&path).to_string();
    let expecting = container.expecting.clone().unwrap_or_else(|| format!("enum {path}"));
    let entries: Vec<BTreeSet<String>> = variants.iter().map(|v| v.names.clone()).collect();
    let other = variants.iter().position(|v| v.other).map(|i| format!("::core::result::Result::Ok(__Field::__field{i})"));

    let mut code = Code::default();
    code.push(&identifier(&entries, None, other.as_deref(), true));
    visitor_head(&mut code, item, &g, &expecting);
    code.push("fn visit_enum<__A: _serde::de::EnumAccess<'de>>(self, __data: __A) -> ::core::result::Result<Self::Value, __A::Error> { match _serde::de::EnumAccess::variant(__data)? {");
    for (i, v) in variants.iter().enumerate() {
        code.push(&format!(
            "(__Field::__field{i}, __variant) => {{ _serde::de::VariantAccess::unit_variant(__variant)?; ::core::result::Result::Ok({path}::{}) }}",
            v.ident
        ));
    }
    code.push("} } }");
    code.push(&names_const("VARIANTS", &entries));
    let deserialize_name = container.rename.clone().unwrap_or(type_name);
    code.push(&format!(
        "_serde::Deserializer::deserialize_enum(__deserializer, {}, VARIANTS, __Visitor {{ marker: ::core::marker::PhantomData, lifetime: ::core::marker::PhantomData }})",
        lit(&deserialize_name)
    ));
    Ok(wrap(item, &g, code.tokens()))
}
