<script>
  import { onMount } from "svelte";
  import { fixture as w, controls, tick, subscribe, unsubscribe } from "./input.js";
  class Row {
    label = $state("");
    constructor(id, label) { this.id = id; this.label = label; }
  }
  let rows = $state.raw(w.initial.rows.map((r) => new Row(r.id, r.label)));
  let cards = $state(structuredClone(w.initial.cards));
  let selected = $state(null), filter = $state(""), direction = $state("");
  let next = w.rowCount + 1, ticks = 0;
  const make = (n) => Array.from({ length: n }, () => { const i = next++; return new Row(`row-${i}`, `group-${(w.seed + i) % 7} row-${i}`); });
  function act(kind, key) {
    switch (kind) {
      case "update-tenth": for (let i = 0; i < rows.length; i += 10) rows[i].label += " !!!"; break;
      case "patch-one": rows[Math.floor(rows.length / 2)].label += " *"; break;
      case "patch-many": for (let i = 0; i < Math.min(100, rows.length); i++) rows[i * (rows.length % 97 ? 97 : 1) % rows.length].label += " *"; break;
      case "select": selected = key; break;
      case "remove": rows = rows.filter((r) => r.id !== key); if (selected === key) selected = null; break;
      case "swap": { const d = rows.slice(); [d[1], d[d.length - 2]] = [d[d.length - 2], d[1]]; rows = d; break; }
      case "append": rows = rows.concat(make(w.appendCount)); break;
      case "clear": case "create-small": case "replace-small": case "create-large":
        rows = kind === "clear" ? [] : make(kind === "create-large" ? w.largeRowCount : w.rowCount);
        selected = null; filter = ""; direction = ""; break;
      default: throw new Error("unknown operation");
    }
  }
  onMount(() => {
    const receive = (e) => {
      ticks++;
      for (let k = 0; k < e.detail; k++) { const i = (k + ticks) % cards.length; cards[i].priceMinor = 10000 + i % 17 * 100 + ticks * 13 + i; }
    };
    subscribe(receive);
    return () => unsubscribe(receive);
  });
  const shown = $derived.by(() => {
    const d = rows.filter((r) => r.label.includes(filter));
    if (direction) d.sort((a, b) => (direction === "asc" ? 1 : -1) * (+a.id.slice(4) - +b.id.slice(4)));
    return d;
  });
</script>
<section id="screen">
  <nav>{#each controls as kind}<button id={kind} onclick={() => act(kind)}>{kind}</button>{/each}</nav>
  <label>Filter<input id="filter" value={filter} oninput={(e) => filter = e.currentTarget.value}></label>
  <button id="sort-asc" onclick={() => direction = 'asc'}>Sort ascending</button><button id="sort-desc" onclick={() => direction = 'desc'}>Sort descending</button>
  <table><tbody>{#each shown as row (row.id)}<tr data-row={row.id} aria-selected={selected === row.id}>
    <td>{row.id}</td><td><button data-select={row.id} onclick={() => act('select', row.id)}>{row.label}</button></td><td><button data-remove={row.id} onclick={() => act('remove', row.id)}>Remove</button></td>
  </tr>{/each}</tbody></table>
  <button id="tick-small" onclick={() => tick(Math.min(20, w.dashboardCount))}>Tick subset</button><button id="tick-all" onclick={() => tick(w.dashboardCount)}>Tick all</button>
  <output id="total">{cards.reduce((n, c) => n + c.priceMinor, 0)}</output><aside>{#each cards as card (card.id)}<div data-card={card.id}><b>{card.id}</b><span>{card.priceMinor}</span></div>{/each}</aside>
</section>
