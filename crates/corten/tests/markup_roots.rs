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

#[component]
fn MathLinks() -> impl Render {
    html! { <math><mtext><a href="#one"><a href="#two">"Link"</a></a></mtext></math> }
}

#[component]
fn SvgLinks() -> impl Render {
    html! { <svg><title><a href="#one"><a href="#two">"Link"</a></a></title></svg> }
}

#[component]
fn InSvg(children: impl Render) -> impl Render {
    html! { <svg>{children}</svg> }
}

#[component]
fn InMath(children: impl Render) -> impl Render {
    html! { <math><mrow>{children}</mrow></math> }
}

/// A literal `<math>` or `<svg>` does not show its own namespace where its markup lands: a
/// `<math>` in an `<svg>` is SVG's and an `<svg>` straight in a `<math>` MathML's, so neither's
/// `<mtext>` or `<title>` holds HTML there, and browsers keep the anchors nested. Each compiles,
/// as a separate component and as children a component writes into the other.
#[test]
fn a_foreign_root_does_not_show_its_namespace_where_its_markup_lands() {
    let math_in_svg = r##"<svg><math><mtext><a href="#one"><a href="#two">Link</a></a></mtext></math></svg>"##;
    let svg_in_math = r##"<math><mrow><svg><title><a href="#one"><a href="#two">Link</a></a></title></svg></mrow></math>"##;
    assert_eq!(html! { <svg><MathLinks /></svg> }.to_html(), math_in_svg);
    assert_eq!(
        html! { <InSvg><math><mtext><a href="#one"><a href="#two">"Link"</a></a></mtext></math></InSvg> }.to_html(),
        math_in_svg
    );
    assert_eq!(html! { <math><mrow><SvgLinks /></mrow></math> }.to_html(), svg_in_math);
    assert_eq!(
        html! { <InMath><svg><title><a href="#one"><a href="#two">"Link"</a></a></title></svg></InMath> }.to_html(),
        svg_in_math
    );
}

#[component]
fn Writes(markup: &'static str) -> impl Render {
    html! { {raw(markup)} }
}

#[component]
fn Within(open: &'static str, close: &'static str, children: impl Render) -> impl Render {
    html! { {raw(open)}{children}{raw(close)} }
}

/// What an expression or a component writes between two elements is not seen, and may be the
/// boundary that makes browsers keep the inner one where it is written (`raw("<button>")` in a
/// `<p>` before a `<div>`), so no nesting refusal reaches across one. One of each kind, each kept
/// by browsers (`parsesAsHtmlMeans` in `scripts/smoke.mjs`).
#[test]
fn no_nesting_refusal_reaches_across_what_the_markup_does_not_show() {
    let p = "<p><button><div>Detail</div></button></p>";
    assert_eq!(
        html! {
            <p>
                {raw("<button>")}
                <div>"Detail"</div>
                {raw("</button>")}
            </p>
        }
        .to_html(),
        p
    );
    assert_eq!(
        html! {
            <p>
                <Writes markup="<button>" />
                <div>"Detail"</div>
                <Writes markup="</button>" />
            </p>
        }
        .to_html(),
        p
    );
    assert_eq!(html! { <p><Within open="<button>" close="</button>"><div>"Detail"</div></Within></p> }.to_html(), p);
    for (markup, expected) in [
        (
            html! {
                <ul>
                    <li>
                        {raw("<ul>")}
                        <li>"x"</li>
                        {raw("</ul>")}
                    </li>
                </ul>
            }
            .to_html(),
            "<ul><li><ul><li>x</li></ul></li></ul>",
        ),
        (
            html! {
                <dl>
                    <dt>
                        {raw("<dl>")}
                        <dd>"x"</dd>
                        {raw("</dl>")}
                    </dt>
                </dl>
            }
            .to_html(),
            "<dl><dt><dl><dd>x</dd></dl></dt></dl>",
        ),
        (
            html! { <div><a href="#one">{raw("<object>")}<a href="#two">"x"</a>{raw("</object>")}</a></div> }.to_html(),
            r##"<div><a href="#one"><object><a href="#two">x</a></object></a></div>"##,
        ),
        (
            html! { <div><button>{raw("<object>")}<button>"x"</button>{raw("</object>")}</button></div> }.to_html(),
            "<div><button><object><button>x</button></object></button></div>",
        ),
        (
            html! {
                <div>
                    <nobr>
                        {raw("<object>")}
                        <nobr>"x"</nobr>
                        {raw("</object>")}
                    </nobr>
                </div>
            }
            .to_html(),
            "<div><nobr><object><nobr>x</nobr></object></nobr></div>",
        ),
        (
            html! {
                <h1>
                    {raw("<span>")}
                    <h2>"x"</h2>
                    {raw("</span>")}
                </h1>
            }
            .to_html(),
            "<h1><span><h2>x</h2></span></h1>",
        ),
        (
            html! { <div><select aria-label="Choice">{raw("<object>")}<input>{raw("</object>")}</select></div> }.to_html(),
            r#"<div><select aria-label="Choice"><object><input></object></select></div>"#,
        ),
        (
            html! {
                <div>
                    <select aria-label="Choice">{raw("<object>")}<select aria-label="Nested"></select>{raw("</object>")}</select>
                </div>
            }
            .to_html(),
            r#"<div><select aria-label="Choice"><object><select aria-label="Nested"></select></object></select></div>"#,
        ),
        (
            html! {
                <div>
                    <select aria-label="Choice">
                        <option>
                            {raw("<span>")}
                            <option>"x"</option>
                            {raw("</span>")}
                        </option>
                    </select>
                </div>
            }
            .to_html(),
            r#"<div><select aria-label="Choice"><option><span><option>x</option></span></option></select></div>"#,
        ),
        (
            html! {
                <div>
                    <select aria-label="Choice">
                        <optgroup label="g">
                            {raw("<span>")}
                            <optgroup label="h"></optgroup>
                            {raw("</span>")}
                        </optgroup>
                    </select>
                </div>
            }
            .to_html(),
            r#"<div><select aria-label="Choice"><optgroup label="g"><span><optgroup label="h"></optgroup></span></optgroup></select></div>"#,
        ),
        (
            html! {
                <div>
                    <select aria-label="Choice">
                        <option>
                            "Choice"{raw("<span>")}
                            <hr>
                            {raw("</span>")}
                        </option>
                    </select>
                </div>
            }
            .to_html(),
            r#"<div><select aria-label="Choice"><option>Choice<span><hr></span></option></select></div>"#,
        ),
        (
            html! {
                <div>
                    <ruby>
                        "Base"
                        <rt>
                            {raw("<ruby>")}
                            <rt>"x"</rt>
                            {raw("</ruby>")}
                        </rt>
                    </ruby>
                </div>
            }
            .to_html(),
            "<div><ruby>Base<rt><ruby><rt>x</rt></ruby></rt></ruby></div>",
        ),
        (
            html! {
                <div>
                    <ruby>
                        <rtc>
                            {raw("<ruby>")}
                            <rb>"x"</rb>
                            {raw("</ruby>")}
                        </rtc>
                    </ruby>
                </div>
            }
            .to_html(),
            "<div><ruby><rtc><ruby><rb>x</rb></ruby></rtc></ruby></div>",
        ),
        // Opened by what an expression writes, an integration point or a template's content
        // starts with nothing open.
        (
            html! {
                <div>
                    <a href="#one">{raw("<svg><foreignObject>")}<a href="#two">"Link"</a>{raw("</foreignObject></svg>")}</a>
                </div>
            }
            .to_html(),
            r##"<div><a href="#one"><svg><foreignObject><a href="#two">Link</a></foreignObject></svg></a></div>"##,
        ),
        (
            html! { <div><a href="#one">{raw("<template>")}<a href="#two">"Link"</a>{raw("</template>")}</a></div> }.to_html(),
            r##"<div><a href="#one"><template><a href="#two">Link</a></template></a></div>"##,
        ),
    ] {
        assert_eq!(markup, expected);
    }
}

/// In a whole document a nested form is refused, but not after something the markup does not
/// show, which may open a `<template>`: browsers keep both forms in its content.
#[component]
fn TemplateForms() -> impl Document {
    html! {
        <html>
            <head>
                <title>"Forms"</title>
                <Corten />
            </head>
            <body>
                <main>
                    {raw("<template>")}
                    <form><form><input></form></form>
                    {raw("</template>")}
                </main>
            </body>
        </html>
    }
}

#[component]
fn TemplateFormsByComponent() -> impl Document {
    html! {
        <html>
            <head>
                <title>"Forms"</title>
                <Corten />
            </head>
            <body>
                <main>
                    <Writes markup="<template>" />
                    <form><form><input></form></form>
                    <Writes markup="</template>" />
                </main>
            </body>
        </html>
    }
}

#[component]
fn TemplateFormsAsChildren() -> impl Document {
    html! {
        <html>
            <head>
                <title>"Forms"</title>
                <Corten />
            </head>
            <body><main><Within open="<template>" close="</template>"><form><form><input></form></form></Within></main></body>
        </html>
    }
}

#[test]
fn a_document_refuses_no_nested_form_after_what_it_does_not_show() {
    let main = "<main><template><form><form><input></form></form></template></main>";
    for html in [TemplateForms {}.to_html(), TemplateFormsByComponent {}.to_html(), TemplateFormsAsChildren {}.to_html()] {
        assert!(html.contains(main), "{html}");
    }
}

/// A `<script>` or `<style>` writes its literal text as is, so `</script>` in it ends the element
/// where the text says, and the text may open a template, as `raw` may.
#[component]
fn ScriptTemplateForms() -> impl Document {
    html! {
        <html>
            <head>
                <title>"Forms"</title>
                <Corten />
            </head>
            <body>
                <main>
                    <script>"</script><template><script>"</script>
                    <form><form><input></form></form>
                    {raw("</template>")}
                </main>
            </body>
        </html>
    }
}

/// What a `<script>` or `<style>` whose text holds a `<` writes is not shown by the markup, as
/// what `raw` writes is not: no refusal reaches across it, and browsers keep each of these as
/// written (`parsesAsHtmlMeans` in `scripts/smoke.mjs`).
#[test]
fn no_refusal_reaches_across_a_script_whose_text_may_write_tags() {
    let p = "<p><script></script><button><script></script><div>Detail</div></button></p>";
    for (markup, expected) in [
        (
            html! {
                <p>
                    <script>"</script><button><script>"</script>
                    <div>"Detail"</div>
                    {raw("</button>")}
                </p>
            }
            .to_html(),
            p,
        ),
        (
            html! {
                <p>
                    <style>"</style><button><style>"</style>
                    <div>"Detail"</div>
                    {raw("</button>")}
                </p>
            }
            .to_html(),
            "<p><style></style><button><style></style><div>Detail</div></button></p>",
        ),
        // The end tag split across two literals.
        (
            html! {
                <p>
                    <script>"<" "/script><button><script>"</script>
                    <div>"Detail"</div>
                    {raw("</button>")}
                </p>
            }
            .to_html(),
            p,
        ),
        // An <svg> the text opens makes the <textarea> after it SVG's, which holds elements.
        (
            html! {
                <div>
                    <script>"</script><svg><script>"</script>
                    <textarea><g></g></textarea>{raw("</svg>")}
                </div>
            }
            .to_html(),
            "<div><script></script><svg><script></script><textarea><g></g></textarea></svg></div>",
        ),
    ] {
        assert_eq!(markup, expected);
    }
    let html = ScriptTemplateForms {}.to_html();
    assert!(
        html.contains("<main><script></script><template><script></script><form><form><input></form></form></template></main>"),
        "{html}"
    );
}

/// `<Corten />` is Corten's head marker by any path that names it; a component of the same name
/// does not compile (the `compile_fail` examples in `view`).
#[component]
fn QualifiedMarker() -> impl Document {
    html! {
        <html>
            <head>
                <title>"Marker"</title>
                <corten::Corten />
            </head>
            <body><main><p>"Body"</p></main></body>
        </html>
    }
}

#[test]
fn corten_s_own_head_marker_compiles_by_any_path() {
    let html = QualifiedMarker {}.to_html();
    assert!(html.contains("<title>Marker</title>"), "{html}");
    assert!(html.contains("<main><p>Body</p></main>"), "{html}");
}
