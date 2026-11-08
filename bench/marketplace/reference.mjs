// Independent expected markup, used only by conformance tests.
import { expectedPage, labels } from "./records.mjs";
const escape = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export function referenceHtml(record, locale) {
  const p = expectedPage(record, locale), l = labels[locale], path = `/marketplace/${locale}/${record.id}`;
  const list = (rows) => `<ul>${rows.map((v) => `<li>${escape(v)}</li>`).join("")}</ul>`;
  const table = (headers, rows, attribute) => `<table><thead><tr>${headers.map((v) => `<th>${escape(v)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr ${attribute}="${escape(r.id)}">${r.cells.map((v) => `<td>${escape(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const lines = (rows) => `<ul>${rows.map((v) => { const at = v.text.lastIndexOf(" × "); return `<li><a href="${escape(v.href)}">${escape(v.text.slice(0, at))}</a>${escape(v.text.slice(at))}</li>`; }).join("")}</ul>`;
  const section = (name, content) => `<section class="marketplace__${name}">${content}</section>`;
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><base href="http://localhost${path}"></head><body><main><article class="marketplace">
    <nav class="marketplace__categories">${p.categories.map((v) => `<a href="${path}">${escape(v)}</a>`).join("")}</nav>
    <h1>${escape(p.title)}</h1>${p.subtitle === null ? "" : `<p class="marketplace__subtitle">${escape(p.subtitle)}</p>`}
    <ul class="marketplace__badges">${p.badges.map((v) => `<li>${escape(v)}</li>`).join("")}</ul>
    <div class="marketplace__images">${p.images.map((v) => `<div class="marketplace__image" role="img" aria-label="${escape(v.label)}" data-src="${escape(v.src)}"></div>`).join("")}</div>
    ${section("summary", p.summary.map((v, i) => `<span>${record.summary !== null && i === 0 ? `<strong>${escape(v.slice(0, -l.lowest.length - 1))}</strong> ${escape(l.lowest)}` : escape(v)}</span>`).join(""))}
    ${section("listings", `<h2>${escape(l.listings)}</h2><form action="${path}" method="get"><label>${escape(l.filter)}<input name="seller"></label><label>${escape(l.sort)}<select name="sort"><option value="asc">${escape(l.asc)}</option><option value="desc">${escape(l.desc)}</option></select></label><button type="submit">${escape(l.apply)}</button></form>${table(p.listingHeaders, p.listings, "data-listing-id")}`)}
    ${section("offers", `<h2>${escape(l.offers)}</h2>${table(p.offerHeaders, p.offers, "data-offer-id")}${p.more ? `<a class="marketplace__more" href="${path}?seller=&amp;sort=asc&amp;offers=all">${escape(l.show_all)}</a>` : ""}`)}
    ${section("alert", `<h2>${escape(l.alert)}</h2><form action="${path}" method="post"><label>${escape(l.email)}<input type="email" name="email"></label><label>${escape(l.target)}<input type="text" inputmode="decimal" name="target_price"></label><button type="submit">${escape(l.submit)}</button></form><p class="marketplace__message"></p>`)}
    ${section("details", `<h2>${escape(l.details)}</h2><p>${escape(p.description)}</p><dl>${p.fields.map((v) => `<dt>${escape(v.name)}</dt><dd>${escape(v.value)}</dd>`).join("")}</dl>${list(p.tags)}`)}
    ${section("contents", `<h2>${escape(l.contents)}</h2>${lines(p.contents)}`)}${section("included", `<h2>${escape(l.included)}</h2>${lines(p.included)}`)}
    </article></main></body></html>`;
}
