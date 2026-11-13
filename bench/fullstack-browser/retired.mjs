// Reads the retained native node, never reattaches it or builds oracle markup.
// Visibility checks belong to the connected-page reader; detached nodes are not visible.
export function readRetiredDOM(root, metadata) {
  if (root.isConnected || !root.matches("article.marketplace")) throw new Error("Expected the actual detached marketplace root");
  const norm = (s) => s.replace(/[\u00a0\u202f]/g, " ").replace(/[\t\n\r\f ]+/g, " ").trim();
  const q = (selector) => { const nodes = root.querySelectorAll(selector); if (nodes.length !== 1) throw new Error(`Retired ${selector}: expected one, got ${nodes.length}`); return nodes[0]; };
  const texts = (selector) => [...root.querySelectorAll(selector)].map((node) => norm(node.textContent));
  const rows = (selector, attribute) => [...q(selector).querySelectorAll("tbody tr")].map((row) => ({ id: row.getAttribute(attribute), cells: [...row.querySelectorAll("td")].map((cell) => norm(cell.textContent)) }));
  const links = (selector) => [...q(selector).querySelectorAll("ul li")].map((node) => {
    const anchors = node.querySelectorAll("a"); if (anchors.length !== 1) throw new Error("Retired related link is ambiguous");
    return { href: anchors[0].getAttribute("href"), text: norm(node.textContent) };
  });
  const label = (name) => {
    const input = q(`[name="${name}"]`), owner = [...root.querySelectorAll("label")].find((node) => node.contains(input) || node.htmlFor && node.htmlFor === input.id);
    if (!owner) throw new Error(`Retired ${name} label absent`);
    const copy = owner.cloneNode(true); copy.querySelectorAll("input,select").forEach((node) => node.remove()); return norm(copy.textContent);
  };
  const filter = q(".marketplace__listings form"), form = q(".marketplace__alert form");
  if (new URL(form.action).pathname !== metadata.path) throw new Error("Retired native form action changed");
  const react = Object.keys(form).find((key) => key.startsWith("__reactProps$"));
  const vue = Object.getOwnPropertySymbols(form).find((key) => key.description === "_vei");
  const enhanced = typeof form[react]?.onSubmit === "function" || typeof form[vue]?.onSubmit?.value === "function"
    || [...form.attributes].some((attribute) => attribute.name.startsWith("wire:submit"));
  const wire = [...root.querySelectorAll("[wire\\:id]")]; if (root.hasAttribute("wire:id")) wire.push(root);
  const ancestor = root.parentElement?.closest("[wire\\:id]"); if (ancestor) wire.push(ancestor);
  const fields = q(".marketplace__details dl"), names = [...fields.querySelectorAll("dt")], values = [...fields.querySelectorAll("dd")];
  if (names.length !== values.length) throw new Error("Retired details are unpaired");
  return { path: metadata.path, error: null, components: [...new Set(wire.map((node) => node.getAttribute("wire:id")))],
    enhancementUnavailable: enhanced,
    form: { method: form.method.toUpperCase(), action: new URL(form.action).pathname, fields: [...form.elements].map((node) => node.name).filter(Boolean), enhancement: null },
    page: { locale: metadata.locale, title: norm(q("h1").textContent), subtitle: root.querySelector(".marketplace__subtitle") ? norm(q(".marketplace__subtitle").textContent) : null,
      categories: texts(".marketplace__categories a"), badges: texts(".marketplace__badges li"),
      images: [...root.querySelectorAll(".marketplace__image")].map((node) => ({ src: node.getAttribute("data-src"), label: norm(node.getAttribute("aria-label")) })),
      summary: texts(".marketplace__summary > span"), headings: texts("section h2"), listingHeaders: texts(".marketplace__listings thead th"), listings: rows(".marketplace__listings table", "data-listing-id"),
      offerHeaders: texts(".marketplace__offers thead th"), offers: rows(".marketplace__offers table", "data-offer-id"), more: root.querySelector(".marketplace__more") ? norm(q(".marketplace__more").textContent) : null,
      controls: { filterLabel: label("seller"), sortLabel: label("sort"), emailLabel: label("email"), targetLabel: label("target_price"), apply: norm(filter.querySelector('[type="submit"]').textContent),
        submit: norm(form.querySelector('[type="submit"]').textContent), options: [...q('[name="sort"]').options].map((option) => norm(option.textContent)) },
      description: norm(q(".marketplace__details > p").textContent), fields: names.map((name, i) => ({ name: norm(name.textContent), value: norm(values[i].textContent) })), tags: texts(".marketplace__details > ul li"),
      contents: links(".marketplace__contents"), included: links(".marketplace__included"), message: norm(q(".marketplace__message").textContent) },
  };
}
