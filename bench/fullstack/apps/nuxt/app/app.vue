<script setup lang="ts">
const route = useRoute();
const catalogPage = computed(() => route.name === "catalog-id");
const header = useTemplateRef<HTMLElement>("header");

// NuxtLink registers visibility prefetch at setup, so crossing the boundary remounts it.
watch(catalogPage, async () => {
  const link = header.value?.querySelector("a");
  if (!link || link !== document.activeElement) return;
  await nextTick();
  if (document.activeElement === document.body) {
    header.value?.querySelector("a")?.focus({ preventScroll: true });
  }
});

// Mounted after hydration; the browser benchmark reads this mark.
onMounted(() => {
  (window as unknown as { __hydratedAt?: number }).__hydratedAt = performance.now();
});
</script>

<template>
  <header ref="header" class="site-header__bar">
    <!-- A catalog visit does not need the home chunk. -->
    <NuxtLink :key="catalogPage ? 'catalog' : 'default'" to="/" :prefetch="!catalogPage">Card Market</NuxtLink>
  </header>
  <main><NuxtPage /></main>
</template>
