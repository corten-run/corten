<script setup lang="ts">
const route = useRoute();
const catalogPage = computed(() => route.name === "catalog-id");

// Mounted after hydration; the browser benchmark reads this mark.
onMounted(() => {
  (window as unknown as { __hydratedAt?: number }).__hydratedAt = performance.now();
});
</script>

<template>
  <header class="site-header__bar">
    <!-- A catalog visit does not need the home chunk. -->
    <NuxtLink :key="catalogPage ? 'catalog' : 'default'" to="/" :prefetch="!catalogPage">Card Market</NuxtLink>
  </header>
  <main><NuxtPage /></main>
</template>
