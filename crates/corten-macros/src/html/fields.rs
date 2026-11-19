//! This pass adds type checks, not a second form lookup. The browser still finds the controls
//! that are actually in the document when a handler runs.

use std::collections::{hash_map::Entry, HashMap, HashSet};

use proc_macro::{Delimiter, Ident, Span, TokenStream, TokenTree};

use super::{first_span, respan, Attr, Node};
use crate::tokens::{is_punct, q, stream};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Input,
    Checkable(bool),
    Inputs(bool),
    Select,
    Textarea,
    Unknown,
}

impl Kind {
    fn marker(self) -> Option<&'static str> {
        match self {
            Self::Input | Self::Checkable(_) | Self::Inputs(_) => Some("el::HTMLInputElement"),
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
    names: HashMap<String, TokenStream>,
}

impl Proofs {
    fn names(&mut self, base: Ident) -> TokenStream {
        let index = self.names.len();
        self.names
            .entry(ident_key(&base))
            .or_insert_with(|| stream([Ident::new(&format!("__corten_field_names_{index}"), Span::mixed_site()).into()]))
            .clone()
    }

    fn bind(&mut self, attr: *const Attr, witness: TokenStream) {
        if let Entry::Vacant(entry) = self.ids.entry(attr) {
            self.lets.extend(q("let __A0 = ::core::marker::PhantomData;", std::slice::from_ref(&witness)));
            entry.insert(witness);
        }
    }

    pub(super) fn infer(&self, attr: &Attr) -> Option<TokenStream> {
        let witness = self.ids.get(&(attr as *const Attr))?;
        let Attr::Expr(_, id) = attr else { return None };
        Some(q("if false { ::corten::script::__private::field_proof_type(__A0, &(__A1)); }", &[witness.clone(), id.clone()]))
    }
}

pub(super) fn check(nodes: &mut [Node]) -> Proofs {
    let mut uses = Uses::default();
    let leading = nodes.iter().take_while(|node| matches!(node, Node::Let(_))).count();
    let mut bases = HashMap::new();
    for (i, node) in nodes[..leading].iter().enumerate() {
        let Node::Let(tokens) = node else { unreachable!() };
        if let Some((name, value)) = root_binding(tokens) {
            uses.tokens(value);
            if bases.insert(ident_key(&name), (i, name.clone())).is_some() {
                uses.other.insert(ident_key(&name));
            }
        } else {
            uses.tokens(tokens.clone());
        }
    }
    if bases.is_empty() {
        return Proofs::default();
    }
    uses.nodes(&nodes[leading..]);
    if uses.opaque {
        return Proofs::default();
    }
    let mut scan = Scan::default();
    let mut scope = 0;
    if !scan.walk(nodes, &mut scope, None, false) {
        // A nested form's end can close the outer form even across a branch or element.
        return Proofs::default();
    }
    let proofs = scan.finish(&uses.other, &bases);
    for (base, witness) in &proofs.names {
        let (i, name) = &bases[base];
        let Node::Let(tokens) = &mut nodes[*i] else { unreachable!() };
        tokens.extend(q(
            "let __A0 = ::core::marker::PhantomData;
             if false { ::corten::script::__private::field_proof_type(__A0, &__A1); }",
            &[witness.clone(), stream([name.clone().into()])],
        ));
    }
    proofs
}

impl<'a> Scan<'a> {
    fn next_scope(&mut self) -> usize {
        self.scopes += 1;
        self.scopes
    }

    fn walk(&mut self, nodes: &'a mut [Node], scope: &mut usize, around: Option<Form>, in_table: bool) -> bool {
        for node in nodes {
            match node {
                Node::Element { name, attrs, children } => {
                    let table_part = ["thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col"]
                        .iter()
                        .any(|tag| name.eq_ignore_ascii_case(tag));
                    // Outside a cell/caption, HTML's table parser can move or drop other tags.
                    let is_form = name.eq_ignore_ascii_case("form");
                    if is_form && (around.is_some() || in_table) {
                        return false;
                    }
                    if in_table && !table_part {
                        // A displaced subtree can also contain a start tag.
                        return false;
                    }
                    let own = if is_form {
                        self.forms += 1;
                        Some(self.forms)
                    } else {
                        None
                    };
                    self.elements.push(Element { tag: name, attrs, scope: *scope, around, own });
                    let inner = own.or(around);
                    if super::writes_tags(name, children) {
                        return false;
                    }
                    if ["template", "svg", "math"].iter().any(|tag| name.eq_ignore_ascii_case(tag))
                        || super::may_read_as_text(super::Parsing::Unknown, name)
                    {
                        // An integration point, noscript or opaque output can still affect which
                        // form tags the parser sees.
                        if may_change_forms(children) {
                            return false;
                        }
                    } else {
                        let in_cell = ["td", "th", "caption"].iter().any(|tag| name.eq_ignore_ascii_case(tag));
                        if !self.walk(children, scope, inner, (in_table && !in_cell) || name.eq_ignore_ascii_case("table")) {
                            return false;
                        }
                    }
                }
                // Different arms can bind different variables, and do not draw together.
                Node::Block { head, bodies, .. } => {
                    // Several iterations can contribute to the same form.
                    if head[0].clone().into_iter().next().is_some_and(|t| crate::tokens::is_ident(Some(&t), "for")) {
                        return false;
                    }
                    for body in bodies {
                        let mut branch = self.next_scope();
                        if !self.walk(body, &mut branch, around, in_table) {
                            return false;
                        }
                    }
                }
                // Do not match uses of a binding on opposite sides of a possible shadow.
                Node::Let(_) => *scope = self.next_scope(),
                // Arbitrary rendered markup can change the parser's form owner.
                Node::Component { .. } | Node::Expr(_) => return false,
                Node::Markup(_) | Node::Text(_) => {}
            }
        }
        true
    }

    fn finish(mut self, other: &HashSet<String>, bases: &HashMap<String, (usize, Ident)>) -> Proofs {
        let mut proofs = Proofs::default();
        if self.forms == 0 || !self.elements.iter().any(|el| el.attrs.iter().any(|a| matches!(a, Attr::On(..)))) {
            return proofs;
        }
        let mut ids = HashMap::new();
        let mut form_ids = HashMap::new();
        let mut unknown_id = false;
        for el in &self.elements {
            match attribute(el.attrs, "id") {
                Ok(None) => {}
                Ok(Some(attr)) => {
                    let Some(id) = key(attr, other) else {
                        unknown_id = true;
                        continue;
                    };
                    ids.entry(id).and_modify(|owner| *owner = None).or_insert(el.own.map(|form| (el.scope, form)));
                    if let (Some(form), Attr::Expr(..)) = (el.own, attr) {
                        form_ids.insert(form, attr as *const Attr);
                    }
                }
                Err(()) => unknown_id = true,
            }
        }
        let owner = |el: &Element<'_>| {
            let implicit = |form| Owner { form, needs_id: false };
            if el.own.is_some() || (!listed(el.tag) && !el.tag.contains('-')) {
                return el.own.or(el.around).map(implicit);
            }
            match attribute(el.attrs, "form") {
                Ok(None) => el.around.map(implicit),
                Ok(Some(attr)) if listed(el.tag) && !unknown_id => {
                    let id = key(attr, other)?;
                    let needs_id = matches!(id, IdKey::Expr(_));
                    // Another spelling of a braced ID might render the same string.
                    if ids.len() > 1 && (needs_id || ids.keys().any(|id| matches!(id, IdKey::Expr(_)))) {
                        return None;
                    }
                    let (scope, form) = ids.get(&id).copied().flatten()?;
                    (scope == el.scope).then_some(Owner { form, needs_id })
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
                let Some((_, name)) = field_read(name) else { continue };
                if !bases.contains_key(&name.0) || other.contains(&name.0) {
                    continue;
                }
                let kind = control_kind(el);
                controls
                    .entry((owner.form, el.scope))
                    .or_default()
                    .entry(name)
                    .and_modify(|old| {
                        old.kind = match (old.kind, kind) {
                            (Kind::Checkable(a) | Kind::Inputs(a), Kind::Checkable(b)) if a == b => Kind::Inputs(a),
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
                let Some((checked, used_id)) = handler(expr, kinds, &owner, form.as_ref().map(|(_, id)| id), &mut proofs) else {
                    continue;
                };
                *expr = checked;
                if let (true, Some((at, id))) = (used_id, &form) {
                    proofs.bind(*at, id.clone());
                }
            }
        }
        proofs
    }
}

fn may_change_forms(nodes: &[Node]) -> bool {
    nodes.iter().any(|node| match node {
        Node::Element { name, children, .. } => {
            name.eq_ignore_ascii_case("form") || super::writes_tags(name, children) || may_change_forms(children)
        }
        Node::Block { bodies, .. } => bodies.iter().any(|body| may_change_forms(body)),
        Node::Component { .. } | Node::Expr(_) => true,
        Node::Let(_) | Node::Markup(_) | Node::Text(_) => false,
    })
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

fn key(attr: &Attr, other: &HashSet<String>) -> Option<IdKey> {
    match attr {
        // Rust must also prove that the value writes a keyless ID (not an Option, keyed ID,
        // or text). The identifier may appear only as one of these attribute reads.
        Attr::Expr(_, expr) => {
            let mut tokens = unparen(expr.clone()).into_iter();
            let (Some(TokenTree::Ident(id)), None) = (tokens.next(), tokens.next()) else { return None };
            let key = ident_key(&id);
            (!other.contains(&key)).then_some(IdKey::Expr(key))
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

fn ident_key(id: &Ident) -> String {
    id.to_string().trim_start_matches("r#").to_owned()
}

/// Type inference can borrow the whole field set immediately after a local declaration,
/// without moving a capture or borrowing a partially moved external struct.
fn root_binding(tokens: &TokenStream) -> Option<(Ident, TokenStream)> {
    let tokens: Vec<_> = tokens.clone().into_iter().collect();
    let [keyword, rest @ .., end] = tokens.as_slice() else { return None };
    if !crate::tokens::is_ident(Some(keyword), "let") || !is_punct(Some(end), ';') {
        return None;
    }
    let rest = if crate::tokens::is_ident(rest.first(), "mut") { &rest[1..] } else { rest };
    let [TokenTree::Ident(base), eq, path @ .., last] = rest else { return None };
    if !is_punct(Some(eq), '=') || !crate::tokens::is_ident(Some(last), "FIELDS") || path.is_empty() || !module_path(path) {
        return None;
    }
    Some((base.clone(), stream(path.iter().chain([last]).cloned())))
}

fn field_read(expr: &TokenStream) -> Option<(Ident, (String, String))> {
    let tokens: Vec<_> = unparen(expr.clone()).into_iter().collect();
    let [TokenTree::Ident(base), dot, TokenTree::Ident(field)] = tokens.as_slice() else { return None };
    let name = ident_key(base);
    (is_punct(Some(dot), '.') && !matches!(name.as_str(), "event" | "target" | "signal" | "scope"))
        .then(|| (base.clone(), (name, ident_key(field))))
}

/// These are the only occurrences we know are reads. Treat every other use of a base
/// as a possible write, mutable borrow or binding, including patterns in Rust groups.
#[derive(Default)]
struct Uses {
    other: HashSet<String>,
    opaque: bool,
}

impl Uses {
    fn tokens(&mut self, tokens: TokenStream) {
        let tokens: Vec<_> = tokens.into_iter().collect();
        for (i, token) in tokens.iter().enumerate() {
            match token {
                TokenTree::Ident(id) => {
                    self.other.insert(ident_key(id));
                    // A macro can use a local by hygiene without naming it as an argument.
                    self.opaque |= is_punct(tokens.get(i + 1), '!');
                }
                TokenTree::Group(group) => self.tokens(group.stream()),
                _ => {}
            }
        }
    }

    fn nodes(&mut self, nodes: &[Node]) {
        for node in nodes {
            match node {
                Node::Element { attrs, children, .. } => {
                    for attr in attrs {
                        match attr {
                            Attr::Expr(name, expr) if name.eq_ignore_ascii_case("name") && field_read(expr).is_some() => {}
                            Attr::Expr(name, expr)
                                if (name.eq_ignore_ascii_case("id") || name.eq_ignore_ascii_case("form"))
                                    && matches!(
                                        unparen(expr.clone()).into_iter().collect::<Vec<_>>().as_slice(),
                                        [TokenTree::Ident(_)]
                                    ) => {}
                            Attr::On(_, _, expr) => {
                                if let Some((path, args)) = call_args(expr) {
                                    self.tokens(path);
                                    for arg in args {
                                        if field_read(&arg).is_none() {
                                            self.tokens(arg);
                                        }
                                    }
                                } else {
                                    self.tokens(expr.clone());
                                }
                            }
                            Attr::Expr(_, expr) | Attr::Spread(expr) | Attr::Ref(expr, _) => self.tokens(expr.clone()),
                            _ => {}
                        }
                    }
                    self.nodes(children);
                }
                Node::Block { head, bodies, .. } => {
                    for tokens in head {
                        self.tokens(tokens.clone());
                    }
                    for body in bodies {
                        self.nodes(body);
                    }
                }
                Node::Component { path, props, children } => {
                    self.tokens(path.clone());
                    for (_, prop) in props {
                        self.tokens(prop.clone());
                    }
                    if let Some(children) = children {
                        self.nodes(children);
                    }
                }
                Node::Expr(expr) | Node::Let(expr) => self.tokens(expr.clone()),
                Node::Markup(_) | Node::Text(_) => {}
            }
        }
    }
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
                Kind::Checkable(ty.eq_ignore_ascii_case("radio"))
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
fn call_args(expr: &TokenStream) -> Option<(TokenStream, Vec<TokenStream>)> {
    let mut tokens: Vec<_> = unparen(expr.clone()).into_iter().collect();
    let Some(TokenTree::Group(args)) = tokens.pop() else { return None };
    let [path @ .., TokenTree::Ident(_)] = tokens.as_slice() else { return None };
    if args.delimiter() != Delimiter::Parenthesis || !module_path(path) {
        return None;
    }
    // A closure or generic argument list can own a comma without a token group.
    if args.stream().into_iter().any(|t| matches!(t, TokenTree::Punct(p) if matches!(p.as_char(), '|' | '<' | '>'))) {
        return None;
    }
    Some((
        stream(tokens),
        crate::component::split(args.stream(), ',').into_iter().filter(|a| !a.is_empty()).map(stream).collect(),
    ))
}

fn module_path(path: &[TokenTree]) -> bool {
    let (segments, rest) = path.as_chunks::<3>();
    rest.is_empty()
        && segments.iter().all(|[name, first, second]| {
            matches!(name, TokenTree::Ident(_)) && is_punct(Some(first), ':') && is_punct(Some(second), ':')
        })
}

fn handler(
    expr: &TokenStream,
    kinds: &HashMap<(String, String), Control>,
    owner: &Owner,
    form_id: Option<&TokenStream>,
    proofs: &mut Proofs,
) -> Option<(TokenStream, bool)> {
    let (_, args) = call_args(expr)?;
    let bind = stream([Ident::new("__corten_bind", Span::mixed_site()).into()]);
    let mut checks = TokenStream::new();
    let mut used_id = false;
    for (i, arg) in args.iter().enumerate() {
        let Some((base, name)) = field_read(arg) else { continue };
        let Some(control) = kinds.get(&name) else { continue };
        let Some(marker) = control.kind.marker() else { continue };
        let pos = crate::script::arg_position(i, args.len());
        let at = first_span(arg);
        let needs_id = owner.needs_id || control.needs_id;
        if needs_id && form_id.is_none() {
            continue;
        }
        let names = proofs.names(base);
        let mut check = q(
            &format!("::corten::script::__private::FieldCheck::<_, __A0, ::corten::script::{marker}, _>::new(&__A1, __A2)"),
            &[pos, bind.clone(), names],
        );
        if let Some(id) = form_id.filter(|_| needs_id) {
            check.extend(q(".in_form(__A0)", std::slice::from_ref(id)));
            used_id = true;
        }
        let method = if matches!(control.kind, Kind::Inputs(_)) { ".group()" } else { ".single()" };
        check.extend(q(method, &[]));
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
        &[unparen(expr.clone()), checks, bind],
    );
    Some((checked, used_id))
}
