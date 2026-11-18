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

/// A document's body follows `<Corten />`, which `html!` does not see, so a nested form there
/// compiles (a miss: a browser ignores the inner start tag), as does one form.
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
fn NestedCheckout() -> impl Document {
    html! {
        <html>
            <head>
                <title>"Checkout"</title>
                <Corten />
            </head>
            <body><main><form><div><form><input></form></div></form></main></body>
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
    assert!(NestedCheckout {}.to_html().contains("<main><form><div><form><input></form></div></form></main>"));
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

/// A script whose text holds `<!--<script>` stays open past its literal end tag (the tokenizer's
/// double-escaped state), so what follows is its text until a second `</script>`, here written
/// by `raw`: a later literal `<svg>`, `<p>` or `<textarea>` shows nothing, and browsers keep
/// each of these as written. So does markup after a script `raw` or a component opens, in a
/// `<template>` too, and children a component writes after one.
#[test]
fn nothing_after_a_script_left_open_is_refused() {
    let x = r#"<script type="text/x-template">"#;
    let comment = r#"<div><script type="text/x-template"><!--<script></script>"#;
    for (markup, expected) in [
        (
            html! {
                <div>
                    <script type="text/x-template">"<!--<script>"</script>
                    <svg><div>"Detail"</div></svg>
                    {raw("</script>")}
                </div>
            }
            .to_html(),
            format!("{comment}<svg><div>Detail</div></svg></script></div>"),
        ),
        (
            html! {
                <div>
                    <script type="text/x-template">"<!--<script>"</script>
                    <p><div>"Detail"</div></p>
                    {raw("</script>")}
                </div>
            }
            .to_html(),
            format!("{comment}<p><div>Detail</div></p></script></div>"),
        ),
        (
            html! {
                <div>
                    <script type="text/x-template">"<!--<script>"</script>
                    <div><textarea><g></g></textarea></div>
                    {raw("</script>")}
                </div>
            }
            .to_html(),
            format!("{comment}<div><textarea><g></g></textarea></div></script></div>"),
        ),
        (
            html! {
                <div>
                    {raw(x)}
                    <svg><div>"Detail"</div></svg>
                    {raw("</script>")}
                </div>
            }
            .to_html(),
            format!("<div>{x}<svg><div>Detail</div></svg></script></div>"),
        ),
        (
            html! {
                <div>
                    {raw(x)}
                    <p><div>"Detail"</div></p>
                    {raw("</script>")}
                </div>
            }
            .to_html(),
            format!("<div>{x}<p><div>Detail</div></p></script></div>"),
        ),
        (
            html! {
                <div>
                    {raw(x)}
                    <template><p><div>"Detail"</div></p></template>
                    {raw("</script>")}
                </div>
            }
            .to_html(),
            format!("<div>{x}<template><p><div>Detail</div></p></template></script></div>"),
        ),
        (
            html! {
                <div>
                    <Writes markup={x} />
                    <div><textarea><g></g></textarea></div>
                    <Writes markup="</script>" />
                </div>
            }
            .to_html(),
            format!("<div>{x}<div><textarea><g></g></textarea></div></script></div>"),
        ),
        (
            html! {
                <div>
                    <Writes markup={x} />
                    <svg><foreignObject><p><div>"Detail"</div></p></foreignObject></svg>
                    <Writes markup="</script>" />
                </div>
            }
            .to_html(),
            format!("<div>{x}<svg><foreignObject><p><div>Detail</div></p></foreignObject></svg></script></div>"),
        ),
        (
            html! { <div><Within open={x} close="</script>"><p><div>"Detail"</div></p></Within></div> }.to_html(),
            format!("<div>{x}<p><div>Detail</div></p></script></div>"),
        ),
    ] {
        assert_eq!(markup, expected);
    }
}

mod custom {
    use corten::prelude::*;

    /// An app's component that shares the head marker's name.
    #[component]
    pub fn Corten() -> impl Render {
        html! { <p>"App component"</p> }
    }
}

mod opens {
    use corten::prelude::*;

    /// One that writes what it is given, unbalanced.
    #[component]
    pub fn Corten(markup: &'static str) -> impl Render {
        html! { {raw(markup)} }
    }
}

mod wraps {
    use corten::prelude::*;

    /// One that writes a `<button>` before its children and leaves it open.
    #[component]
    pub fn Corten(children: impl Render) -> impl Render {
        html! { {raw("<button>")}{children} }
    }
}

/// Every component is unseen, `<Corten />` too: `html!` knows it only by its name, which an app's
/// component may share, so a component named `Corten` compiles by any path, with or without
/// children, and no refusal reaches across it. Browsers keep each of these as written.
#[test]
fn a_component_named_corten_is_unseen_like_any_other() {
    assert_eq!(html! { <div><custom::Corten /></div> }.to_html(), "<div><p>App component</p></div>");
    let kept = "<p><button><div>Detail</div></button></p>";
    assert_eq!(
        html! {
            <p>
                <opens::Corten markup="<button>" />
                <div>"Detail"</div>
                {raw("</button>")}
            </p>
        }
        .to_html(),
        kept
    );
    assert_eq!(
        html! {
            <p>
                <wraps::Corten><div>"Detail"</div></wraps::Corten>
                {raw("</button>")}
            </p>
        }
        .to_html(),
        kept
    );
    {
        use opens::Corten;
        assert_eq!(
            html! {
                <p>
                    <Corten markup="<button>" />
                    <div>"Detail"</div>
                    {raw("</button>")}
                </p>
            }
            .to_html(),
            kept
        );
        let open = true;
        assert_eq!(
            html! {
                <p>
                    if open { <Corten markup="<button>" /> }
                    <div>"Detail"</div>
                    {raw("</button>")}
                </p>
            }
            .to_html(),
            kept
        );
        assert_eq!(
            html! {
                <p>
                    <span><Corten markup="</span><button><span>" /></span>
                    <div>"Detail"</div>
                    {raw("</button>")}
                </p>
            }
            .to_html(),
            "<p><span></span><button><span></span><div>Detail</div></button></p>"
        );
    }
}

/// Corten's own head marker still compiles by any path that names it, and writes the head.
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

/// What an element a browser parsing HTML reads as text holds is not read for a refusal where the
/// markup does not show the element is HTML's (the top of a component's markup, an `<svg>`'s
/// integration point whose `<svg>` the markup does not place): there it may be text, and
/// browsers keep each of these as written. A `<noscript>`'s content is text with scripting on.
#[component]
fn FramedDetail() -> impl Render {
    html! { <iframe><p><div>"Detail"</div></p></iframe> }
}

#[test]
fn an_element_that_may_read_as_text_holds_what_no_refusal_reads() {
    for (markup, expected) in [
        (FramedDetail {}.to_html(), "<iframe><p><div>Detail</div></p></iframe>"),
        (html! { <iframe><p><div>"Detail"</div></p></iframe> }.to_html(), "<iframe><p><div>Detail</div></p></iframe>"),
        (html! { <noscript><p><div>"Detail"</div></p></noscript> }.to_html(), "<noscript><p><div>Detail</div></p></noscript>"),
        (html! { <xmp><p><div>"Detail"</div></p></xmp> }.to_html(), "<xmp><p><div>Detail</div></p></xmp>"),
        (html! { <noembed><p><div>"Detail"</div></p></noembed> }.to_html(), "<noembed><p><div>Detail</div></p></noembed>"),
        (html! { <noframes><p><div>"Detail"</div></p></noframes> }.to_html(), "<noframes><p><div>Detail</div></p></noframes>"),
        (html! { <style><p><div>"Detail"</div></p></style> }.to_html(), "<style><p><div>Detail</div></p></style>"),
        (html! { <script><p><div>"Detail"</div></p></script> }.to_html(), "<script><p><div>Detail</div></p></script>"),
        (html! { <textarea><p><div>"Detail"</div></p></textarea> }.to_html(), "<textarea><p><div>Detail</div></p></textarea>"),
        (html! { <title><p><div>"Detail"</div></p></title> }.to_html(), "<title><p><div>Detail</div></p></title>"),
        (
            html! { <div><noscript><p><div>"Detail"</div></p></noscript></div> }.to_html(),
            "<div><noscript><p><div>Detail</div></p></noscript></div>",
        ),
        (
            html! { <svg><foreignObject><textarea><p><div>"Detail"</div></p></textarea></foreignObject></svg> }.to_html(),
            "<svg><foreignObject><textarea><p><div>Detail</div></p></textarea></foreignObject></svg>",
        ),
    ] {
        assert_eq!(markup, expected);
    }
}

/// `key` is written `data-key`, so a `KEY` beside it is another attribute.
#[test]
fn key_and_upper_case_key_are_two_attributes() {
    assert_eq!(
        html! { <my-widget key="row-1" KEY="widget-value"></my-widget> }.to_html(),
        r#"<my-widget data-key="row-1" KEY="widget-value"></my-widget>"#
    );
}

#[test]
fn ref_and_upper_case_ref_are_two_attributes() {
    #[component]
    fn Marked() -> impl Render {
        let node = refs();
        html! { <div ref={node} REF="widget-value"></div> }
    }
    assert_eq!(Marked {}.to_html(), r#"<div data-scope="marked" data-ref="node" REF="widget-value"></div>"#);
}

#[test]
fn bare_page_and_literal_page_are_two_attributes() {
    #[derive(Id)]
    struct NavId;

    for (doc, expected) in [
        (
            html! {
                <html>
                    <head>
                        <title>"Page attributes"</title>
                        <Corten />
                    </head>
                    <body>
                        <nav page PAGE="widget-value" id={NavId}></nav>
                        <main></main>
                    </body>
                </html>
            }
            .to_html(),
            r#"<nav data-corten-page PAGE="widget-value" id="nav"></nav>"#,
        ),
        (
            html! {
                <html>
                    <head>
                        <title>"Page attributes"</title>
                        <Corten />
                    </head>
                    <body>
                        <nav page page="widget-value" id={NavId}></nav>
                        <main></main>
                    </body>
                </html>
            }
            .to_html(),
            r#"<nav data-corten-page page="widget-value" id="nav"></nav>"#,
        ),
    ] {
        assert!(doc.contains(expected), "{doc}");
    }
}
