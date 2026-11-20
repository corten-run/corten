import { readFileSync } from "node:fs";
import { shadowing, check } from "./helpers.mjs";

export async function viewHelpers(page, browser) {
  // The optional views helper, using its actual built bytes under the watchlist's CSP. This
  // fixture needs no app view class: the nested deck-builder smoke also uses generated classes.
  await page.route("**/smoke-views.js", (route) => route.fulfill({ contentType: "text/javascript", body:
    readFileSync(new URL("../../crates/corten/js/dist/view.js", import.meta.url), "utf8") + "\nexport { view, rows };\n",
  }));
  const branches = await page.evaluate(async () => {
    const { view } = await import("/smoke-views.js");
    class View { constructor(el) { this.el = el; } }
    const host = document.createElement("div");
    host.innerHTML = __html('<section id="smoke-branch-a"><label for="smoke-note">Note</label><input id="smoke-note" value="server"></section>');
    document.body.append(host);
    const template = document.createElement("template");
    template.innerHTML = __html(host.innerHTML);
    const ssr = host.firstElementChild;
    const input = host.querySelector("input");
    input.value = "draft";
    input.focus();
    const adopted = view(host, View, template).el === ssr && input.value === "draft" && document.activeElement === input;
    template.innerHTML = __html('<article id="smoke-branch-b" data-vars="--smoke-width:13px"><label for="smoke-export">Export</label><textarea id="smoke-export">text</textarea></article>');
    const branch = view(host, View, template).el;
    const copied = branch.id === "smoke-branch-b" && branch.querySelector("label").control === branch.querySelector("textarea") && branch.style.getPropertyValue("--smoke-width") === "13px";
    const external = branch.cloneNode(true);
    branch.replaceWith(external);
    const follows = view(host, View, template).el === external;
    const outside = document.createElement("div");
    outside.id = "smoke-outside";
    document.body.append(outside);
    let refused = 0;
    for (const html of [
      '<section id="smoke-new"><input id="smoke-outside"></section>',
      '<section id="smoke-new"><input id="smoke-twice"><input id="smoke-twice"></section>',
      '<section>no id</section>',
      '<section id="smoke-new"></section><p>extra root</p>',
      '<section id="smoke-new"><script></script></section>',
    ]) {
      template.innerHTML = __html(html);
      try { view(host, View, template); } catch { if (host.firstElementChild === external) refused++; }
    }
    outside.id = "smoke-export";
    template.innerHTML = __html('<section id="smoke-new"><input id="smoke-export"></section>');
    let rejectsHiddenCollision = false;
    try { view(host, View, template); } catch { rejectsHiddenCollision = host.firstElementChild === external; }
    host.remove(); outside.remove();
    return { adopted, copied, follows, refused, rejectsHiddenCollision };
  });
  check("view adopts SSR without replacing local state, focus or identity", branches.adopted);
  check("view clones a branch with intact label IDs and CSP-safe custom properties", branches.copied);
  check("view follows external replacement rather than a detached cache", branches.follows);
  check("view refuses ID collisions, malformed templates and scripts before removing the active tree", branches.refused === 5, JSON.stringify(branches));
  check("view refuses an outside ID even when the outgoing tree has the first match", branches.rejectsHiddenCollision);
  // Rows and a view's root that are forms with controls named after the members the helper reads
  // or calls on them (`<button name="remove">`, a hidden `id`, and the rest of `shadowing`).
  const formViews = await page.evaluate(async (names) => {
    const { view, rows } = await import("/smoke-views.js");
    const controls = names.map((name) => `<input type="hidden" name="${name}" value="x" disabled>`).join("");
    // As #[component(view)] writes a keyed view's class, with a hole on the root itself
    // (`data-selected={selected}`), which it reads and writes through Element's own.
    class Row {
      constructor(el) { this.el = el; }
      get selected() { return Element.prototype.hasAttribute.call(this.el, "data-selected"); }
      static fill(el, data) {
        if (Element.prototype.hasAttribute.call(el, "data-selected") !== data.s) Element.prototype.toggleAttribute.call(el, "data-selected", data.s);
      }
      static key(el) { return Element.prototype.getAttribute.call(el, "data-key") ?? ""; }
      static keyOf(data) { return String(data.k); }
    }
    const own = Element.prototype;
    const parent = document.createElement("div");
    parent.innerHTML = __html(["a", "b", "c"].map((k) => `<form data-key="${k}"><button name="remove">Remove</button><input type="hidden" name="id" value="${k}">${controls}</form>`).join(""));
    document.body.append(parent);
    let removed = "";
    try {
      const list = rows(parent, Row);
      const keys = () => Array.from(own.querySelectorAll.call(parent, "form"), (f) => own.getAttribute.call(f, "data-key")).join();
      list.remove(list.get("b"));
      const afterRemove = keys();
      list.replace([{ k: "c", s: true }, { k: "a", s: false }]);
      const reordered = keys();
      const selected = `${list.get("c")?.selected}/${list.get("a")?.selected}`;
      list.replace([{ k: "c", s: false }]);
      removed = `${afterRemove};${reordered};${selected};${keys()}`;
    } catch (error) {
      removed = String(error);
    }
    parent.remove();
    const host = document.createElement("div");
    document.body.append(host);
    const template = document.createElement("template");
    template.innerHTML = __html(`<form id="smoke-form-view" data-vars="--smoke-width:7px"><input type="hidden" name="id" value="1">${controls}</form>`);
    let viewed = "";
    try {
      const first = view(host, Row, template).el;
      const again = view(host, Row, template).el;
      // The form's own `style`: its control named style is `first.style`.
      const style = /** @type {CSSStyleDeclaration} */ (Reflect.get(HTMLElement.prototype, "style", first));
      viewed = String(first === again && own.getAttribute.call(first, "id") === "smoke-form-view" && style.getPropertyValue("--smoke-width") === "7px");
    } catch (error) {
      viewed = String(error);
    }
    host.remove();
    return { removed, viewed };
  }, [...shadowing, "id"]);
  check("rows() finds, removes, reorders, fills and drops rows that are forms with controls named remove, getAttribute and the like", formViews.removed === "a,c;c,a;true/false;c", formViews.removed);
  check("view() draws and adopts a root that is a form with controls named id, children and the like", formViews.viewed === "true", formViews.viewed);
  const formParent = await page.evaluate(async (names) => {
    const { view, rows } = await import("/smoke-views.js");
    const own = Element.prototype;
    const form = document.createElement("form");
    const template = document.createElement("template");
    template.innerHTML = __html('<span id="form-parent-branch">Branch</span>');
    document.body.append(form);
    // Associated controls outside the form shadow its members without becoming its rows.
    const controls = names.map((name) => {
      const input = document.createElement("input");
      input.name = name;
      input.setAttribute("form", "form-parent");
      document.body.append(input);
      return input;
    });
    form.id = "form-parent";
    class Row {
      constructor(el) { this.el = el; }
      static key(el) { return own.getAttribute.call(el, "data-key") ?? ""; }
      static keyOf(data) { return data.k; }
      static fill(el, data) { own.setAttribute.call(el, "data-key", data.k); }
    }
    try {
      const first = view(form, Row, template).el;
      const adopted = view(form, Row, template).el === first;
      template.innerHTML = __html('<span data-key="a">Row</span>');
      const list = rows(form, Row, template);
      list.replace([{ k: "a" }, { k: "b" }]);
      list.swap(0, 1);
      const moved = list.at(0)?.el && own.getAttribute.call(list.at(0).el, "data-key") === "b";
      list.clear();
      return adopted && moved && own.querySelectorAll.call(form, "*").length === 0;
    } finally {
      own.remove.call(form);
      for (const control of controls) control.remove();
    }
  }, shadowing);
  check("view() and rows() use a form host's DOM members past named associated controls", formParent);
  // Form rows with controls named parentNode and nextSibling: `of` walks up from a control inside
  // one (a walk through the form's own `parentNode` would never end, so this runs on its own page,
  // timed), from `window` and from a node of another realm; `swap` moves neighbors past one, and a
  // key a script changes is seen.
  {
    const walkPage = await browser.newPage();
    await walkPage.route("**/smoke-views.js", (route) => route.fulfill({ contentType: "text/javascript", body:
      readFileSync(new URL("../../crates/corten/js/dist/view.js", import.meta.url), "utf8") + "\nexport { view, rows };\n",
    }));
    await walkPage.goto(page.url());
    const walking = walkPage.evaluate(async (names) => {
      const { rows } = await import("/smoke-views.js");
      const controls = names.map((name) => `<input type="hidden" name="${name}" value="x" disabled>`).join("");
      class Row {
        constructor(el) { this.el = el; }
        static fill() {}
        static key(el) { return Element.prototype.getAttribute.call(el, "data-key") ?? ""; }
        static keyOf(data) { return String(data.k); }
      }
      const own = Element.prototype;
      const parent = document.createElement("div");
      parent.innerHTML = __html(["a", "b", "c"].map((k) => `<form data-key="${k}"><button name="remove">Remove</button>${controls}</form>`).join(""));
      document.body.append(parent);
      const frame = document.createElement("iframe");
      document.body.append(frame);
      try {
        const list = rows(parent, Row);
        const keys = () => Array.from(own.querySelectorAll.call(parent, "form"), (f) => own.getAttribute.call(f, "data-key")).join();
        const rowB = own.querySelector.call(parent, 'form[data-key="b"]');
        const found = list.of(own.querySelector.call(rowB, "button"))?.el === rowB && list.of(window) === undefined;
        // A row made in another document's realm and moved here.
        const other = /** @type {Document} */ (frame.contentDocument);
        const foreign = other.createElement("div");
        const button = other.createElement("button");
        foreign.append(button);
        parent.append(foreign);
        const realm = list.of(button)?.el === foreign;
        foreign.remove();
        list.swap(0, 1);
        const swapped = keys();
        list.swap(0, 1);
        const rowA = list.get("a")?.el;
        own.setAttribute.call(rowA, "data-key", "z");
        const rekeyed = list.get("z")?.el === rowA && list.get("a") === undefined;
        own.setAttribute.call(rowA, "data-key", "a");
        return `${found};${realm};${swapped};${keys()};${rekeyed}`;
      } catch (error) {
        return String(error);
      } finally {
        parent.remove();
        frame.remove();
      }
    }, [...shadowing, "parentNode", "nextSibling"]);
    const walked = await Promise.race([walking, new Promise((resolve) => setTimeout(() => resolve("timed out after 5 s"), 5000))]);
    await walkPage.close().catch(() => {});
    walking.catch(() => {});
    check("rows() finds a form row from inside it, swaps form rows and sees a changed key, with controls named parentNode and nextSibling", walked === "true;true;b,a,c;a,b,c;true", String(walked));
  }
}
