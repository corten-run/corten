<script setup lang="ts">
import type { MarketplaceRecord } from "~~/shared/marketplace";
import { isLocale, marketplacePath, marketplaceView } from "~~/shared/marketplace";
import alertErrors from "~~/shared/marketplace-alert-errors.json";

definePageMeta({ key: (route) => route.fullPath });
const route = useRoute();
const locale = String(route.params.locale);
if (!isLocale(locale)) throw createError({ statusCode: 400, statusMessage: "Unsupported locale", fatal: true });
const event = useRequestEvent();
const { data, error } = await useAsyncData(`marketplace:${route.fullPath}`, async () => {
  const alert = event?.context.marketplaceAlert;
  const record = alert?.record ?? await $fetch<MarketplaceRecord>(`/api/marketplace/${encodeURIComponent(String(route.params.id))}`, {
    cache: "no-store", retry: 0,
  });
  return { record, message: alert?.message ?? "" };
}, {
  getCachedData: (key, app) => app.isHydrating ? app.payload.data[key] : undefined,
});
if (error.value) throw createError({
  statusCode: (error.value as any).statusCode ?? 500,
  statusMessage: (error.value as any).statusCode === 404 ? "Not found" : "Marketplace request failed",
  fatal: true,
});
if (!data.value) throw createError({ statusCode: 500, statusMessage: "Missing marketplace record", fatal: true });
const view = computed(() => marketplaceView(data.value!.record, locale, new URLSearchParams(route.fullPath.split("?")[1] ?? "")));
async function submitAlert(event: Event) {
  const form = new FormData(event.currentTarget as HTMLFormElement);
  form.set("locale", locale);
  data.value = { ...data.value!, message: "" };
  try {
    const result = await $fetch<{ message: string }>(`/api/marketplace/${encodeURIComponent(String(route.params.id))}`, {
      method: "POST", body: form, retry: 0,
    });
    data.value = { ...data.value!, message: result.message };
  } catch {
    data.value = { ...data.value!, message: alertErrors[locale] };
  }
}
useHead({ title: "Marketplace | Card Market", htmlAttrs: { lang: locale },
  link: [{ rel: "stylesheet", href: "/marketplace.css" }] });
</script>

<template>
  <article class="marketplace">
    <nav class="marketplace__categories"><a v-for="(category, i) in view.record.categories" :key="i" :href="marketplacePath(view.locale, 'item_1')">{{ category.name }}</a></nav>
    <h1>{{ view.record.title }}</h1>
    <p v-if="view.record.subtitle !== null" class="marketplace__subtitle">{{ view.record.subtitle }}</p>
    <ul class="marketplace__badges"><li v-for="(badge, i) in view.record.badges" :key="i">{{ badge }}</li></ul>
    <div class="marketplace__images"><div v-for="(src, i) in view.record.images" :key="i" class="marketplace__image" role="img" :aria-label="view.record.title + ' ' + (i + 1)" :data-src="src"></div></div>
    <section class="marketplace__summary">
      <template v-if="view.summary">
        <span><strong>{{ view.summary.lowest }}</strong> {{ view.words.lowest }}</span>
        <span>{{ view.summary.count }}</span><span>{{ view.summary.quantity }} {{ view.words.available }}</span>
      </template>
      <span v-else>{{ view.words.no_listings }}</span>
    </section>
    <section class="marketplace__listings">
      <h2>{{ view.words.listings }}</h2>
      <form method="get" :action="view.path">
        <label>{{ view.words.filter }} <input type="text" name="seller" :value="view.seller" /></label>
        <label>{{ view.words.sort }} <select name="sort" :value="view.sort"><option value="asc" :selected="view.sort === 'asc'">{{ view.words.asc }}</option><option value="desc" :selected="view.sort === 'desc'">{{ view.words.desc }}</option></select></label>
        <button type="submit">{{ view.words.apply }}</button>
      </form>
      <table>
        <thead><tr><th scope="col">{{ view.words.seller }}</th><th scope="col">{{ view.words.condition }}</th><th scope="col">{{ view.words.ships_from }}</th><th scope="col">{{ view.words.qty }}</th><th scope="col">{{ view.words.price }}</th><th scope="col">{{ view.words.reviews }}</th></tr></thead>
        <tbody><tr v-for="row in view.listings" :key="row.id" :data-listing-id="row.id"><td>{{ row.sellerText }}</td><td>{{ row.condition }}</td><td>{{ row.ships_from }}</td><td>{{ row.quantityText }}</td><td>{{ row.priceText }}</td><td>{{ row.reviewsText }}</td></tr></tbody>
      </table>
    </section>
    <section class="marketplace__offers">
      <h2>{{ view.words.offers }}</h2>
      <table>
        <thead><tr><th scope="col">{{ view.words.buyer }}</th><th scope="col">{{ view.words.condition }}</th><th scope="col">{{ view.words.qty }}</th><th scope="col">{{ view.words.price }}</th></tr></thead>
        <tbody><tr v-for="row in view.offers" :key="row.id" :data-offer-id="row.id"><td>{{ row.buyer }}</td><td>{{ row.condition }}</td><td>{{ row.quantityText }}</td><td>{{ row.priceText }}</td></tr></tbody>
      </table>
      <a v-if="view.more" class="marketplace__more" :href="view.more">{{ view.words.show_all }}</a>
    </section>
    <section class="marketplace__alert">
      <h2>{{ view.words.alert }}</h2>
      <form method="post" :action="view.path" @submit.prevent="submitAlert">
        <label>{{ view.words.email }} <input type="email" name="email" /></label>
        <label>{{ view.words.target }} <input type="text" inputmode="decimal" name="target_price" /></label>
        <button type="submit">{{ view.words.submit }}</button>
      </form>
      <p class="marketplace__message">{{ data?.message }}</p>
    </section>
    <section class="marketplace__details">
      <h2>{{ view.words.details }}</h2><p>{{ view.record.description }}</p>
      <dl><template v-for="(field, i) in view.record.fields" :key="i"><dt>{{ field.name }}</dt><dd>{{ field.value }}</dd></template></dl>
      <ul><li v-for="(tag, i) in view.record.tags" :key="i">{{ tag }}</li></ul>
    </section>
    <section class="marketplace__contents"><h2>{{ view.words.contents }}</h2><ul><li v-for="row in view.contents" :key="row.id"><a :href="row.href">{{ row.title }}</a> × {{ row.quantityText }}</li></ul></section>
    <section class="marketplace__included"><h2>{{ view.words.included }}</h2><ul><li v-for="row in view.included" :key="row.id"><a :href="row.href">{{ row.title }}</a> × {{ row.quantityText }}</li></ul></section>
  </article>
</template>
