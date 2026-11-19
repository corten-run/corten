//! This pass adds type checks, not a second form lookup. The browser still finds the controls
//! that are actually in the document when a handler runs.

use std::collections::{hash_map::Entry, HashMap};

use proc_macro::{Delimiter, Ident, Span, TokenStream, TokenTree};

use super::{first_span, respan, Attr, Node};
use crate::tokens::{is_punct, q, stream};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Input,
    Checkable,
    Inputs,
    Select,
    Textarea,
    Unknown,
}

impl Kind {
    fn marker(self) -> Option<&'static str> {
        match self {
            Self::Input | Self::Checkable => Some("el::HTMLInputElement"),
            Self::Inputs => Some("ts::Array<::corten::script::el::HTMLInputElement>"),
            Self::Select => Some("el::HTMLSelectElement"),
            Self::Textarea => Some("el::HTMLTextAreaElement"),
            Self::Unknown => None,
        }
    }
}

type Form = usize;

struct Element<'a> {
    tag: &'a str,
    attrs: &'a mut [Attr],
    scope: usize,
    around: Option<Form>,
    own: Option<Form>,
}

struct Owner {
    form: Form,
    needs_id: bool,
}

struct Control {
    kind: Kind,
    needs_id: bool,
}

#[derive(Default)]
struct Scan<'a> {
    elements: Vec<Element<'a>>,
    forms: usize,
    scopes: usize,
}

/// The typed IDs a `form={..}` check relies on. The attribute's address is only an identity:
/// the node tree is not rearranged between this pass and writing its attributes.
#[derive(Default)]
pub(super) struct Proofs {
    pub(super) lets: TokenStream,
    ids: HashMap<*const Attr, TokenStream>,
}

impl Proofs {
    fn bind(&mut self, attr: *const Attr, witness: TokenStream) {
        if let Entry::Vacant(entry) = self.ids.entry(attr) {
            self.lets.extend(q("let __A0 = ::core::marker::PhantomData;", std::slice::from_ref(&witness)));
            entry.insert(witness);
        }
    }

    pub(super) fn infer(&self, attr: &Attr) -> Option<TokenStream> {
        let witness = self.ids.get(&(attr as *const Attr))?;
        let Attr::Expr(_, id) = attr else { return None };
        Some(q("if false { ::corten::script::__private::form_id_type(__A0, &(__A1)); }", &[witness.clone(), id.clone()]))
    }
}

pub(super) fn check(nodes: &mut [Node]) -> Proofs {
    let mut scan = Scan::default();
    let mut scope = 0;
    scan.walk(nodes, &mut scope, None, false);
    scan.finish()
}

impl<'a> Scan<'a> {
    fn next_scope(&mut self) -> usize {
        self.scopes += 1;
        self.scopes
    }

    fn walk(&mut self, nodes: &'a mut [Node], scope: &mut usize, mut around: Option<Form>, in_table: bool) {
        for node in nodes {
            match node {
                Node::Element { name, attrs, children } => {
                    let table_part = ["thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col"]
                        .iter()
                        .any(|tag| name.eq_ignore_ascii_case(tag));
                    // Outside a cell/caption, HTML's table parser can move or drop other tags.
                    if in_table && !table_part {
                        continue;
                    }
                    let own = if name.eq_ignore_ascii_case("form") {
                        // The HTML parser can drop a nested form's start tag and close the
                        // outer one at its end tag. Do not infer an owner from either.
                        if around.is_some() {
                            around = None;
                            *scope = self.next_scope();
                            continue;
                        }
                        self.forms += 1;
                        Some(self.forms)
                    } else {
                        None
                    };
                    self.elements.push(Element { tag: name, attrs, scope: *scope, around, own });
                    let inner = own.or(around);
                    if !["template", "svg", "math"].iter().any(|tag| name.eq_ignore_ascii_case(tag))
                        && !super::may_read_as_text(super::Parsing::Unknown, name)
                    {
                        let in_cell = ["td", "th", "caption"].iter().any(|tag| name.eq_ignore_ascii_case(tag));
                        self.walk(children, scope, inner, (in_table && !in_cell) || name.eq_ignore_ascii_case("table"));
                    }
                }
                // Different arms can bind different variables, and do not draw together.
                Node::Block { bodies, .. } => {
                    for body in bodies {
                        let mut branch = self.next_scope();
                        self.walk(body, &mut branch, around, in_table);
                    }
                }
                // Do not match uses of a binding on opposite sides of a possible shadow.
                Node::Let(_) => *scope = self.next_scope(),
                // A component's children need not land in the form where it is written.
                Node::Component { .. } | Node::Expr(_) | Node::Markup(_) | Node::Text(_) => {}
            }
        }
    }

    fn finish(mut self) -> Proofs {
        let mut proofs = Proofs::default();
        if self.forms == 0 || !self.elements.iter().any(|el| el.attrs.iter().any(|a| matches!(a, Attr::On(..)))) {
            return proofs;
        }
        let mut ids = HashMap::new();
        let mut form_ids = HashMap::new();
        for el in &self.elements {
            if let Ok(Some(attr)) = attribute(el.attrs, "id") {
                if let Some(id) = key(attr) {
                    ids.entry((el.scope, id)).and_modify(|owner| *owner = None).or_insert(el.own);
                    if let (Some(form), Attr::Expr(..)) = (el.own, attr) {
                        form_ids.insert(form, attr as *const Attr);
                    }
                }
            }
        }
        let owner = |el: &Element<'_>| {
            let implicit = |form| Owner { form, needs_id: false };
            if el.own.is_some() || (!listed(el.tag) && !el.tag.contains('-')) {
                return el.own.or(el.around).map(implicit);
            }
            match attribute(el.attrs, "form") {
                Ok(None) => el.around.map(implicit),
                Ok(Some(attr)) if listed(el.tag) => {
                    let id = key(attr)?;
                    let form = ids.get(&(el.scope, id)).copied().flatten()?;
                    Some(Owner { form, needs_id: matches!(attr, Attr::Expr(..)) })
                }
                // Unknown spread or a custom element whose form association the macro can't see.
                _ => None,
            }
        };
        let mut controls: HashMap<_, HashMap<_, Control>> = HashMap::new();
        for el in &self.elements {
            if !listed(el.tag) {
                continue;
            }
            if let (Some(owner), Ok(Some(Attr::Expr(_, name)))) = (owner(el), attribute(el.attrs, "name")) {
                let kind = control_kind(el);
                controls
                    .entry((owner.form, el.scope))
                    .or_default()
                    .entry(expr_key(name))
                    .and_modify(|old| {
                        old.kind = match (old.kind, kind) {
                            (Kind::Checkable | Kind::Inputs, Kind::Checkable) => Kind::Inputs,
                            _ => Kind::Unknown,
                        };
                        old.needs_id |= owner.needs_id;
                    })
                    .or_insert(Control { kind, needs_id: owner.needs_id });
            }
        }
        for el in &mut self.elements {
            let Some(owner) = owner(el) else { continue };
            let Some(kinds) = controls.get(&(owner.form, el.scope)) else { continue };
            let form = form_ids.get(&owner.form).map(|&at| {
                let witness = Ident::new(&format!("__corten_form_id_{}", owner.form), Span::mixed_site());
                (at, stream([witness.into()]))
            });
            for attr in el.attrs.iter_mut() {
                let Attr::On(_, _, expr) = attr else { continue };
                let Some((checked, used_id)) = handler(expr, kinds, &owner, form.as_ref().map(|(_, id)| id)) else { continue };
                *expr = checked;
                if let (true, Some((at, id))) = (used_id, &form) {
                    proofs.bind(*at, id.clone());
                }
            }
        }
        proofs
    }
}

fn listed(tag: &str) -> bool {
    ["button", "fieldset", "input", "object", "output", "select", "textarea"].iter().any(|n| tag.eq_ignore_ascii_case(n))
}

/// An earlier spread may write the attribute the browser keeps.
fn attribute<'a>(attrs: &'a [Attr], name: &str) -> Result<Option<&'a Attr>, ()> {
    for attr in attrs {
        match attr {
            Attr::Spread(_) => return Err(()),
            Attr::Bare(n) | Attr::Static(n, _) | Attr::Expr(n, _) if n.eq_ignore_ascii_case(name) => {
                return Ok(Some(attr));
            }
            _ => {}
        }
    }
    Ok(None)
}

#[derive(PartialEq, Eq, Hash)]
enum IdKey {
    Expr(String),
    Text(String),
}

fn key(attr: &Attr) -> Option<IdKey> {
    match attr {
        // Only a place or path offers a name to match, not a computed ID.
        Attr::Expr(_, expr)
            if unparen(expr.clone())
                .into_iter()
                .all(|t| matches!(t, TokenTree::Ident(_)) || is_punct(Some(&t), ':') || is_punct(Some(&t), '.')) =>
        {
            Some(IdKey::Expr(expr_key(expr)))
        }
        Attr::Static(_, value) if !value.is_empty() => Some(IdKey::Text(value.clone())),
        _ => None,
    }
}

fn unparen(expr: TokenStream) -> TokenStream {
    let mut tokens = expr.clone().into_iter();
    match (tokens.next(), tokens.next()) {
        (Some(TokenTree::Group(g)), None) if g.delimiter() == Delimiter::Parenthesis => unparen(g.stream()),
        _ => expr,
    }
}

fn expr_key(expr: &TokenStream) -> String {
    unparen(expr.clone()).to_string()
}

fn control_kind(el: &Element<'_>) -> Kind {
    if el.tag.eq_ignore_ascii_case("select") {
        Kind::Select
    } else if el.tag.eq_ignore_ascii_case("textarea") {
        Kind::Textarea
    } else if el.tag.eq_ignore_ascii_case("input") {
        match attribute(el.attrs, "type") {
            Ok(Some(Attr::Static(_, ty))) if ty.eq_ignore_ascii_case("image") => Kind::Unknown,
            Ok(Some(Attr::Static(_, ty))) if ty.eq_ignore_ascii_case("checkbox") || ty.eq_ignore_ascii_case("radio") => {
                Kind::Checkable
            }
            Ok(Some(Attr::Static(..) | Attr::Bare(_)) | None) => Kind::Input,
            _ => Kind::Unknown,
        }
    } else {
        Kind::Unknown
    }
}

/// The direct arguments of a call written as a path followed by parentheses. Keep the original
/// call and prove its argument types separately, so an ordinary Rust function can keep its API.
fn handler(
    expr: &TokenStream,
    kinds: &HashMap<String, Control>,
    owner: &Owner,
    form_id: Option<&TokenStream>,
) -> Option<(TokenStream, bool)> {
    let call = unparen(expr.clone());
    let mut tokens: Vec<_> = call.clone().into_iter().collect();
    let Some(TokenTree::Group(args)) = tokens.pop() else { return None };
    if args.delimiter() != Delimiter::Parenthesis
        || !matches!(tokens.last(), Some(TokenTree::Ident(_)))
        || !tokens[..tokens.len() - 1].chunks_exact(3).remainder().is_empty()
        || !tokens[..tokens.len() - 1]
            .chunks_exact(3)
            .all(|t| matches!(t[0], TokenTree::Ident(_)) && is_punct(t.get(1), ':') && is_punct(t.get(2), ':'))
    {
        return None;
    }
    // An unparenthesized closure can own a comma in this token group. Leave such a call alone.
    if args.stream().into_iter().any(|t| is_punct(Some(&t), '|')) {
        return None;
    }
    let args = crate::component::variants(args.stream());
    let bind = stream([Ident::new("__corten_bind", Span::mixed_site()).into()]);
    let mut checks = TokenStream::new();
    let mut used_id = false;
    for (i, arg) in args.iter().enumerate() {
        let arg = stream(arg.iter().cloned());
        let Some(control) = kinds.get(&expr_key(&arg)) else { continue };
        let Some(marker) = control.kind.marker() else { continue };
        let pos = crate::script::arg_position(i, args.len());
        let at = first_span(&arg);
        let mut check = q(
            &format!("::corten::script::__private::FieldCheck::<_, __A0, ::corten::script::{marker}>::new(&__A1)"),
            &[pos, bind.clone()],
        );
        if owner.needs_id || control.needs_id {
            let Some(id) = form_id else { continue };
            check.extend(q(".in_form(__A0)", std::slice::from_ref(id)));
            used_id = true;
        }
        check.extend(respan(q(".check();", &[]), at));
        checks.extend(check);
    }
    if checks.is_empty() {
        return None;
    }
    let checked = q(
        "match __A0 {
            __A2 => {
                if false {
                    #[allow(unused_imports)]
                    use ::corten::script::__private::UncheckedField as _;
                    __A1
                }
                __A2
            }
        }",
        &[call, checks, bind],
    );
    Some((checked, used_id))
}
