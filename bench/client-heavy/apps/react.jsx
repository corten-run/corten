import { memo, useLayoutEffect, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { fixture as w, controls, tick, subscribe, unsubscribe } from "./input.js";

function reduce(s, op) {
  let { rows, selected, filter, direction, next, cards, ticks } = s;
  const make = (n) => Array.from({ length: n }, () => { const i = next++; return { id: `row-${i}`, label: `group-${(w.seed + i) % 7} row-${i}` }; });
  const patch = (indices, suffix) => {
    rows = rows.slice();
    for (const i of indices) rows[i] = { ...rows[i], label: rows[i].label + suffix };
  };
  switch (op.kind) {
    case "update-tenth": patch(Array.from({ length: Math.ceil(rows.length / 10) }, (_, i) => i * 10), " !!!"); break;
    case "patch-one": patch([Math.floor(rows.length / 2)], " *"); break;
    case "patch-many": patch(Array.from({ length: Math.min(100, rows.length) }, (_, i) => i * (rows.length % 97 ? 97 : 1) % rows.length), " *"); break;
    case "select": selected = op.key; break;
    case "remove": rows = rows.filter((r) => r.id !== op.key); if (selected === op.key) selected = null; break;
    case "filter": filter = op.text; break;
    case "sort": direction = op.direction; break;
    case "swap": rows = rows.slice(); [rows[1], rows[rows.length - 2]] = [rows[rows.length - 2], rows[1]]; break;
    case "append": rows = rows.concat(make(w.appendCount)); break;
    case "clear": case "create-small": case "replace-small": case "create-large":
      rows = op.kind === "clear" ? [] : make(op.kind === "create-large" ? w.largeRowCount : w.rowCount);
      selected = null; filter = ""; direction = ""; break;
    case "tick": {
      ticks++;
      cards = cards.slice();
      for (let k = 0; k < op.count; k++) { const i = (k + ticks) % cards.length; cards[i] = { ...cards[i], priceMinor: 10000 + i % 17 * 100 + ticks * 13 + i }; }
      break;
    }
    default: throw new Error("unknown operation");
  }
  return { rows, selected, filter, direction, next, cards, ticks };
}
const Row = memo(({ row, selected, dispatch }) => <tr data-row={row.id} aria-selected={selected}><td>{row.id}</td><td><button data-select={row.id} onClick={() => dispatch({ kind: "select", key: row.id })}>{row.label}</button></td><td><button data-remove={row.id} onClick={() => dispatch({ kind: "remove", key: row.id })}>Remove</button></td></tr>);
const Card = memo(({ card }) => <div data-card={card.id}><b>{card.id}</b><span>{card.priceMinor}</span></div>);
function App() {
  const [s, dispatch] = useReducer(reduce, null, () => ({ ...structuredClone(w.initial), selected: null, filter: "", direction: "", next: w.rowCount + 1, ticks: 0 }));
  useLayoutEffect(() => { const receive = (e) => dispatch({ kind: "tick", count: e.detail }); subscribe(receive); return () => unsubscribe(receive); }, []);
  let shown = s.rows.filter((r) => r.label.includes(s.filter));
  if (s.direction) shown.sort((a, b) => (s.direction === "asc" ? 1 : -1) * (+a.id.slice(4) - +b.id.slice(4)));
  return <section id="screen"><nav>{controls.map((kind) => <button key={kind} id={kind} onClick={() => dispatch({ kind })}>{kind}</button>)}</nav>
    <label>Filter<input id="filter" value={s.filter} onChange={(e) => dispatch({ kind: "filter", text: e.target.value })}/></label>
    <button id="sort-asc" onClick={() => dispatch({ kind: "sort", direction: "asc" })}>Sort ascending</button><button id="sort-desc" onClick={() => dispatch({ kind: "sort", direction: "desc" })}>Sort descending</button>
    <table><tbody>{shown.map((row) => <Row key={row.id} row={row} selected={s.selected === row.id} dispatch={dispatch}/>)}</tbody></table>
    <button id="tick-small" onClick={() => tick(Math.min(20, w.dashboardCount))}>Tick subset</button><button id="tick-all" onClick={() => tick(w.dashboardCount)}>Tick all</button>
    <output id="total">{s.cards.reduce((n, c) => n + c.priceMinor, 0)}</output><aside>{s.cards.map((card) => <Card key={card.id} card={card}/>)}</aside></section>;
}
const root = createRoot(document.getElementById("mount"));
window.clientMount = () => root.render(<App/>);
window.clientDetach = () => root.unmount();
