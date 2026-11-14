// Mixed DOM contract, derived from marketplace/check.mjs snapshotPage. Unlike
// marketplace's same-page wire protocol, mixed permits a discovered local action
// and an inline action response at another URL. Do not modify the captured DOM.
export function snapshotMixedPage({ readPath }) {
  const norm = (s) => s.replace(/[\u00a0\u202f]/g, " ").replace(/[\t\n\r\f ]+/g, " ").trim();
  const roots = document.querySelectorAll("main article.marketplace");
  if (roots.length !== 1) throw new Error(`expected one marketplace article, got ${roots.length}`);
  const root = roots[0];
  if (globalThis.marketplaceInjected) throw new Error("fixture executed script");
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (["script", "style"].includes(el.localName) || el.matches('input[type="hidden"]')) continue;
    const s = getComputedStyle(el);
    if (el.hidden || el.localName === "template" || el.getAttribute("aria-hidden") === "true" || s.display === "none" || s.visibility !== "visible" || Number(s.opacity) === 0) throw new Error(`hidden work: ${el.localName}`);
  }
  const q = (s) => { const nodes = root.querySelectorAll(s); if (nodes.length !== 1) throw new Error(`${s}: expected one, got ${nodes.length}`); return nodes[0]; };
  const texts = (s) => [...root.querySelectorAll(s)].map((v) => norm(v.textContent));
  const rows = (s, attr) => [...q(s).querySelectorAll("tbody tr")].map((v) => ({ id: v.getAttribute(attr), cells: [...v.querySelectorAll("td")].map((c) => norm(c.textContent)) }));
  const links = (s) => [...q(s).querySelectorAll("ul li")].map((v) => { const a = v.querySelectorAll("a"); if (a.length !== 1) throw new Error("expected one related link"); return { href: a[0].getAttribute("href"), text: norm(v.textContent) }; });
  const message = q(".marketplace__message"), subtitle = root.querySelector(".marketplace__subtitle"), fields = q(".marketplace__details dl");
  const names = [...fields.querySelectorAll("dt")], values = [...fields.querySelectorAll("dd")];
  if (names.length !== values.length) throw new Error("unpaired fields");
  for (const s of [".marketplace__badges", ".marketplace__images", ".marketplace__details > ul"]) q(s);
  for (const control of root.querySelectorAll("input:not([type=hidden]),select,button")) {
    if (control.disabled || control.readOnly) throw new Error("disabled control");
    if (control.matches("input,select") && ![...root.querySelectorAll("label")].some((l) => l.contains(control) || l.htmlFor && l.htmlFor === control.id)) throw new Error(`unlabelled ${control.name}`);
  }
  const controlLabel = (name) => {
    const control = q(`[name="${name}"]`), label = [...root.querySelectorAll("label")].find((l) => l.contains(control) || l.htmlFor && l.htmlFor === control.id);
    const clone = label.cloneNode(true); clone.querySelectorAll("input,select").forEach((el) => el.remove()); return norm(clone.textContent);
  };
  const filter = q(".marketplace__listings form"), alert = q(".marketplace__alert form");
  if (filter.method !== "get" || alert.method !== "post") throw new Error("native GET/POST methods required");
  for (const form of [filter, alert]) {
    const url = new URL(form.action);
    if (url.origin !== location.origin || url.username || url.password || url.hash || !/^\/(?!\/)[^?#\\\s]+$/.test(url.pathname)) throw new Error("nonlocal native action");
  }
  if (new URL(filter.action).pathname !== readPath) throw new Error("filter action must retain locale and record");
  if (q('[name="email"]').type !== "email" || q('[name="target_price"]').type !== "text" || q('[name="target_price"]').inputMode !== "decimal") throw new Error("input semantics");
  return {
    locale: document.documentElement.lang, title: norm(q("h1").textContent), subtitle: subtitle ? norm(subtitle.textContent) : null,
    categories: texts(".marketplace__categories a"), badges: texts(".marketplace__badges li"),
    images: [...root.querySelectorAll(".marketplace__image")].map((v) => { if (v.getAttribute("role") !== "img") throw new Error("image role"); return { src: v.getAttribute("data-src"), label: norm(v.getAttribute("aria-label")) }; }),
    summary: texts(".marketplace__summary > span"), headings: texts("section h2"), listingHeaders: texts(".marketplace__listings thead th"),
    listings: rows(".marketplace__listings table", "data-listing-id"), offerHeaders: texts(".marketplace__offers thead th"), offers: rows(".marketplace__offers table", "data-offer-id"),
    more: root.querySelector(".marketplace__more") ? norm(root.querySelector(".marketplace__more").textContent) : null,
    controls: { filterLabel: controlLabel("seller"), sortLabel: controlLabel("sort"), emailLabel: controlLabel("email"), targetLabel: controlLabel("target_price"), apply: norm(filter.querySelector('[type="submit"]').textContent), submit: norm(alert.querySelector('[type="submit"]').textContent), options: [...q('[name="sort"]').options].map((o) => norm(o.textContent)) },
    description: norm(q(".marketplace__details > p").textContent), fields: names.map((v, i) => ({ name: norm(v.textContent), value: norm(values[i].textContent) })), tags: texts(".marketplace__details > ul li"),
    contents: links(".marketplace__contents"), included: links(".marketplace__included"), message: norm(message.textContent),
  };
}
