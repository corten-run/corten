<script setup>
import { ref, shallowRef, computed, triggerRef, onMounted, onUnmounted } from "vue";
import { fixture as w, controls, tick, subscribe, unsubscribe } from "./input.js";
const rows = shallowRef(structuredClone(w.initial.rows)), cards = shallowRef(structuredClone(w.initial.cards));
const selected = ref(null), filter = ref(""), direction = ref("");
let next = w.rowCount + 1, ticks = 0;
const make = (n) => Array.from({ length: n }, () => { const i = next++; return { id: `row-${i}`, label: `group-${(w.seed + i) % 7} row-${i}` }; });
function act(kind, key) {
  const d = rows.value;
  switch (kind) {
    case "update-tenth": for (let i = 0; i < d.length; i += 10) d[i].label += " !!!"; break;
    case "patch-one": d[Math.floor(d.length / 2)].label += " *"; break;
    case "patch-many": for (let i = 0; i < Math.min(100, d.length); i++) d[i * (d.length % 97 ? 97 : 1) % d.length].label += " *"; break;
    case "select": selected.value = key; break;
    case "remove": rows.value = d.filter((r) => r.id !== key); if (selected.value === key) selected.value = null; break;
    case "swap": [d[1], d[d.length - 2]] = [d[d.length - 2], d[1]]; break;
    case "append": rows.value = d.concat(make(w.appendCount)); break;
    case "clear": case "create-small": case "replace-small": case "create-large":
      rows.value = kind === "clear" ? [] : make(kind === "create-large" ? w.largeRowCount : w.rowCount);
      selected.value = null; filter.value = ""; direction.value = ""; break;
    default: throw new Error("unknown operation");
  }
  triggerRef(rows);
}
const receive = (e) => {
  ticks++;
  for (let k = 0; k < e.detail; k++) { const i = (k + ticks) % cards.value.length; cards.value[i].priceMinor = 10000 + i % 17 * 100 + ticks * 13 + i; }
  triggerRef(cards);
};
onMounted(() => subscribe(receive));
onUnmounted(() => unsubscribe(receive));
const shown = computed(() => {
  const d = rows.value.filter((r) => r.label.includes(filter.value));
  if (direction.value) d.sort((a, b) => (direction.value === "asc" ? 1 : -1) * (+a.id.slice(4) - +b.id.slice(4)));
  return d;
});
</script>
<template>
  <section id="screen">
    <nav><button v-for="kind in controls" :key="kind" :id="kind" @click="act(kind)">{{kind}}</button></nav>
    <label>Filter<input id="filter" v-model="filter"></label>
    <button id="sort-asc" @click="direction = 'asc'">Sort ascending</button><button id="sort-desc" @click="direction = 'desc'">Sort descending</button>
    <table><tbody><tr v-for="row in shown" :key="row.id" :data-row="row.id" :aria-selected="row.id === selected" v-memo="[row.label, row.id === selected]">
      <td>{{row.id}}</td><td><button :data-select="row.id" @click="act('select', row.id)">{{row.label}}</button></td><td><button :data-remove="row.id" @click="act('remove', row.id)">Remove</button></td>
    </tr></tbody></table>
    <button id="tick-small" @click="tick(Math.min(20, w.dashboardCount))">Tick subset</button><button id="tick-all" @click="tick(w.dashboardCount)">Tick all</button>
    <output id="total">{{cards.reduce((n, c) => n + c.priceMinor, 0)}}</output><aside><div v-for="card in cards" :key="card.id" :data-card="card.id"><b>{{card.id}}</b><span>{{card.priceMinor}}</span></div></aside>
  </section>
</template>
