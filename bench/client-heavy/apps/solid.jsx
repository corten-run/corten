import { createSignal, createMemo, createSelector, batch, For, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import { fixture as w, controls, tick, subscribe, unsubscribe } from "./input.js";
function App() {
  const row = (r) => { const [label, setLabel] = createSignal(r.label); return { id: r.id, label, setLabel }; };
  const [rows, setRows] = createSignal(w.initial.rows.map(row));
  const cards = w.initial.cards.map((c) => { const [price, setPrice] = createSignal(c.priceMinor); return { id: c.id, price, setPrice }; });
  const [selected, setSelected] = createSignal(null), [filter, setFilter] = createSignal(""), [direction, setDirection] = createSignal("");
  const isSelected = createSelector(selected);
  let next = w.rowCount + 1, ticks = 0;
  const make = (n) => Array.from({ length: n }, () => { const i = next++; return row({ id: `row-${i}`, label: `group-${(w.seed + i) % 7} row-${i}` }); });
  function act(kind, key) {
    batch(() => {
      const d = rows();
      const patch = (i, suffix) => d[i].setLabel(d[i].label() + suffix);
      switch (kind) {
        case "update-tenth": for (let i = 0; i < d.length; i += 10) patch(i, " !!!"); break;
        case "patch-one": patch(Math.floor(d.length / 2), " *"); break;
        case "patch-many": for (let i = 0; i < Math.min(100, d.length); i++) patch(i * (d.length % 97 ? 97 : 1) % d.length, " *"); break;
        case "select": setSelected(key); break;
        case "remove": setRows(d.filter((r) => r.id !== key)); if (selected() === key) setSelected(null); break;
        case "swap": { const copy = d.slice(); [copy[1], copy[copy.length - 2]] = [copy[copy.length - 2], copy[1]]; setRows(copy); break; }
        case "append": setRows(d.concat(make(w.appendCount))); break;
        case "clear": case "create-small": case "replace-small": case "create-large":
          setRows(kind === "clear" ? [] : make(kind === "create-large" ? w.largeRowCount : w.rowCount)); setSelected(null); setFilter(""); setDirection(""); break;
        default: throw new Error("unknown operation");
      }
    });
  }
  const receive = (e) => batch(() => {
    ticks++;
    for (let k = 0; k < e.detail; k++) { const i = (k + ticks) % cards.length; cards[i].setPrice(10000 + i % 17 * 100 + ticks * 13 + i); }
  });
  subscribe(receive); onCleanup(() => unsubscribe(receive));
  const shown = createMemo(() => {
    const d = rows().filter((r) => r.label().includes(filter()));
    if (direction()) d.sort((a, b) => (direction() === "asc" ? 1 : -1) * (+a.id.slice(4) - +b.id.slice(4)));
    return d;
  });
  return <section id="screen"><nav><For each={controls}>{(kind) => <button id={kind} onClick={() => act(kind)}>{kind}</button>}</For></nav>
    <label>Filter<input id="filter" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)}/></label>
    <button id="sort-asc" onClick={() => setDirection("asc")}>Sort ascending</button><button id="sort-desc" onClick={() => setDirection("desc")}>Sort descending</button>
    <table><tbody><For each={shown()}>{(r) => <tr data-row={r.id} aria-selected={isSelected(r.id)}><td>{r.id}</td><td><button data-select={r.id} onClick={() => act("select", r.id)}>{r.label()}</button></td><td><button data-remove={r.id} onClick={() => act("remove", r.id)}>Remove</button></td></tr>}</For></tbody></table>
    <button id="tick-small" onClick={() => tick(Math.min(20, w.dashboardCount))}>Tick subset</button><button id="tick-all" onClick={() => tick(w.dashboardCount)}>Tick all</button>
    <output id="total">{cards.reduce((n, c) => n + c.price(), 0)}</output><aside><For each={cards}>{(c) => <div data-card={c.id}><b>{c.id}</b><span>{c.price()}</span></div>}</For></aside></section>;
}
let dispose;
window.clientMount = () => { dispose = render(App, document.getElementById("mount")); };
window.clientDetach = () => dispose();
