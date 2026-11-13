import { createRoot, on, type Handle } from "remix/component";
import { fixture as w, controls, tick, subscribe } from "./input.js";
function App(handle: Handle) {
  let rows = structuredClone(w.initial.rows), cards = structuredClone(w.initial.cards);
  let selected = null, filter = "", direction = "", next = w.rowCount + 1, ticks = 0;
  const make = (n) => Array.from({ length: n }, () => { const i = next++; return { id: `row-${i}`, label: `group-${(w.seed + i) % 7} row-${i}` }; });
  function act(kind, key?) {
    switch (kind) {
      case "update-tenth": for (let i = 0; i < rows.length; i += 10) rows[i].label += " !!!"; break;
      case "patch-one": rows[Math.floor(rows.length / 2)].label += " *"; break;
      case "patch-many": for (let i = 0; i < Math.min(100, rows.length); i++) rows[i * (rows.length % 97 ? 97 : 1) % rows.length].label += " *"; break;
      case "select": selected = key; break;
      case "remove": rows = rows.filter((r) => r.id !== key); if (selected === key) selected = null; break;
      case "swap": [rows[1], rows[rows.length - 2]] = [rows[rows.length - 2], rows[1]]; break;
      case "append": rows = rows.concat(make(w.appendCount)); break;
      case "clear": case "create-small": case "replace-small": case "create-large":
        rows = kind === "clear" ? [] : make(kind === "create-large" ? w.largeRowCount : w.rowCount); selected = null; filter = ""; direction = ""; break;
      default: throw new Error("unknown operation");
    }
    handle.update();
  }
  subscribe((e) => {
    ticks++;
    for (let k = 0; k < e.detail; k++) { const i = (k + ticks) % cards.length; cards[i].priceMinor = 10000 + i % 17 * 100 + ticks * 13 + i; }
    handle.update();
  }, handle.signal);
  return () => {
    const shown = rows.filter((r) => r.label.includes(filter));
    if (direction) shown.sort((a, b) => (direction === "asc" ? 1 : -1) * (+a.id.slice(4) - +b.id.slice(4)));
    return <section id="screen"><nav>{controls.map((kind) => <button key={kind} id={kind} mix={on("click", () => act(kind))}>{kind}</button>)}</nav>
      <label>Filter<input id="filter" value={filter} mix={on("input", (e) => { filter = (e.target as HTMLInputElement).value; handle.update(); })}/></label>
      <button id="sort-asc" mix={on("click", () => { direction = "asc"; handle.update(); })}>Sort ascending</button><button id="sort-desc" mix={on("click", () => { direction = "desc"; handle.update(); })}>Sort descending</button>
      <table><tbody>{shown.map((r) => <tr key={r.id} data-row={r.id} aria-selected={selected === r.id}><td>{r.id}</td><td><button data-select={r.id} mix={on("click", () => act("select", r.id))}>{r.label}</button></td><td><button data-remove={r.id} mix={on("click", () => act("remove", r.id))}>Remove</button></td></tr>)}</tbody></table>
      <button id="tick-small" mix={on("click", () => tick(Math.min(20, w.dashboardCount)))}>Tick subset</button><button id="tick-all" mix={on("click", () => tick(w.dashboardCount))}>Tick all</button>
      <output id="total">{cards.reduce((n, c) => n + c.priceMinor, 0)}</output><aside>{cards.map((c) => <div key={c.id} data-card={c.id}><b>{c.id}</b><span>{c.priceMinor}</span></div>)}</aside></section>;
  };
}
const root = createRoot(document.getElementById("mount")!);
window.clientMount = () => { root.render(<App/>); root.flush(); };
window.clientDetach = () => root.dispose();
