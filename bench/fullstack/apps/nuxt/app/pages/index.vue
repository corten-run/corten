<script setup lang="ts">
// Corten's home page: cards with items in memory, links by id from the item API.
const { data: cards } = await useFetch<{ id: string; title: string; subtitle: string | null; from: string }[]>("/api/shelf");
useHead({ title: "Popular items | Card Market" });
</script>

<template>
  <h1>Popular items</h1>
  <ul v-if="cards && cards.length > 0" class="item-list__list">
    <li v-for="card in cards" :key="card.id">
      <NuxtLink class="item-card__card" :to="`/items/${card.id}`">
        <strong>{{ card.title }}</strong>
        <span v-if="card.subtitle" class="item-card__set">{{ card.subtitle }}</span>
        <span class="item-card__from">{{ card.from }}</span>
      </NuxtLink>
    </li>
  </ul>
  <ul v-else class="item-list__list item-list__ids">
    <li v-for="n in 50" :key="n"><NuxtLink :to="`/items/item_${n}`">{{ `Item ${n}` }}</NuxtLink></li>
  </ul>
</template>
