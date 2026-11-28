//! `html!`: JSX-like markup compiled to string pushes.
//!
//! Static markup is merged at compile time into one `push_str` per run; expressions are escaped
//! through `corten::view::Render` (or `Display`); control flow is plain Rust (`for`, `if`,
//! `match`, `let`) written inside the markup, so no intermediate strings or trees are built.

use proc_macro::{Delimiter, Group, Ident, Span, TokenStream, TokenTree};

mod nesting;

use crate::tokens::{
    compile_error, err, escape, is_ident, is_punct, literal, literal_text, parens, q, stream, string_value, Error,
};

/// Elements that never have children or a closing tag.
const VOID: &[&str] = &["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"];
/// Elements that use raw text in HTML. The parser pre-escapes their literals in known foreign content.
const RAW_TEXT: &[&str] = &["script", "style"];

/// Whether the literal text can change how the tags after the holder are read. Foreign text is
/// already escaped; unescaped text with an unknown context cannot contain '<'.
fn writes_tags(name: &str, children: &[Node]) -> bool {
    RAW_TEXT.contains(&name) && raw_text_boundary(name, children) != RawTextBoundary::Unchanged
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RawTextBoundary {
    Unchanged,
    EarlyClose,
    StillOpen,
}

/// Check only the lexical transitions that can move the boundary of an HTML raw-text holder.
/// A matching end tag with a delimiter may end it early; do not try to recover the tree after
/// it. A script in the double-escaped state consumes its generated end tag as text.
fn raw_text_boundary(name: &str, children: &[Node]) -> RawTextBoundary {
    if !children.iter().any(|node| matches!(node, Node::Text(text) if text.contains('<'))) {
        return RawTextBoundary::Unchanged;
    }
    let mut text = String::new();
    for child in children {
        match child {
            Node::Text(literal) | Node::Markup(literal) => text.push_str(literal),
            Node::Let(_) => {}
            _ => break,
        }
    }
    let tag = |tail: &str| {
        let bytes = tail.as_bytes();
        bytes.get(..name.len()).is_some_and(|start| start.eq_ignore_ascii_case(name.as_bytes()))
            && matches!(bytes.get(name.len()), Some(b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' | b'/' | b'>'))
    };
    let script = name == "script";
    let mut escaped = false;
    let mut double = false;
    for tail in text.split('<').skip(1) {
        if tail.strip_prefix('/').is_some_and(tag) {
            if !double {
                return RawTextBoundary::EarlyClose;
            }
            double = false;
        } else if script {
            if !escaped && tail.starts_with("!--") {
                escaped = true;
            } else if escaped && tag(tail) {
                double = true;
            }
        }
        if escaped && tail.contains("-->") {
            escaped = false;
            double = false;
        }
    }
    if double {
        RawTextBoundary::StillOpen
    } else {
        RawTextBoundary::Unchanged
    }
}

/// The other elements whose content a browser parsing HTML reads as text (the HTML standard's
/// RCDATA and RAWTEXT elements, `<noscript>` aside, which `<template>`'s handling covers): an
/// element written in one is text to the browser, so `html!` refuses it there where the markup
/// shows the content is parsed as HTML (`Parsing`), and the key
/// check takes no key written in one (by an expression or a component) for the page's. Inside an
/// `<svg>` they are SVG's elements (`<title>`) or unknown ones, whose children are elements.
const TEXT_ONLY: &[&str] = &["textarea", "title", "xmp", "iframe", "noembed", "noframes"];
/// Rust keywords that need `r#` as a component prop name.
const KEYWORDS: &[&str] = &[
    "as", "async", "await", "break", "const", "continue", "dyn", "else", "enum", "extern", "fn", "for", "if", "impl", "in",
    "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "static", "struct", "trait", "type", "unsafe", "use",
    "where", "while", "yield",
];

pub fn expand(input: TokenStream) -> TokenStream {
    expand_with_loss(input, |_| {})
}

fn expand_with_loss(input: TokenStream, record_loss: impl FnOnce(&str)) -> TokenStream {
    let (inside, input) = inside_marker(input);
    // A view written as another view's prop renders inside it, so it borrows what it uses (see
    // `borrowing`); any other owns it, since it may be returned.
    let capture = if inside { "" } else { "move " };
    let (scope, input) = scope_marker(input);
    match Cursor::new(input).nodes(None, false).and_then(|mut nodes| {
        if let Some(scope) = &scope {
            mark_scope(&mut nodes, scope)?;
        }
        check_raw_text(&nodes, None)?;
        nesting::check(&nodes)?;
        check_pages(&nodes)?;
        if could_patch(&nodes) {
            check_patch_top(&nodes)?;
        }
        Ok(nodes)
    }) {
        Ok(nodes) if is_document(&nodes) => {
            if let Err((span, message)) = check_document(&nodes) {
                return compile_error(span, &message);
            }
            let mut gen = Gen::default();
            gen.doc_nodes(&nodes);
            q(
                &"::corten::view::DocHtml::new({
                    static SIZE: ::std::sync::atomic::AtomicUsize = ::std::sync::atomic::AtomicUsize::new(0);
                    &SIZE
                }, {
                    const SHELL: u64 = ::corten::view::__private::shell_id(file!(), line!(), column!());
                    SHELL
                }, __CAPTURE__|__OUT: &mut ::std::string::String, __PART: ::corten::view::Part| {
                    #[allow(unused_imports)]
                    use ::corten::view::__private::{AttrViaDisplay as _, AttrViaValue as _, ViaDisplay as _, ViaRender as _};
                    __A0
                })"
                .replace("__CAPTURE__", capture),
                &[gen.finish()],
            )
        }
        // One component: the component itself, its props evaluated where the markup is, so a
        // layout stays a document and borrows what the handler has (`req={&req}`). Its children
        // own what they use, as a view does.
        Ok(nodes) if matches!(nodes.as_slice(), [Node::Component { .. }]) => {
            let [Node::Component { path, props, children }] = nodes.as_slice() else { unreachable!() };
            let gen = Gen::default();
            let built = gen.component(path, props, children, !inside);
            q(
                "{
                    #[allow(unused_imports)]
                    use ::corten::view::__private::{AttrViaDisplay as _, AttrViaValue as _, ViaDisplay as _, ViaRender as _};
                    __A0
                }",
                &[built],
            )
        }
        // `let`s, then one component: a view that owns what the `let`s make (a title it formats,
        // a link it builds), and a document when the component is one.
        Ok(nodes) if lets_then_component(&nodes) => {
            let mut gen = Gen::default();
            let (component, lets) = nodes.split_last().expect("a component");
            gen.nodes(lets, false);
            let Node::Component { path, props, children } = component else { unreachable!() };
            let built = gen.component(path, props, children, false);
            gen.code(q("(&&&::corten::view::__private::OneOf(&__A0)).__one(__OUT, __PART)", &[built]));
            q(
                &"::corten::view::__private::One::new({
                    static SIZE: ::std::sync::atomic::AtomicUsize = ::std::sync::atomic::AtomicUsize::new(0);
                    &SIZE
                }, __CAPTURE__|__OUT: &mut ::std::string::String, __PART: ::std::option::Option<::corten::view::Part>| {
                    #[allow(unused_imports)]
                    use ::corten::view::__private::{AttrViaDisplay as _, AttrViaValue as _, ViaDisplay as _, ViaRender as _, ViaDocument as _, ViaPatch as _, ViaView as _};
                    __A0
                })".replace("__CAPTURE__", capture),
                &[gen.finish()],
            )
        }
        Ok(nodes) => {
            let mut gen = Gen::default();
            // The closure returns the view's shape, which says whether it is a patch (see
            // `corten::view::Patch`). A view with a part that cannot be one is written as before.
            let body = if could_patch(&nodes) {
                let mut slots = Slots::default();
                let mut shape = gen.top_nodes(&nodes, &mut slots);
                if let Some(why) = lost_if_whole(&nodes) {
                    record_loss(&why);
                    shape = q(
                        "{
                            struct __CortenLostIfWhole<S>(S);
                            impl<S: ::corten::view::__private::PatchShape> ::corten::view::__private::PatchShape
                                for __CortenLostIfWhole<S>
                            {
                                const CHECK_WHOLE: () = ::core::panic!(__A1);
                            }
                            __CortenLostIfWhole(__A0)
                        }",
                        &[shape, literal(&why)],
                    );
                }
                let mut body = slots.lets;
                body.extend(gen.finish());
                body.extend(shape);
                body
            } else {
                gen.nodes(&nodes, false);
                let mut body = gen.finish();
                body.extend(q("::corten::view::__private::TextOrElementWithoutId", &[]));
                body
            };
            q(
                &"::corten::view::Html::new({
                    static SIZE: ::std::sync::atomic::AtomicUsize = ::std::sync::atomic::AtomicUsize::new(0);
                    &SIZE
                }, __CAPTURE__|__OUT: &mut ::std::string::String| {
                    #[allow(unused_imports)]
                    use ::corten::view::__private::{AttrViaDisplay as _, AttrViaValue as _, ViaDisplay as _, ViaRender as _, ProofPatch as _, ProofOther as _, ProofId as _, ProofNotId as _};
                    __A0
                })".replace("__CAPTURE__", capture),
                &[body],
            )
        }
        Err((span, message)) => compile_error(span, &message),
    }
}

/// Project the test fixture into Rust. The browser-vector test also renders the exact expansion
/// that supplied the verdict to find its recorded parse.
pub(super) fn whole_patch_cases(render: bool) -> TokenStream {
    use crate::json::Value;
    let Value::Array(cases) = crate::json::parse(include_str!("whole-patch-cases.json")).unwrap() else { unreachable!() };
    let option = |text: Option<&str>| match text {
        Some(text) => q("Some(__A0)", &[literal(text)]),
        None => q("None", &[]),
    };
    let mut rows = TokenStream::new();
    for case in cases {
        let Value::Array(fields) = case else { unreachable!() };
        let [Value::String(markup), expected] = fields.as_slice() else { unreachable!() };
        let expected = match expected {
            Value::String(text) => Some(text.as_str()),
            Value::Null => None,
            _ => unreachable!(),
        };
        let mut actual = None;
        let view = expand_with_loss(markup.parse().expect("literal patch markup"), |why| actual = Some(why.to_owned()));
        let rendered = if render { q("render_patch(__A0)", &[view]) } else { q("()", &[]) };
        rows.extend(q("(__A0, __A1, __A2, __A3),", &[literal(markup), option(expected), option(actual.as_deref()), rendered]));
    }
    q("[__A0]", &[rows])
}

/// One or more `let`s and then one component, nothing else.
fn lets_then_component(nodes: &[Node]) -> bool {
    match nodes.split_last() {
        Some((Node::Component { .. }, lets)) => !lets.is_empty() && lets.iter().all(|n| matches!(n, Node::Let(_))),
        _ => false,
    }
}
/// The `@__in;` that `borrowing` puts first in a view written as a prop.
fn inside_marker(input: TokenStream) -> (bool, TokenStream) {
    let tokens: Vec<TokenTree> = input.clone().into_iter().collect();
    if is_punct(tokens.first(), '@') && is_ident(tokens.get(1), "__in") && is_punct(tokens.get(2), ';') {
        return (true, stream(tokens.into_iter().skip(3)));
    }
    (false, input)
}

/// A prop whose whole value is a view lent to it (`action={&html! { .. }}`, or `corten::html!`),
/// marked to borrow what it uses: it is built and rendered inside the enclosing view's closure,
/// which already owns or borrows those locals, so the same local can be read again in the rest of
/// the markup. Any other value is left as written: a view given by value may be kept, and one
/// inside a closure of its own (`.map(|row| html! { .. })`) may outlive what it would borrow.
fn borrowing(value: &TokenStream) -> TokenStream {
    let tokens: Vec<TokenTree> = value.clone().into_iter().collect();
    // A `{..}` value arrives in parentheses.
    if let [TokenTree::Group(group)] = tokens.as_slice() {
        if group.delimiter() == Delimiter::Parenthesis {
            let mut inner = Group::new(Delimiter::Parenthesis, borrowing(&group.stream()));
            inner.set_span(group.span());
            return stream([TokenTree::Group(inner)]);
        }
    }
    let [path @ .., TokenTree::Ident(name), TokenTree::Punct(bang), TokenTree::Group(body)] = tokens.as_slice() else {
        return value.clone();
    };
    // Lent (`&html!`): a reference to the view cannot outlive the render, so borrowing loses
    // nothing, where a view given by value may be kept (a prop that needs `'static`). And this
    // macro, by its name or its path in `corten`, not another crate's `html!`.
    let refs = path.iter().take_while(|t| is_punct(Some(t), '&')).count();
    let segments: Vec<String> = path[refs..].iter().filter(|t| !is_punct(Some(t), ':')).map(ToString::to_string).collect();
    let colons = path[refs..].iter().filter(|t| is_punct(Some(t), ':')).count();
    let ours = match segments.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        [] => colons == 0,
        ["corten"] | ["corten", "view"] => colons == 2 * segments.len() || colons == 2 * segments.len() + 2,
        _ => false,
    };
    let idents_only = path[refs..].iter().all(|t| matches!(t, TokenTree::Ident(_) | TokenTree::Punct(_)));
    if refs == 0
        || inside_marker(body.stream()).0
        || !ours
        || !idents_only
        || name.to_string() != "html"
        || bang.as_char() != '!'
        || body.delimiter() == Delimiter::None
    {
        return value.clone();
    }
    let mut inner = q("@ __in ;", &[]);
    inner.extend(body.stream());
    let mut marked = Group::new(body.delimiter(), inner);
    marked.set_span(body.span());
    let mut out = stream(tokens[..tokens.len() - 1].iter().cloned());
    out.extend([TokenTree::Group(marked)]);
    out
}

/// A child `{keep_query(&at, &html! { .. })}`: a view lent to a call written there (`&html! { .. }`
/// as a whole argument) is built and rendered inside this view's closure, as one lent to a prop is,
/// so it borrows what it uses (`borrowing`; one given by value may be kept). Only the arguments of
/// the expression's own calls: one inside a closure or a block of its own
/// (`.map(|row| f(html! { .. }))`) may outlive what it would borrow. A macro's arguments
/// (`format!(..)`, `stringify!(..)`) are its own to read, so they are left as written. Arguments are split at every top-level comma and joined again as they were, so
/// a turbofish's comma (`Vec::<A, B>::new()`) only makes two pieces that are not views.
fn lent_args(expr: TokenStream) -> TokenStream {
    let mut after_bang = false;
    expr.into_iter()
        .map(|token| {
            let macro_args = std::mem::replace(&mut after_bang, is_punct(Some(&token), '!'));
            match token {
                TokenTree::Group(g) if g.delimiter() == Delimiter::Parenthesis && !macro_args => {
                    let mut args = TokenStream::new();
                    let mut arg = Vec::new();
                    for t in g.stream() {
                        if is_punct(Some(&t), ',') {
                            args.extend(borrowing(&stream(arg.drain(..))));
                            args.extend([t]);
                        } else {
                            arg.push(t);
                        }
                    }
                    args.extend(borrowing(&stream(arg)));
                    let mut lent = Group::new(Delimiter::Parenthesis, args);
                    lent.set_span(g.span());
                    TokenTree::Group(lent)
                }
                other => other,
            }
        })
        .collect()
}

/// `#[component]` starts the markup of a component with refs with `@scope "name";`.
fn scope_marker(input: TokenStream) -> (Option<String>, TokenStream) {
    let tokens: Vec<TokenTree> = input.clone().into_iter().collect();
    if let (true, true, Some(TokenTree::Literal(name)), true) =
        (is_punct(tokens.first(), '@'), is_ident(tokens.get(1), "scope"), tokens.get(2), is_punct(tokens.get(3), ';'))
    {
        if let Some(name) = string_value(name) {
            return (Some(name), stream(tokens.into_iter().skip(4)));
        }
    }
    (None, input)
}

/// Puts `data-scope="name"` on the one root element.
fn mark_scope(nodes: &mut [Node], scope: &str) -> Result<(), Error> {
    let mut roots = nodes.iter_mut().filter(|n| !matches!(n, Node::Let(_)));
    let first = roots.next();
    let doctype = matches!(&first, Some(Node::Markup(text)) if text == "<!DOCTYPE html>");
    let root = if doctype { roots.next() } else { first };
    match (root, roots.next()) {
        (Some(Node::Element { name, attrs, .. }), None) if !doctype || name == "html" => {
            attrs.insert(0, Attr::Static("data-scope".into(), scope.into()));
            Ok(())
        }
        _ => err(
            Span::call_site(),
            "a component with refs, or with a handler that takes scope, renders one root element, which holds its refs and is its scope: wrap its markup in one element",
        ),
    }
}

/// How a view property reads back from the page, from the parameter's Rust type.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Number,
    Text,
    Bool,
}

impl Kind {
    /// `u32`, `f64`, `&'a str`, `String`, `Cow<'a, str>` or `bool`; other types are not a
    /// view's (a script could not read them back from the page as the same value).
    fn of(ty: &[TokenTree]) -> Option<Kind> {
        let mut i = 0;
        loop {
            match ty.get(i) {
                Some(TokenTree::Punct(p)) if p.as_char() == '&' => i += 1,
                Some(TokenTree::Punct(p)) if p.as_char() == '\'' => i += 2,
                Some(TokenTree::Ident(id)) if id.to_string() == "mut" => i += 1,
                _ => break,
            }
        }
        let words: Vec<String> = ty[i..].iter().map(ToString::to_string).collect();
        match words.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
            ["u8" | "u16" | "u32" | "u64" | "usize" | "i8" | "i16" | "i32" | "i64" | "isize" | "f32" | "f64"] => {
                Some(Kind::Number)
            }
            ["str" | "String"] => Some(Kind::Text),
            ["bool"] => Some(Kind::Bool),
            ["Cow", "<", .., "str", ">"] => Some(Kind::Text),
            _ => None,
        }
    }

    fn ts(self) -> &'static str {
        match self {
            Kind::Number => "number",
            Kind::Text => "string",
            Kind::Bool => "boolean",
        }
    }
}

/// Where a parameter is shown: an element's whole text, or one attribute's whole value. `path` is
/// the way to the element from the root, one step to a first child or a next sibling at a time.
struct Hole {
    param: usize,
    path: Vec<Step>,
    attr: Option<String>,
    /// The element's tag: an `<input>`'s `value` and `checked` are what it shows now, which
    /// the user changes, so a view reads and writes them as properties.
    tag: String,
}

/// One step of a hole's path: to the first child element (`firstElementChild`) or to the next
/// sibling element (`nextElementSibling`), and whether the element it is taken from is a
/// `<form>`, whose controls' names shadow its members.
#[derive(Clone, Copy)]
struct Step {
    next: bool,
    from_form: bool,
}

impl Hole {
    /// The `<input>` property this hole is, when a script should read what the user changed:
    /// `value` (text or a number) or `checked` (a bool).
    fn live(&self, kind: Kind) -> Option<&'static str> {
        match (self.tag.as_str(), self.attr.as_deref(), kind) {
            ("input", Some("value"), Kind::Number | Kind::Text) => Some("value"),
            ("input", Some("checked"), Kind::Bool) => Some("checked"),
            _ => None,
        }
    }
}

/// The view class `#[component(view)]` generates for the component `class`, from the `html!` its
/// `body` ends with: the JavaScript (`export class Row { .. }`) and its TypeScript declaration.
///
/// A parameter is a property when every use of it in the markup is a hole: `{label}` as the only
/// child of an element, or an attribute's whole value (`data-selected={selected}`), on elements
/// whose place is fixed (no loop, condition, expression or component before them among their
/// siblings). The property's getter reads its first hole and its setter writes all of them. A root
/// with `key={id}` keys the view, for `rows()`.
pub fn view_of(body: &Group, class: &str, params: &[(String, Vec<TokenTree>)], span: Span) -> Result<View, Error> {
    let tokens: Vec<TokenTree> = body.stream().into_iter().collect();
    let n = tokens.len();
    let markup = match tokens.last() {
        Some(TokenTree::Group(g))
            if n >= 3
                && g.delimiter() == Delimiter::Brace
                && is_ident(tokens.get(n - 3), "html")
                && is_punct(tokens.get(n - 2), '!') =>
        {
            g.clone()
        }
        _ => {
            return err(
                body.span(),
                "a view's component ends with html! { <root> .. </root> }: its holes are found in that markup",
            )
        }
    };
    let nodes = Cursor::of(&markup).nodes(None, false)?;
    let mut roots = nodes.iter().filter(|n| !matches!(n, Node::Let(_)));
    let root = match (roots.next(), roots.next()) {
        (Some(root @ Node::Element { .. }), None) => root,
        _ => return err(markup.span(), "a view renders one root element: wrap its markup in one element"),
    };
    let names: Vec<&str> = params.iter().map(|(name, _)| name.as_str()).collect();
    let mut holes = Vec::new();
    find_holes(root, &mut Vec::new(), &names, &mut holes);
    let mut uses = vec![0; params.len()];
    count_uses(&nodes, &names, &mut uses);
    // The properties: parameters shown only in holes, of a type the page can hold.
    let mut props: Vec<(usize, Kind)> = Vec::new();
    for (i, (_, ty)) in params.iter().enumerate() {
        let shown: Vec<&Hole> = holes.iter().filter(|h| h.param == i).collect();
        let Some(kind) = Kind::of(ty) else { continue };
        let fits = shown.iter().all(|h| h.attr.is_some() || kind != Kind::Bool);
        if !shown.is_empty() && shown.len() == uses[i] && fits {
            props.push((i, kind));
        }
    }
    if let Some(&(i, _)) = props.iter().find(|&&(i, _)| matches!(params[i].0.as_str(), "el" | "constructor")) {
        return err(
            span,
            format!("a view's property cannot be named {}: its root element is el, and a class has a constructor", params[i].0),
        );
    }
    if props.is_empty() {
        return err(
            span,
            "a view needs a hole a script can write: a parameter that is the whole text of an element (<a>{label}</a>) or an attribute's whole value (data-selected={selected})",
        );
    }
    let Node::Element { attrs: root_attrs, .. } = root else { unreachable!() };
    let key = root_attrs.iter().find_map(|a| match a {
        Attr::Expr(name, expr) if name == "data-key" => Some(param_of(expr, &names)),
        _ => None,
    });
    // A key that is one of its holes lets scripts make rows (`keyOf` and `fill` give a new row its
    // key); a key the markup also shows elsewhere (a child's prop, an id) is fixed, and the server
    // makes the rows.
    let (key, made) = match key {
        None => (None, false),
        Some(Some(i)) => (Some(i), props.iter().any(|(p, _)| *p == i)),
        Some(None) => return err(span, "a view's key={..} is one of its parameters, alone (key={id})"),
    };

    // A step from a `<form>` goes through Element's own getter: a control named
    // `firstElementChild` or `nextElementSibling` (inside the form or joined to it by `form=`) is
    // the form's member of that name, as in the runtime. No other element has its members
    // shadowed, so every other step keeps the property, and a view with no form costs nothing.
    let access = |base: &str, path: &[Step]| {
        let mut s = base.to_string();
        for step in path {
            let member = if step.next { "nextElementSibling" } else { "firstElementChild" };
            s = if step.from_form {
                format!("Reflect.get(Element.prototype, \"{member}\", {s})")
            } else {
                format!("{s}.{member}")
            };
        }
        s
    };
    // A form's whole text is read through Node's own `textContent`, for the same reason.
    let text_of = |at: &str, tag: &str| {
        if tag == "form" {
            format!("Reflect.get(Node.prototype, \"textContent\", {at})")
        } else {
            format!("{at}.textContent")
        }
    };
    // An attribute method on a `<form>` goes through Element's own: a form has its controls'
    // names over its members (`<input name="hasAttribute">`), as in the runtime. No other element
    // has, so a hole on any other tag (a `<tr>` row) keeps the direct call.
    let attr_call = |at: &str, tag: &str, method: &str, args: &str| {
        if tag == "form" {
            format!("Element.prototype.{method}.call({at}, {args})")
        } else {
            format!("{at}.{method}({args})")
        }
    };
    let mut js = format!("export class {class} {{\n  constructor(el) {{ this.el = el; }}\n");
    let Node::Element { name: root_tag, .. } = root else { unreachable!() };
    let root_el = crate::dom::element(root_tag);
    let mut ts = format!(
        "  /** The view of #[component(view)] {class}: its holes, read from and written to the page. */\n  export class {class} {{\n    constructor(el: Element);\n    readonly el: {root_el};\n"
    );
    let mut data = Vec::new();
    // `fill` writes the holes itself: going through a view and its setters cost about 1.5 µs a
    // row when making 10,000 rows.
    let mut fill = Vec::new();
    for &(i, kind) in &props {
        let name = &params[i].0;
        let shown: Vec<&Hole> = holes.iter().filter(|h| h.param == i).collect();
        let first = shown[0];
        let at = access("this.el", &first.path);
        let get = match (first.live(kind), &first.attr, kind) {
            (Some(prop), _, Kind::Number) => format!("Number({at}.{prop})"),
            (Some(prop), ..) => format!("{at}.{prop}"),
            (None, None, Kind::Number) => format!("Number({})", text_of(&at, &first.tag)),
            (None, None, _) => text_of(&at, &first.tag),
            (None, Some(attr), Kind::Number) => {
                format!("Number({})", attr_call(&at, &first.tag, "getAttribute", &format!("{attr:?}")))
            }
            (None, Some(attr), Kind::Text) => {
                format!("{} ?? \"\"", attr_call(&at, &first.tag, "getAttribute", &format!("{attr:?}")))
            }
            (None, Some(attr), Kind::Bool) => attr_call(&at, &first.tag, "hasAttribute", &format!("{attr:?}")),
        };
        // Writes every hole of the element `base` from `value`. `fill` (`many`) checks a
        // boolean attribute before toggling it: hasAttribute is about half the cost of a
        // toggleAttribute that changes nothing, which is most rows of a new list.
        let write = |base: &str, value: &str, many: bool| -> Vec<String> {
            shown
                .iter()
                .map(|h| {
                    let at = access(base, &h.path);
                    match (h.live(kind), &h.attr, kind) {
                        // `value(..)` and `checked(..)` write the property (what is shown, even
                        // after the user typed) and the attribute (what a form reset goes back to).
                        (Some(prop), ..) => format!("{prop}({at}, {value});"),
                        (None, None, _) => format!("text({at}, {value});"),
                        (None, Some(attr), Kind::Bool) if many => format!(
                            "if ({} !== {value}) {};",
                            attr_call(&at, &h.tag, "hasAttribute", &format!("{attr:?}")),
                            attr_call(&at, &h.tag, "toggleAttribute", &format!("{attr:?}, {value}"))
                        ),
                        (None, Some(attr), Kind::Bool) => {
                            format!("{};", attr_call(&at, &h.tag, "toggleAttribute", &format!("{attr:?}, {value}")))
                        }
                        (None, Some(attr), _) => {
                            format!("{};", attr_call(&at, &h.tag, "setAttribute", &format!("{attr:?}, {value}")))
                        }
                    }
                })
                .collect()
        };
        let (set, filled) = if kind == Kind::Number {
            // A numbered local: a parameter may be named like anything in this function.
            let local = format!("v{i}");
            let mut filled = vec![format!("const {local} = String(data.{name});")];
            filled.extend(write("el", &local, true));
            (write("this.el", "String(v)", false), filled)
        } else {
            (write("this.el", "v", false), write("el", &format!("data.{name}"), true))
        };
        fill.extend(filled);
        js.push_str(&format!("  get {name}() {{ return {get}; }}\n  set {name}(v) {{ {} }}\n", set.join(" ")));
        ts.push_str(&format!("    {name}: {};\n", kind.ts()));
        data.push(format!("{name}: {}", kind.ts()));
    }
    js.push_str(&format!("  static fill(el, data) {{ {} }}\n", fill.join(" ")));
    let data = format!("{{ {} }}", data.join("; "));
    ts.push_str(&format!("    /** Writes every hole of `el` (a {class}'s root) from `data`. */\n    static fill(el: Element, data: {data}): void;\n"));
    if let Some(i) = key {
        let key = &params[i].0;
        // Through Element's own when the row is a form, whose controls' names shadow its members.
        js.push_str(&format!(
            "  static key(el) {{ return {} ?? \"\"; }}\n",
            attr_call("el", root_tag, "getAttribute", "\"data-key\"")
        ));
        ts.push_str(&format!(
            "    /** The key of a {class}'s root (its key={{{key}}}). */\n    static key(el: Element): string;\n"
        ));
        if made {
            js.push_str(&format!("  static keyOf(data) {{ return String(data.{key}); }}\n"));
            ts.push_str(&format!("    static keyOf(data: {data}): string;\n"));
        }
    }
    js.push_str("}\n");
    ts.push_str("  }\n");
    let numbers = props.iter().filter(|(_, kind)| *kind == Kind::Number).map(|&(i, _)| params[i].0.clone()).collect();
    Ok(View { js, ts, numbers })
}

/// What `#[component(view)]` generates for a component.
pub struct View {
    /// The class, for `corten/views`.
    pub js: String,
    /// Its declaration.
    pub ts: String,
    /// The properties that are numbers in the page: debug builds check their values fit one.
    pub numbers: Vec<String>,
}

/// The holes under `node` (an element at `path`): its attributes whose value is a parameter, its
/// text when that is a parameter alone, and those of its child elements whose place is fixed.
fn find_holes(node: &Node, path: &mut Vec<Step>, names: &[&str], holes: &mut Vec<Hole>) {
    let Node::Element { name, attrs, children } = node else { return };
    for attr in attrs {
        if let Attr::Expr(attr, expr) = attr {
            if let (false, Some(param)) = (attr == "class" || attr == "style", param_of(expr, names)) {
                holes.push(Hole { param, path: path.clone(), attr: Some(attr.clone()), tag: name.clone() });
            }
        }
    }
    let content: Vec<&Node> = children.iter().filter(|c| !matches!(c, Node::Let(_))).collect();
    if let ([Node::Expr(expr)], false) = (content.as_slice(), VOID.contains(&name.as_str()) || RAW_TEXT.contains(&name.as_str()))
    {
        if let Some(param) = param_of(expr, names) {
            holes.push(Hole { param, path: path.clone(), attr: None, tag: name.clone() });
        }
    }
    // The tags of the child elements before the one looked at: its path steps past each.
    let mut before: Vec<&str> = Vec::new();
    for child in children {
        match child {
            Node::Element { name: tag, .. } => {
                let depth = path.len();
                path.push(Step { next: false, from_form: name == "form" });
                path.extend(before.iter().map(|&t| Step { next: true, from_form: t == "form" }));
                find_holes(child, path, names, holes);
                path.truncate(depth);
                before.push(tag);
            }
            Node::Text(_) | Node::Let(_) => {}
            // Anything else may print elements, so the ones after it have no fixed place.
            _ => break,
        }
    }
}

/// The parameter an expression is, when it is one alone (`label`, or `(label)` as an attribute
/// value is wrapped).
fn param_of(expr: &TokenStream, names: &[&str]) -> Option<usize> {
    let mut tokens: Vec<TokenTree> = expr.clone().into_iter().collect();
    if let [TokenTree::Group(g)] = tokens.as_slice() {
        if g.delimiter() == Delimiter::Parenthesis {
            tokens = g.stream().into_iter().collect();
        }
    }
    match tokens.as_slice() {
        [TokenTree::Ident(id)] => names.iter().position(|n| id.to_string() == *n),
        _ => None,
    }
}

/// Counts every mention of each parameter in the markup's Rust code (a field `x.label` is not one).
fn count_uses(nodes: &[Node], names: &[&str], uses: &mut [usize]) {
    fn count(tokens: &TokenStream, names: &[&str], uses: &mut [usize]) {
        let tokens: Vec<TokenTree> = tokens.clone().into_iter().collect();
        for (i, token) in tokens.iter().enumerate() {
            match token {
                TokenTree::Ident(id) if !(i > 0 && is_punct(tokens.get(i - 1), '.')) => {
                    if let Some(p) = names.iter().position(|n| id.to_string() == *n) {
                        uses[p] += 1;
                    }
                }
                TokenTree::Group(g) => count(&g.stream(), names, uses),
                _ => {}
            }
        }
    }
    for node in nodes {
        match node {
            Node::Element { attrs, children, .. } => {
                for attr in attrs {
                    match attr {
                        Attr::Expr(_, expr) | Attr::Spread(expr) | Attr::Ref(expr, _) | Attr::On(_, _, expr) => {
                            count(expr, names, uses)
                        }
                        Attr::Bare(_) | Attr::Static(..) | Attr::Page(_) => {}
                    }
                }
                count_uses(children, names, uses);
            }
            Node::Component { props, children, .. } => {
                for (_, value) in props {
                    count(value, names, uses);
                }
                if let Some(children) = children {
                    count_uses(children, names, uses);
                }
            }
            Node::Expr(tokens) | Node::Let(tokens) => count(tokens, names, uses),
            Node::Block { head, bodies, .. } => {
                for h in head {
                    count(h, names, uses);
                }
                for body in bodies {
                    count_uses(body, names, uses);
                }
            }
            Node::Text(_) | Node::Markup(_) => {}
        }
    }
}

enum Node {
    Element {
        name: String,
        attrs: Vec<Attr>,
        children: Vec<Node>,
    },
    Component {
        path: TokenStream,
        props: Vec<(TokenStream, TokenStream)>,
        children: Option<Vec<Node>>,
    },
    Text(String),
    Markup(String),
    Expr(TokenStream),
    /// `for`, `if`/`else`, `match`: the Rust tokens around each body, with the bodies in order.
    Block {
        head: Vec<TokenStream>,
        bodies: Vec<Vec<Node>>,
        arms: bool,
    },
    Let(TokenStream),
}

enum Attr {
    Bare(String),
    Static(String, String),
    Expr(String, TokenStream),
    Spread(TokenStream),
    /// `ref={rows}`: prints `data-ref="rows"`, and types the ref with the element's interface, or
    /// with a wider one (`ref={trigger as HTMLElement}`) when the ref is on several kinds.
    Ref(TokenStream, Option<Ident>),
    /// `on:click={js::show(rows)}`: the event (with its span) and the handler. All of an
    /// element's print as one `data-on='click:module.show(@rows)'`.
    On(String, Span, TokenStream),
    /// `page`: an element of a document's layout around `<main>` that is the page's (a section's
    /// nav). Printed `data-corten-page`; a navigation's answer has it, and the runtime puts it in
    /// place of the one on screen, found by its id.
    Page(Span),
}

/// Why a `<form>` with `on:corten:progress` would never hear it: the runtime reports progress only
/// for a `data-patch` form it sends as `multipart/form-data` by a method other than GET. Attributes
/// a spread may write are not known here, so a form with one is left to the runtime.
fn progress_unsent(attrs: &[Attr]) -> Option<&'static str> {
    if !attrs.iter().any(|a| matches!(a, Attr::On(event, ..) if event == "corten:progress")) {
        return None;
    }
    if attrs.iter().any(|a| matches!(a, Attr::Spread(_))) {
        return None;
    }
    // `None`: not written; `Some(None)`: written as an expression, so not known here.
    let named = |want: &str| {
        attrs.iter().find_map(|a| match a {
            Attr::Bare(n) if n.eq_ignore_ascii_case(want) => Some(Some("")),
            Attr::Static(n, v) if n.eq_ignore_ascii_case(want) => Some(Some(v.as_str())),
            Attr::Expr(n, _) if n.eq_ignore_ascii_case(want) => Some(None),
            _ => None,
        })
    };
    if named("data-patch").is_none() {
        return Some("on:corten:progress: the runtime reports an upload's progress only for a data-patch form (a form without it is sent by the browser, which reports none): add data-patch");
    }
    let multipart = match named("enctype") {
        Some(Some(v)) => v.eq_ignore_ascii_case("multipart/form-data"),
        Some(None) => true,
        None => false,
    };
    if !multipart {
        return Some("on:corten:progress: only a multipart body is sent with its progress: add enctype=\"multipart/form-data\"");
    }
    let sends_body = match named("method") {
        Some(Some(v)) => !v.is_empty() && !v.eq_ignore_ascii_case("get") && !v.eq_ignore_ascii_case("dialog"),
        Some(None) => true,
        None => false,
    };
    if !sends_body {
        return Some(
            "on:corten:progress: a GET or dialog form sends no body, so it has no upload progress: give the form method=\"post\"",
        );
    }
    None
}

/// The attribute an element is named by for assistive technology, `aria-label` or
/// `aria-labelledby`, unless the element takes its role from elsewhere (a `role` of its own, or
/// a spread, which may write one).
fn label_of(attrs: &[Attr]) -> Option<&str> {
    let mut label = None;
    for attr in attrs {
        let name = match attr {
            Attr::Bare(name) | Attr::Static(name, _) | Attr::Expr(name, _) => name.as_str(),
            Attr::Spread(_) => return None,
            Attr::Ref(..) | Attr::On(..) | Attr::Page(_) => continue,
        };
        match name.to_ascii_lowercase().as_str() {
            "role" => return None,
            "aria-label" | "aria-labelledby" => label = label.or(Some(name)),
            _ => {}
        }
    }
    label
}

/// What is wrong with an element named by `aria-label` or `aria-labelledby` that, by its kind and
/// attributes, has no role a name can go on, so assistive technology drops the name (ARIA
/// prohibits it there): a `<div>` or `<span>` without a `role`, or an `<a>` without an `href`.
/// An `<a>` whose `href` is an expression is checked by its type (`checks_href`). Not checked
/// inside an `<svg>`, whose elements ARIA maps differently (an `<a>` with no href is a group).
fn unnamed_label(name: &str, attrs: &[Attr]) -> Option<String> {
    let label = label_of(attrs)?;
    let has = |wanted: &str| {
        attrs.iter().any(|a| matches!(a, Attr::Bare(n) | Attr::Static(n, _) | Attr::Expr(n, _) if n.eq_ignore_ascii_case(wanted)))
    };
    match name {
        "div" | "span" => Some(format!(
            "{label} on a <{name}> with no role names nothing: assistive technology drops it. Put the name in the element as text (<span class={{VisuallyHidden {{}}}}>\"..\"</span> beside an icon), or give the element the role it plays (role=\"img\", role=\"group\")"
        )),
        "a" if !has("href") => Some(format!(
            "{label} on an <a> with no href names nothing: without an href it is not a link, and assistive technology drops the name. Give it an href, or put the name in it as text (<span class={{VisuallyHidden {{}}}}>\"..\"</span>)"
        )),
        _ => None,
    }
}

/// An `<a>` named by a written-out `aria-label` or `aria-labelledby` whose `href` is an
/// expression: its type must always write one (not `href={before.map(..)}`). A name that is an
/// expression may be absent with the href, so it is not checked.
fn checks_href(name: &str, attrs: &[Attr]) -> bool {
    let named = |n: &str| n.eq_ignore_ascii_case("aria-label") || n.eq_ignore_ascii_case("aria-labelledby");
    name == "a" && label_of(attrs).is_some() && attrs.iter().any(|a| matches!(a, Attr::Bare(n) | Attr::Static(n, _) if named(n)))
}

/// Attributes whose value is a URL a browser loads or goes to.
const URL_ATTRS: &[&str] =
    &["href", "xlink:href", "src", "srcset", "imagesrcset", "poster", "action", "formaction", "data", "ping"];

/// Whether `attr` takes a URL that is not a form's address, where a page's post's address
/// (`route::Action`, which only a form sends to) does not compile.
fn link_attr(attr: &str) -> bool {
    let attr = attr.to_ascii_lowercase();
    URL_ATTRS.contains(&attr.as_str()) && attr != "action" && attr != "formaction"
}

/// The URL in `value`, the text of the attribute `name` (lowercase), that is a path in this app
/// (`is_local_path`). `srcset` and `imagesrcset` hold a list of candidates and `ping` a list of
/// URLs, and each URL in them is read. A link is a route and a static file its constant, so a path
/// written as text is refused (`refused_path`).
fn local_path<'a>(name: &str, value: &'a str) -> Option<&'a str> {
    match name {
        "srcset" | "imagesrcset" => srcset_urls(value).into_iter().find(|url| is_local_path(url)),
        "ping" => value.split_ascii_whitespace().find(|url| is_local_path(url)),
        _ if URL_ATTRS.contains(&name) => is_local_path(value).then_some(value),
        _ => None,
    }
}

/// `url` as a browser reads it: without the spaces and control characters it drops at either end,
/// or the tabs and newlines it drops anywhere.
fn as_read(url: &str) -> String {
    url.trim_matches(|c: char| c <= ' ').chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect()
}

/// What follows `http:` or `https:` (in any case) at the start of `url`.
fn after_web_scheme(url: &str) -> Option<&str> {
    ["http:", "https:"].into_iter().find_map(|scheme| {
        url.get(..scheme.len()).filter(|start| start.eq_ignore_ascii_case(scheme)).map(|_| &url[scheme.len()..])
    })
}

/// Whether `url` is a path in this app as a browser reads it (`as_read`): it starts with one `/`
/// or `\` (which a browser reads as `/`), not two, which name another host. So is `http:` or
/// `https:` without the two slashes of a host (`https:/items`, `https:items`): on a page of that
/// scheme a browser reads it as `/items` or `items`. A fragment, another URL with a scheme and a
/// relative path are not.
fn is_local_path(url: &str) -> bool {
    let url = as_read(url);
    let slashes = |s: &str| s.chars().take(2).take_while(|c| matches!(c, '/' | '\\')).count();
    match after_web_scheme(&url) {
        Some(rest) => slashes(rest) < 2,
        None => slashes(&url) == 1,
    }
}

/// The URLs of a `srcset`, split as the HTML standard splits it: a candidate is a URL (the text up
/// to a space, less its trailing commas) and its descriptors, up to the next comma outside
/// parentheses, which do not nest (the first `)` closes them). A comma inside a URL
/// (`data:image/jpeg;base64,/9j/..`) does not split it.
fn srcset_urls(value: &str) -> Vec<&str> {
    let mut urls = Vec::new();
    let mut rest = value;
    loop {
        rest = rest.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == ',');
        if rest.is_empty() {
            return urls;
        }
        let end = rest.find(|c: char| c.is_ascii_whitespace()).unwrap_or(rest.len());
        let url = rest[..end].trim_end_matches(',');
        urls.push(url);
        let ended = url.len() < end;
        rest = &rest[end..];
        if ended {
            // A comma after the URL ends the candidate: it has no descriptors.
            continue;
        }
        let mut in_parens = false;
        let cut = rest
            .char_indices()
            .find(|&(_, c)| {
                match c {
                    '(' => in_parens = true,
                    ')' => in_parens = false,
                    ',' if !in_parens => return true,
                    _ => {}
                }
                false
            })
            .map_or(rest.len(), |(at, _)| at);
        rest = &rest[cut..];
    }
}

/// The error for `url`, a path in this app written as text in the URL attribute `name` (as
/// written; its case does not change the advice): it names the typed forms that replace it, as that
/// attribute writes them (a list keeps its descriptors or spaces, a fragment stays after a static
/// file), and the explicit opt-out for a path the app does not route, a `Local`, which keeps a
/// fragment.
fn refused_path(name: &str, url: &str) -> String {
    let read = as_read(url);
    let what = if after_web_scheme(&read).is_some() {
        "has a scheme but no host (no //): on a page of that scheme a browser reads it as a path in this app, and on a page of the other scheme as a host named by its first segment"
    } else {
        "is a path in this app written as text"
    };
    let lower = name.to_ascii_lowercase();
    let list = matches!(lower.as_str(), "srcset" | "imagesrcset" | "ping");
    let fragment = read.split_once('#').map(|(_, fragment)| fragment);
    let fix = match (lower.as_str(), fragment) {
        ("srcset" | "imagesrcset", _) => format!(
            "Name each file by its constant in a tuple that keeps the descriptors, {name}={{(req.asset(Static::PHOTO_PNG), \" 1x, \", req.asset(Static::PHOTO_2X_PNG), \" 2x\")}}"
        ),
        ("ping", _) => format!(
            "Name each URL by its #[derive(Route)] struct in a tuple that keeps the spaces, {name}={{(url::Seen.href(), \" \", url::Read.href())}}"
        ),
        (_, Some(fragment)) => format!(
            "A place on a page of the app is its #[derive(Route)] struct's, {name}={{url::Items.at(Id)}}, and a static file with a fragment is its constant and the fragment, {name}={{(req.asset(Static::SPRITE_SVG), \"#{fragment}\")}}"
        ),
        _ => format!(
            "Link to a #[derive(Route)] struct, {name}={{url::Items}} (url::Item {{ id }} for one with parameters, url::Items.at(Id) for a place on a page), or name a static file by its constant, {name}={{req.asset(Static::LOGO_SVG)}}"
        ),
    };
    let example = match fragment {
        Some(fragment) => format!("/proxy/page#{fragment}"),
        None => "/oauth2/sign_out".to_string(),
    };
    let unrouted = if list {
        "the text of a corten::Local in the tuple, Local::parse(\"/cdn-cgi/image/photo.png\").expect(\"a path on this site\").to_string()".to_string()
    } else {
        format!("a corten::Local, {name}={{corten::Local::parse(\"{example}\").expect(\"a path on this site\")}}, which keeps a query and #fragment")
    };
    format!(
        "{name}: \"{url}\" {what}, which nothing checks. {fix}. Only a path on this origin that the app does not route (another service behind the same proxy) may be written out, and then as an explicit opt-out the compiler takes on trust: {unrouted}. A URL outside the app is written whole (https://..)"
    )
}

/// The text of a value in braces that is one string literal, `href={"/items"}`, which the macro
/// sees as it sees `href="/items"`: `value` gives it in parentheses.
fn braced_text(expr: &TokenStream) -> Option<String> {
    let mut outer = expr.clone().into_iter();
    let (Some(TokenTree::Group(group)), None) = (outer.next(), outer.next()) else {
        return None;
    };
    let mut inner = group.stream().into_iter();
    match (inner.next(), inner.next()) {
        (Some(TokenTree::Literal(lit)), None) => string_value(&lit),
        _ => None,
    }
}

/// `tokens` with every span, inside groups too, located at `at`, so an error in them points
/// there; their names still resolve where the macro expands (a `macro_rules!` around `html!`).
fn respan(tokens: TokenStream, at: Span) -> TokenStream {
    let at = Span::call_site().located_at(at);
    tokens
        .into_iter()
        .map(|token| match token {
            TokenTree::Group(g) => {
                let mut group = Group::new(g.delimiter(), respan(g.stream(), at));
                group.set_span(at);
                TokenTree::Group(group)
            }
            mut other => {
                other.set_span(at);
                other
            }
        })
        .collect()
}

/// The SVG elements whose children are HTML's: the HTML standard's HTML integration points in
/// SVG, where a browser parses what they hold as HTML.
const SVG_HTML_POINTS: &[&str] = &["foreignObject", "desc", "title"];

/// Whether the children of `name`, inside an `<svg>` when `outer`, are taken for SVG's by the
/// accessible-name check and the named link's `href` check: everything in an `<svg>` but what its
/// `<foreignObject>` holds. Those checks keep that rule, so markup in an `<svg>`'s `<desc>` or
/// `<title>` that compiled before `within_svg` took them for HTML's still compiles.
fn within_aria_svg(outer: bool, name: &str) -> bool {
    if outer {
        !name.eq_ignore_ascii_case("foreignObject")
    } else {
        name.eq_ignore_ascii_case("svg")
    }
}

/// Whether the children of `name`, inside an `<svg>` when `outer`, are SVG's elements, as the
/// key check counts them.
fn within_svg(outer: bool, name: &str) -> bool {
    if outer {
        !SVG_HTML_POINTS.iter().any(|point| name.eq_ignore_ascii_case(point))
    } else {
        name.eq_ignore_ascii_case("svg")
    }
}

/// The start tags the HTML standard's rules for parsing tokens in foreign content take out of an
/// `<svg>` or a `<math>`: the parser closes the foreign elements around it (up to an HTML or a
/// MathML text integration point) and reads the tag as HTML's, so it and what follows land
/// outside the drawing or the formula. A `<font>` does too when it has a `color`, `face` or
/// `size` (`breaks_out`).
const BREAKOUT: &[&str] = &[
    "b",
    "big",
    "blockquote",
    "body",
    "br",
    "center",
    "code",
    "dd",
    "div",
    "dl",
    "dt",
    "em",
    "embed",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "hr",
    "i",
    "img",
    "li",
    "listing",
    "menu",
    "meta",
    "nobr",
    "ol",
    "p",
    "pre",
    "ruby",
    "s",
    "small",
    "span",
    "strong",
    "strike",
    "sub",
    "sup",
    "table",
    "tt",
    "u",
    "ul",
    "var",
];

/// The MathML elements whose children are HTML's: the HTML standard's MathML text integration
/// points, where every start tag is HTML's but `<mglyph>` and `<malignmark>`, which stay
/// MathML's (`Parsing::MathText`). An `<annotation-xml>` is an HTML integration point only with
/// an `encoding` of `text/html` or `application/xhtml+xml` (`annotation_parsing`, by its first); with another
/// or none it holds MathML, and an `<svg>` in it is SVG's (`Parsing::AnnotationXml`).
const MATH_HTML_POINTS: &[&str] = &["mi", "mo", "mn", "ms", "mtext"];

/// How a browser parses the content at a point of the markup, as far as this markup shows: an
/// `html!` does not see where its view is written, so what it cannot show is `Unknown`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Parsing {
    /// As HTML: under an element that is HTML's wherever it lands (one of `BREAKOUT`, which a
    /// document's `<head>` and `<body>` are), in an `<svg>`'s `<foreignObject>`, `<desc>` or
    /// `<title>` (`SVG_HTML_POINTS`), or in a `<math>`'s `<annotation-xml>` whose first
    /// `encoding` is an HTML one.
    Html,
    /// As HTML, but for two tags: straight in a `<math>`'s `<mi>`, `<mo>`, `<mn>`, `<ms>` or
    /// `<mtext>` (`MATH_HTML_POINTS`), where a `<mglyph>` or a `<malignmark>` is MathML's.
    MathText,
    /// As SVG: in a literal `<svg>`, outside those.
    Svg,
    /// As MathML: in a literal `<math>`, outside those. An element a browser takes out of
    /// foreign content (`BREAKOUT`) is refused here as in an `<svg>`; the rules for elements
    /// read as text do not apply.
    Math,
    /// As MathML, but an `<svg>` is SVG's: straight in an `<annotation-xml>` whose first
    /// `encoding` is not an HTML one, or that has none. Refuses as `Math` does.
    AnnotationXml,
    /// As SVG or as MathML, which the markup does not show: in a literal `<svg>` or `<math>`
    /// written where how the browser parses is not known (a `<math>` in an `<svg>` is SVG's, an
    /// `<svg>` straight in a `<math>` MathML's). An element a browser takes out of foreign
    /// content is refused here as in either, and what an element that is an integration point in
    /// either holds is not known.
    Foreign,
    /// Not known: at the top of an `html!` (a component's markup lands where its parent writes
    /// it, in an `<svg>` perhaps), among a component's children, which go where it writes them,
    /// after an expression or a component (what it writes may open an `<svg>` or close one),
    /// and in an `<annotation-xml>` where an expression or a spread comes before the first written
    /// `encoding` (either may write the first); one after it changes nothing.
    Unknown,
}

/// How the children of an `<annotation-xml>` with `attrs` are parsed, by its first `encoding`, the
/// one a browser keeps (`html!` writes attributes in the order they are written): HTML when it is
/// `text/html` or `application/xhtml+xml` (ASCII case-insensitive), MathML when it is another or
/// none is written, and not known when an expression or a spread comes first, which may write it.
fn annotation_parsing(attrs: &[Attr]) -> Parsing {
    for a in attrs {
        match a {
            Attr::Spread(_) => return Parsing::Unknown,
            Attr::Expr(n, _) if n.eq_ignore_ascii_case("encoding") => return Parsing::Unknown,
            Attr::Static(n, v) if n.eq_ignore_ascii_case("encoding") => {
                let html = v.eq_ignore_ascii_case("text/html") || v.eq_ignore_ascii_case("application/xhtml+xml");
                return if html { Parsing::Html } else { Parsing::AnnotationXml };
            }
            Attr::Bare(n) if n.eq_ignore_ascii_case("encoding") => return Parsing::AnnotationXml,
            _ => {}
        }
    }
    Parsing::AnnotationXml
}

/// Whether the element `name` with `attrs` is HTML's wherever it is written: one a browser
/// takes out of an `<svg>` or a `<math>` (`BREAKOUT`). A `<font>` is only with a `color`,
/// `face` or `size` the markup writes for certain (not one a spread or an expression may leave out).
fn breaks_out(name: &str, attrs: &[Attr]) -> bool {
    BREAKOUT.iter().any(|t| name.eq_ignore_ascii_case(t))
        || (name.eq_ignore_ascii_case("font")
            && attrs.iter().any(|a| matches!(a, Attr::Static(n, _) | Attr::Bare(n) if font_breakout_attr(n))))
}

fn font_breakout_attr(name: &str) -> bool {
    ["color", "face", "size"].iter().any(|attr| name.eq_ignore_ascii_case(attr))
}

fn may_break_out(name: &str, attrs: &[Attr]) -> bool {
    name.eq_ignore_ascii_case("font")
        && attrs.iter().any(|a| matches!(a, Attr::Spread(_)) || matches!(a, Attr::Expr(n, _) if font_breakout_attr(n)))
}

/// How the children of `name` with `attrs` are parsed, in content parsed as `outer`.
fn parsing_within(outer: Parsing, name: &str, attrs: &[Attr]) -> Parsing {
    let is = |n: &str| name.eq_ignore_ascii_case(n);
    match outer {
        Parsing::Svg if SVG_HTML_POINTS.iter().any(|point| is(point)) => Parsing::Html,
        Parsing::Svg => Parsing::Svg,
        // Straight in a `<math>` an `<svg>` is MathML's (valid only in `<annotation-xml>` or a
        // text integration point, where it is SVG's). A breakout element here does not compile
        // (`foreign_breakout` refuses it before its children are read), so it needs no arm.
        Parsing::Math if MATH_HTML_POINTS.iter().any(|point| is(point)) => Parsing::MathText,
        Parsing::Math if is("annotation-xml") => annotation_parsing(attrs),
        Parsing::Math => Parsing::Math,
        // The HTML standard's tree construction dispatcher reads an `<svg>` in a MathML
        // `<annotation-xml>` as HTML's rules do (an SVG `<svg>`); every other tag as in a `<math>`.
        Parsing::AnnotationXml if is("svg") => Parsing::Svg,
        Parsing::AnnotationXml => parsing_within(Parsing::Math, name, attrs),
        Parsing::MathText if is("mglyph") || is("malignmark") => Parsing::Math,
        Parsing::MathText => parsing_within(Parsing::Html, name, attrs),
        // An integration point of either namespace holds what the markup does not show; every
        // other element, an `<svg>` or a `<math>` too, is foreign in both.
        Parsing::Foreign if SVG_HTML_POINTS.iter().chain(MATH_HTML_POINTS).any(|point| is(point)) || is("annotation-xml") => {
            Parsing::Unknown
        }
        Parsing::Foreign => Parsing::Foreign,
        Parsing::Unknown if is("svg") || is("math") => Parsing::Foreign,
        _ if is("svg") => Parsing::Svg,
        _ if is("math") => Parsing::Math,
        Parsing::Html => Parsing::Html,
        Parsing::Unknown if breaks_out(name, attrs) => Parsing::Html,
        Parsing::Unknown => Parsing::Unknown,
    }
}

/// Whether a start tag in content parsed as `parsing` is HTML's for certain. In a text
/// integration point only `<mglyph>` and `<malignmark>` are not, and neither reads its content
/// as text or is `<plaintext>`, so the rules below need not name them.
fn as_html(parsing: Parsing) -> bool {
    matches!(parsing, Parsing::Html | Parsing::MathText)
}

/// Whether a browser reads the content of `name`, in content parsed as `parsing`, as text: as
/// HTML, `<script>` and `<style>` and the elements of `TEXT_ONLY`. In an `<svg>` or a
/// `<math>` they are elements whose children are elements, and where the markup does not show
/// which it is, it is not taken for text.
fn reads_as_text(parsing: Parsing, name: &str) -> bool {
    as_html(parsing) && RAW_TEXT.iter().chain(TEXT_ONLY).any(|t| name.eq_ignore_ascii_case(t))
}

/// Whether what `name` holds, in content parsed as `parsing`, may be text a browser does not read
/// as tags, though the markup does not show it is: a `<noscript>` anywhere (text with scripting
/// on, markup without it), and, where the markup does not show the element is HTML's
/// (`Parsing::Unknown`), the elements a browser parsing HTML reads as text (`RAW_TEXT`,
/// `TEXT_ONLY`, `<plaintext>`), which in an `<svg>` or a `<math>` hold elements. Nothing a
/// refusal rests on is read in one: what it holds is unseen.
fn may_read_as_text(parsing: Parsing, name: &str) -> bool {
    let is = |n: &str| name.eq_ignore_ascii_case(n);
    is("noscript") || (parsing == Parsing::Unknown && (is("plaintext") || RAW_TEXT.iter().chain(TEXT_ONLY).any(|t| is(t))))
}

/// Why the element `name` does not compile here: inside `holder`, whose content a browser reads
/// as text, or a `<plaintext>` parsed as HTML, which makes the rest of the page text.
fn text_only_element(holder: Option<&str>, parsing: Parsing, name: &str) -> Option<String> {
    if let Some(holder) = holder {
        let instead = if RAW_TEXT.contains(&holder) {
            format!(
                "behavior is a #[component(js)], styles a component's CSS file, or write the content as a string literal, which a <{holder}> writes as is"
            )
        } else {
            "put the element beside it, or write text meant to show tags as a string (\"<b>\")".into()
        };
        return Some(format!(
            "<{holder}> holds only text: a browser reads a <{name}> written in it as text, not as an element; {instead}"
        ));
    }
    (as_html(parsing) && name.eq_ignore_ascii_case("plaintext"))
        .then(|| "<plaintext> makes the rest of the page text, its end tag included: write <pre> for preformatted text".into())
}

/// Why the element `name` with `attrs` does not compile here: written straight into an `<svg>`
/// or a `<math>` (outside their integration points), it is one a browser takes out of foreign
/// content (`BREAKOUT`).
fn foreign_breakout(parsing: Parsing, name: &str, attrs: &[Attr]) -> Option<String> {
    if !breaks_out(name, attrs) {
        return None;
    }
    match parsing {
        Parsing::Svg => Some(format!(
            "<{name}> is HTML's, and a browser that meets it in an <svg> closes the <svg> before it, so it and what follows land outside the drawing: put HTML in an <svg> inside a <foreignObject>"
        )),
        Parsing::Math => Some(format!(
            "<{name}> is HTML's, and a browser that meets it in a <math> closes the MathML elements around it, the <math> too unless one of them is an <mi>, <mo>, <mn>, <ms> or <mtext>, so it and what follows land outside them: put HTML in a <math> inside an <mtext>"
        )),
        Parsing::AnnotationXml => Some(format!(
            "<{name}> is HTML's, and an <annotation-xml> whose first encoding is not an HTML one (or that has none) holds MathML, so a browser that meets it there closes the MathML elements around it, the <math> too unless one of them is an <mi>, <mo>, <mn>, <ms> or <mtext>: give the <annotation-xml> encoding=\"text/html\" as its first encoding, or put the HTML in an <mtext>"
        )),
        Parsing::Foreign => Some(format!(
            "<{name}> is HTML's, and a browser that meets it in an <svg> or a <math> closes the foreign elements around it, so it and what follows land outside them: put HTML in an <svg> inside a <foreignObject>, and in a <math> inside an <mtext>"
        )),
        _ => None,
    }
}

struct Cursor {
    tokens: Vec<TokenTree>,
    i: usize,
    end: Span,
    /// Inside an `<svg>` (and not in its `<foreignObject>`), where the accessible-name check does
    /// not look (`within_aria_svg`).
    aria_svg: bool,
    /// Inside the content of an element a browser reads as text (`RAW_TEXT`, `TEXT_ONLY`), named
    /// here, where an element does not compile.
    text_only: Option<String>,
    /// How a browser parses the content here, as far as this markup shows.
    parsing: Parsing,
    /// Context at the start of a `<script>` or `<style>`, whose text `Gen` writes as prepared here.
    raw_text: Option<Parsing>,
    /// Count of possible context changes, so a body can tell whether it added any. After
    /// opaque output a browser may be reading text no later literal tag ends (a `<plaintext>`,
    /// a comment, or a script whose text holds `<!--<script>`).
    opaque: usize,
}

impl Cursor {
    fn new(stream: TokenStream) -> Self {
        Cursor {
            tokens: stream.into_iter().collect(),
            i: 0,
            end: Span::call_site(),
            aria_svg: false,
            text_only: None,
            parsing: Parsing::Unknown,
            raw_text: None,
            opaque: 0,
        }
    }

    fn of(group: &Group) -> Self {
        Cursor {
            tokens: group.stream().into_iter().collect(),
            i: 0,
            end: group.span_close(),
            aria_svg: false,
            text_only: None,
            parsing: Parsing::Unknown,
            raw_text: None,
            opaque: 0,
        }
    }

    /// Past an expression, a component or a block holding one: what it writes may close the
    /// element whose content is read as text, open an `<svg>` or an integration point, or leave
    /// a browser reading text, so the markup shows none of them again (`tag`).
    fn unseen(&mut self) {
        self.opaque += 1;
        self.parsing = Parsing::Unknown;
        self.text_only = None;
    }

    /// The body of a `for`, `if` or `match` here, inside an `<svg>` or an element read as text
    /// when this is, and after what the markup does not show when this is.
    fn inner(&self, group: &Group) -> Self {
        Cursor {
            aria_svg: self.aria_svg,
            text_only: self.text_only.clone(),
            parsing: self.parsing,
            raw_text: self.raw_text,
            opaque: self.opaque,
            ..Cursor::of(group)
        }
    }

    fn peek(&self) -> Option<&TokenTree> {
        self.tokens.get(self.i)
    }

    fn peek2(&self) -> Option<&TokenTree> {
        self.tokens.get(self.i + 1)
    }

    fn next(&mut self) -> Option<TokenTree> {
        let token = self.tokens.get(self.i).cloned();
        self.i += 1;
        token
    }

    fn span(&self) -> Span {
        self.peek().map_or(self.end, TokenTree::span)
    }

    fn at_end(&self) -> bool {
        self.i >= self.tokens.len()
    }

    /// Nodes until the end, or until `</` when inside the element named `closing`.
    fn nodes(&mut self, closing: Option<&str>, mut html_noscript: bool) -> Result<Vec<Node>, Error> {
        let raw_holder = closing.filter(|name| self.text_only.as_deref() == Some(*name) && RAW_TEXT.contains(name));
        let mut nodes = Vec::new();
        while !self.at_end() {
            if is_punct(self.peek(), '<') && is_punct(self.peek2(), '/') {
                if closing.is_some() {
                    break;
                }
                let span = self.span();
                self.next();
                self.next();
                let name = self.name().map(|n| n.0).unwrap_or_default();
                let hint = if VOID.contains(&name.as_str()) {
                    format!("; <{name}> is a void element and has no closing tag")
                } else {
                    String::new()
                };
                return err(span, format!("unexpected closing tag </{name}>{hint}"));
            }
            // An early end tag can release the text-only check. A script that will consume
            // its closing tag is still a text holder here. Neither depends on literal encoding.
            if let Some(name) = raw_holder.filter(|_| self.text_only.is_some()) {
                if is_punct(self.peek(), '<')
                    && !is_punct(self.peek2(), '!')
                    && raw_text_boundary(name, &nodes) == RawTextBoundary::EarlyClose
                {
                    self.unseen();
                }
            }
            let span = self.span();
            let node = self.node(html_noscript)?;
            if html_noscript {
                // With scripting on the stylesheet is part of noscript's raw text; with it
                // off the style is itself raw text. Keep the proof only across a static
                // prefix that preserves both contexts, including head's metadata tags.
                html_noscript = match &node {
                    Node::Element { name, children, .. } if name == "style" => {
                        let stable = children.iter().all(|node| matches!(node, Node::Text(_) | Node::Let(_)))
                            && !writes_tags(name, children)
                            && raw_text_boundary("noscript", children) == RawTextBoundary::Unchanged;
                        if !stable && has_raw_delimiters(children, true) {
                            return err(
                                span,
                                ambiguous_raw_text("a fallback stylesheet must be literal and leave both tag boundaries intact"),
                            );
                        }
                        stable
                    }
                    Node::Element { name, .. } => matches!(name.as_str(), "link" | "meta"),
                    Node::Text(text) => text.bytes().all(|byte| byte.is_ascii_whitespace()),
                    Node::Let(_) => true,
                    _ => false,
                };
            }
            nodes.push(node);
        }
        if let Some(name) = raw_holder.filter(|_| self.text_only.is_some()) {
            if writes_tags(name, &nodes) {
                self.unseen();
            }
        }
        Ok(nodes)
    }

    fn node(&mut self, html_noscript: bool) -> Result<Node, Error> {
        let span = self.span();
        match self.peek().cloned() {
            Some(TokenTree::Punct(p)) if p.as_char() == '<' => self.tag(html_noscript),
            Some(TokenTree::Literal(lit)) => {
                self.next();
                match string_value(&lit).or_else(|| literal_text(&lit)) {
                    Some(text) => self.text(text, span),
                    None => err(span, "write text as a string literal: \"...\""),
                }
            }
            Some(TokenTree::Group(g)) if g.delimiter() == Delimiter::Brace => {
                self.next();
                let inner: Vec<TokenTree> = g.stream().into_iter().collect();
                if inner.is_empty() {
                    return err(span, "empty braces: put a Rust expression inside, like {name}");
                }
                if is_punct(inner.first(), '.') && is_punct(inner.get(1), '.') {
                    return err(span, "{..attributes} goes inside a start tag, like <input {..attrs}>");
                }
                self.unseen();
                Ok(Node::Expr(borrowing(&lent_args(g.stream()))))
            }
            Some(TokenTree::Ident(id)) => match id.to_string().as_str() {
                "for" => self.block_for(),
                "if" => self.block_if(),
                "match" => self.block_match(),
                "let" => {
                    let tokens = self.until_semicolon()?;
                    Ok(Node::Let(tokens))
                }
                word => err(
                    span,
                    format!("unexpected `{word}`: write text in quotes (\"{word}\") and Rust expressions in braces ({{{word}}})"),
                ),
            },
            Some(other) => err(
                other.span(),
                format!("unexpected `{other}`: expected <element>, \"text\", {{expression}}, for, if, match or let"),
            ),
            None => err(span, "unexpected end of markup"),
        }
    }

    fn text(&mut self, mut text: String, span: Span) -> Result<Node, Error> {
        if let Some(parsing) = self.raw_text.filter(|_| text.contains(['&', '<'])) {
            match parsing {
                Parsing::Unknown => {
                    return err(
                        span,
                        ambiguous_raw_text("the surrounding markup does not show whether it is HTML or foreign content"),
                    )
                }
                Parsing::Html | Parsing::MathText => {}
                Parsing::Svg | Parsing::Math | Parsing::AnnotationXml | Parsing::Foreign => {
                    // Gen writes these bytes as is; the browser reads them in the data state.
                    text = text.replace('&', "&amp;").replace('<', "&lt;");
                }
            }
        }
        Ok(Node::Text(text))
    }

    /// A tag name: `div`, `listing-sort`, `Card` or `ui::Card`. Returns the name, its tokens and
    /// whether it names a component (a path, or a name starting with an uppercase letter).
    fn name(&mut self) -> Result<(String, TokenStream, Span), Error> {
        let span = self.span();
        let Some(TokenTree::Ident(first)) = self.next() else {
            return err(span, "expected a tag name");
        };
        let mut name = first.to_string();
        let mut tokens = vec![TokenTree::Ident(first)];
        loop {
            match (self.peek(), self.peek2()) {
                (Some(TokenTree::Punct(p)), Some(TokenTree::Ident(_) | TokenTree::Literal(_))) if p.as_char() == '-' => {
                    let dash = self.next().unwrap();
                    let part = self.next().unwrap();
                    name.push('-');
                    name.push_str(&part.to_string());
                    tokens.extend([dash, part]);
                }
                (Some(TokenTree::Punct(a)), Some(TokenTree::Punct(b))) if a.as_char() == ':' && b.as_char() == ':' => {
                    tokens.extend([self.next().unwrap(), self.next().unwrap()]);
                    let span = self.span();
                    match self.next() {
                        Some(TokenTree::Ident(part)) => {
                            name.push_str("::");
                            name.push_str(&part.to_string());
                            tokens.push(TokenTree::Ident(part));
                        }
                        _ => return err(span, "expected a name after ::"),
                    }
                }
                _ => break,
            }
        }
        Ok((name, stream(tokens), span))
    }

    fn tag(&mut self, html_noscript: bool) -> Result<Node, Error> {
        let open = self.span();
        self.next();
        if is_punct(self.peek(), '!') {
            self.next();
            let doctype = self.next();
            let html = self.next();
            if !(matches!(&doctype, Some(TokenTree::Ident(d)) if d.to_string().eq_ignore_ascii_case("doctype"))
                && matches!(&html, Some(TokenTree::Ident(h)) if h.to_string() == "html")
                && is_punct(self.peek(), '>'))
            {
                return err(open, "the only declaration is <!DOCTYPE html>");
            }
            self.next();
            return Ok(Node::Markup("<!DOCTYPE html>".into()));
        }
        if is_punct(self.peek(), '>') {
            self.next();
            let children = self.nodes(Some(""), false)?;
            self.closing("", open)?;
            return Ok(Node::Block { head: vec![TokenStream::new()], bodies: vec![children], arms: false });
        }
        let (name, path, name_span) = self.name()?;
        let component = name.contains("::") || name.starts_with(|c: char| c.is_ascii_uppercase());
        let is_form = name == "form";
        if component && name.contains('-') {
            return err(name_span, "a component name is a Rust path; element names with - are lowercase");
        }
        if !component {
            if let Some(why) = text_only_element(self.text_only.as_deref(), self.parsing, &name) {
                return err(name_span, why);
            }
        }
        let mut attrs = Vec::new();
        let mut props = Vec::new();
        let mut names = std::collections::HashSet::new();
        let self_closing = loop {
            let span = self.span();
            match self.peek().cloned() {
                Some(TokenTree::Punct(p)) if p.as_char() == '>' => {
                    self.next();
                    break false;
                }
                Some(TokenTree::Punct(p)) if p.as_char() == '/' && is_punct(self.peek2(), '>') => {
                    self.next();
                    self.next();
                    break true;
                }
                Some(TokenTree::Group(g)) if g.delimiter() == Delimiter::Brace => {
                    self.next();
                    let inner: Vec<TokenTree> = g.stream().into_iter().collect();
                    if component || !(is_punct(inner.first(), '.') && is_punct(inner.get(1), '.')) {
                        return err(span, "inside a start tag, braces spread attributes: {..attrs}");
                    }
                    attrs.push(Attr::Spread(stream(inner.into_iter().skip(2))));
                }
                Some(TokenTree::Ident(id))
                    if component
                        && id.to_string() == "on"
                        && is_punct(self.peek2(), ':')
                        && !matches!(self.tokens.get(self.i + 2), Some(TokenTree::Punct(_))) =>
                {
                    self.next();
                    self.next();
                    let span = self.span();
                    let Some(TokenTree::Ident(event)) = self.next() else {
                        return err(span, "on: on a component names one of its Handler props: on:remove={..} sets on_remove");
                    };
                    if event.to_string() == "document" && is_punct(self.peek(), ':') {
                        return err(span, "on:document: goes on an element in the component's own markup, which hears the event anywhere on the page while it is there; on: on a component sets one of its Handler props");
                    }
                    if !is_punct(self.peek(), '=') {
                        return err(span, format!("on:{event} takes a handler: on:{event}={{js::name(..)}}"));
                    }
                    self.next();
                    let (_, expr) = self.value(true)?;
                    let field = Ident::new(&format!("on_{event}"), event.span());
                    let expr =
                        keywords(expr, &q("::corten::script::ev::Event", &[]), &q("::corten::script::el::HTMLElement", &[]));
                    props.push((stream([TokenTree::Ident(field)]), q("&(__A0)", &[expr])));
                }
                Some(TokenTree::Ident(_)) if component => {
                    let Some(TokenTree::Ident(prop)) = self.next() else { unreachable!() };
                    if is_punct(self.peek(), '-') {
                        return err(self.span(), "component props are Rust field names (no -)");
                    }
                    let text = prop.to_string();
                    let field = if KEYWORDS.contains(&text.as_str()) { Ident::new_raw(&text, prop.span()) } else { prop };
                    let value = if is_punct(self.peek(), '=') {
                        self.next();
                        self.value(true)?.1
                    } else {
                        q("true", &[])
                    };
                    props.push((stream([TokenTree::Ident(field)]), value));
                }
                Some(TokenTree::Ident(_)) => {
                    let name = self.attr_name()?;
                    let lower = name.to_ascii_lowercase();
                    if lower == "data-key" {
                        return err(span, "data-key is printed by Corten: write key={item.id} to give a keyed ref its key");
                    }
                    // HTML attribute names are case-insensitive: `data-Vars` is `data-vars`.
                    if matches!(lower.as_str(), "data-nav" | "data-nav-group" | "data-nav-also" | "data-nav-order") {
                        return err(span, format!("{name} is printed by Corten: write <a {{..req.nav(&url::News)}}> (or req.nav_section, or a link of req.nav_of), which writes the link's href and current-page attributes from one mention of the route"));
                    }
                    if lower == "data-ref" || lower == "data-on" || lower == "data-scope" {
                        return err(span, "data-ref, data-on and data-scope are printed by Corten: write ref={rows} (with let (rows) = refs();) or on:click={js::show(rows)}");
                    }
                    if lower == "data-ref-value" {
                        return err(span, "data-ref-value is printed by Corten: give the value with the element's ref, ref={row.with(cents)}, and take it in the handler as a Map<El, number> (or string, boolean)");
                    }
                    if lower == "style" && name != "style" {
                        return err(span, format!("write style, not {name}: style={{FILL.pct(42.0)}} is checked only as style"));
                    }
                    if lower == "data-vars" {
                        return err(span, "data-vars is printed by Corten: write style={FILL.pct(42.0)}, with --fill registered by an @property in the component's stylesheet");
                    }
                    if lower == "data-corten-page" {
                        return err(span, "data-corten-page is printed by Corten: write page on an element of the layout, <nav page id={SectionNavId}>");
                    }
                    // `page`: an element of a document's layout that is the page's (a section's
                    // nav), which a navigation sends with `<main>`'s children.
                    let attr = if name == "page" && !is_punct(self.peek(), '=') {
                        Attr::Page(span)
                    } else if name == "ref" || name.starts_with("on:") {
                        let braced = is_punct(self.peek(), '=')
                            && matches!(self.peek2(), Some(TokenTree::Group(g)) if g.delimiter() == Delimiter::Brace);
                        if !braced {
                            return err(
                                span,
                                format!("{name} takes a value in braces: ref={{rows}}, on:click={{js::show(rows)}}"),
                            );
                        }
                        self.next();
                        let (_, expr) = self.value(false)?;
                        match name.strip_prefix("on:") {
                            Some(event) => {
                                // `on:document:keydown`: the element's handler for an event anywhere on
                                // the page, printed `document.keydown` (the last `:` before the module
                                // ends the type, so the runtime's `corten:error` keeps its own).
                                let named = event.strip_prefix("document:").unwrap_or(event);
                                if named.contains(':') && !crate::dom::is_runtime_event(named) {
                                    return err(span, format!("{name}: an event name with a colon is one of the runtime's, corten:error (on a data-patch form, or on:document:), corten:progress (on a data-patch form) or corten:notice (on:document:corten:notice); a component's own event is a typed one (#[event], on:RowToggled)"));
                                }
                                if named == "corten:progress" && (event != named || !is_form) {
                                    return err(span, format!("{name}: the runtime dispatches corten:progress on the data-patch form whose upload it is, and it does not bubble: write on:corten:progress on that <form>"));
                                }
                                if event == "corten:notice" {
                                    return err(span, format!("{name}: the runtime dispatches corten:notice on the document, so no element hears it: write on:document:corten:notice"));
                                }
                                if let Some(on_page) = event.strip_prefix("document:") {
                                    if on_page.starts_with(|c: char| c.is_ascii_uppercase()) {
                                        return err(span, format!("{name}: on:document: takes an event of the browser's (on:document:keydown); a typed event is heard on an element it bubbles through: on:{on_page}={{..}}"));
                                    }
                                    let bubbling = match on_page {
                                        "focus" => Some("focusin"),
                                        "blur" => Some("focusout"),
                                        "mouseenter" => Some("mouseover"),
                                        "mouseleave" => Some("mouseout"),
                                        "pointerenter" => Some("pointerover"),
                                        "pointerleave" => Some("pointerout"),
                                        _ => None,
                                    };
                                    if let Some(bubbling) = bubbling {
                                        return err(span, format!("{name}: {on_page} stays on its element, so the document never hears it; on:document:{bubbling} hears every element's"));
                                    }
                                    if !crate::dom::reaches_document(on_page) && !crate::dom::is_runtime_event(on_page) {
                                        return err(span, format!("{name}: on:document: takes an event of the browser's that bubbles to the document (keydown, click, focusin, pointerover); {on_page} is not one, so a listener there would never hear it"));
                                    }
                                    Attr::On(format!("document.{on_page}"), span, expr)
                                } else {
                                    Attr::On(event.to_string(), span, expr)
                                }
                            }
                            None => {
                                // `value` wraps the braces' contents in parentheses.
                                let mut tokens: Vec<TokenTree> = expr.clone().into_iter().collect();
                                if let [TokenTree::Group(g)] = tokens.as_slice() {
                                    if g.delimiter() == Delimiter::Parenthesis {
                                        tokens = g.stream().into_iter().collect();
                                    }
                                }
                                let n = tokens.len();
                                if n >= 3 && is_ident(tokens.get(n - 2), "as") {
                                    let TokenTree::Ident(wide) = &tokens[n - 1] else {
                                        return err(tokens[n - 1].span(), "ref={trigger as HTMLElement} names a DOM interface");
                                    };
                                    Attr::Ref(stream(tokens[..n - 2].iter().cloned()), Some(wide.clone()))
                                } else {
                                    Attr::Ref(expr, None)
                                }
                            }
                        }
                    } else {
                        // `key={item.id}` names an element in a keyed ref (a handler's `Map`).
                        let emitted = if name == "key" { "data-key".into() } else { name.clone() };
                        if is_punct(self.peek(), '=') {
                            self.next();
                            let value_span = self.span();
                            match self.value(false)? {
                                (Some(text), _) => {
                                    if let Some(path) = local_path(&lower, &text) {
                                        return err(value_span, refused_path(&name, path));
                                    }
                                    Attr::Static(emitted, text)
                                }
                                (None, expr) => {
                                    if let Some(text) = braced_text(&expr) {
                                        if let Some(path) = local_path(&lower, &text) {
                                            return err(value_span, refused_path(&name, path));
                                        }
                                    }
                                    Attr::Expr(emitted, expr)
                                }
                            }
                        } else {
                            Attr::Bare(emitted)
                        }
                    };
                    let emitted = match &attr {
                        Attr::Ref(..) => Some("data-ref".into()),
                        Attr::Page(_) => Some("data-corten-page".into()),
                        // `style={FILL.pct(42.0)}` is written as data-vars, so a literal style beside it is another attribute.
                        Attr::Expr(name, _) if name == "style" => Some("data-vars".into()),
                        Attr::Bare(name) | Attr::Static(name, _) | Attr::Expr(name, _) => Some(name.to_ascii_lowercase()),
                        // Handler calls share one generated data-on attribute, including repeated events.
                        Attr::On(..) => None,
                        Attr::Spread(_) => unreachable!(),
                    };
                    if let Some(emitted) = emitted.filter(|emitted| !names.insert(emitted.clone())) {
                        let instead = if emitted == "data-vars" {
                            "give it a tuple, style={(FILL.pct(42.0), GAP.px(4.0))}"
                        } else {
                            "write the attribute once, combining its values in one expression if needed"
                        };
                        return err(
                            span,
                            format!(
                                "attribute {name} is written twice on this element: {instead}; a browser keeps only the first"
                            ),
                        );
                    }
                    attrs.push(attr);
                }
                _ => return err(span, format!("expected an attribute, > or /> in <{name}>")),
            }
        };
        if !component {
            if let Some(why) = foreign_breakout(self.parsing, &name, &attrs) {
                return err(name_span, why);
            }
            if !as_html(self.parsing) && may_break_out(&name, &attrs) {
                // A rendered color, face or size can pop the foreign ancestors, affecting both
                // this element's children and any markup after it.
                self.unseen();
            }
        } else {
            // A component's children go where it writes them, and its output is unseen even
            // when it takes no children.
            self.unseen();
        }
        if !component && !self.aria_svg {
            if let Some(why) = unnamed_label(&name, &attrs) {
                return err(name_span, why);
            }
        }
        if is_form {
            if let Some(why) = progress_unsent(&attrs) {
                return err(name_span, why);
            }
        }
        let void = !component && VOID.contains(&name.as_str());
        let children = if self_closing || void {
            None
        } else {
            let outer = self.aria_svg;
            self.aria_svg = within_aria_svg(outer, &name);
            let known_noscript = self.opaque == 0 && as_html(self.parsing) && name.eq_ignore_ascii_case("noscript");
            // What a `<noscript>` holds, or an element read as text where the markup does not show
            // it is HTML's, may be text: no context-dependent structural checks reach inside.
            let hidden = !component && may_read_as_text(self.parsing, &name);
            if hidden {
                self.opaque += 1;
            }
            let shown = self.opaque == 0;
            let holder = (shown && reads_as_text(self.parsing, &name)).then(|| name.clone());
            let outer_text = std::mem::replace(&mut self.text_only, holder);
            let inner = if shown { parsing_within(self.parsing, &name, &attrs) } else { Parsing::Unknown };
            let outer_parsing = std::mem::replace(&mut self.parsing, inner);
            let encoding = if html_noscript && name == "style" { Parsing::Html } else { inner };
            let raw = (!component && RAW_TEXT.contains(&name.as_str())).then_some(encoding);
            let outer_raw = std::mem::replace(&mut self.raw_text, raw);
            let seen = self.opaque;
            let children = self.nodes(Some(&name), known_noscript);
            self.aria_svg = outer;
            self.text_only = outer_text;
            self.parsing = outer_parsing;
            self.raw_text = outer_raw;
            if self.opaque != seen {
                self.unseen();
            }
            if hidden {
                self.opaque -= 1;
            }
            let children = children?;
            self.closing(&name, open)?;
            Some(children)
        };
        // A `<plaintext>` HTML's makes the rest of the page text, so after one (where it is not
        // refused, the markup does not show it is HTML's) nothing shows how anything is parsed.
        if !component && name.eq_ignore_ascii_case("plaintext") {
            self.unseen();
        }
        if component {
            return Ok(Node::Component { path, props, children });
        }
        Ok(Node::Element { name, attrs, children: children.unwrap_or_default() })
    }

    /// `</name>` after the children of the element opened at `open`.
    fn closing(&mut self, name: &str, open: Span) -> Result<(), Error> {
        if self.at_end() {
            return err(open, format!("<{name}> is never closed; add </{name}> or write <{name} />"));
        }
        self.next();
        self.next();
        let found = if is_punct(self.peek(), '>') { String::new() } else { self.name()?.0 };
        let span = self.span();
        if found != name {
            return err(span, format!("expected </{name}>, found </{found}>"));
        }
        if !is_punct(self.peek(), '>') {
            return err(span, format!("expected > to end </{name}"));
        }
        self.next();
        Ok(())
    }

    /// `data-ref`, `aria-label`, `xlink:href`.
    fn attr_name(&mut self) -> Result<String, Error> {
        let mut name = self.next().map(|t| t.to_string()).unwrap_or_default();
        while let (Some(TokenTree::Punct(p)), Some(TokenTree::Ident(_) | TokenTree::Literal(_))) = (self.peek(), self.peek2()) {
            if p.as_char() != '-' && p.as_char() != ':' {
                break;
            }
            name.push(p.as_char());
            self.next();
            name.push_str(&self.next().unwrap().to_string());
        }
        Ok(name)
    }

    /// An attribute or prop value: `"text"`, a literal, `{expression}` or a single identifier.
    /// Returns the static text when the value is known at compile time (elements only).
    fn value(&mut self, component: bool) -> Result<(Option<String>, TokenStream), Error> {
        let span = self.span();
        match self.next() {
            Some(TokenTree::Literal(lit)) if !component => match string_value(&lit).or_else(|| literal_text(&lit)) {
                Some(text) => Ok((Some(text), TokenStream::new())),
                None => err(span, "unsupported literal"),
            },
            Some(TokenTree::Literal(lit)) => Ok((None, TokenTree::Literal(lit).into())),
            Some(TokenTree::Group(g)) if g.delimiter() == Delimiter::Brace => {
                if g.stream().is_empty() {
                    return err(span, "empty braces: put a Rust expression inside");
                }
                Ok((None, parens(g.stream())))
            }
            Some(TokenTree::Ident(id)) => Ok((None, TokenTree::Ident(id).into())),
            _ => err(span, "a value is \"text\" or {expression}"),
        }
    }

    /// Tokens up to the body, the next top-level `{...}` group, and the group. A pattern's
    /// braces are its own, as in Rust: a `let` pattern's up to its `=` (`if let Shape::Circle { r }
    /// = shape`, each `let` of a chain), and, when `pattern` is set, a `for` pattern's up to `in`.
    fn until_brace(&mut self, what: &str, pattern: bool) -> Result<(TokenStream, Group), Error> {
        let start = self.span();
        let mut head: Vec<TokenTree> = Vec::new();
        // Where a pattern ends: `=` for a `let`, `in` for a `for`; `None` outside one.
        let mut ends_at: Option<&str> = pattern.then_some("in");
        while let Some(token) = self.next() {
            match (&token, ends_at) {
                (TokenTree::Group(g), None) if g.delimiter() == Delimiter::Brace => return Ok((stream(head), g.clone())),
                (TokenTree::Ident(id), None) if id.to_string() == "let" => ends_at = Some("="),
                (TokenTree::Ident(id), Some("in")) if id.to_string() == "in" => ends_at = None,
                // A lone `=`: not part of `==`, `=>`, `<=`, `!=` or a range's `..=`.
                (TokenTree::Punct(p), Some("=")) if p.as_char() == '=' => {
                    let joined_before =
                        matches!(head.last(), Some(TokenTree::Punct(prev)) if prev.spacing() == proc_macro::Spacing::Joint);
                    if !joined_before && p.spacing() == proc_macro::Spacing::Alone {
                        ends_at = None;
                    }
                }
                _ => {}
            }
            head.push(token);
        }
        err(start, format!("expected {{ ... }} after {what}"))
    }

    fn until_semicolon(&mut self) -> Result<TokenStream, Error> {
        let start = self.span();
        let mut tokens = Vec::new();
        while let Some(token) = self.next() {
            let end = matches!(&token, TokenTree::Punct(p) if p.as_char() == ';');
            tokens.push(token);
            if end {
                return Ok(stream(tokens));
            }
        }
        err(start, "a let in markup ends with ;")
    }

    fn block_for(&mut self) -> Result<Node, Error> {
        let keyword = self.next().unwrap();
        let span = keyword.span();
        let (head, body) = self.until_brace("for ... in ...", true)?;
        let mut tokens = stream([keyword]);
        tokens.extend(head);
        let mut changed = false;
        let body = self.branch(&body, &mut changed)?;
        if changed {
            if has_raw_delimiters(&body, self.raw_text.is_some()) {
                return err(span, ambiguous_raw_text("the loop body can change the parsing context of later iterations"));
            }
            self.unseen();
        }
        Ok(Node::Block { head: vec![tokens], bodies: vec![body], arms: false })
    }

    fn branch(&self, group: &Group, changed: &mut bool) -> Result<Vec<Node>, Error> {
        let mut cursor = self.inner(group);
        let nodes = cursor.nodes(None, false)?;
        *changed |= cursor.opaque != self.opaque;
        Ok(nodes)
    }

    fn block_if(&mut self) -> Result<Node, Error> {
        let mut heads = Vec::new();
        let mut bodies = Vec::new();
        let mut keyword = stream([self.next().unwrap()]);
        let mut changed = false;
        loop {
            let (cond, body) = self.until_brace("if", false)?;
            keyword.extend(cond);
            heads.push(keyword);
            bodies.push(self.branch(&body, &mut changed)?);
            if !is_ident(self.peek(), "else") {
                break;
            }
            keyword = stream([self.next().unwrap()]);
            if is_ident(self.peek(), "if") {
                keyword.extend([self.next().unwrap()]);
                continue;
            }
            let span = self.span();
            match self.next() {
                Some(TokenTree::Group(g)) if g.delimiter() == Delimiter::Brace => {
                    heads.push(keyword);
                    bodies.push(self.branch(&g, &mut changed)?);
                    break;
                }
                _ => return err(span, "expected { ... } or if after else"),
            }
        }
        if changed {
            self.unseen();
        }
        Ok(Node::Block { head: heads, bodies, arms: false })
    }

    fn block_match(&mut self) -> Result<Node, Error> {
        let keyword = self.next().unwrap();
        let (scrutinee, arms) = self.until_brace("match", false)?;
        let mut cursor = self.inner(&arms);
        let mut head = stream([keyword]);
        head.extend(scrutinee);
        let mut heads = vec![head];
        let mut bodies = Vec::new();
        let mut changed = false;
        while !cursor.at_end() {
            let start = cursor.span();
            let mut pattern = Vec::new();
            loop {
                match (cursor.peek(), cursor.peek2()) {
                    (Some(TokenTree::Punct(a)), Some(TokenTree::Punct(b))) if a.as_char() == '=' && b.as_char() == '>' => {
                        pattern.extend([cursor.next().unwrap(), cursor.next().unwrap()]);
                        break;
                    }
                    (Some(_), _) => pattern.push(cursor.next().unwrap()),
                    (None, _) => return err(start, "expected => in match arm"),
                }
            }
            heads.push(stream(pattern));
            let body = match cursor.peek() {
                Some(TokenTree::Group(g)) if g.delimiter() == Delimiter::Brace => {
                    let g = g.clone();
                    cursor.next();
                    self.branch(&g, &mut changed)?
                }
                _ => {
                    let node = cursor.node(false)?;
                    changed |= cursor.opaque != self.opaque;
                    cursor.opaque = self.opaque;
                    cursor.parsing = self.parsing;
                    cursor.text_only.clone_from(&self.text_only);
                    vec![node]
                }
            };
            bodies.push(body);
            if is_punct(cursor.peek(), ',') {
                cursor.next();
            }
        }
        if changed {
            self.unseen();
        }
        Ok(Node::Block { head: heads, bodies, arms: true })
    }
}

fn ambiguous_raw_text(reason: &str) -> String {
    format!(
        "<script> or <style> text containing '<' or '&' cannot be written here: {reason}; move it to markup with a known parsing context, use a #[component(js)] for behavior or a component's CSS file for styles. For a fixed HTML-only data slot, pass the complete static tag via trusted raw(...), without untrusted input"
    )
}

/// A loop is parsed once. Even a literal already escaped for its first iteration (and now
/// containing '&') cannot be reused if the next iteration may enter a different context.
fn has_raw_delimiters(nodes: &[Node], raw: bool) -> bool {
    nodes.iter().any(|node| match node {
        Node::Element { name, children, .. } => has_raw_delimiters(children, RAW_TEXT.contains(&name.as_str())),
        Node::Block { bodies, .. } => bodies.iter().any(|body| has_raw_delimiters(body, raw)),
        Node::Text(text) => raw && text.contains(['<', '&']),
        _ => false,
    })
}

/// Generated statements, with adjacent static markup merged into one `push_str`.
#[derive(Default)]
struct Gen {
    out: TokenStream,
    text: String,
    /// Type checks that print nothing, emitted before the writes so they do not split runs of
    /// static markup.
    checks: TokenStream,
    /// In a document, which parts what is written now belongs to.
    level: Level,
    /// Set while a patch's top-level element opens: the local its `id={..}` binds its shape to.
    id_shape: Option<TokenStream>,
    /// Inside an `<svg>` (and not in its `<foreignObject>`, `<desc>` or `<title>`), where elements
    /// are SVG's, as the key check counts them.
    svg: bool,
    /// Inside an `<svg>` (and not in its `<foreignObject>`), where the named link's `href` check
    /// does not look (`within_aria_svg`).
    aria_svg: bool,
    /// In a component's children, which the component may write anywhere (in an `<svg>`, its
    /// `<desc>`, a `<template>`), until a literal `<svg>` inside them: whether a browser makes an
    /// element there SVG's or HTML's is not known, so the key check takes no `<template>`'s or
    /// `<noscript>`'s content there for the page's.
    unknown_context: bool,
    /// The locals declared so far that hold a debug build's record while markup is written.
    debug_locals: usize,
}

/// The locals a view's shape is gathered in: one `Option` per body of a `for`, `if` or `match`
/// at its top level, declared before the markup, and a count for every local's name.
#[derive(Default)]
struct Slots {
    lets: TokenStream,
    count: usize,
}

impl Slots {
    fn name(&mut self) -> TokenStream {
        self.count += 1;
        TokenTree::Ident(Ident::new(&format!("__corten_shape_{}", self.count), Span::call_site())).into()
    }

    /// An `Option` a body of a block sets to its shape when it runs.
    fn slot(&mut self) -> TokenStream {
        let name = self.name();
        self.lets.extend(q(
            "#[allow(unused_mut, unused_assignments)] let mut __A0 = ::core::option::Option::None;",
            std::slice::from_ref(&name),
        ));
        name
    }
}

/// Whether a view's top level could be a patch: no text, no `<!DOCTYPE>` and no element without
/// `id={..}` at its top level or in the bodies of its blocks. Anything else is settled by types.
fn could_patch(nodes: &[Node]) -> bool {
    nodes.iter().all(|node| match node {
        Node::Text(text) => text.trim().is_empty(),
        Node::Markup(_) => false,
        Node::Element { attrs, .. } => attrs.iter().any(|a| matches!(a, Attr::Expr(name, _) if name == "id")),
        Node::Block { bodies, .. } => bodies.iter().all(|body| could_patch(body)),
        Node::Expr(_) | Node::Component { .. } | Node::Let(_) => true,
    })
}

/// Head tags a `<template>`'s content reads by the rules for a document's head (the HTML
/// standard's "in template" insertion mode), before the first element `check_patch_top` reads.
/// The shapes it refuses are lost after them however a browser reads them: as the standard
/// does (Firefox), or letting a leading `<title>`, `<base>`, `<basefont>`, `<bgsound>` or
/// `<noframes>` decide how the rest is read, as a page's body does (Chromium and WebKit). The
/// same list as `HEAD_TAGS` in `crates/corten/src/html.rs`, which a test there holds it to.
const TEMPLATE_HEAD: &[&str] =
    &["base", "basefont", "bgsound", "link", "meta", "noframes", "script", "style", "template", "title"];

/// The leading head tags that decide in Chromium and WebKit only (`DECIDING_HEAD` in the debug check).
const DECIDING_HEAD: &[&str] = &["base", "basefont", "bgsound", "noframes", "title"];

/// The start tags the "in template" insertion mode reads as a table's. The same list as
/// `TABLE_PARTS` in `crates/corten/src/html.rs`, which a test there holds it to.
const TABLE_PARTS: &[&str] = &["caption", "col", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr"];

/// How the first deciding element at a view's top level makes the elements after it read.
#[derive(Clone, Copy, Debug, PartialEq)]
enum TopRead<'a> {
    /// No element yet but head tags.
    Open,
    /// The first is a `<table>`: a table part after it is lost.
    Table,
    /// The first is a `<col>`: an element HTML's wherever it lands after it is lost.
    Col,
    /// The first is another table part (its index in `TABLE_PARTS`): a `<table>` after it, at
    /// the top level or in a later element, is lost, and so is a `<form>` there that holds an
    /// element, where an element HTML's wherever it lands is in or around it (`lost_after_part`).
    Part(usize),
    /// The whole patch begins with an element that selects body rules: later table parts are dropped.
    Body(&'a str),
    /// The first is unknown, or some markup since it may change how the rest is read.
    Unknown,
}

#[derive(Clone, Copy, PartialEq)]
enum TopPlace {
    Anywhere,
    Whole,
    WholeWithDecidingHead,
}

/// Where a refusal of `check_patch_top` sends the reader for why each shape is lost, and where.
const PARSE_REFUSALS: &str = "https://github.com/corten-run/corten/blob/main/docs/design.md#choice-html-parse-refusals";

/// A view that could be a patch (`could_patch`) whose top level is lost wherever it is written: a
/// first `<table>` with a table part after it; a first `<col>` with an element HTML's wherever it
/// lands (`breaks_out`) after it; and a first other table part with a `<table>` after it, at the
/// top level or in a later element, or a `<form>` there that holds an element with an element HTML's
/// wherever it lands in or around it (`lost_after_part`). The runtime parses a patch as a
/// `<template>`'s content, where the first element decides how the rest is read. After a
/// `<table>`, a table part is dropped; where the patch already began with a table part (one an
/// element or a component before this markup wrote), the `<table>` tag is dropped instead and its
/// parts are read as the patch's; on a page the table part is dropped, and in an `<svg>` the
/// `<table>` closes it. After a `<col>`, anything but a `<col>` or a `<template>` is dropped;
/// after another table part, the `<col>` is dropped or put in a `<colgroup>` the browser adds;
/// on a page the `<col>` is dropped, and in an `<svg>` the other element closes it. After another
/// table part, `lost_after_part` says what is lost where. So refusing them never stops markup a
/// browser keeps as written (docs/design.md#choice-html-parse-refusals), and
/// `a_shape_html_refuses_is_lost_after_each_table_part` in `crates/corten/src/html.rs` holds each
/// to the browsers' parses in `patch-parsing.json`. Every other shape the parse loses depends on
/// what the patch began with or where the view is written, which a component's markup does not show
/// (after a first `<tr>`, a `<p>` and a `<tr>` after it are both kept, and an `<svg>` keeps a
/// `<form>` of fields after a `<tr>`). `lost_if_whole` can decide more when this view starts the
/// patch; the debug check reads what is sent. Like every refusal of `html!`, each rests only
/// on the markup between the two elements: an expression, a component, or a `<script>` or
/// `<style>` whose text may change the parsing context (`writes_tags`) before the lost element's start tag (in the
/// first element, between the two, or in a later element that holds the lost one, before it) may
/// write unbalanced markup (`raw("<table>")` keeps a later row in its table), so after one nothing
/// is refused and the debug check is left to find it. What a lost top-level element holds does
/// not save it: the parse has lost it at its start tag.
fn check_patch_top(nodes: &[Node]) -> Result<(), Error> {
    match patch_top(nodes, TopRead::Open, TopPlace::Anywhere) {
        Ok(_) => Ok(()),
        Err((attrs, message)) => err(id_span(attrs), message),
    }
}

/// What a browser loses when this literal top level starts the patch. A view can still be drawn
/// after other markup, so only a send boundary consumes this verdict.
fn lost_if_whole(nodes: &[Node]) -> Option<String> {
    patch_top(nodes, TopRead::Open, TopPlace::Whole)
        .and_then(|_| patch_top(nodes, TopRead::Open, TopPlace::WholeWithDecidingHead))
        .err()
        .map(|(_, why)| why)
}

/// Reads `nodes` from `read`, returning what follows them reads as, or the attributes of the
/// top-level element whose markup is lost (for its `id`'s span) and why.
fn patch_top<'a>(nodes: &'a [Node], mut read: TopRead<'a>, place: TopPlace) -> Result<TopRead<'a>, (&'a [Attr], String)> {
    let whole = place != TopPlace::Anywhere;
    for node in nodes {
        match node {
            Node::Text(_) | Node::Markup(_) | Node::Let(_) => {}
            // What it writes may open or close any element, so nothing after it is known.
            Node::Expr(_) | Node::Component { .. } => read = TopRead::Unknown,
            // A body that runs reads from where the block is; one that may not leaves what
            // follows to an element the markup cannot name, and one with an expression or a
            // component in it to markup it does not show.
            Node::Block { bodies, .. } => {
                // Only unconditional top-level elements provide the whole-patch proof.
                if whole {
                    return Ok(TopRead::Unknown);
                }
                for body in bodies {
                    patch_top(body, read, place)?;
                }
                if read == TopRead::Open || bodies.iter().any(|body| nesting::holds_unseen(body)) {
                    read = TopRead::Unknown;
                }
            }
            Node::Element { name, attrs, children } => {
                let is = |list: &[&str]| list.iter().any(|t| name.eq_ignore_ascii_case(t));
                // A `<script>` or `<style>` whose text may write tags is as unseen as what it holds.
                let unseen = nesting::holds_unseen(std::slice::from_ref(node));
                match read {
                    TopRead::Open if place == TopPlace::WholeWithDecidingHead && is(DECIDING_HEAD) => {
                        read = TopRead::Body(name);
                    }
                    TopRead::Open if is(TEMPLATE_HEAD) => {}
                    TopRead::Open if is(&["table"]) => read = TopRead::Table,
                    TopRead::Open if is(&["col"]) => read = TopRead::Col,
                    TopRead::Open => match TABLE_PARTS.iter().position(|part| name.eq_ignore_ascii_case(part)) {
                        Some(part) => read = TopRead::Part(part),
                        None if whole => read = TopRead::Body(name),
                        None => return Ok(TopRead::Unknown),
                    },
                    TopRead::Unknown => return Ok(TopRead::Unknown),
                    TopRead::Table if is(TABLE_PARTS) => {
                        return Err((
                            attrs,
                            format!(
                                "send the <{name}> inside the <table>, or in a patch of its own: a patch that begins with a <table> loses a <{name}> after it wherever it is written ({PARSE_REFUSALS})"
                            ),
                        ));
                    }
                    TopRead::Body(first) if is(TABLE_PARTS) => {
                        let browsers = if DECIDING_HEAD.iter().any(|head| first.eq_ignore_ascii_case(head)) {
                            " in Chromium and WebKit"
                        } else {
                            ""
                        };
                        return Err((attrs, whole_loss(name, first, &format!("is dropped{browsers}"))));
                    }
                    TopRead::Col if !is(&["col", "template"]) && whole => {
                        return Err((attrs, whole_loss(name, "col", "is dropped")));
                    }
                    TopRead::Col if !is(&["col", "template"]) && breaks_out(name, attrs) => {
                        return Err((
                            attrs,
                            format!(
                                "send the <col>s in a <colgroup> with an id, or the <{name}> in a patch of its own: a patch that begins with a <col> loses a <{name}> after it wherever it is written, or after a leading <title>, <base>, <basefont>, <bgsound> or <noframes> Chromium and WebKit drop the <col> instead ({PARSE_REFUSALS})"
                            ),
                        ));
                    }
                    TopRead::Part(part) if is(&["table"]) => {
                        let first = TABLE_PARTS[part];
                        return Err((
                            attrs,
                            format!(
                                "send the <{name}> in a patch of its own: a patch that begins with a <{first}> loses a <table> after it wherever it is written ({PARSE_REFUSALS})"
                            ),
                        ));
                    }
                    TopRead::Part(part) if whole && is(TABLE_PARTS) => {
                        let first = TABLE_PARTS[part];
                        if let Some(change) = table_part_change(first, name) {
                            return Err((attrs, whole_loss(name, first, change)));
                        }
                    }
                    TopRead::Part(part) if !is(TABLE_PARTS) && !is(TEMPLATE_HEAD) => {
                        // The lost element is in this one, so what this one holds is between them.
                        if !unseen {
                            if let Some(why) = lost_after_part(name, attrs, children, false) {
                                let first = TABLE_PARTS[part];
                                return Err((attrs, why.message(name, first)));
                            }
                        }
                    }
                    TopRead::Table | TopRead::Col | TopRead::Part(_) | TopRead::Body(_) => {}
                }
                // What an expression or a component in it writes may leave an element open.
                if unseen {
                    read = TopRead::Unknown;
                }
            }
        }
    }
    Ok(read)
}

/// Changes to a later top-level table part in the table, table body or row insertion mode.
fn table_part_change(first: &str, next: &str) -> Option<&'static str> {
    let one_of = |names: &[&str]| names.iter().any(|name| next.eq_ignore_ascii_case(name));
    let cell = one_of(&["td", "th"]);
    match first {
        "td" | "th" => (!cell).then_some("is dropped"),
        "tr" if cell => Some("is put in a <tr> the browser adds"),
        "tr" => (!one_of(&["tr"])).then_some("is dropped"),
        _ if cell => Some("is put in a <tbody> and a <tr> the browser adds"),
        _ if one_of(&["tr"]) => Some("is put in a <tbody> the browser adds"),
        _ if one_of(&["col"]) => Some("is put in a <colgroup> the browser adds"),
        _ => None,
    }
}

fn whole_loss(name: &str, first: &str, change: &str) -> String {
    format!("the <{name}> {change} when this whole patch begins with <{first}>; send the <{name}> in a patch of its own ({PARSE_REFUSALS})")
}

/// What a later top-level element loses after a first table part (`lost_after_part`).
#[derive(Debug, PartialEq)]
enum PartLoss {
    /// A `<table>` in it.
    Table,
    /// A `<form>`, it or one in it, that holds an element.
    Form,
}

impl PartLoss {
    /// Why the top-level `<top>` is lost after a first `<first>`, for the error.
    fn message(&self, top: &str, first: &str) -> String {
        let what = match self {
            PartLoss::Table => "table",
            PartLoss::Form => "form",
        };
        let place = if top.eq_ignore_ascii_case(what) { String::new() } else { format!(" in <{top}>") };
        let loses = match self {
            PartLoss::Table => format!("loses a <table>{place} after it"),
            PartLoss::Form => format!("loses what a <form>{place} after it holds"),
        };
        format!("send the <{top}> in a patch of its own: a patch that begins with a <{first}> {loses} wherever it is written ({PARSE_REFUSALS})")
    }
}

/// After a first table part other than a `<col>` (`TopRead::Part`), what the element `name` loses
/// wherever the view is written: a later top-level element that is not a table part or a head's,
/// or one in it, with `around` telling whether an element HTML's wherever it lands (`breaks_out`) is
/// around it. A `<table>` there is lost: in a patch that began with a table part the `<table>` tag
/// is dropped and its parts moved out; where it began with another element, and on a page, the table
/// part is dropped; in a page's table the `<table>` closes it; and in an `<svg>` or a `<math>` the
/// `<table>` closes it. A `<form>` that holds an element is put in empty, what it holds moved out
/// of it, in a patch that began with a table part and in a page's table, while an `<svg>` keeps it
/// as written unless an element HTML's wherever it lands is in or around it, which closes the
/// drawing; so only that `<form>` is lost. Not read into a `<template>`, whose content is read on
/// its own, an `<svg>` or a `<math>`, whose content is foreign content's wherever it lands (a
/// `<form>` there is SVG's or MathML's and kept as written, even under a `<div>`, and an element
/// HTML's wherever it lands written straight in one is refused on its own), or an SVG or MathML
/// integration point, where in an `<svg>` a page's body reads the HTML and keeps both, so the other
/// cases are misses, never refusals. `scripts/smoke.mjs` holds each
/// to the browsers' parses through `a_shape_html_refuses_is_lost_after_each_table_part` in
/// `crates/corten/src/html.rs`.
fn lost_after_part(name: &str, attrs: &[Attr], children: &[Node], around: bool) -> Option<PartLoss> {
    if !read_after_part(name) {
        return None;
    }
    if name.eq_ignore_ascii_case("table") {
        return Some(PartLoss::Table);
    }
    let around = around || breaks_out(name, attrs);
    if name.eq_ignore_ascii_case("form") && !elements(children).is_empty() && (around || breaking_in(children)) {
        return Some(PartLoss::Form);
    }
    elements(children).into_iter().find_map(|(name, attrs, children)| lost_after_part(name, attrs, children, around))
}

/// Whether `lost_after_part` reads into the element `name`: not a `<template>`, a new foreign
/// content root (an `<svg>` or a `<math>`), an SVG or MathML integration point, or an element
/// whose content a browser parsing HTML may read as text (`may_read_as_text`: the check does not
/// know the namespace, and as HTML's what it holds is text, which is kept).
fn read_after_part(name: &str) -> bool {
    let is = |list: &[&str]| list.iter().any(|t| name.eq_ignore_ascii_case(t));
    !is(&["template", "svg", "math", "annotation-xml"])
        && !is(SVG_HTML_POINTS)
        && !is(MATH_HTML_POINTS)
        && !may_read_as_text(Parsing::Unknown, name)
}

/// Whether an element HTML's wherever it lands is among `nodes` or in them, read as
/// `lost_after_part` reads.
fn breaking_in(nodes: &[Node]) -> bool {
    elements(nodes)
        .into_iter()
        .any(|(name, attrs, children)| read_after_part(name) && (breaks_out(name, attrs) || breaking_in(children)))
}

/// The elements written in `nodes`, those in a block's bodies included: its name, attributes and
/// children.
fn elements(nodes: &[Node]) -> Vec<(&str, &[Attr], &[Node])> {
    let mut found = Vec::new();
    for node in nodes {
        match node {
            Node::Element { name, attrs, children } => found.push((name.as_str(), attrs.as_slice(), children.as_slice())),
            Node::Block { bodies, .. } => bodies.iter().for_each(|body| found.extend(elements(body))),
            _ => {}
        }
    }
    found
}

/// Where an element's `id={..}` is written, which a patch's top-level elements have.
fn id_span(attrs: &[Attr]) -> Span {
    attrs
        .iter()
        .find_map(|a| match a {
            Attr::Expr(name, value) if name == "id" => Some(first_span(value)),
            _ => None,
        })
        .unwrap_or_else(Span::call_site)
}
/// `(a, (b, (c, End)))`: a view's shape from its parts' shapes.
fn shape_of(shapes: Vec<TokenStream>) -> TokenStream {
    let mut shape = q("::corten::view::__private::End", &[]);
    for part in shapes.into_iter().rev() {
        let mut pair = part;
        pair.extend(q(",", &[]));
        pair.extend(shape);
        shape = stream([TokenTree::Group(Group::new(Delimiter::Parenthesis, pair))]);
    }
    shape
}

/// The parts of a document (`corten::view::Part`) a piece of its markup is written in.
#[derive(Clone, Copy, Default, PartialEq)]
enum Level {
    /// Every part: markup outside documents, the text of `<title>`, `let`.
    #[default]
    Always,
    /// The whole document and a navigation's swap: `<title>`, the page's head tags, `<main>`'s
    /// children.
    Page,
    /// The whole document only: the rest of the layout.
    Layout,
}

impl Gen {
    fn flush(&mut self) {
        if !self.text.is_empty() {
            let text = std::mem::take(&mut self.text);
            let write = q("__OUT.push_str(__A0);", &[literal(&text)]);
            self.emit(write);
        }
    }

    fn code(&mut self, tokens: TokenStream) {
        self.flush();
        self.emit(tokens);
    }

    fn emit(&mut self, tokens: TokenStream) {
        let block = stream([TokenTree::Group(Group::new(Delimiter::Brace, tokens.clone()))]);
        match self.level {
            Level::Always => self.out.extend(tokens),
            Level::Page => self.out.extend(q("if __PART != ::corten::view::Part::Title __A0", &[block])),
            Level::Layout => self.out.extend(q("if __PART == ::corten::view::Part::Full __A0", &[block])),
        }
    }

    /// Declares a local that holds the key check's record (`open`, an expression) while the
    /// markup after it is written, and is let go by a statement after that markup. It is declared
    /// outside the parts' `if`s, so it lives through them, and before the static markup not yet
    /// written, which has no refs. The record is Corten's to keep or not: a build of `corten-run`
    /// without debug assertions makes it an empty value and its calls empty, whatever the app's
    /// own setting, so the check is on or off for every crate's markup together.
    fn debug_local(&mut self, open: &str) -> TokenStream {
        self.debug_locals += 1;
        let name: TokenStream =
            TokenTree::Ident(Ident::new(&format!("__corten_debug_{}", self.debug_locals), Span::call_site())).into();
        self.out.extend(q(&format!("let __A0 = {open};"), std::slice::from_ref(&name)));
        name
    }

    /// Switches the parts what follows is written in.
    fn level(&mut self, level: Level) {
        if self.level != level {
            self.flush();
            self.level = level;
        }
    }

    /// A document's nodes (see `check_document`): the element path down to `<main>` is the
    /// layout's, except `<title>`, the expressions and components in `<head>` and the children
    /// of `<main>`, which are the page's. A `let` always runs.
    fn doc_nodes(&mut self, nodes: &[Node]) {
        for node in nodes {
            match node {
                Node::Let(tokens) => {
                    let level = self.level;
                    self.level(Level::Always);
                    self.code(tokens.clone());
                    self.level(level);
                }
                Node::Element { name, attrs, children } if name == "main" => {
                    self.level(Level::Layout);
                    self.open_tag(name, attrs, children);
                    self.level(Level::Page);
                    self.nodes(children, false);
                    self.level(Level::Layout);
                    self.text.push_str("</main>");
                }
                Node::Element { name, attrs, children } if name == "head" => {
                    self.level(Level::Layout);
                    self.open_tag(name, attrs, children);
                    for child in children {
                        match child {
                            Node::Element { name, attrs, children } if name == "title" => {
                                self.level(Level::Page);
                                self.open_tag(name, attrs, children);
                                self.level(Level::Always);
                                // Text to a browser, as in `node`.
                                let content = self.debug_local("::corten::script::__private::UnqueriedContent::open()");
                                self.nodes(children, false);
                                self.out.extend(q("__A0.end();", &[content]));
                                self.level(Level::Page);
                                self.text.push_str("</title>");
                            }
                            Node::Component { path, .. } if is_corten(path) => {
                                self.level(Level::Page);
                                self.node(child, false);
                            }
                            // The page's own tags: marked so a navigation replaces them.
                            Node::Expr(_) | Node::Component { .. } => {
                                self.level(Level::Page);
                                let body = self.body(std::slice::from_ref(child), false);
                                self.code(q(
                                    "::corten::view::__private::head_slot(|__OUT: &mut ::std::string::String| __A0, __OUT);",
                                    &[body.into()],
                                ));
                            }
                            Node::Let(_) => self.doc_nodes(std::slice::from_ref(child)),
                            _ => {
                                self.level(Level::Layout);
                                self.node(child, false);
                            }
                        }
                    }
                    self.level(Level::Layout);
                    self.text.push_str("</head>");
                }
                Node::Element { name, attrs, children } if holds_main(children) => {
                    self.level(Level::Layout);
                    self.open_tag(name, attrs, children);
                    self.doc_nodes(children);
                    self.level(Level::Layout);
                    self.text.push_str(&format!("</{name}>"));
                }
                _ => {
                    self.level(Level::Layout);
                    self.node(node, false);
                }
            }
        }
        self.level(Level::Layout);
    }

    /// `Path { prop: value, .., children }`: a component built from its tag.
    fn component(
        &self,
        path: &TokenStream,
        props: &[(TokenStream, TokenStream)],
        children: &Option<Vec<Node>>,
        moving: bool,
    ) -> TokenStream {
        let mut fields = TokenStream::new();
        for (field, value) in props {
            // Only a view's own closure has something to borrow from: the props of the one
            // component a view is (`moving`) are evaluated where the view is written.
            let value = if moving { value.clone() } else { borrowing(value) };
            fields.extend(q("__A0: __A1,", &[field.clone(), value]));
        }
        if let Some(children) = children {
            let body = stream([self.body_in(children, false, true)]);
            let capture = if moving { "move " } else { "" };
            fields.extend(q(
                &format!("children: ::corten::view::Html::child({capture}|__OUT: &mut ::std::string::String| __A0),"),
                &[body],
            ));
        }
        let literal = stream([TokenTree::Group(Group::new(Delimiter::Brace, fields))]);
        let mut out = path.clone();
        out.extend(literal);
        out
    }

    fn finish(mut self) -> TokenStream {
        self.flush();
        let mut out = self.checks;
        out.extend(self.out);
        out
    }

    /// The top level of a view that could be a patch (see `could_patch`), written as `nodes`
    /// writes it, with each part's shape bound to a local: an element's from its `id={..}`
    /// (`Yes` for an `Id`), an expression's or component's from its type (`Yes` for a `Patch`),
    /// a block's from the `Option` each of its bodies sets. Returns the view's shape.
    fn top_nodes(&mut self, nodes: &[Node], slots: &mut Slots) -> TokenStream {
        let mut shapes = Vec::new();
        for node in nodes {
            match node {
                Node::Text(_) | Node::Markup(_) | Node::Let(_) => self.node(node, false),
                Node::Expr(expr) => {
                    let name = slots.name();
                    self.code(q(
                        "let __A1 = {
                            let __corten_part = &(__A0);
                            (&::corten::view::__private::Wrap(__corten_part)).__render(__OUT);
                            (&::corten::view::__private::Proof(__corten_part)).__shape()
                        };",
                        &[expr.clone(), name.clone()],
                    ));
                    shapes.push(name);
                }
                Node::Component { path, props, children } => {
                    let built = self.component(path, props, children, false);
                    let name = slots.name();
                    self.code(q(
                        "let __A1 = {
                            let __corten_part = __A0;
                            ::corten::view::Render::render(&__corten_part, __OUT);
                            (&::corten::view::__private::Proof(&__corten_part)).__shape()
                        };",
                        &[built, name.clone()],
                    ));
                    shapes.push(name);
                }
                Node::Element { .. } => {
                    let name = slots.name();
                    self.id_shape = Some(name.clone());
                    self.node(node, false);
                    // `could_patch` saw an `id={..}`, so `open_tag` bound it.
                    self.id_shape = None;
                    shapes.push(name);
                }
                Node::Block { head, bodies, arms } => {
                    let mut tokens = if *arms { TokenStream::new() } else { head[0].clone() };
                    let mut inner = TokenStream::new();
                    for (i, body) in bodies.iter().enumerate() {
                        let slot = slots.slot();
                        let mut gen = Gen::default();
                        let shape = gen.top_nodes(body, slots);
                        let mut code = gen.finish();
                        code.extend(q("__A0 = ::core::option::Option::Some(__A1);", &[slot.clone(), shape]));
                        let group = TokenTree::Group(Group::new(Delimiter::Brace, code));
                        if *arms {
                            inner.extend(head[i + 1].clone());
                            inner.extend([group, TokenTree::Punct(proc_macro::Punct::new(',', proc_macro::Spacing::Alone))]);
                        } else {
                            if i > 0 {
                                tokens.extend(head[i].clone());
                            }
                            tokens.extend([group]);
                        }
                        shapes.push(slot);
                    }
                    if *arms {
                        tokens = head[0].clone();
                        tokens.extend([TokenTree::Group(Group::new(Delimiter::Brace, inner))]);
                    }
                    self.code(tokens);
                }
            }
        }
        shape_of(shapes)
    }

    fn body(&self, nodes: &[Node], raw: bool) -> TokenTree {
        self.body_in(nodes, raw, self.unknown_context)
    }

    /// `nodes` written in a block of their own, in a context not known when `unknown_context`.
    fn body_in(&self, nodes: &[Node], raw: bool, unknown_context: bool) -> TokenTree {
        let mut gen = Gen { svg: self.svg, aria_svg: self.aria_svg, unknown_context, ..Gen::default() };
        gen.nodes(nodes, raw);
        TokenTree::Group(Group::new(Delimiter::Brace, gen.finish()))
    }

    fn nodes(&mut self, nodes: &[Node], raw: bool) {
        for node in nodes {
            self.node(node, raw);
        }
    }

    /// `<name attrs>`: the start tag of an element, whose children only matter for a ref's rows.
    fn open_tag(&mut self, name: &str, attrs: &[Attr], children: &[Node]) {
        self.text.push('<');
        self.text.push_str(name);
        let mut actions_printed = false;
        // Whether the element has a key (`key={..}`, written `data-key`), for a handler's
        // Map<string, El>: every element of a ref has one, or none does.
        let is_key = |attr: &str| attr.eq_ignore_ascii_case("data-key");
        let keyed = attrs.iter().any(|a| matches!(a, Attr::Expr(attr, _) | Attr::Static(attr, _) if is_key(attr)));
        let has_ref = attrs.iter().any(|a| matches!(a, Attr::Ref(..)));
        // A keyed ref's element: debug builds note its ref and key on it, and the string it is written
        // into, until its tag is written, whatever an attribute's expression renders meanwhile.
        let tag = (has_ref && keyed).then(|| self.debug_local("::corten::script::__private::KeyTag::open(__OUT)"));
        for attr in attrs {
            match attr {
                Attr::Bare(attr) => {
                    self.text.push(' ');
                    self.text.push_str(attr);
                }
                Attr::Page(_) => self.text.push_str(" data-corten-page"),
                // A keyed ref's key, which debug builds check against its other elements'. The
                // call is given the key as written, not the output, so it goes beside the markup
                // not yet written instead of ending it: the tag is still written in one piece.
                Attr::Static(attr, value) if has_ref && is_key(attr) => {
                    let written = format!(" {attr}=\"{}\"", escape(value));
                    self.text.push_str(&written);
                    self.out.extend(q("::corten::script::__private::key_written(__A0);", &[literal(&written)]));
                }
                Attr::Static(attr, value) => {
                    self.text.push_str(&format!(" {attr}=\"{}\"", escape(value)));
                }
                Attr::Ref(expr, wide) => {
                    let el: TokenStream =
                        format!("::corten::script::el::{}", crate::dom::element(name)).parse().expect("a path parses");
                    // What the element holds: one view's rows, for a handler's Holds<Row, ..>.
                    let holds: TokenStream = match rows_of(children) {
                        Some(view) => format!("::corten::script::RowsOf<{}u64>", crate::script::view_id(&view)),
                        None => "::corten::script::NoRows".to_string(),
                    }
                    .parse()
                    .expect("a path parses");
                    let keys: TokenStream =
                        if keyed { q("::corten::script::Keyed", &[]) } else { q("::corten::script::NoKey", &[]) };
                    match wide {
                        // `ref={trigger as HTMLElement}`: a ref on several kinds of element, typed as one they all are.
                        Some(wide) => {
                            let ty: TokenStream = format!("::corten::script::el::{wide}").parse().expect("a path parses");
                            let ty: TokenStream = ty
                                .into_iter()
                                .map(|mut t| {
                                    t.set_span(wide.span());
                                    t
                                })
                                .collect();
                            self.code(q(
                                "::corten::script::__private::ref_attr_as::<__A1, __A2, __A3, __A4>(&(__A0), __OUT);",
                                &[expr.clone(), el, ty, holds, keys],
                            ))
                        }
                        None => self.code(q(
                            "::corten::script::__private::ref_attr::<__A1, __A2, __A3>(&(__A0), __OUT);",
                            &[expr.clone(), el, holds, keys],
                        )),
                    }
                }
                Attr::On(..) if actions_printed => {}
                Attr::On(..) => {
                    actions_printed = true;
                    let target: TokenStream =
                        format!("::corten::script::el::{}", crate::dom::element(name)).parse().expect("a path parses");
                    let mut binds = TokenStream::new();
                    let mut binds_before = TokenStream::new();
                    for attr in attrs {
                        let Attr::On(event, span, expr) = attr else { continue };
                        // A form that hears its upload's progress sends it by the upload module.
                        if event == "corten:progress" {
                            binds_before.extend(q("::corten::script::__private::uses_upload();", &[]));
                        }
                        // A typed event's name is the one its `#[event]` gave it (a library's carries its
                        // prefix: `ui-copied`), so it is read from the type rather than derived here.
                        let (printed, ty) = if event.starts_with(|c: char| c.is_ascii_uppercase()) {
                            let ty: TokenStream = TokenTree::Ident(Ident::new(event, *span)).into();
                            self.checks.extend(q("::corten::script::__private::is_event::<__A0>();", std::slice::from_ref(&ty)));
                            (q("<__A0 as ::corten::script::DomEvent>::NAME", std::slice::from_ref(&ty)), ty)
                        } else {
                            let dom_event = event.strip_prefix("document.").unwrap_or(event);
                            let ty: TokenStream =
                                format!("::corten::script::ev::{}", crate::dom::event(dom_event)).parse().expect("a path parses");
                            (literal(event), ty)
                        };
                        let expr = keywords(expr.clone(), &ty, &target);
                        binds.extend(q("(__A0, &(__A1) as &dyn ::corten::script::Bind),", &[printed, expr]));
                    }
                    if !binds_before.is_empty() {
                        self.code(binds_before);
                    }
                    self.code(q("::corten::script::__private::data_on(__OUT, &[__A0]);", &[binds]));
                }
                // Classes are a list (see `corten::style::ClassList`): `class={(Row, hot.then_some(Hot))}`.
                Attr::Expr(attr, expr) if attr == "class" => {
                    self.code(q("::corten::style::__private::class_attr(&(__A0), __OUT);", std::slice::from_ref(expr)))
                }
                // Custom properties of the component's stylesheet: `style={(FILL.pct(42.0), GAP.px(4.0))}`.
                Attr::Expr(attr, expr) if attr == "style" => {
                    self.code(q("::corten::style::__private::vars_attr(&(__A0), __OUT);", std::slice::from_ref(expr)))
                }
                // A patch's top-level element: the id also says whether it is a `#[derive(Id)]`.
                Attr::Expr(attr, expr) if attr == "id" && self.id_shape.is_some() => {
                    let name = self.id_shape.take().expect("checked");
                    self.code(q(
                        "let __A2 = {
                            let __corten_id = &(__A0);
                            (&::corten::view::__private::Attr(__corten_id)).__attr(__A1, __OUT);
                            (&::corten::view::__private::IdProof(__corten_id)).__id_shape()
                        };",
                        &[expr.clone(), literal(" id"), name],
                    ))
                }
                // A link named by aria-label: its href's type must always write one.
                Attr::Expr(attr, expr) if !self.aria_svg && attr.eq_ignore_ascii_case("href") && checks_href(name, attrs) => {
                    // The error points at the href's expression, not the whole `html!`.
                    let at = expr.clone().into_iter().next().map_or_else(Span::call_site, |t| t.span());
                    let check = respan(
                        q(
                            "(&::corten::view::__private::NamedHref(__corten_href)).__named_href();
                            (&::corten::view::__private::NotPost(__corten_href)).__not_post();",
                            &[],
                        ),
                        at,
                    );
                    // A `match`, not a `let`: temporaries in the expression live through the write.
                    self.code(q(
                        "match &(__A0) {
                            __corten_href => {
                                use ::corten::view::__private::{NamedHrefAlways as _, NamedHrefMaybe as _, NotPostAny as _, NotPostOwn as _};
                                __A2
                                (&::corten::view::__private::Attr(__corten_href)).__attr(__A1, __OUT);
                            }
                        }",
                        &[expr.clone(), literal(&format!(" {attr}")), check],
                    ))
                }
                // A link, a source or a ping is no page's post: one in it does not compile.
                Attr::Expr(attr, expr) if link_attr(attr) => {
                    let at = expr.clone().into_iter().next().map_or_else(Span::call_site, |t| t.span());
                    let check = respan(q("(&::corten::view::__private::NotPost(__corten_url)).__not_post();", &[]), at);
                    self.code(q(
                        "match &(__A0) {
                            __corten_url => {
                                use ::corten::view::__private::{NotPostAny as _, NotPostOwn as _};
                                __A2
                                (&::corten::view::__private::Attr(__corten_url)).__attr(__A1, __OUT);
                            }
                        }",
                        &[expr.clone(), literal(&format!(" {attr}")), check],
                    ))
                }
                // A page part is found on screen by its id, so it is a typed one.
                Attr::Expr(attr, expr) if attr == "id" && attrs.iter().any(|a| matches!(a, Attr::Page(_))) => {
                    self.code(q("::corten::view::__private::page_id(&(__A0), __OUT);", std::slice::from_ref(expr)))
                }
                // A keyed ref's key, which debug builds check against its other elements' as written.
                Attr::Expr(attr, expr) if has_ref && is_key(attr) => self.code(q(
                    "{
                        let __corten_key = __OUT.len();
                        (&::corten::view::__private::Attr(&(__A0))).__attr(__A1, __OUT);
                        ::corten::script::__private::key_written_from(__OUT, __corten_key);
                    }",
                    &[expr.clone(), literal(&format!(" {attr}"))],
                )),
                Attr::Expr(attr, expr) => self.code(q(
                    "(&::corten::view::__private::Attr(&(__A0))).__attr(__A1, __OUT);",
                    &[expr.clone(), literal(&format!(" {attr}"))],
                )),
                Attr::Spread(expr) => {
                    // What else the tag writes, which the spread must not write again.
                    let written: Vec<String> = attrs
                        .iter()
                        .filter_map(|other| match other {
                            Attr::Expr(name, _) if name == "style" => Some("\"data-vars\"".into()),
                            Attr::Bare(name) | Attr::Static(name, _) | Attr::Expr(name, _) => {
                                Some(format!("{:?}", name.to_ascii_lowercase()))
                            }
                            Attr::Ref(..) => Some("\"data-ref\"".into()),
                            Attr::On(..) => Some("\"data-on\"".into()),
                            Attr::Page(_) => Some("\"data-corten-page\"".into()),
                            Attr::Spread(_) => None,
                        })
                        .collect();
                    // Which spread of the tag this is, and how many it has: each spread after the
                    // first is checked against those before it, by type (`Writes::Static`, which
                    // holds none of their borrows), so no expression is evaluated twice.
                    let spreads = attrs.iter().filter(|a| matches!(a, Attr::Spread(_))).count();
                    let index = attrs
                        .iter()
                        .filter(|a| matches!(a, Attr::Spread(_)))
                        .position(|a| std::ptr::eq(a, attr))
                        .expect("in the list");
                    if written.is_empty() && spreads < 2 {
                        self.code(q("::corten::view::Attrs::render_attrs(&(__A0), __OUT);", std::slice::from_ref(expr)))
                    } else {
                        // The checks are calls that do nothing, or do not compile when the
                        // spread's type declares (`Writes`) one of the names; one evaluation of
                        // the expression serves the checks and the render.
                        let mut checks = String::from(
                            "#[allow(unused_imports)] use ::corten::view::__private::{Declared as _, Undeclared as _};",
                        );
                        if !written.is_empty() {
                            checks.push_str(&format!(
                                "struct __CortenWritten; impl ::corten::view::__private::Written for __CortenWritten {{ const NAMES: &'static [&'static str] = &[{}]; }}",
                                written.join(", ")
                            ));
                        }
                        let mut calls = String::new();
                        if !written.is_empty() {
                            calls.push_str("(&::corten::view::__private::Spread(__spread)).check::<__CortenWritten>();");
                        }
                        for earlier in 0..index {
                            calls.push_str(&format!(
                                "(&::corten::view::__private::Spread(__spread)).after(&__corten_spread_{earlier});"
                            ));
                        }
                        let checks: TokenStream = checks.parse().expect("the names parse");
                        let calls: TokenStream = calls.parse().expect("the checks parse");
                        if spreads < 2 {
                            self.code(q(
                                "{ __A1 match &(__A0) { __spread => { __A2 ::corten::view::Attrs::render_attrs(__spread, __OUT); } } }",
                                &[expr.clone(), checks, calls],
                            ))
                        } else {
                            let bind: TokenStream = format!("__corten_spread_{index}").parse().expect("a name parses");
                            self.code(q(
                                "let __A3 = { __A1 match &(__A0) { __spread => { __A2 ::corten::view::Attrs::render_attrs(__spread, __OUT); (&::corten::view::__private::Spread(__spread)).marker() } } };",
                                &[expr.clone(), checks, calls, bind],
                            ))
                        }
                    }
                }
            }
        }
        if let Some(tag) = tag {
            self.out.extend(q("__A0.close();", &[tag]));
        }
        self.text.push('>');
    }

    fn node(&mut self, node: &Node, raw: bool) {
        match node {
            Node::Text(text) if raw => self.text.push_str(text),
            Node::Text(text) => self.text.push_str(&escape(text)),
            Node::Markup(markup) => self.text.push_str(markup),
            Node::Expr(expr) => {
                self.code(q("(&::corten::view::__private::Wrap(&(__A0))).__render(__OUT);", std::slice::from_ref(expr)))
            }
            Node::Let(tokens) => self.code(tokens.clone()),
            Node::Element { name, attrs, children } => {
                // An element of the layout that is the page's (`page`): written for a navigation too.
                let part = self.level == Level::Layout && attrs.iter().any(|a| matches!(a, Attr::Page(_)));
                if part {
                    self.level(Level::Page);
                }
                self.open_tag(name, attrs, children);
                if !VOID.contains(&name.as_str()) {
                    // A `<template>`'s content and a `<noscript>`'s, which the runtime's query for a
                    // ref's elements does not reach (with scripts on, a `<noscript>` holds text),
                    // and the content of an element a browser reads as text (`TEXT_ONLY`: a
                    // `<textarea>` holding a component or an expression that writes markup, or an
                    // element where the markup does not show it is HTML's, `Parsing::Unknown`):
                    // debug builds record none of their keys. In an `<svg>` they are elements like
                    // any other, whose children the query finds, except in what an element whose
                    // children are HTML's holds (`SVG_HTML_POINTS`). A component's markup does
                    // not see an `<svg>` its parent writes it into, so it takes its `<template>`
                    // for HTML's, and a component's children do not see where it writes them
                    // (`unknown_context`), so theirs are taken for HTML's too: the check misses
                    // those keys rather than stop a render it cannot be sure of.
                    let svg_element = self.svg && !self.unknown_context;
                    let unqueried = !svg_element
                        && (name.eq_ignore_ascii_case("template")
                            || name.eq_ignore_ascii_case("noscript")
                            || TEXT_ONLY.iter().any(|t| name.eq_ignore_ascii_case(t)));
                    let content = unqueried.then(|| self.debug_local("::corten::script::__private::UnqueriedContent::open()"));
                    let (outer, outer_context, outer_aria) = (self.svg, self.unknown_context, self.aria_svg);
                    self.svg = within_svg(outer, name);
                    self.aria_svg = within_aria_svg(outer_aria, name);
                    // A literal `<svg>`'s content is foreign wherever its markup lands: SVG's, or,
                    // straight in a `<math>` (which is not valid there), MathML's, whose
                    // `<template>` the query finds too; and what its `<foreignObject>`, `<desc>` or
                    // `<title>` holds is taken for HTML's, which at worst misses a key.
                    self.unknown_context = outer_context && !name.eq_ignore_ascii_case("svg");
                    self.nodes(children, RAW_TEXT.contains(&name.as_str()));
                    self.svg = outer;
                    self.aria_svg = outer_aria;
                    self.unknown_context = outer_context;
                    if let Some(content) = content {
                        self.out.extend(q("__A0.end();", &[content]));
                    }
                    self.text.push_str(&format!("</{name}>"));
                }
                if part {
                    self.level(Level::Layout);
                }
            }
            Node::Component { path, props, children } => {
                let built = self.component(path, props, children, false);
                self.code(q("::corten::view::Render::render(&__A0, __OUT);", &[built]));
            }
            Node::Block { head, bodies, arms } => {
                if *arms {
                    let mut inner = TokenStream::new();
                    for (pattern, body) in head[1..].iter().zip(bodies) {
                        inner.extend(pattern.clone());
                        inner.extend([
                            self.body(body, raw),
                            TokenTree::Punct(proc_macro::Punct::new(',', proc_macro::Spacing::Alone)),
                        ]);
                    }
                    let mut tokens = head[0].clone();
                    tokens.extend([TokenTree::Group(Group::new(Delimiter::Brace, inner))]);
                    self.code(tokens);
                } else {
                    let mut tokens = TokenStream::new();
                    for (h, body) in head.iter().zip(bodies) {
                        tokens.extend(h.clone());
                        tokens.extend([self.body(body, raw)]);
                    }
                    self.code(tokens);
                }
            }
        }
    }
}

/// Inside `<script>` and `<style>` only literal text: in HTML an escaped expression would not
/// read back as what it was (JSON with `&quot;` is not JSON), and unescaped it could end the element.
fn check_raw_text(nodes: &[Node], inside: Option<&str>) -> Result<(), Error> {
    for node in nodes {
        let span = match node {
            Node::Element { name, children, .. } => {
                let inside = if RAW_TEXT.contains(&name.as_str()) { Some(name.as_str()) } else { inside };
                check_raw_text(children, inside)?;
                continue;
            }
            Node::Text(_) | Node::Markup(_) | Node::Let(_) => continue,
            Node::Expr(tokens) | Node::Component { path: tokens, .. } => first_span(tokens),
            Node::Block { head, bodies, .. } => {
                if inside.is_none() {
                    for body in bodies {
                        check_raw_text(body, None)?;
                    }
                    continue;
                }
                head.first().map_or(Span::call_site(), first_span)
            }
        };
        if let Some(name) = inside {
            return err(
                span,
                format!(
                    "<{name}> holds only literal text: an expression in it is escaped as HTML, which a {name} does not read back. Structured data is <JsonLd value={{..}} /> (corten::JsonLd), behavior a #[component(js)], styles a component's CSS file"
                ),
            );
        }
        if let Node::Component { children: Some(children), .. } = node {
            check_raw_text(children, None)?;
        }
    }
    Ok(())
}

fn first_span(tokens: &TokenStream) -> Span {
    tokens.clone().into_iter().next().map_or(Span::call_site(), |t| t.span())
}
/// True when `<main>` is among `nodes` or inside one of their elements.
fn holds_main(nodes: &[Node]) -> bool {
    nodes.iter().any(|node| match node {
        Node::Element { name, children, .. } => name == "main" || holds_main(children),
        _ => false,
    })
}

/// True for `<Corten />`, where Corten writes its tags in a document's `<head>`.
fn is_corten(path: &TokenStream) -> bool {
    let path = path.to_string();
    path == "Corten" || path.ends_with(":: Corten")
}

/// True when the markup is a document: `<!DOCTYPE html>` (optional) and `<html>`.
fn is_document(nodes: &[Node]) -> bool {
    let mut roots = nodes.iter().filter(|n| !matches!(n, Node::Let(_)));
    let first = roots.next();
    let root = match first {
        Some(Node::Markup(_)) => roots.next(),
        other => other,
    };
    matches!(root, Some(Node::Element { name, .. }) if name == "html")
}

/// What `corten::view::Document` needs, checked here so a mistake does not compile: the doctype
/// at most, then `<html>` holding one `<head>` (with one `<title>` and `<Corten />`) and one
/// `<main>`, reached through elements alone so every part knows where it is.
fn check_document(nodes: &[Node]) -> Result<(), Error> {
    let fail = |message: &str| err(Span::call_site(), message);
    let roots: Vec<&Node> = nodes.iter().filter(|n| !matches!(n, Node::Let(_) | Node::Markup(_))).collect();
    let [Node::Element { children, .. }] = roots.as_slice() else {
        return fail("a document is <!DOCTYPE html> and one <html> element, with nothing after it");
    };
    let heads: Vec<&Vec<Node>> = children
        .iter()
        .filter_map(|n| match n {
            Node::Element { name, children, .. } if name == "head" => Some(children),
            _ => None,
        })
        .collect();
    let [head] = heads.as_slice() else {
        return fail("a document's <html> holds one <head>, with its <title> and <Corten />");
    };
    let titles = head.iter().filter(|n| matches!(n, Node::Element { name, .. } if name == "title")).count();
    if titles != 1 {
        return fail("a document's <head> holds one <title>: <title>{title}</title>");
    }
    let cortens = head.iter().filter(|n| matches!(n, Node::Component { path, .. } if is_corten(path))).count();
    if cortens != 1 {
        return fail("a document's <head> holds <Corten /> once, where Corten writes the runtime and the page's scripts");
    }
    fn mains(nodes: &[Node], in_block: bool, found: &mut usize) -> Result<(), &'static str> {
        for node in nodes {
            match node {
                Node::Element { name, children, .. } => {
                    if name == "main" {
                        if in_block {
                            return Err("a document's <main> is not inside for, if or match: a navigation swaps it");
                        }
                        *found += 1;
                    }
                    mains(children, in_block, found)?;
                }
                Node::Block { bodies, .. } => {
                    for body in bodies {
                        mains(body, true, found)?;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
    let mut found = 0;
    mains(children, false, &mut found).or_else(fail)?;
    if found != 1 {
        return fail("a document holds one <main>, which a client navigation swaps: <main>{children}</main>");
    }
    Ok(())
}

/// Where `page` goes: on an element of a document's layout around `<main>`, outside `<head>`, not
/// inside `for`, `if` or `match` (so every page of the layout has it, and a navigation's answer
/// always holds one for the runtime to put in place), nor inside another such element. It has a
/// typed `id={..}`, by which the runtime finds the one on screen.
fn check_pages(nodes: &[Node]) -> Result<(), Error> {
    fn walk(nodes: &[Node], document: bool, inside: Option<&'static str>) -> Result<(), Error> {
        for node in nodes {
            match node {
                Node::Element { name, attrs, children } => {
                    let page = attrs.iter().find_map(|a| match a {
                        Attr::Page(span) => Some(*span),
                        _ => None,
                    });
                    let within = match page {
                        Some(span) => {
                            if !document {
                                return err(span, "page marks an element of a document's layout (the html! that starts with <html>) as the page's: write it there, around this markup (<nav page id={SectionNavId}><SectionLinks req={req} /></nav>); an attribute named page is written page=\"\"");
                            }
                            if matches!(name.as_str(), "main" | "head" | "title") {
                                return err(span, format!("page marks an element of the layout beside <main> as the page's, and <{name}> is the page's already: a navigation sends it"));
                            }
                            if let Some(place) = inside {
                                return err(span, format!("page marks an element of the layout around <main> as the page's, and this one is {place}"));
                            }
                            if holds_main(children) {
                                return err(span, "an element marked page is beside <main>, not around it: a navigation sends <main>'s children already");
                            }
                            if !attrs.iter().any(|a| matches!(a, Attr::Expr(n, _) if n == "id")) {
                                return err(span, "an element marked page has an id of a #[derive(Id)] type, by which the runtime finds the one on screen: <nav page id={SectionNavId}>");
                            }
                            Some("inside another element marked page")
                        }
                        None if name == "main" => inside.or(Some("inside <main>, which is the page's already")),
                        None if name == "head" => {
                            inside.or(Some("in <head>, where the page's tags are an expression or component ({head})"))
                        }
                        None => inside,
                    };
                    walk(children, document, within)?;
                }
                Node::Block { bodies, .. } => {
                    for body in bodies {
                        walk(body, document, inside.or(Some("inside for, if or match: draw it on every page, with what is in it chosen by the page (it may be empty)")))?;
                    }
                }
                Node::Component { children: Some(children), .. } => {
                    walk(
                        children,
                        document,
                        inside.or(Some(
                            "in a component's children, which the component places: mark an element of the layout's own markup",
                        )),
                    )?;
                }
                _ => {}
            }
        }
        Ok(())
    }
    walk(nodes, is_document(nodes), None)
}

/// The view every child of an element is, when the markup puts only components of one name in it
/// (`<Row .. />`, directly or as the whole body of a `for`, `if` or `match`): its name, the last
/// segment of its path, which is also its class in `corten/views`.
fn rows_of(children: &[Node]) -> Option<String> {
    fn walk(nodes: &[Node], found: &mut Option<String>) -> bool {
        nodes.iter().all(|node| match node {
            Node::Let(_) => true,
            Node::Text(text) => text.trim().is_empty(),
            Node::Component { path, .. } => {
                let Some(TokenTree::Ident(last)) = path.clone().into_iter().last() else { return false };
                let name = last.to_string();
                found.get_or_insert_with(|| name.clone()) == &name
            }
            Node::Block { bodies, .. } => bodies.iter().all(|body| walk(body, found)),
            Node::Element { .. } | Node::Markup(_) | Node::Expr(_) => false,
        })
    }
    let mut found = None;
    if walk(children, &mut found) {
        found
    } else {
        None
    }
}

/// Whether the identifier at `tokens[i]` is a handler keyword there: not a field (`x.scope`), a
/// path segment, a struct field name (`scope: ..`), a call (`scope()`) or a macro.
fn is_keyword_at(tokens: &[TokenTree], i: usize) -> bool {
    let after_dot = i > 0 && (is_punct(tokens.get(i - 1), '.') || is_punct(tokens.get(i - 1), ':'));
    let next = tokens.get(i + 1);
    let used_otherwise = is_punct(next, ':')
        || is_punct(next, '!')
        || matches!(next, Some(TokenTree::Group(g)) if g.delimiter() == Delimiter::Parenthesis);
    !(after_dot || used_otherwise)
}

/// True when a handler value (the `{..}` of an `on:`) passes the keyword `kw`, as `keywords`
/// would replace it.
pub(crate) fn passes_keyword(tokens: TokenStream, kw: &str) -> bool {
    let tokens: Vec<TokenTree> = tokens.into_iter().collect();
    tokens.iter().enumerate().any(|(i, token)| match token {
        TokenTree::Ident(id) => id.to_string() == kw && is_keyword_at(&tokens, i),
        TokenTree::Group(g) => passes_keyword(g.stream(), kw),
        _ => false,
    })
}

/// `event`, `target`, `signal` and `scope` in a handler call are the browser's: typed as the
/// event `event_ty` and the element `target_ty`. A field (`x.event`), a path segment, a struct
/// field name (`event: ..`), a call (`event()`) or a macro keeps its own meaning.
fn keywords(tokens: TokenStream, event_ty: &TokenStream, target_ty: &TokenStream) -> TokenStream {
    let tokens: Vec<TokenTree> = tokens.into_iter().collect();
    let mut out = TokenStream::new();
    for (i, token) in tokens.iter().enumerate() {
        match token {
            TokenTree::Ident(id) if matches!(id.to_string().as_str(), "event" | "target" | "signal" | "scope") => {
                if !is_keyword_at(&tokens, i) {
                    out.extend([token.clone()]);
                    continue;
                }
                let replaced = match id.to_string().as_str() {
                    "event" => q("::corten::script::__private::EventKw::<__A0>::NEW", std::slice::from_ref(event_ty)),
                    "target" => q("::corten::script::__private::TargetKw::<__A0>::NEW", std::slice::from_ref(target_ty)),
                    "signal" => q("::corten::script::__private::SignalKw", &[]),
                    _ => q("::corten::script::__private::ScopeKw", &[]),
                };
                // Errors about the keyword point at it.
                out.extend(replaced.into_iter().map(|mut t| {
                    t.set_span(id.span());
                    t
                }));
            }
            TokenTree::Group(g) => {
                let mut copy = Group::new(g.delimiter(), keywords(g.stream(), event_ty, target_ty));
                copy.set_span(g.span());
                out.extend([TokenTree::Group(copy)]);
            }
            other => out.extend([other.clone()]),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        breaks_out, foreign_breakout, local_path, lost_if_whole, parsing_within, patch_top, raw_text_boundary, reads_as_text,
        refused_path, text_only_element, Attr, Node, Parsing, RawTextBoundary, TopPlace, TopRead, BREAKOUT, DECIDING_HEAD,
        MATH_HTML_POINTS, RAW_TEXT, SVG_HTML_POINTS, TABLE_PARTS, TEMPLATE_HEAD, TEXT_ONLY,
    };
    use proc_macro::TokenStream;

    #[test]
    fn html_raw_text_boundary_depends_on_the_holder_and_delimiter() {
        use RawTextBoundary::{EarlyClose, StillOpen, Unchanged};
        for (name, literals, expected) in [
            ("script", &["a < b && c"][..], Unchanged),
            ("script", &["</scripture> </script <"], EarlyClose),
            ("script", &["</scripture> </script"], Unchanged),
            ("script", &["</sCr", "IpT", "\t>"], EarlyClose),
            ("style", &["</script> <!--<script>"], Unchanged),
            ("style", &["<", "/STYLE/>"], EarlyClose),
            ("script", &["<!", "--<scr", "ipt>"], StillOpen),
            ("script", &["<!-- a < b"], Unchanged),
            ("script", &["<!-- --> <script>"], Unchanged),
            ("script", &["<!--<script> -->"], Unchanged),
            ("script", &["<!--<script></script>"], Unchanged),
            ("script", &["<!--<script></script></script>"], EarlyClose),
        ] {
            let children: Vec<_> = literals.iter().map(|literal| Node::Text((*literal).into())).collect();
            assert_eq!(raw_text_boundary(name, &children), expected, "{literals:?}");
        }
    }

    /// Each element read as text, as each parse would read it: text in HTML, at an `<svg>`'s
    /// integration points too, and an element in an `<svg>`, a `<math>` or where the markup does
    /// not show which (the top of a component's markup, its children).
    #[test]
    fn an_element_is_read_as_text_only_where_the_markup_shows_html() {
        let svg = parsing_within(Parsing::Html, "svg", &[]);
        assert_eq!(svg, Parsing::Svg);
        for point in ["foreignObject", "desc", "title"] {
            assert_eq!(parsing_within(svg, point, &[]), Parsing::Html, "{point}");
        }
        let html = parsing_within(svg, "foreignObject", &[]);
        for name in RAW_TEXT.iter().chain(TEXT_ONLY) {
            assert!(reads_as_text(Parsing::Html, name), "{name} as HTML");
            assert!(reads_as_text(html, name), "{name} in a foreignObject");
            assert!(reads_as_text(parsing_within(svg, "desc", &[]), name), "{name} in a desc");
            assert!(!reads_as_text(Parsing::Svg, name), "{name} in an svg");
            assert!(!reads_as_text(Parsing::Math, name), "{name} in a math");
            assert!(!reads_as_text(Parsing::Unknown, name), "{name} where it is not known");
            // What it holds is SVG's in an <svg> (but for a <title>, which holds HTML), so an
            // element there compiles.
            if *name != "title" {
                assert_eq!(parsing_within(svg, name, &[]), Parsing::Svg, "{name} in an svg");
            }

            let why = text_only_element(Some(name), Parsing::Html, "b").expect("refused");
            assert!(why.starts_with(&format!("<{name}> holds only text: a browser reads a <b>")), "{why}");
            let instead = if RAW_TEXT.contains(name) {
                format!("#[component(js)], styles a component's CSS file, or write the content as a string literal, which a <{name}> writes as is")
            } else {
                "put the element beside it".into()
            };
            assert!(why.contains(&instead), "{why}");
        }
        assert_eq!(text_only_element(None, Parsing::Svg, "g"), None);
        assert!(!reads_as_text(Parsing::Html, "div"));
        assert!(!reads_as_text(Parsing::Html, "noscript"));

        // <plaintext> where the markup shows HTML, and not in an <svg> or where it does not.
        let why = text_only_element(None, Parsing::Html, "plaintext").expect("refused");
        assert!(why.contains("write <pre>"), "{why}");
        assert_eq!(text_only_element(None, Parsing::Svg, "plaintext"), None);
        assert_eq!(text_only_element(None, Parsing::Unknown, "plaintext"), None);
    }

    #[test]
    fn the_markup_shows_html_under_an_element_a_browser_keeps_out_of_an_svg() {
        for name in BREAKOUT {
            assert_eq!(parsing_within(Parsing::Unknown, name, &[]), Parsing::Html, "{name}");
            assert!(breaks_out(name, &[]), "{name}");
        }
        // Elements that are SVG's in an <svg> do not show it (an <html> there is SVG's too).
        for name in ["title", "a", "textarea", "rect", "section", "template", "desc", "foreignObject", "html"] {
            assert_eq!(parsing_within(Parsing::Unknown, name, &[]), Parsing::Unknown, "{name}");
        }
        assert_eq!(parsing_within(Parsing::Html, "section", &[]), Parsing::Html);
        assert_eq!(parsing_within(Parsing::Html, "math", &[]), Parsing::Math);
        assert_eq!(parsing_within(Parsing::Svg, "math", &[]), Parsing::Svg);
        assert_eq!(parsing_within(Parsing::Html, "svg", &[]), Parsing::Svg);
        assert_eq!(parsing_within(Parsing::Svg, "svg", &[]), Parsing::Svg);

        // Where the markup does not show how it is parsed, an <svg> or a <math> is foreign, but
        // which namespace is not known: a <math> in an <svg> is SVG's, an <svg> straight in a
        // <math> MathML's. So neither's integration points show HTML, and a <textarea> under
        // them is not taken for text; an element taken out of either is still refused.
        for root in ["svg", "math"] {
            let foreign = parsing_within(Parsing::Unknown, root, &[]);
            assert_eq!(foreign, Parsing::Foreign, "{root}");
            for point in SVG_HTML_POINTS.iter().chain(MATH_HTML_POINTS).chain(&["annotation-xml"]) {
                assert_eq!(parsing_within(foreign, point, &[]), Parsing::Unknown, "{root} {point}");
                assert!(!reads_as_text(parsing_within(foreign, point, &[]), "textarea"), "{root} {point}");
            }
            for name in ["g", "mrow", "svg", "math", "textarea", "style", "template"] {
                assert_eq!(parsing_within(foreign, name, &[]), Parsing::Foreign, "{root} {name}");
                assert!(!reads_as_text(foreign, name), "{root} {name}");
            }
            for name in BREAKOUT {
                let why = foreign_breakout(foreign, name, &[]).expect("refused");
                assert!(why.contains("<foreignObject>") && why.contains("<mtext>"), "{why}");
            }
            assert!(foreign_breakout(foreign, "font", &[]).is_none());
            assert!(text_only_element(None, foreign, "plaintext").is_none());
        }

        let color = [Attr::Static("color".into(), "red".into())];
        assert!(breaks_out("font", &color));
        assert!(breaks_out("FONT", &[Attr::Bare("SIZE".into())]));
        assert!(!breaks_out("font", &[]));
        assert!(!breaks_out("font", &[Attr::Static("class".into(), "x".into())]));
        assert_eq!(parsing_within(Parsing::Unknown, "font", &color), Parsing::Html);
        assert_eq!(parsing_within(Parsing::Unknown, "font", &[]), Parsing::Unknown);
    }

    /// A `<math>`'s text integration points hold HTML but for `<mglyph>` and `<malignmark>`, and
    /// an `<annotation-xml>` holds HTML only with an HTML first `encoding`; an `<svg>` straight in a
    /// `<math>` is MathML's.
    #[test]
    fn a_math_holds_html_at_its_text_integration_points() {
        let math = parsing_within(Parsing::Html, "math", &[]);
        assert_eq!(math, Parsing::Math);
        for point in MATH_HTML_POINTS {
            let text = parsing_within(math, point, &[]);
            assert_eq!(text, Parsing::MathText, "{point}");
            assert!(reads_as_text(text, "title") && reads_as_text(text, "textarea"), "{point}");
            assert!(text_only_element(None, text, "plaintext").is_some(), "{point}");
            assert_eq!(foreign_breakout(text, "div", &[]), None, "{point}");
            assert_eq!(parsing_within(text, "b", &[]), Parsing::Html, "{point}");
            assert_eq!(parsing_within(text, "svg", &[]), Parsing::Svg, "{point}");
            assert_eq!(parsing_within(text, "math", &[]), Parsing::Math, "{point}");
            // <mglyph> and <malignmark> stay MathML's: a <title> in them holds elements.
            for glyph in ["mglyph", "MAlignMark"] {
                let inner = parsing_within(text, glyph, &[]);
                assert_eq!(inner, Parsing::Math, "{point} {glyph}");
                assert!(!reads_as_text(inner, "title"), "{point} {glyph}");
                assert_eq!(parsing_within(inner, "title", &[]), Parsing::Math, "{point} {glyph}");
            }
            assert_eq!(parsing_within(Parsing::Svg, point, &[]), Parsing::Svg, "{point} in an svg");
            assert_eq!(parsing_within(Parsing::Unknown, point, &[]), Parsing::Unknown, "{point}");
        }
        assert!(reads_as_text(parsing_within(math, "mi", &[]), "title"));
        assert!(text_only_element(None, Parsing::Math, "plaintext").is_none());
        for name in ["mrow", "mfrac", "title", "textarea", "svg", "math", "template"] {
            assert_eq!(parsing_within(math, name, &[]), Parsing::Math, "{name}");
        }
        for encoding in ["text/html", "Application/XHTML+XML"] {
            let attrs = [Attr::Static("encoding".into(), encoding.into())];
            assert_eq!(parsing_within(math, "annotation-xml", &attrs), Parsing::Html, "{encoding}");
        }
        // With another encoding or none it holds MathML, an <svg> in it SVG; where an expression
        // or a spread may write the encoding, it is not known.
        let svg_encoding = [Attr::Static("encoding".into(), "image/svg+xml".into())];
        for attrs in [&svg_encoding[..], &[]] {
            let annotation = parsing_within(math, "annotation-xml", attrs);
            assert_eq!(annotation, Parsing::AnnotationXml);
            assert_eq!(parsing_within(annotation, "svg", &[]), Parsing::Svg);
            assert_eq!(parsing_within(annotation, "math", &[]), Parsing::Math);
            assert_eq!(parsing_within(annotation, "title", &[]), Parsing::Math);
            assert_eq!(parsing_within(annotation, "mtext", &[]), Parsing::MathText);
            assert!(!reads_as_text(annotation, "title") && !reads_as_text(annotation, "textarea"));
            assert!(text_only_element(None, annotation, "plaintext").is_none());
            for name in BREAKOUT {
                let why = foreign_breakout(annotation, name, &[]).expect("refused");
                assert!(why.contains("encoding=\"text/html\"") && why.contains("<mtext>"), "{why}");
            }
            assert_eq!(foreign_breakout(annotation, "mrow", &[]), None);
        }
        let written = [Attr::Expr("encoding".into(), TokenStream::new())];
        assert_eq!(parsing_within(math, "annotation-xml", &written), Parsing::Unknown);
        let spread_first = [Attr::Spread(TokenStream::new()), Attr::Static("encoding".into(), "text/html".into())];
        assert_eq!(parsing_within(math, "annotation-xml", &spread_first), Parsing::Unknown);
        // The first encoding is the one a browser keeps, so a spread or a second one after it
        // changes nothing.
        let spread_after = [Attr::Static("encoding".into(), "image/svg+xml".into()), Attr::Spread(TokenStream::new())];
        assert_eq!(parsing_within(math, "annotation-xml", &spread_after), Parsing::AnnotationXml);
        let html_second = [Attr::Static("encoding".into(), "x".into()), Attr::Static("encoding".into(), "text/html".into())];
        assert_eq!(parsing_within(math, "annotation-xml", &html_second), Parsing::AnnotationXml);
        let html_first = [Attr::Static("ENCODING".into(), "TEXT/HTML".into()), Attr::Static("encoding".into(), "x".into())];
        assert_eq!(parsing_within(math, "annotation-xml", &html_first), Parsing::Html);
        // Only an `encoding` an expression writes makes it unknown: another attribute's expression
        // or a ref before the written one changes nothing. (An `on:` holds a span, which a test
        // cannot make outside a macro; it takes the same arm as a ref.)
        for (encoding, parsing) in [("text/html", Parsing::Html), ("x", Parsing::AnnotationXml)] {
            let attrs = [
                Attr::Expr("class".into(), TokenStream::new()),
                Attr::Ref(TokenStream::new(), None),
                Attr::Static("encoding".into(), encoding.into()),
            ];
            assert_eq!(parsing_within(math, "annotation-xml", &attrs), parsing, "{encoding}");
        }
        // An expression after a written `encoding` writes a second one, which a browser drops.
        for (encoding, parsing) in [("text/html", Parsing::Html), ("x", Parsing::AnnotationXml)] {
            let attrs = [Attr::Static("encoding".into(), encoding.into()), Attr::Expr("encoding".into(), TokenStream::new())];
            assert_eq!(parsing_within(math, "annotation-xml", &attrs), parsing, "{encoding} first");
        }
        assert_eq!(parsing_within(math, "annotation-xml", &[Attr::Bare("encoding".into())]), Parsing::AnnotationXml);
        // An element a browser takes out of foreign content is refused there, as in an <svg>.
        for name in BREAKOUT {
            let why = foreign_breakout(math, name, &[]).expect("refused");
            assert!(why.contains("<mtext>"), "{why}");
            let mrow = parsing_within(math, "mrow", &[]);
            assert!(foreign_breakout(mrow, name, &[]).is_some(), "{name} in an mrow");
        }
        assert!(foreign_breakout(math, "font", &[Attr::Bare("size".into())]).is_some());
        for name in ["font", "mrow", "mi", "title", "annotation-xml", "svg"] {
            assert_eq!(foreign_breakout(math, name, &[]), None, "{name}");
        }
        let html = [Attr::Static("encoding".into(), "text/html".into())];
        assert_eq!(foreign_breakout(parsing_within(math, "annotation-xml", &html), "div", &[]), None);
        assert!(foreign_breakout(parsing_within(math, "annotation-xml", &[]), "div", &[]).is_some());
        assert_eq!(foreign_breakout(parsing_within(math, "annotation-xml", &written), "div", &[]), None);
        // An <svg> where it is valid in a <math> is SVG's.
        assert_eq!(parsing_within(parsing_within(math, "mi", &[]), "svg", &[]), Parsing::Svg);
    }

    fn el(name: &str, children: Vec<Node>) -> Node {
        Node::Element { name: name.into(), attrs: Vec::new(), children }
    }

    /// Why `patch_top` refuses `nodes`, or `None`.
    fn lost(nodes: &[Node]) -> Option<String> {
        patch_top(nodes, TopRead::Open, TopPlace::Anywhere).err().map(|(_, why)| why)
    }

    #[test]
    fn a_whole_patch_knows_which_literal_element_decides() {
        let leaf = |name| el(name, vec![]);
        for part in TABLE_PARTS {
            let nodes = [leaf("p"), leaf(part)];
            assert_eq!(lost(&nodes), None);
            let why = lost_if_whole(&nodes).expect("lost in a whole patch");
            assert!(why.contains(&format!("the <{part}> is dropped when this whole patch begins with <p>")), "{why}");
        }
        for head in TEMPLATE_HEAD {
            let why = lost_if_whole(&[leaf(head), leaf("tr")]);
            if DECIDING_HEAD.contains(head) {
                let why = why.expect("lost in Chromium and WebKit");
                assert!(
                    why.contains(&format!(
                        "the <tr> is dropped in Chromium and WebKit when this whole patch begins with <{head}>"
                    )),
                    "{why}"
                );
            } else {
                assert_eq!(why, None, "{head}");
            }
        }
        let unknown = || Node::Expr(TokenStream::new());
        for nodes in [
            vec![leaf("p"), leaf("table"), leaf("form")],
            vec![unknown(), leaf("p"), leaf("tr")],
            vec![leaf("p"), unknown(), leaf("tr")],
            vec![el("p", vec![unknown()]), leaf("tr")],
            vec![Node::Block { head: Vec::new(), bodies: vec![vec![leaf("tr")]], arms: false }, leaf("p"), leaf("tr")],
        ] {
            assert_eq!(lost_if_whole(&nodes), None);
        }
        // The last element has already been lost before any of its children are read.
        assert!(lost_if_whole(&[leaf("p"), el("tr", vec![unknown()])]).is_some());
    }

    #[test]
    fn a_patch_s_top_level_is_refused_only_where_no_browser_keeps_it_as_written() {
        // After a first <table>, every table part is lost; head tags before it do not decide, and
        // a table part in a block after it counts.
        for part in TABLE_PARTS {
            let why = lost(&[el("table", vec![]), el(part, vec![])]).expect("refused");
            assert!(why.starts_with(&format!("send the <{part}> inside the <table>, or in a patch of its own:")), "{why}");
            assert!(why.contains(&format!("begins with a <table> loses a <{part}> after it")), "{why}");
            assert!(why.ends_with("#choice-html-parse-refusals)"), "{why}");
        }
        for head in TEMPLATE_HEAD {
            let block = Node::Block { head: Vec::new(), bodies: vec![vec![el("tr", vec![])]], arms: false };
            let why = lost(&[el(head, vec![]), el("TABLE", vec![]), el("p", vec![]), block]).expect("refused");
            assert!(why.starts_with("send the <tr> inside the <table>"), "{head}: {why}");
        }
        // After a first <col>, an element HTML's wherever it lands is lost.
        for name in ["p", "div", "span", "table"] {
            let why = lost(&[el("col", vec![]), el("col", vec![]), el(name, vec![])]).expect("refused");
            assert!(
                why.starts_with(&format!("send the <col>s in a <colgroup> with an id, or the <{name}> in a patch of its own:")),
                "{why}"
            );
            assert!(why.contains(&format!("begins with a <col> loses a <{name}> after it")), "{why}");
            assert!(why.contains("Chromium and WebKit drop the <col> instead"), "{why}");
        }
        // After a first other table part, a <table> at the top level or in a later element, and a
        // <form> that holds an element with an element HTML's wherever it lands in or around it.
        let table = || el("table", vec![el("tr", vec![el("td", vec![])])]);
        let input = || el("input", vec![]);
        for part in TABLE_PARTS.iter().filter(|part| **part != "col") {
            let first = || el(part, vec![]);
            let refused: [(Vec<Node>, &str, &str); 7] = [
                (vec![first(), table()], "table", "loses a <table> after it"),
                (vec![first(), el("div", vec![table()])], "div", "loses a <table> in <div> after it"),
                (vec![first(), el("label", vec![el("span", vec![table()])])], "label", "loses a <table> in <label> after it"),
                (vec![first(), el("form", vec![el("div", vec![input()])])], "form", "loses what a <form> after it holds"),
                (vec![first(), el("form", vec![el("p", vec![])])], "form", "loses what a <form> after it holds"),
                (vec![first(), el("div", vec![el("form", vec![input()])])], "div", "loses what a <form> in <div> after it holds"),
                (
                    vec![first(), el("form", vec![el("label", vec![el("span", vec![input()])])])],
                    "form",
                    "loses what a <form> after it holds",
                ),
            ];
            for (nodes, top, says) in refused {
                let why = lost(&nodes).expect("refused");
                assert!(why.starts_with(&format!("send the <{top}> in a patch of its own:")), "{why}");
                assert!(why.contains(&format!("begins with a <{part}> {says}")), "{why}");
            }
        }
        for head in TEMPLATE_HEAD {
            let block = Node::Block { head: Vec::new(), bodies: vec![vec![table()]], arms: false };
            let why = lost(&[el(head, vec![]), el("TR", vec![]), el("p", vec![]), block]).expect("refused");
            assert!(why.starts_with("send the <table> in a patch of its own: a patch that begins with a <tr>"), "{head}: {why}");
        }

        // Markup a browser may keep as written, or whose first element is not known, compiles:
        let expr = || Node::Expr(TokenStream::new());
        let kept: &[&[Node]] = &[
            // after any other first element, which a table part the patch began with may make
            // table content, where a <p> is kept and a <tr> after it too
            &[el("p", vec![]), el("tr", vec![])],
            &[el("div", vec![]), el("td", vec![])],
            &[el("span", vec![]), el("tbody", vec![])],
            &[el("section", vec![]), el("tr", vec![])],
            // after a first table part, a <form> of fields an <svg> keeps, a table in a later table
            // part, and one in a <template> or at an integration point, where the svg's body keeps it
            &[el("tr", vec![]), el("form", vec![el("input", vec![]), el("label", vec![el("select", vec![])])])],
            &[el("td", vec![]), el("label", vec![el("form", vec![el("input", vec![])])]), el("form", vec![])],
            &[el("tr", vec![]), el("tr", vec![el("td", vec![el("table", vec![])])])],
            &[el("tr", vec![]), el("div", vec![el("template", vec![el("table", vec![])])])],
            &[
                el("tbody", vec![]),
                el("label", vec![el("foreignObject", vec![el("table", vec![]), el("form", vec![el("p", vec![])])])]),
            ],
            // an <svg>'s or a <math>'s <form>, foreign content's even under an HTML <div>
            &[el("tr", vec![]), el("div", vec![el("svg", vec![el("form", vec![el("g", vec![])])])])],
            &[el("td", vec![]), el("div", vec![el("math", vec![el("form", vec![el("mi", vec![])])])])],
            // a table part, an element an <svg> keeps or other markup after a <table>
            &[el("table", vec![]), el("p", vec![el("span", vec![])]), el("table", vec![]), el("form", vec![])],
            // after a <col>, a <col>, a <template> or an element an <svg> keeps
            &[el("col", vec![]), el("col", vec![]), el("template", vec![]), el("section", vec![]), el("tr", vec![])],
            // what an expression, a component or a block writes first
            &[expr(), el("table", vec![]), el("tr", vec![])],
            &[Node::Block { head: Vec::new(), bodies: vec![vec![]], arms: false }, el("col", vec![]), el("p", vec![])],
            // an expression or a component between the two, in the first, or in a later element
            // that holds the lost one, before it, which may leave an element open (`raw("<table>")`)
            &[el("table", vec![]), expr(), el("tr", vec![])],
            &[el("table", vec![expr()]), el("tr", vec![])],
            &[
                el("col", vec![]),
                Node::Component { path: TokenStream::new(), props: Vec::new(), children: None },
                el("p", vec![]),
            ],
            &[el("tr", vec![]), Node::Block { head: Vec::new(), bodies: vec![vec![expr()]], arms: false }, el("table", vec![])],
            &[el("tr", vec![]), el("div", vec![expr(), el("table", vec![])])],
            &[el("td", vec![]), el("form", vec![el("div", vec![expr(), el("input", vec![])])])],
            // a <script> or <style> whose text `html!` writes as is, which may open a <table> or
            // a <template> (`</script><template>`), there too
            &[el("tr", vec![]), el("script", vec![Node::Text("</script><template>".into())]), el("table", vec![])],
            &[el("table", vec![]), el("style", vec![Node::Text("</style><template>".into())]), el("tr", vec![])],
            &[
                el("tr", vec![]),
                el(
                    "div",
                    vec![
                        el("script", vec![Node::Text("<".into()), Node::Text("/script><template>".into())]),
                        el("table", vec![]),
                    ],
                ),
            ],
        ];
        for nodes in kept {
            assert_eq!(lost(nodes), None);
        }
        // Unseen output stops a refusal only before the lost element's start tag: after a first
        // row, an expression in a later <div> before its <table> may open a template around it,
        // but one inside the <table> comes after the tag the parse has already dropped, as one
        // in a row after a first <table> comes after the row's.
        assert_eq!(lost(&[el("tr", vec![]), el("div", vec![expr(), el("table", vec![])])]), None);
        let why = lost(&[el("tr", vec![]), el("table", vec![expr()])]).expect("refused");
        assert!(why.starts_with("send the <table> in a patch of its own: a patch that begins with a <tr>"), "{why}");
        let why = lost(&[el("table", vec![]), el("tr", vec![expr()])]).expect("refused");
        assert!(why.starts_with("send the <tr> inside the <table>"), "{why}");
        let script = || el("script", vec![Node::Text("</script>".into())]);
        let why = lost(&[el("tr", vec![]), el("table", vec![script()])]).expect("refused");
        assert!(why.starts_with("send the <table> in a patch of its own"), "{why}");
    }

    #[test]
    fn an_element_a_browser_takes_out_of_foreign_content_is_refused_only_straight_in_it() {
        for name in BREAKOUT {
            let why = foreign_breakout(Parsing::Svg, name, &[]).expect("refused");
            assert!(why.starts_with(&format!("<{name}> is HTML's")), "{why}");
            assert!(why.contains("<foreignObject>"), "{why}");
            assert_eq!(foreign_breakout(Parsing::Html, name, &[]), None, "{name}");
            assert_eq!(foreign_breakout(Parsing::Unknown, name, &[]), None, "{name}");
            assert_eq!(foreign_breakout(Parsing::MathText, name, &[]), None, "{name}");
        }
        assert!(foreign_breakout(Parsing::Svg, "font", &[Attr::Bare("face".into())]).is_some());
        for name in ["font", "a", "title", "textarea", "style", "rect", "g", "foreignObject", "math"] {
            assert_eq!(foreign_breakout(Parsing::Svg, name, &[]), None, "{name}");
        }
    }

    #[test]
    fn a_path_in_the_app_is_found_in_each_url_attribute() {
        for (name, value, path) in [
            ("href", "/items", "/items"),
            ("href", "/", "/"),
            ("href", "/items?tab=offers#review", "/items?tab=offers#review"),
            ("action", " /watch ", " /watch "),
            ("formaction", "/unwatch", "/unwatch"),
            ("href", "\\items", "\\items"),
            ("href", "\t/items", "\t/items"),
            ("src", "/logo.svg", "/logo.svg"),
            ("poster", "/clip.jpg", "/clip.jpg"),
            ("data", "/doc.pdf", "/doc.pdf"),
            ("xlink:href", "/sprite.svg#arrow", "/sprite.svg#arrow"),
            ("srcset", "a.png 1x, /b.png 2x", "/b.png"),
            ("srcset", "/a.png, https://cdn.example/b.png 2x", "/a.png"),
            ("srcset", "https://cdn.example/a.png 1x,/b.png 2x", "/b.png"),
            ("srcset", "https://cdn.example/a.png 100w,/b.png 200w", "/b.png"),
            ("imagesrcset", "https://cdn.example/a.png 1x, /b.png 2x", "/b.png"),
            ("ping", "https://stats.example/p /track", "/track"),
            // A scheme without the two slashes of a host: a path or a relative path on its page.
            ("href", "https:/items", "https:/items"),
            ("href", "HTTPS:items", "HTTPS:items"),
            ("action", " http:/watch", " http:/watch"),
            ("href", "https:\\items", "https:\\items"),
            ("srcset", "https:/a.png 1x", "https:/a.png"),
            // Parentheses do not nest: the first `)` closes them, so the comma after it splits.
            ("srcset", "https://cdn.example/a.png 1x (a (b) c), /b.png 2x", "/b.png"),
        ] {
            assert_eq!(local_path(name, value), Some(path), "{name}={value:?}");
        }
    }

    #[test]
    fn other_urls_and_other_attributes_are_not_paths_in_the_app() {
        for (name, value) in [
            ("href", "#top"),
            ("href", "https://example.com"),
            ("href", "mailto:help@example.com"),
            ("href", "tel:+15550100"),
            ("href", "//cdn.example/a.png"),
            ("href", "/\\evil.example"),
            ("href", "\\\\evil.example"),
            ("href", "/\t/evil.example"),
            ("href", "items/7"),
            ("href", "?page=2"),
            ("href", ""),
            ("src", "data:image/png;base64,iVBORw0KGgo="),
            ("srcset", "data:image/jpeg;base64,/9j/4AAQ 1x, https://cdn.example/b.png 2x"),
            // One URL: a comma splits candidates only after a space or at the URL's end.
            ("srcset", "https://cdn.example/a.png,/b.png 2x"),
            ("srcset", "a.png 1x, b.png 2x"),
            ("ping", "https://stats.example/p https://stats.example/q"),
            ("title", "/items"),
            ("data-path", "/items"),
            ("content", "0; url=/items"),
            ("href", "https:\\\\evil.example"),
            ("href", "https:/\\evil.example"),
            ("href", "HTTP://example.com"),
            ("href", "httpx:/items"),
            ("href", "ftp:/items"),
        ] {
            assert_eq!(local_path(name, value), None, "{name}={value:?}");
        }
    }

    #[test]
    fn the_error_names_the_form_the_attribute_takes() {
        let error = refused_path("href", "/items");
        assert!(error.starts_with("href: \"/items\" is a path in this app written as text"), "{error}");
        assert!(error.contains("href={url::Items}"), "{error}");
        assert!(error.contains("href={corten::Local::parse(\"/oauth2/sign_out\").expect(\"a path on this site\")}"), "{error}");

        let error = refused_path("xlink:href", "/sprite.svg#arrow");
        assert!(error.contains("xlink:href={(req.asset(Static::SPRITE_SVG), \"#arrow\")}"), "{error}");
        assert!(error.contains("xlink:href={url::Items.at(Id)}"), "{error}");
        // An unrouted path with a fragment is steered to a form that keeps it.
        assert!(error.contains("Local::parse(\"/proxy/page#arrow\")"), "{error}");
        assert!(!error.contains("Uri"), "{error}");

        let error = refused_path("srcset", "/b.png");
        assert!(error.contains("srcset={(req.asset(Static::PHOTO_PNG), \" 1x, \""), "{error}");
        assert!(error.contains(".to_string()"), "{error}");

        let error = refused_path("ping", "/seen");
        assert!(error.contains("ping={(url::Seen.href(), \" \", url::Read.href())}"), "{error}");

        let error = refused_path("href", "https:/items");
        assert!(error.contains("has a scheme but no host"), "{error}");
        assert!(error.contains("on a page of the other scheme as a host"), "{error}");
    }

    #[test]
    fn the_advice_follows_the_attribute_whatever_its_case_and_names_it_as_written() {
        let error = refused_path("SRCSET", "/b.png");
        assert!(error.starts_with("SRCSET: "), "{error}");
        assert!(error.contains("SRCSET={(req.asset(Static::PHOTO_PNG), \" 1x, \""), "{error}");
        assert!(error.contains("the text of a corten::Local in the tuple"), "{error}");

        let error = refused_path("PING", "/seen");
        assert!(error.contains("PING={(url::Seen.href(), \" \", url::Read.href())}"), "{error}");

        let error = refused_path("HREF", "/items");
        assert!(error.contains("HREF={url::Items}"), "{error}");
        assert_eq!(
            refused_path("ImageSrcSet", "/b.png").replace("ImageSrcSet", "imagesrcset"),
            refused_path("imagesrcset", "/b.png")
        );
    }
}
