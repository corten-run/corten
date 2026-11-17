use corten::prelude::*;

#[component]
fn ScopedDocument() -> impl Document {
    let lead = refs();
    html! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <title>"Scoped document"</title>
                <Corten />
            </head>
            <body><main><p ref={lead}>"Lead"</p></main></body>
        </html>
    }
}

#[test]
fn a_scoped_document_keeps_its_doctype_and_scopes_the_html_element() {
    let doc = ScopedDocument {};
    let html = doc.to_html();
    assert!(html.starts_with("<!DOCTYPE html><html data-scope=\"scoped-document\" lang=\"en\">"), "{html}");
    assert!(html.contains("<p data-ref=\"lead\">Lead</p>"), "{html}");
    for (part, expected) in [
        (corten::view::Part::Swap, "<title>Scoped document</title><p data-ref=\"lead\">Lead</p>"),
        (corten::view::Part::Title, "Scoped document"),
    ] {
        let mut out = String::new();
        doc.render_part(&mut out, part);
        assert_eq!(out, expected);
    }
}

#[test]
fn nesting_boundaries_and_unknown_namespaces_still_compile() {
    #[component]
    fn Drawing() -> impl Render {
        html! { <a><a>"SVG links"</a></a> }
    }
    #[component]
    fn Wrap(children: impl Render) -> impl Render {
        html! { <svg>{children}</svg> }
    }
    let markup = html! {
        <div>
            <ul><li><ul><li>"Nested list"</li></ul></li></ul>
            <dl><dt><dl><dd>"Nested definition list"</dd></dl></dt></dl>
            <p><button><div>"Button scope"</div></button></p>
            <a href="#outer"><object><a href="#inner">"Independent link"</a></object></a>
            <a href="#outer"><table><caption><a href="#caption">"Caption link"</a></caption></table></a>
            <form><template><form><input></form></template></form>
            <select aria-label="Choice"><optgroup label="Group"><option>"Choice"</option></optgroup></select>
            <ruby>
                "Base"
                <rtc><rt>"Reading"</rt></rtc>
            </ruby>
            <optgroup label="Outside select"><optgroup label="Still outside"></optgroup></optgroup>
            <p><svg><foreignObject><div>"HTML in SVG"</div></foreignObject></svg></p>
            <svg><Drawing /></svg>
            <Wrap><a><a>"SVG children"</a></a></Wrap>
            <p><math><mtext><div>"HTML in MathML"</div></mtext></math></p>
        </div>
    }
    .to_html();
    assert!(markup.contains("<ul><li><ul><li>Nested list</li></ul></li></ul>"));
    assert!(markup.contains("<a><a>SVG links</a></a>"));
    assert!(markup.contains("<a><a>SVG children</a></a>"));
}

/// Browsers keep these trees: an anchor reached through an SVG or MathML integration point is
/// independent of one around the drawing, and a template's forms do not see the form pointer.
/// The twin of the nested-form `compile_fail` example in `view`: the same document with one form.
#[component]
fn Checkout() -> impl Document {
    html! {
        <html>
            <head>
                <title>"Checkout"</title>
                <Corten />
            </head>
            <body><main><form><div><input></div></form></main></body>
        </html>
    }
}

#[component]
fn FormTemplate(children: impl Render) -> impl Render {
    html! { <template>{children}</template> }
}

#[component]
fn NestedForms() -> impl Render {
    html! { <div><form><form><input></form></form></div> }
}

/// A fragment's caller may write it into a template, where a browser keeps a form in a form, so
/// outside a document the nested form compiles: in a component's children it writes into a
/// template, and as a component's own markup used in a literal one.
#[test]
fn nested_forms_compile_where_a_template_may_hold_them() {
    let nested = "<template><div><form><form><input></form></form></div></template>";
    assert_eq!(html! { <FormTemplate><div><form><form><input></form></form></div></FormTemplate> }.to_html(), nested);
    assert_eq!(html! { <template><NestedForms /></template> }.to_html(), nested);
    assert!(Checkout {}.to_html().contains("<main><form><div><input></div></form></main>"));
}

#[test]
fn templates_and_foreign_content_start_with_nothing_open() {
    #[component]
    fn Holder(children: impl Render) -> impl Render {
        html! { <div>{children}</div> }
    }
    for (markup, expected) in [
        (
            html! { <div><a><svg><foreignObject><a>"Link"</a></foreignObject></svg></a></div> }.to_html(),
            "<div><a><svg><foreignObject><a>Link</a></foreignObject></svg></a></div>",
        ),
        (
            html! { <div><a><math><mtext><a>"Link"</a></mtext></math></a></div> }.to_html(),
            "<div><a><math><mtext><a>Link</a></mtext></math></a></div>",
        ),
        (
            html! { <div><a><svg><title><a>"Link"</a></title></svg></a></div> }.to_html(),
            "<div><a><svg><title><a>Link</a></title></svg></a></div>",
        ),
        (
            html! { <template><div><form><form><input></form></form></div></template> }.to_html(),
            "<template><div><form><form><input></form></form></div></template>",
        ),
        (
            html! { <template><Holder><form><form><input></form></form></Holder></template> }.to_html(),
            "<template><div><form><form><input></form></form></div></template>",
        ),
    ] {
        assert_eq!(markup, expected);
    }
}
