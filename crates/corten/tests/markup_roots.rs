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
