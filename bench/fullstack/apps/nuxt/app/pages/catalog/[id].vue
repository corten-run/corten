<script setup lang="ts">
import type { CatalogRecord } from "~~/server/utils/catalog";

const route = useRoute();
const { data: record, error } = await useFetch<CatalogRecord>(() =>
  `/api/catalog/${encodeURIComponent(String(route.params.id))}`, {
  cache: "no-store",
  retry: 0,
  getCachedData: (key, app) => app.isHydrating ? app.payload.data[key] : undefined,
});
if (error.value) throw createError({
  statusCode: error.value.statusCode ?? 500,
  statusMessage: error.value.statusCode === 404 ? "Not found" : "Catalog request failed",
  fatal: true,
});
if (!record.value) throw createError({ statusCode: 500, statusMessage: "Missing catalog record", fatal: true });
const field = computed(() => {
  const query = route.query.field;
  return (Array.isArray(query) ? query[0] : query) ?? "";
});
useHead({ title: "Catalog | Card Market", link: [{ rel: "stylesheet", href: "/catalog.css" }] });
</script>

<template>
  <article v-if="record" aria-label="Catalog record">
    <h1>{{ record.title }}</h1>
    <p>{{ record.subtitle }}</p>
    <p>{{ record.description }}</p>
    <ul aria-label="Tags"><li v-for="(tag, i) in record.tags" :key="i">{{ tag }}</li></ul>
    <form method="get" :action="`/catalog/${encodeURIComponent(record.id)}`">
        <label>Field name <input name="field" :value="field" /></label>
      <button type="submit">Filter</button>
    </form>
    <table>
      <caption>Record fields</caption>
      <thead><tr><th scope="col">Name</th><th scope="col">Value</th></tr></thead>
      <tbody><tr v-for="(entry, i) in record.fields.filter((entry) => entry.name.startsWith(field))" :key="i">
        <th scope="row">{{ entry.name }}</th><td>{{ entry.value }}</td>
      </tr></tbody>
    </table>
    <nav aria-label="Related records"><ul><li v-for="(related, i) in record.related" :key="i">
      <NuxtLink :to="`/catalog/${encodeURIComponent(related.id)}`" :prefetch="false">{{ related.title }}</NuxtLink>
    </li></ul></nav>
  </article>
</template>
