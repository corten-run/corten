import { readFileSync } from "node:fs";
import { checkMarkupScanner } from "../markup-scan.mjs";
import { checkCssScanner } from "../css-scan.mjs";
import { engine, check } from "./helpers.mjs";

/**
 * How the browser parses the shapes `html!`'s examples in `view.rs` hold, accepted and refused
 * (docs/design.md#choice-html-parse-refusals): an element a MathML text integration point, its
 * `<mglyph>` or `<malignmark>`, an `<annotation-xml>` or an `<svg>` holds stays there, an
 * `<svg>` straight in a `<math>` is MathML's, an element in a `<title>` parsed as HTML is text,
 * and one a browser takes out of foreign content lands outside it. The strings below are written
 * by hand as `html!` writes those shapes (it writes literal markup as given), not rendered by it:
 * this checks the browser's parsing that `html!`'s rules stand on, each shape as a page of its own.
 * @param {import("@playwright/test").Browser} browser
 */
async function parsesAsHtmlMeans(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const MATHML = "http://www.w3.org/1998/Math/MathML";
  const XHTML = "http://www.w3.org/1999/xhtml";
  /** @type {[string, string, (page: { MATHML: string, XHTML: string, markup: string }) => boolean][]} */
  const shapes = [
    [
      "a <title> in a <mglyph> in an <mi> is MathML's and holds elements",
      `<p><math><mi><mglyph><title><mrow></mrow></title></mglyph></mi></math></p>`,
      ({ MATHML }) => document.querySelector("mi > mglyph > title > mrow")?.namespaceURI === MATHML,
    ],
    [
      "an <annotation-xml> with an HTML encoding holds HTML",
      `<p><math><annotation-xml encoding="text/html"><b>x</b></annotation-xml></math></p>`,
      ({ XHTML }) => document.querySelector("annotation-xml > b")?.namespaceURI === XHTML,
    ],
    [
      "an <annotation-xml> whose first encoding is TEXT/HTML (any case) holds HTML",
      `<p><math><annotation-xml encoding="TEXT/HTML" encoding="x"><b>x</b></annotation-xml></math></p>`,
      ({ XHTML }) => document.querySelector("annotation-xml > b")?.namespaceURI === XHTML,
    ],
    [
      "an <annotation-xml> with a MathML encoding holds a MathML <title> with elements, and an <svg> with HTML in its <foreignObject>",
      `<p><math><annotation-xml encoding="application/mathml+xml"><title><mrow></mrow></title><svg><foreignObject><b>x</b></foreignObject></svg></annotation-xml></math></p>`,
      ({ MATHML, XHTML }) =>
        document.querySelector("annotation-xml > title > mrow")?.namespaceURI === MATHML &&
        document.querySelector("annotation-xml > svg > foreignObject > b")?.namespaceURI === XHTML,
    ],
    [
      "a <title> in a <malignmark> in an <mi> is MathML's and holds elements",
      `<p><math><mi><malignmark><title><mrow></mrow></title></malignmark></mi></math></p>`,
      ({ MATHML }) => document.querySelector("mi > malignmark > title > mrow")?.namespaceURI === MATHML,
    ],
    [
      "a <div> in an <mtext> stays there, HTML's",
      `<p><math><mtext><div>x</div></mtext></math></p>`,
      ({ XHTML }) => document.querySelector("math > mtext > div")?.namespaceURI === XHTML,
    ],
    [
      "an <svg> straight in a <math> is MathML's",
      `<p><math><svg><g></g></svg></math></p>`,
      ({ MATHML }) =>
        document.querySelector("math > svg")?.namespaceURI === MATHML &&
        document.querySelector("math > svg > g")?.namespaceURI === MATHML,
    ],
    [
      "an <annotation-xml> without an encoding holds MathML, and an <svg> in it is SVG's",
      `<p><math><annotation-xml><title><mrow></mrow></title><svg><g></g></svg></annotation-xml></math></p>`,
      ({ MATHML }) =>
        document.querySelector("annotation-xml > title > mrow")?.namespaceURI === MATHML &&
        document.querySelector("annotation-xml > svg > g")?.namespaceURI === "http://www.w3.org/2000/svg",
    ],
    [
      "an <svg>'s <title> holds HTML, and its <style> and <textarea> hold elements",
      `<div><svg><title><span>Chart</span></title><style><g></g></style><textarea><g></g></textarea></svg></div>`,
      ({ XHTML }) =>
        document.querySelector("svg > title > span")?.namespaceURI === XHTML &&
        !!document.querySelector("svg > style > g") &&
        !!document.querySelector("svg > textarea > g"),
    ],
    // The escaped variants are the serialized literals asserted in markup_roots.rs.
    ...["svg", "math"].flatMap((root) =>
      ["style", "script"].flatMap((tag) => {
        const shape = (/** @type {string} */ text) =>
          `<${root}><${tag}${tag === "script" ? ' type="text/plain"' : ""}>${text}</${tag}></${root}>`;
        return /** @type {typeof shapes} */ ([
          [
            `unescaped <${tag}> text in <${root}> opens a child and decodes a reference`,
            shape("a <g></g> &lt; &&"),
            () => {
              const element = document.body.firstElementChild?.firstElementChild;
              return element?.textContent === "a  < &&" && element.firstElementChild?.localName === "g";
            },
          ],
          [
            `escaped <${tag}> text in <${root}> is kept literally`,
            shape("a &lt;g>&lt;/g> &amp;lt; &amp;&amp;"),
            () => {
              const element = document.body.firstElementChild?.firstElementChild;
              return element?.textContent === "a <g></g> &lt; &&" && element.children.length === 0;
            },
          ],
        ]);
      }),
    ),
    ...["", ' color="red"'].map((attr) => /** @type {typeof shapes[number]} */ ([
      `a foreign <font>${attr || " without color"} ${attr ? "moves" : "keeps"} styles`,
      `<div><svg><font${attr}><style>g { fill: red }</style></font><style>g { fill: blue }</style></svg></div>`,
      ({ XHTML, markup }) => {
        const styles = [...document.querySelectorAll("style")];
        const expected = markup.includes(' color="red"') ? XHTML : "http://www.w3.org/2000/svg";
        return styles.length === 2 && styles.every((style) => style.namespaceURI === expected) &&
          styles[0].textContent === "g { fill: red }" && styles[1].textContent === "g { fill: blue }";
      },
    ])),
    [
      "an ordinary < in repeated HTML script data does not change how the following style parses",
      `<div><script type="text/plain">a < b</script><script type="text/plain">a < b</script><style>.card { & .title { color: red } }</style></div>`,
      ({ XHTML }) => {
        const scripts = [...document.querySelectorAll("div > script")];
        const style = document.querySelector("div > style");
        return scripts.length === 2 && scripts.every((script) => script.namespaceURI === XHTML && script.textContent === "a < b") &&
          style?.namespaceURI === XHTML && style.textContent === ".card { & .title { color: red } }";
      },
    ],
    [
      "a comparison does not make element markup in an HTML script into an element (refused by html!)",
      `<div><script type="text/plain">a < b<b>Draft</b></script></div>`,
      () => !document.querySelector("b") && document.querySelector("div > script")?.textContent === "a < b<b>Draft</b>",
    ],
    [
      "closing SVG between loop iterations makes the second style HTML's",
      `<div><svg><style>a &lt; b &amp;&amp; c</style></svg><style>a < b && c</style><svg></svg></div>`,
      ({ XHTML }) => {
        const [foreign, html] = [...document.querySelectorAll("style")];
        return foreign?.namespaceURI === "http://www.w3.org/2000/svg" && html?.namespaceURI === XHTML &&
          foreign.textContent === "a < b && c" && html.textContent === "a < b && c";
      },
    ],
    [
      "an element in a <title> in an <mi> is text (refused by html!)",
      `<p><math><mi><title><b>x</b></title></mi></math></p>`,
      () => !document.querySelector("b") && document.querySelector("mi > title")?.textContent === "<b>x</b>",
    ],
    [
      "an element in a <title> in an HTML <annotation-xml> is text (refused by html!)",
      `<p><math><annotation-xml encoding="text/html"><title><b>x</b></title></annotation-xml></math></p>`,
      () => !document.querySelector("b") && document.querySelector("annotation-xml > title")?.textContent === "<b>x</b>",
    ],
    [
      "a <div> in an <mrow> lands outside the <math> (refused by html!)",
      `<p><math><mrow><div>x</div></mrow></math></p>`,
      () => !!document.querySelector("div") && !document.querySelector("math div"),
    ],
    [
      "a <div> in an <annotation-xml> without an encoding lands outside the <math> (refused by html!)",
      `<p><math><annotation-xml><div>x</div></annotation-xml></math></p>`,
      () => !!document.querySelector("div") && !document.querySelector("math div"),
    ],
    [
      "a <div> in an <annotation-xml> with a MathML encoding lands outside the <math> (refused by html!)",
      `<p><math><annotation-xml encoding="application/mathml+xml"><div>x</div></annotation-xml></math></p>`,
      () => !!document.querySelector("div") && !document.querySelector("math div"),
    ],
    [
      "a <div> in an <annotation-xml> whose first encoding is not HTML's lands outside the <math> (refused by html!)",
      `<p><math><annotation-xml encoding="x" encoding="text/html"><div>x</div></annotation-xml></math></p>`,
      () => !!document.querySelector("div") && !document.querySelector("math div"),
    ],
    [
      "a <p> in an <svg> lands outside it (refused by html!)",
      `<div><svg><rect width="4" height="4"></rect><p>Total</p></svg></div>`,
      () => !!document.querySelector("p") && !document.querySelector("svg p"),
    ],
    [
      "a block through phrasing content closes its paragraph (refused by html!)",
      `<p data-scope="root"><span><div data-ref="detail">Detail</div></span></p>`,
      () => !!document.querySelector("[data-ref=detail]") && !document.querySelector("[data-scope=root] [data-ref=detail]"),
    ],
    [
      "a nested li without a list between closes the earlier item (refused by html!)",
      `<ul><li id="outer"><span><li id="inner">Next</li></span></li></ul>`,
      () => !!document.querySelector("ul > #inner") && !document.querySelector("#outer #inner"),
    ],
    [
      "a nested definition closes the term (refused by html!)",
      `<dl><dt id="term"><dd id="definition">Meaning</dd></dt></dl>`,
      () => !!document.querySelector("dl > #definition") && !document.querySelector("#term #definition"),
    ],
    [
      "a nested anchor closes the active anchor (refused by html!)",
      `<div><a href="#one"><span><a href="#two">Two</a></span></a></div>`,
      () => document.querySelectorAll("a").length === 2 && !document.querySelector("a a"),
    ],
    [
      "a nested form start tag is ignored (not refused by html!: no markup shows it is outside every template)",
      `<div><form id="outer"><div><form id="inner"><input></form></div></form></div>`,
      () => !!document.querySelector("#outer") && !document.querySelector("#inner"),
    ],
    [
      "a nested button closes the earlier button (refused by html!)",
      `<div><button id="outer"><span><button id="inner">Again</button></span></button></div>`,
      () => !!document.querySelector("div > #inner") && !document.querySelector("#outer #inner"),
    ],
    [
      "a directly nested heading closes the earlier heading (refused by html!)",
      `<h1 id="outer"><h2 id="inner">Heading</h2></h1>`,
      () => !!document.querySelector("body > #inner") && !document.querySelector("#outer #inner"),
    ],
    [
      "a nested nobr in scope closes the earlier nobr (refused by html!)",
      `<div><nobr id="outer"><span><nobr id="inner">Text</nobr></span></nobr></div>`,
      () => !!document.querySelector("#inner") && !document.querySelector("#outer #inner"),
    ],
    [
      "list, button, formatting and foreign-content boundaries keep the nested content",
      `<div><ul><li><ul><li id="item">Nested</li></ul></li></ul><p><button><div id="block">Button</div></button></p><a><object><a id="link">Link</a></object></a><p><svg><foreignObject><div id="drawing">HTML</div></foreignObject></svg></p></div>`,
      () => !!document.querySelector("li li#item") && !!document.querySelector("p button #block") && !!document.querySelector("a object a#link") && !!document.querySelector("p svg foreignObject #drawing"),
    ],
    [
        "a caption's formatting marker separates its anchor from one around the table",
        `<div><a href="#outer"><table><caption><a id="caption-link" href="#inner">Caption</a></caption></table></a></div>`,
        () => !!document.querySelector("a table caption a#caption-link"),
      ],
      [
      "a form in a template is independent of the outer form",
      `<div><form><template><form id="inner"><input></form></template></form></div>`,
      () => !!document.querySelector("template")?.content.querySelector("form#inner"),
    ],
    [
        "an input closes a select in scope (refused by html!)",
        `<div><select id="outer"><input id="inner"></select></div>`,
        () => !!document.querySelector("#inner") && !document.querySelector("#outer #inner"),
      ],
      [
        "a nested select is ignored and closes the earlier select (refused by html!)",
        `<div><select id="outer"><select id="inner"></select><option id="after">After</option></select></div>`,
        () => !document.querySelector("#inner") && !!document.querySelector("#after") && !document.querySelector("#outer #after"),
      ],
      [
        "an option start ends the current option (refused by html!)",
        `<div><select><option id="outer"><option id="inner">Next</option></option></select></div>`,
        () => !!document.querySelector("select > #inner") && !document.querySelector("#outer #inner"),
      ],
      [
        "an optgroup start ends the current optgroup in select scope (refused by html!)",
        `<div><select><optgroup id="outer" label="One"><optgroup id="inner" label="Two"></optgroup></optgroup></select></div>`,
        () => !!document.querySelector("select > #inner") && !document.querySelector("#outer #inner"),
      ],
      [
        "an hr ends the current option in select scope (refused by html!)",
        `<div><select><option id="outer">Choice<hr id="inner"></option></select></div>`,
        () => !!document.querySelector("select > #inner") && !document.querySelector("#outer #inner"),
      ],
      [
        "a ruby reading ends the current reading (refused by html!)",
        `<div><ruby>Base<rt id="outer"><rt id="inner">Reading</rt></rt></ruby></div>`,
        () => !!document.querySelector("ruby > #inner") && !document.querySelector("#outer #inner"),
      ],
      [
        "a ruby base ends the current rtc (refused by html!)",
        `<div><ruby><rtc id="outer"><rb id="inner">Base</rb></rtc></ruby></div>`,
        () => !!document.querySelector("ruby > #inner") && !document.querySelector("#outer #inner"),
      ],
      [
        "an option in an optgroup, a reading in an rtc and optgroups outside select keep their parent",
        `<div><select><optgroup id="group" label="Group"><option id="choice">Choice</option></optgroup></select><ruby>Base<rtc id="rtc"><rt id="reading">Reading</rt></rtc></ruby><optgroup id="outer" label="Outside"><optgroup id="inner" label="Still outside"></optgroup></optgroup></div>`,
        () => !!document.querySelector("#group > #choice") && !!document.querySelector("#rtc > #reading") && !!document.querySelector("#outer > #inner"),
      ],
      [
      "duplicate attributes keep the first even when the names differ in case (refused by html!)",
      `<input name="first" NAME="second">`,
      () => document.querySelector("input")?.name === "first",
    ],
    // Each nesting rule html! refuses (crates/corten-macros/src/html/nesting.rs), for every tag
    // it names: the browser takes #inner out of #outer, or drops it, in each engine.
    ...refusedNesting().map(([around, outer, between, inner]) => {
      const tag = (name, id) => `<${name}${id ? ` id="${id}"` : ""}${name === "optgroup" ? ' label="g"' : ""}>`;
      const end = (name) => (["hr", "input"].includes(name) ? "" : `</${name}>`);
      const markup =
        around.map((n) => tag(n)).join("") +
        tag(outer, "outer") +
        (between ? tag(between) : "") +
        `${tag(inner, "inner")}x${end(inner)}` +
        (between ? end(between) : "") +
        end(outer) +
        [...around].reverse().map(end).join("");
      return /** @type {[string, string, () => boolean]} */ ([
        `<${inner}> in <${outer}>${between ? ` through <${between}>` : ""} leaves it (refused by html!)`,
        markup,
        () => {
          const outer = document.getElementById("outer");
          const inner = document.getElementById("inner");
          return !!outer && !(inner && outer.contains(inner));
        },
      ]);
    }),
    // A template's content and a foreign element's start with nothing open in html!'s check:
    // browsers keep these, so it must not refuse them.
    ...[
      ["svg", "foreignObject"],
      ["svg", "title"],
      ["svg", "desc"],
      ["math", "mtext"],
      ["math", "mi"],
    ].map(([foreign, point]) => /** @type {[string, string, () => boolean]} */ ([
      `an <a> in a <${point}> in an <${foreign}> in an <a> stays there`,
      `<div><a id="outer"><${foreign}><${point}><a id="inner">Link</a></${point}></${foreign}></a></div>`,
      () => !!document.getElementById("outer")?.contains(document.getElementById("inner")),
    ])),
    [
      "a form in a form in a root template stays there",
      `<template id="forms"><div><form id="outer"><form id="inner"><input></form></form></div></template>`,
      () => !!(/** @type {HTMLTemplateElement | null} */ (document.getElementById("forms")))?.content.querySelector("#outer > #inner"),
    ],
    // html! refuses nothing across what its markup does not show: an expression or a component
    // between the two elements may write a boundary, as `raw` does here, or an <svg> or <math>
    // root may land in the other one. Browsers keep each inner element in its outer one
    // (crates/corten/tests/markup_roots.rs).
    ...[
      `<p id="outer"><button><div id="inner">Detail</div></button></p>`,
      `<ul><li id="outer"><ul><li id="inner">x</li></ul></li></ul>`,
      `<dl><dt id="outer"><dl><dd id="inner">x</dd></dl></dt></dl>`,
      `<div><a id="outer" href="#one"><object><a id="inner" href="#two">x</a></object></a></div>`,
      `<div><button id="outer"><object><button id="inner">x</button></object></button></div>`,
      `<div><nobr id="outer"><object><nobr id="inner">x</nobr></object></nobr></div>`,
      `<h1 id="outer"><span><h2 id="inner">x</h2></span></h1>`,
      `<div><select id="outer"><object><input id="inner"></object></select></div>`,
      `<div><select id="outer"><object><select id="inner"></select></object></select></div>`,
      `<div><select><option id="outer"><span><option id="inner">x</option></span></option></select></div>`,
      `<div><select><optgroup id="outer" label="g"><span><optgroup id="inner" label="h"></optgroup></span></optgroup></select></div>`,
      `<div><select><option id="outer">Choice<span><hr id="inner"></span></option></select></div>`,
      `<div><ruby>Base<rt id="outer"><ruby><rt id="inner">x</rt></ruby></rt></ruby></div>`,
      `<div><ruby><rtc id="outer"><ruby><rb id="inner">x</rb></ruby></rtc></ruby></div>`,
      `<div><a id="outer" href="#one"><svg><foreignObject><a id="inner" href="#two">Link</a></foreignObject></svg></a></div>`,
      `<svg><math><mtext><a id="outer" href="#one"><a id="inner" href="#two">Link</a></a></mtext></math></svg>`,
      `<math><mrow><svg><title><a id="outer" href="#one"><a id="inner" href="#two">Link</a></a></title></svg></mrow></math>`,
    ].map((markup) => /** @type {[string, string, () => boolean]} */ ([
      `an element stays in its outer one across a boundary html! does not see: ${markup}`,
      markup,
      () => !!document.getElementById("outer")?.contains(document.getElementById("inner")),
    ])),
    ...[
      `<div><a href="#one"><template id="content"><a id="inner" href="#two">Link</a></template></a></div>`,
      `<main><template id="content"><form id="outer"><form id="inner"><input></form></form></template></main>`,
      // A <script> whose literal text holds `</script><template><script>`, as html! writes it.
      `<main><script></script><template id="content"><script></script><form id="outer"><form id="inner"><input></form></form></template></main>`,
    ].map((markup) => /** @type {[string, string, () => boolean]} */ ([
      `an element stays in a template written where html! does not see it: ${markup}`,
      markup,
      () => {
        const content = /** @type {HTMLTemplateElement | null} */ (document.getElementById("content"))?.content;
        const inner = content?.querySelector("#inner");
        return !!inner && (!content?.querySelector("#outer") || !!content.querySelector("#outer > #inner"));
      },
    ])),
    // html! writes a <script>'s or <style>'s literal text as is, so `</script>` in it ends the
    // element and what follows is markup html! does not see (crates/corten/tests/markup_roots.rs).
    ...[
      `<p id="outer"><script></script><button><script></script><div id="inner">Detail</div></button></p>`,
      `<p id="outer"><style></style><button><style></style><div id="inner">Detail</div></button></p>`,
      `<div><script></script><svg><script></script><textarea id="outer"><g id="inner"></g></textarea></svg></div>`,
    ].map((markup) => /** @type {[string, string, () => boolean]} */ ([
      `an element stays in its outer one after a script whose text html! writes as is: ${markup}`,
      markup,
      () => !!document.getElementById("outer")?.contains(document.getElementById("inner")),
    ])),
    // After a script left open (its text holds `<!--<script>`, or `raw` or a component opened
    // it), what follows is its text until a second `</script>`, and a component named `Corten`
    // may write a boundary: html! refuses nothing after either, and browsers serialize each back
    // as written (crates/corten/tests/markup_roots.rs).
    ...[
      `<div><script type="text/x-template"><!--<script></script><svg><div>Detail</div></svg></script></div>`,
      `<div><script type="text/x-template"><!--<script></script><p><div>Detail</div></p></script></div>`,
      `<div><script type="text/x-template"><!--<script></script><div><textarea><g></g></textarea></div></script></div>`,
      `<div><script type="text/x-template"><svg><div>Detail</div></svg></script></div>`,
      `<div><script type="text/x-template"><p><div>Detail</div></p></script></div>`,
      `<div><script type="text/x-template"><template><p><div>Detail</div></p></template></script></div>`,
      `<div><script type="text/x-template"><div><textarea><g></g></textarea></div></script></div>`,
      `<div><script type="text/x-template"><svg><foreignObject><p><div>Detail</div></p></foreignObject></svg></script></div>`,
      `<p><span></span><button><span></span><div>Detail</div></button></p>`,
    ].map((markup) => /** @type {[string, string, (page: { markup: string }) => boolean]} */ ([
      `a browser keeps markup after unseen output as written: ${markup}`,
      markup,
      // Run in the page: the markup it was given comes in the argument.
      ({ markup }) => document.body.innerHTML === markup,
    ])),
    // An element a browser parsing HTML reads as text, written where html! does not see that it
    // is HTML's (the top of a component's markup), may hold text: html! reads nothing in it for a
    // refusal, and a <noscript>'s nowhere (text with scripting on). Browsers keep each as written
    // (crates/corten/tests/markup_roots.rs).
    ...[
      ...["iframe", "noscript", "xmp", "noembed", "noframes", "style", "script"].map((holder) => `<${holder}><p><div>Detail</div></p></${holder}>`),
      `<div><noscript><p><div>Detail</div></p></noscript></div>`,
    ]
      .map((markup) => /** @type {[string, string, (page: { markup: string }) => boolean]} */ ([
        `a browser reads what a text element holds as text: ${markup}`,
        markup,
        ({ markup }) => document.body.innerHTML === markup,
      ])),
    // A <textarea> and a <title> serialize their text escaped, so their text is compared, at the
    // top and in an <svg>'s <foreignObject> whose <svg> html! does not place.
    ...[
      `<textarea id="held"><p><div>Detail</div></p></textarea>`,
      `<title id="held"><p><div>Detail</div></p></title>`,
      `<svg><foreignObject><textarea id="held"><p><div>Detail</div></p></textarea></foreignObject></svg>`,
    ].map((markup) => /** @type {[string, string, () => boolean]} */ ([
      `a browser reads what a text element holds as text: ${markup}`,
      markup,
      () => document.getElementById("held")?.textContent === "<p><div>Detail</div></p>",
    ])),
  ];
  for (const [name, markup, keeps] of shapes) {
    await page.setContent(`<!DOCTYPE html><html><head><title>Shapes</title></head><body>${markup}</body></html>`);
    check(`html! markup: ${name}`, await page.evaluate(keeps, { MATHML, XHTML, markup }), markup);
  }
  await context.close();
}

/**
 * The nestings html! refuses, as [around, outer, between, inner]: `inner` written in `outer`
 * (through `between` when given), inside the `around` elements.
 * @returns {[string[], string, string, string][]}
 */
function refusedNesting() {
  /** @type {[string[], string, string, string][]} */
  const shapes = [];
  // Start tags that close a <p> in button scope (nesting.rs CLOSE_P).
  const closesP = ["address", "article", "aside", "blockquote", "center", "details", "dialog", "dir", "div", "dl", "fieldset", "figcaption", "figure", "footer", "header", "hgroup", "main", "menu", "nav", "ol", "p", "search", "section", "summary", "ul", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "listing", "form", "li", "dd", "dt", "plaintext", "hr", "xmp"];
  for (const inner of closesP) shapes.push([["div"], "p", "span", inner]);
  shapes.push([["ul"], "li", "span", "li"], [["ul"], "li", "div", "li"], [["dl"], "dt", "div", "dd"]);
  for (const outer of ["dd", "dt"]) for (const inner of ["dd", "dt"]) shapes.push([["dl"], outer, "", inner]);
  for (const name of ["a", "button", "nobr"]) for (const between of ["span", "div"]) shapes.push([["div"], name, between, name]);
  const headings = ["h1", "h2", "h3", "h4", "h5", "h6"];
  for (const outer of headings) for (const inner of headings) shapes.push([["div"], outer, "", inner]);
  shapes.push([["div"], "select", "option", "input"], [["div"], "select", "option", "select"]);
  for (const outer of ["option", "optgroup"])
    for (const inner of ["option", "optgroup", "hr"]) if (!(outer === "optgroup" && inner === "option")) shapes.push([["div", "select"], outer, "", inner]);
  shapes.push([["div"], "option", "", "option"], [["div"], "option", "", "optgroup"]);
  const ruby = ["rb", "rtc", "rp", "rt"];
  for (const outer of ruby) for (const inner of ruby) if (!(outer === "rtc" && ["rp", "rt"].includes(inner))) shapes.push([["div", "ruby"], outer, "", inner]);
  shapes.push([["div", "ruby"], "p", "", "rt"]);
  return shapes;
}

export async function patchParsing(browser) {
  await parsesAsHtmlMeans(browser);
}

export async function patchFixtures(page, browser) {
  // The runtime parses a patch as a <template>'s content (`parse`), where the first top-level
  // element decides how the rest is read: what each engine keeps of the shapes the server's debug
  // check (`patch_parse`) is held to, the leading head tags Chromium and WebKit let decide
  // included, and of the shapes `html!` refuses, after each table part a patch may begin with.
  {
    /** @type {{ cases: { html: string, parsed: string[], parsedIn?: Record<string, string[]> }[] }} */
    const { cases } = JSON.parse(readFileSync(new URL("../../crates/corten/src/patch-parsing.json", import.meta.url), "utf8"));
    const parsed = await page.evaluate(
      (cases) =>
        cases.map((html) => {
          const template = document.createElement("template");
          template.innerHTML = /** @type {any} */ (window).__html(html);
          /** @param {Element} el @returns {string} */
          const show = (el) => {
            const name = el.localName + (el.id ? `#${el.id}` : "");
            if (el instanceof HTMLTemplateElement) return `${name}{${Array.from(el.content.children, show).join(",")}}`;
            return el.children.length ? `${name}(${Array.from(el.children, show).join(",")})` : name;
          };
          return Array.from(template.content.children, show);
        }),
      cases.map((c) => c.html),
    );
    const differ = cases.flatMap((c, i) => {
      const want = c.parsedIn?.[engine] ?? c.parsed;
      return JSON.stringify(parsed[i]) === JSON.stringify(want) ? [] : [`${c.html} => ${JSON.stringify(parsed[i])}`];
    });
    check(`a patch's top level parses as patch-parsing.json says, in ${cases.length} shapes`, !differ.length, differ.join("; "));
  }
  const markupCases = await checkMarkupScanner(browser);
  check(`the developer markup fixture agrees with the browser in ${markupCases} cases`, true);
  const cssCases = await checkCssScanner(browser);
  check(`the stylesheet fixture agrees with the browser in ${cssCases} cases`, true);
  // Patches generated from a fixed seed (`patch-generated.json`, which html.rs's
  // `generated_patches_carry_the_check_s_verdict` writes with the debug check's verdict on each):
  // the shapes above composed with the tokens the check has been found to misread. The check
  // reports a loss only in an engine that parses the patch otherwise than as written, and where
  // one does, the check reports a loss in it or says where it stopped. Text counts here (a `"`,
  // first for the patch's own top level), as anything but ASCII whitespace; and the id check
  // (`patch_problem`) reports an element without an id or text outside one only where the
  // engine's parse has one at its top level, or loses something.
  {
    /** @type {{ cases: [string, string[], string, boolean, boolean][] }} */
    const { cases } = JSON.parse(readFileSync(new URL("../patch-generated.json", import.meta.url), "utf8"));
    const parsed = await page.evaluate(
      (cases) =>
        cases.map((html) => {
          const template = document.createElement("template");
          template.innerHTML = /** @type {any} */ (window).__html(html);
          /** @param {Node} node */
          const text = (node) => (Array.from(node.childNodes).some((c) => c.nodeType === Node.TEXT_NODE && /[^\t\n\f\r ]/.test(/** @type {Text} */ (c).data)) ? '"' : "");
          /** @param {Element} el @returns {string} */
          const show = (el) => {
            const name = el.localName + (el.id ? `#${el.id}` : "");
            if (el instanceof HTMLTemplateElement) return `${name}${text(el.content)}{${Array.from(el.content.children, show).join(",")}}`;
            return name + text(el) + (el.children.length ? `(${Array.from(el.children, show).join(",")})` : "");
          };
          const top = text(template.content) ? ['"'] : [];
          const idless = !!top.length || Array.from(template.content.children).some((el) => !el.id);
          return { shown: [...top, ...Array.from(template.content.children, show)].join(" "), idless };
        }),
      cases.map((c) => c[0]),
    );
    const wrong = cases.flatMap(([html, written, lost, stops, idless], i) => {
      const differs = parsed[i].shown !== written.join(" ");
      const reported = lost === "all" || lost.split(" ").includes(engine);
      if (reported && !differs) return [`${html}: the check reports a loss, and ${engine} keeps it as written`];
      if (differs && !reported && !stops) return [`${html} => ${parsed[i].shown}: ${engine} loses part of it, and the check passes it`];
      if (idless && !parsed[i].idless && !differs) return [`${html}: the id check reports what ${engine} parses with an id at its top level`];
      return [];
    });
    check(`the patch parse check's verdicts hold in ${cases.length} generated patches`, !wrong.length, wrong.slice(0, 5).join("; "));
  }
}
