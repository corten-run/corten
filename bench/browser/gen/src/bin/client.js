import { keep } from "corten";
import { rows, ClientRow, ClientCard } from "corten/views";
import { fixture as w, tick as publish, subscribe } from "../../../../client-heavy/apps/input.js";
/** @import { Holds } from "corten/views" */

const state = () => keep(() => ({ ...structuredClone(w.initial), selected: null, filter: "", direction: "", next: w.rowCount + 1, ticks: 0, draw: () => {} }));

/**
 * @param {Holds<ClientRow, HTMLTableSectionElement>} body
 * @param {Holds<ClientRow, HTMLTemplateElement>} template
 * @param {Holds<ClientCard, HTMLElement>} cards
 * @param {HTMLOutputElement} total
 * @param {HTMLInputElement} filter
 * @param {AbortSignal} signal
 */
export function connect(body, template, cards, total, filter, signal) {
  const s = state(), list = rows(body, ClientRow, template), prices = rows(cards, ClientCard);
  s.draw = () => {
    const shown = s.rows.filter((r) => r.label.includes(s.filter));
    if (s.direction) shown.sort((a, b) => (s.direction === "asc" ? 1 : -1) * (+a.id.slice(4) - +b.id.slice(4)));
    list.replace(shown.map((r) => ({ ...r, selected: r.id === s.selected })));
    filter.value = s.filter;
  };
  subscribe((e) => {
    s.ticks++;
    for (let k = 0; k < e.detail; k++) {
      const i = (k + s.ticks) % s.cards.length, card = s.cards[i];
      card.priceMinor = 10000 + i % 17 * 100 + s.ticks * 13 + i;
      prices.get(card.id).price = card.priceMinor;
    }
    total.value = String(s.cards.reduce((n, c) => n + c.priceMinor, 0));
  }, signal);
}
/** @param {string} kind */
export function act(kind) {
  const s = state(), d = s.rows;
  const make = (n) => Array.from({ length: n }, () => { const i = s.next++; return { id: `row-${i}`, label: `group-${(w.seed + i) % 7} row-${i}` }; });
  switch (kind) {
    case "update-tenth": for (let i = 0; i < d.length; i += 10) d[i].label += " !!!"; break;
    case "patch-one": d[Math.floor(d.length / 2)].label += " *"; break;
    case "patch-many": for (let i = 0; i < Math.min(100, d.length); i++) d[i * (d.length % 97 ? 97 : 1) % d.length].label += " *"; break;
    case "swap": [d[1], d[d.length - 2]] = [d[d.length - 2], d[1]]; break;
    case "append": s.rows = d.concat(make(w.appendCount)); break;
    case "clear": case "create-small": case "replace-small": case "create-large":
      s.rows = kind === "clear" ? [] : make(kind === "create-large" ? w.largeRowCount : w.rowCount); s.selected = null; s.filter = ""; s.direction = ""; break;
    default: throw new Error("unknown operation");
  }
  s.draw();
}
/** @param {HTMLInputElement} input */
export function filter(input) { const s = state(); s.filter = input.value; s.draw(); }
/** @param {string} direction */
export function sort(direction) { const s = state(); s.direction = direction; s.draw(); }
/** @param {PointerEvent} event */
export function row(event) {
  if (!(event.target instanceof HTMLButtonElement)) return;
  const s = state(), { select, remove } = event.target.dataset;
  if (select) s.selected = select;
  if (remove) { s.rows = s.rows.filter((r) => r.id !== remove); if (s.selected === remove) s.selected = null; }
  s.draw();
}
/** @param {boolean} all */
export function tick(all) { publish(all ? w.dashboardCount : Math.min(20, w.dashboardCount)); }

// Benchmark bootstrap only; component handlers reach the page through their typed refs.
window.clientMount = () => document.getElementById("mount").append(document.getElementById("screen-template").content.cloneNode(true));
window.clientDetach = () => document.getElementById("screen").remove();
