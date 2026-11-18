// Browser oracle for the developer scanner's Rust test. The fixture has two lenses:
// walk all start elements (even template contents), then walk only live DOM for forms.
import { deepStrictEqual } from "node:assert";
import { readFileSync } from "node:fs";

const cases = JSON.parse(readFileSync(new URL("../crates/corten/src/html/scan-cases.json", import.meta.url), "utf8"));

export async function checkMarkupScanner(browser) {
  const page = await browser.newPage();
  try {
    for (const { name, html, patch = false, scripting = false, tags, browserTags, closedShadowHost, hint = false, key = false, idless = false } of cases) {
      const documentHtml = "<!doctype html><html><head></head><body>" + html;
      if (scripting) await page.setContent(documentHtml);
      const got = await page.evaluate(({ html, documentHtml, patch, scripting, closedShadowHost }) => {
        let written;
        let live;
        if (patch) {
          const template = document.createElement("template");
          template.innerHTML = html;
          written = live = template.content;
        } else if (scripting) {
          written = live = document.body;
        } else {
          // DOMParser does not attach declarative roots; parseHTMLUnsafe does.
          written = new DOMParser().parseFromString(documentHtml, "text/html").body;
          live = Document.parseHTMLUnsafe(documentHtml).body;
        }
        const closed = new Map();
        if (closedShadowHost) {
          const host = live.querySelector(`#${closedShadowHost}`);
          if (!host || host.shadowRoot || host.querySelector("template[shadowrootmode=closed]")) {
            throw new Error("expected the closed declarative template to attach to its host");
          }
          const serialized = document.createElement("template");
          serialized.innerHTML = host.getHTML({ serializableShadowRoots: true });
          const root = serialized.content.firstElementChild;
          if (!(root instanceof HTMLTemplateElement) || !root.matches("template[shadowrootmode=closed][shadowrootserializable]")) {
            throw new Error("expected an attached closed, serializable shadow root");
          }
          closed.set(host, root.content);
        }
        const shadow = (node) => node.shadowRoot ?? closed.get(node);
        const elements = (node, all) => Array.from(node.children).flatMap((el) => {
          const content = el instanceof HTMLTemplateElement ? (all ? el.content : null) : el;
          const root = !all && shadow(el);
          return [el, ...(content ? elements(content, all) : []), ...(root ? elements(root, false) : [])];
        });
        const tags = elements(written, true).map((el) => {
          const attrs = ["a", "data-submit", "data-vars", "id", "shadowrootmode"]
            .filter((attr) => el.hasAttribute(attr)).map((attr) => ` ${attr}=${el.getAttribute(attr)}`);
          return el.localName.toLowerCase() + attrs.join("");
        });
        const hasText = (node) => {
          if (node.nodeType === Node.TEXT_NODE) return /[^\t\n\f\r ]/.test(node.data);
          if (node instanceof HTMLTemplateElement || ["script", "style"].includes(node.localName)) return false;
          if (node.namespaceURI === "http://www.w3.org/1999/xhtml" &&
              ["title", "iframe", "noembed", "noframes", "noscript"].includes(node.localName)) return false;
          const root = shadow(node);
          return (root && hasText(root)) || Array.from(node.childNodes).some(hasText);
        };
        const pageElements = elements(live, false);
        const shown = pageElements.find((el) => el.id === "qty-hint");
        const control = pageElements.find((el) => el.id === "qty");
        return {
          tags,
          hint: Boolean(shown && hasText(shown) &&
            (control ? !control.getAttribute("aria-describedby")?.split(/\s+/).includes("qty-hint") : !patch)),
          key: !patch && pageElements.some((el) => el instanceof HTMLInputElement &&
            el.getAttribute("data-submit") === "" && !el.hasAttribute("value")),
          idless: patch && Array.from(live.childNodes).some((node) =>
            node.nodeType === Node.TEXT_NODE ? hasText(node) : node.nodeType === Node.ELEMENT_NODE && !node.id),
        };
      }, { html, documentHtml, patch, scripting, closedShadowHost });
      deepStrictEqual(got, { tags: browserTags ?? tags, hint, key, idless }, name);
    }
    return cases.length;
  } finally {
    await page.close();
  }
}
