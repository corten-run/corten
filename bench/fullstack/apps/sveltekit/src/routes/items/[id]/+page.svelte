<script lang="ts">
  import { enhance } from "$app/forms";
  import { counted, sortListings } from "#lib/view-model";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();
  let descending = $state(false);
  let showAllOffers = $state(data.allOffers);
  const item = $derived(data.item);
  const listings = $derived(sortListings(item.listings, descending));
  const offers = $derived(showAllOffers ? item.offers : item.offers.slice(0, 5));
</script>

<svelte:head><title>{`${item.title} | Card Market`}</title></svelte:head>

<article>
  <div class="item-detail__top">
    <div class="item-detail__intro">
      <nav class="item-detail__crumbs">
        {#each item.categories as c (c.slug)}<a href={`/categories/${c.slug}`}>{c.name}</a>{/each}
      </nav>
      <h1>{item.title}</h1>
      {#if item.subtitle}<p class="item-detail__subtitle">{item.subtitle}</p>{/if}
      <ul class="item-detail__chips">
        {#each item.badges as b, i (i)}<li>{b}</li>{/each}
      </ul>
    </div>
    {#if item.images.length > 0}
      <div class="item-detail__gallery">
        {#each item.images as url, i (url)}
          <div class="item-detail__image" role="img" aria-label={`${item.title} image ${i + 1}`} data-src={url}></div>
        {/each}
      </div>
    {/if}
    <section class="item-detail__panel item-detail__summary gap-3 sm:gap-5">
      {#if item.summary}
        <span><strong>{item.summary.lowest ?? "—"}</strong> lowest</span>
        <span>{counted(item.summary.count, "listing", "listings")}</span>
        <span>{counted(item.summary.quantity, "available", "available")}</span>
      {:else}
        <span>No listings yet</span>
      {/if}
    </section>
  </div>
  <section class="item-detail__panel">
    <h2>Listings</h2>
    <button type="button" onclick={() => (descending = !descending)}>
      <span hidden={descending}>Price: low to high</span>
      <span hidden={!descending}>Price: high to low</span>
    </button>
    <table>
      <thead><tr><th>Seller</th><th>Condition</th><th>Ships from</th><th>Qty</th><th>Price</th></tr></thead>
      <tbody>
        {#each listings as l (l.id)}
          <tr>
            <td>{l.seller + (l.rating ? ` · ${l.rating} ★ (${l.reviews})` : "")}</td>
            <td>{l.condition}</td>
            <td>{l.ships_from}</td>
            <td>{l.quantity}</td>
            <td class="price__amount">{l.price}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>
  <section class="item-detail__panel">
    <h2>Offers</h2>
    <table>
      <thead><tr><th>Buyer</th><th>Condition</th><th>Qty</th><th>Price</th></tr></thead>
      <tbody>
        {#each offers as o (o.id)}
          <tr>
            <td>{o.buyer}</td>
            <td>{o.condition}</td>
            <td>{o.quantity}</td>
            <td class="price__amount">{o.price}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if item.offers.length > 5 && !showAllOffers}
      <form
        method="get"
        action={`/items/${item.id}`}
        onsubmit={(event) => {
          event.preventDefault();
          showAllOffers = true;
        }}
      >
        <button name="offers" value="all">{`Show all ${item.offers.length} offers`}</button>
      </form>
    {/if}
  </section>
  <section class="item-detail__panel">
    <h2>Price alert</h2>
    <div class="alert-form__form">
      <form method="post" use:enhance={() => ({ update }) => update({ reset: false, invalidateAll: false })}>
        <input type="hidden" name="item_id" value={item.id} />
        <input type="hidden" name="title" value={item.title} />
        <label>Email<input type="email" name="email" required /></label>
        <label>Alert me below<input type="text" name="target_price" inputmode="decimal" required /></label>
        <button type="submit">Set alert</button>
      </form>
    </div>
    <p class="alert-form__message" id="alert-message" aria-live="polite">{form?.message ?? ""}</p>
  </section>
  <section class="item-detail__panel">
    <h2>Details</h2>
    <p>{item.description}</p>
    <dl>
      {#each item.fields as f, i (i)}<dt>{f.name}</dt><dd>{f.value}</dd>{/each}
    </dl>
    {#if item.tags.length > 0}
      <ul class="item-detail__chips">
        {#each item.tags as t, i (i)}<li>{t}</li>{/each}
      </ul>
    {/if}
  </section>
  {#if item.contents.length > 0}
    <section class="item-detail__panel">
      <h2>Contents</h2>
      <ul>
        {#each item.contents as c (c.id)}<li><a href={`/items/${c.item_id}`}>{c.title}</a>{` × ${c.quantity}`}</li>{/each}
      </ul>
    </section>
  {/if}
  {#if item.included_in.length > 0}
    <section class="item-detail__panel">
      <h2>Included in</h2>
      <ul>
        {#each item.included_in as c (c.id)}<li><a href={`/items/${c.item_id}`}>{c.title}</a>{` × ${c.quantity}`}</li>{/each}
      </ul>
    </section>
  {/if}
</article>
