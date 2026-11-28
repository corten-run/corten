import { base, check } from "./helpers.mjs";

export async function handlerEncoding(page) {
  // `data-on` is single-quoted, so the JSON of a handler's arguments (here the feed's address and
  // the formats) goes in with its quotes as they are, and the watch above read them as written.
  {
    const served = await (await page.request.get(base)).text();
    const watched = /data-on='connect:live_prices\.watch\(([^']*)\)'/.exec(served)?.[1] ?? "";
    check(
      "data-on is single-quoted, its JSON's quotes as they are",
      watched.includes('"/feed/stocks"') && watched.includes('%{"z":') && !served.includes('data-on="') && !/data-on='[^']*&quot;/.test(served),
      watched.slice(0, 120),
    );
  }
}

export async function handlerArguments(browser) {
  // A handler is given its text and JSON arguments as the server had them, with an apostrophe
  // (`&#39;` in the single-quoted attribute), quotes, `&` and `<` in them, and so are the text and
  // the booleans elements give their refs (`ref={said.with(..)}`, `data-ref-value`, JSON read with
  // `JSON.parse`), in the page's order.
  {
    const quoted = await browser.newPage();
    await quoted.goto(`${base}/smoke/quoted`);
    const got = await quoted
      .waitForFunction(() => document.getElementById("quoted")?.textContent || null, undefined, { timeout: 5000 })
      .then((shown) => shown.jsonValue(), () => null);
    const served = await (await quoted.request.get(`${base}/smoke/quoted`)).text();
    const text = `It's "<b>" & more`;
    const written = `It&#39;s \\"&lt;b&gt;\\" &amp; more`;
    check(
      "a handler gets text and JSON arguments with an apostrophe, quotes, & and < in them as the server had them",
      got !== null &&
        JSON.stringify(JSON.parse(got).slice(0, 2)) === JSON.stringify([text, [text]]) &&
        served.includes(`data-on='connect:quoted.show($t,"${written}",["${written}"],=said,=held)'`),
      `${got} ${/data-on='[^']*'/.exec(served)?.[0] ?? "no data-on"}`,
    );
    check(
      "a handler gets the text and the booleans elements give their refs, an apostrophe, quotes, &, < and > in the text, as the server had them",
      got !== null &&
        JSON.stringify(JSON.parse(got).slice(2)) === JSON.stringify([[text, "plain"], [true, false]]) &&
        served.includes(`<li data-ref="said" data-ref-value='"${written}"'>`) &&
        served.includes(`<li data-ref="held" data-ref-value='true'>`),
      `${got} ${/<li data-ref="said"[^>]*>/.exec(served)?.[0] ?? "no ref value"}`,
    );
    await quoted.close();
  }

  {
    const scoped = await browser.newPage();
    await scoped.goto(`${base}/smoke/scope`);
    const probes = scoped.locator("[data-scope-probe]");
    const names = await probes.evaluateAll((items) => items.map((p) => p.getAttribute("data-scope-probe")).join(","));
    check("the nested scope fixture has both inside and outside controls", names === "inside,section,outside,other", names);
    for (const [root, expected] of [
      ["hoisted", "inside,section"],
      ["subject", "inside,section"],
      ["ancestor", "section"],
      ["filtered", "inside,section"],
    ]) {
      const matched = await probes.evaluateAll(
        (probes, root) => probes.filter((p) => getComputedStyle(p).getPropertyValue(`--smoke-${root}-scope`) === "yes").map((p) => p.getAttribute("data-scope-probe")).join(","),
        root,
      );
      check(`the ${root} inner scope styles only its owned paragraphs`, matched === expected, matched);
    }
    await scoped.close();
  }
  // A handler given a form's fields (`js::fill(f.weight, ..)`) gets their controls when it runs,
  // found by name in its own form: a select, an input, a textarea, a checkbox, a radio group's
  // inputs and a row's field (`parcels[1].weight`), which a component with no refs draws. A call
  // whose form has no such control, or one of another kind, runs nothing and says which.
  {
    const shipped = await browser.newPage();
    /** @type {string[]} */
    const shipErrors = [];
    shipped.on("pageerror", (e) => shipErrors.push(e.message));
    await shipped.goto(`${base}/smoke/fields`);
    const served = await (await shipped.request.get(`${base}/smoke/fields`)).text();
    await shipped.selectOption('select[name="service"]', "air");
    const filled = await shipped
      .waitForFunction(() => document.querySelector("#ship-form output")?.textContent || null, undefined, { timeout: 5000 })
      .then(
        () =>
          shipped.evaluate(() => {
            const form = /** @type {HTMLFormElement} */ (document.getElementById("ship-form"));
            /** @param {string} name */
            const at = (name) => /** @type {HTMLInputElement} */ (form.querySelector(`[name="${name}"]`));
            const size = /** @type {HTMLInputElement | null} */ (form.querySelector('[name="size"]:checked'));
            return [form.querySelector("output")?.textContent, at("weight").value, at("note").value, at("gift").checked, size?.value, at("parcels[1].weight").value].join("|");
          }),
        () => null,
      );
    check(
      "a page whose handlers take a form field loads the field module",
      await shipped.evaluate(() => performance.getEntriesByType("resource").some((e) => /\/corten-field\.js(\?|$)/.test(e.name))),
    );
    check(
      "a handler gets a form's fields as their controls, each of the kind it takes, from the form it is in",
      filled === "select,input,textarea,input,input,small,large|2|by air|true|small|2" &&
        served.includes(`data-on='change:ship_form.fill(~s"service",~i"weight",~t"note",~i"gift",~*"size",~i"parcels[1].weight",@out)'`),
      `${filled} ${/data-on='change:[^']*'/.exec(served)?.[0] ?? "no data-on"}`,
    );
    for (const [name, field, has] of [["Weigh the note", "note", "its form has textarea"], ["Weigh elsewhere", "weight", "its form has none"]]) {
      const before = shipErrors.length;
      await shipped.getByRole("button", { name }).click();
      for (let waited = 0; shipErrors.length === before && waited < 5000; waited += 50) await shipped.waitForTimeout(50);
      // Long enough for a second report, which would be a fault.
      await shipped.waitForTimeout(100);
      const said = shipErrors.slice(before);
      check(
        `a call given a form field its form does not have as the handler takes it runs nothing and says why (${name.toLowerCase()})`,
        said.length === 1 && said[0].includes(`corten: ship_form.weigh takes field ${field} as one <input>, and ${has}`) && (await shipped.inputValue('#ship-form [name="weight"]')) === "2",
        said.join(" | "),
      );
    }
    // A button whose `form=` names no form belongs to none, as a submit has it, though a form is
    // around it: its field is not that form's, whose gift box would otherwise be given. (Its own
    // field, so its message differs from the last: WebKit folds a repeated one.)
    {
      const before = shipErrors.length;
      await shipped.evaluate(() => {
        // Built from elements, not markup: the page requires Trusted Types.
        const orphan = Object.assign(document.createElement("button"), { type: "button", id: "orphan", textContent: "Orphan" });
        orphan.setAttribute("form", "missing");
        orphan.setAttribute("data-on", 'click:ship_form.weigh(~i"gift")');
        document.getElementById("ship-form")?.append(orphan);
      });
      await shipped.click("#orphan");
      for (let waited = 0; shipErrors.length === before && waited < 5000; waited += 50) await shipped.waitForTimeout(50);
      await shipped.waitForTimeout(100);
      const said = shipErrors.slice(before);
      check(
        "a call from a control whose form= names no form is given none of the form around it",
        said.length === 1 && said[0].includes("corten: ship_form.weigh takes field gift as one <input>, and it is in no form") && (await shipped.inputValue('#ship-form [name="gift"]')) === "on",
        said.join(" | "),
      );
    }
    // The form a field is found in: the form itself for an `on:` on it, the one around a list (a
    // deck's lines), the one a button outside joins with `form=`, and the one around a label, not
    // the form of the control it labels, which `form=` joins to the first.
    {
      await shipped.dispatchEvent("#ship-form", "dblclick");
      await shipped.click("#ship-form ul li");
      await shipped.getByRole("button", { name: "Mark from outside" }).click();
      await shipped.getByText("Mark from the label").click();
      const marks = await shipped
        .waitForFunction(() => document.querySelectorAll("[data-form]").length === 4, undefined, { timeout: 5000 })
        .then(
          () => true,
          () => false,
        )
        .then(() =>
          shipped.evaluate(() =>
            ["#ship-form", "#ship-form ul", 'button[form="ship-form"]', "#label-form label"].map((at) => document.querySelector(at)?.getAttribute("data-form") ?? "none").join(","),
          ),
        );
      check(
        "a field is found in the form an on: is on, the one around a list, the one a control outside joins with form=, and the one around a label, not its control's",
        marks === "ship-form,ship-form,ship-form,label-form",
        marks,
      );
    }    // A form-associated custom element is a listed element too: its form= names its form, as a
    // control's does, so a field is found in that form, not in the one around it, nor in none
    // when no form is around it.
    {
      const faced = await shipped.evaluate(async () => {
        customElements.define(
          "smoke-control",
          class extends HTMLElement {
            static formAssociated = true;
          },
        );
        // Built from elements, not markup: the page requires Trusted Types.
        const other = Object.assign(document.createElement("form"), { id: "face-form" });
        other.append(Object.assign(document.createElement("input"), { name: "weight" }));
        document.body.append(other);
        const on = document.querySelector("#ship-form ul")?.getAttribute("data-on") ?? "";
        const controls = [document.createElement("smoke-control"), document.createElement("smoke-control")];
        for (const control of controls) {
          control.setAttribute("form", "face-form");
          control.setAttribute("data-on", on);
          control.textContent = "Mark";
        }
        document.getElementById("ship-form")?.append(controls[0]);
        document.body.append(controls[1]);
        for (const control of controls) control.click();
        for (let waited = 0; controls.some((c) => !c.hasAttribute("data-form")) && waited < 5000; waited += 50) await new Promise((done) => setTimeout(done, 50));
        return `${on.startsWith("click:") ? "" : `${on} `}${controls.map((c) => c.getAttribute("data-form") ?? "none").join(",")}`;
      });
      check("a field is found in the form a form-associated custom element's form= names, in a form or out of one", faced === "face-form,face-form", faced);
    }
    // A group no control of the form has is empty; one whose name is the form's select runs
    // nothing and says why.
    {
      await shipped.getByRole("button", { name: "Count extras" }).click();
      const before = shipErrors.length;
      await shipped.getByRole("button", { name: "Count services" }).click();
      for (let waited = 0; shipErrors.length === before && waited < 5000; waited += 50) await shipped.waitForTimeout(50);
      await shipped.waitForTimeout(100);
      const said = shipErrors.slice(before);
      const counts = await shipped.evaluate(() =>
        ["Count extras", "Count services"].map((name) => [...document.querySelectorAll("button")].find((b) => b.textContent === name)?.getAttribute("data-count") ?? "none").join(","),
      );
      check("a handler given a group no control of its form has gets []", counts.startsWith("0,"), counts);
      check(
        "a call given a group whose name is its form's select runs nothing and says why",
        counts.endsWith(",none") && said.length === 1 && said[0].includes("corten: ship_form.count takes field service as every <input>, and its form has select"),
        `${counts} ${said.join(" | ")}`,
      );
    }
    // The control is found each time the handler runs: one a patch replaced is the new one, and
    // the old one, gone from the page, is not touched. It is found by its name, not its id: an
    // element of the form whose id is the field's name (which the form's index of names also
    // holds) is not a second control of it.
    const replaced = await shipped.evaluate(async () => {
      const old = /** @type {HTMLInputElement} */ (document.querySelector('#ship-form [name="weight"]'));
      const fresh = Object.assign(document.createElement("input"), { name: "weight", value: "1" });
      old.replaceWith(fresh);
      fresh.after(Object.assign(document.createElement("output"), { id: "weight" }));
      const select = /** @type {HTMLSelectElement} */ (document.querySelector('#ship-form [name="service"]'));
      select.value = "ground";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((done) => setTimeout(done, 100));
      return `${fresh.value},${old.value}`;
    });
    check("a handler given a field gets the control its form has when it runs, not one a patch replaced, nor an element whose id is its name", replaced === "9,2", replaced);
    await shipped.close();
  }
}
