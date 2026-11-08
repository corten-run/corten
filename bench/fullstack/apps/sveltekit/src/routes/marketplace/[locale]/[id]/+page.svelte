<script lang="ts">
  import type { PageData, ActionData } from "./$types";
  import { marketplaceView, marketplacePath, alertMessage } from "#lib/marketplace";
  let { data, form }: { data: PageData; form: ActionData } = $props();
  const view = $derived(marketplaceView(data.record, data.locale, new URLSearchParams(data.query)));
  const message = $derived(form?.alert ? alertMessage(data.locale, data.record.title, form.alert.email, form.alert.target) : "");
  $effect(() => {
    document.documentElement.lang = data.locale;
    return () => { document.documentElement.lang = "en"; };
  });
</script>
<svelte:head><title>Marketplace | Card Market</title><link rel="stylesheet" href="/marketplace.css" /></svelte:head>
<article class="marketplace">
  <nav class="marketplace__categories">{#each view.record.categories as category}<a href={marketplacePath(view.locale, "item_1")}>{category.name}</a>{/each}</nav>
  <h1>{view.record.title}</h1>
  {#if view.record.subtitle !== null}<p class="marketplace__subtitle">{view.record.subtitle}</p>{/if}
  <ul class="marketplace__badges">{#each view.record.badges as badge}<li>{badge}</li>{/each}</ul>
  <div class="marketplace__images">{#each view.record.images as src, i}<div class="marketplace__image" role="img" aria-label={view.record.title + " " + (i + 1)} data-src={src}></div>{/each}</div>
  <section class="marketplace__summary">
    {#if view.summary}
      <span><strong>{view.summary.lowest}</strong> {view.words.lowest}</span>
      <span>{view.summary.count}</span><span>{view.summary.quantity} {view.words.available}</span>
    {:else}<span>{view.words.no_listings}</span>{/if}
  </section>
  <section class="marketplace__listings">
    <h2>{view.words.listings}</h2>
    <form method="get" action={view.path}>
      <label>{view.words.filter} <input type="text" name="seller" value={view.seller} /></label>
      <label>{view.words.sort} <select name="sort" value={view.sort}><option value="asc">{view.words.asc}</option><option value="desc">{view.words.desc}</option></select></label>
      <button type="submit">{view.words.apply}</button>
    </form>
    <table>
      <thead><tr><th scope="col">{view.words.seller}</th><th scope="col">{view.words.condition}</th><th scope="col">{view.words.ships_from}</th><th scope="col">{view.words.qty}</th><th scope="col">{view.words.price}</th><th scope="col">{view.words.reviews}</th></tr></thead>
      <tbody>{#each view.listings as row}<tr data-listing-id={row.id}><td>{row.sellerText}</td><td>{row.condition}</td><td>{row.ships_from}</td><td>{row.quantityText}</td><td>{row.priceText}</td><td>{row.reviewsText}</td></tr>{/each}</tbody>
    </table>
  </section>
  <section class="marketplace__offers">
    <h2>{view.words.offers}</h2>
    <table>
      <thead><tr><th scope="col">{view.words.buyer}</th><th scope="col">{view.words.condition}</th><th scope="col">{view.words.qty}</th><th scope="col">{view.words.price}</th></tr></thead>
      <tbody>{#each view.offers as row}<tr data-offer-id={row.id}><td>{row.buyer}</td><td>{row.condition}</td><td>{row.quantityText}</td><td>{row.priceText}</td></tr>{/each}</tbody>
    </table>
    {#if view.more}<a class="marketplace__more" href={view.more}>{view.words.show_all}</a>{/if}
  </section>
  <section class="marketplace__alert">
    <h2>{view.words.alert}</h2>
    <form method="post" action={view.path}>
      <label>{view.words.email} <input type="email" name="email" /></label>
      <label>{view.words.target} <input type="text" inputmode="decimal" name="target_price" /></label>
      <button type="submit">{view.words.submit}</button>
    </form>
    <p class="marketplace__message">{message}</p>
  </section>
  <section class="marketplace__details">
    <h2>{view.words.details}</h2><p>{view.record.description}</p>
    <dl>{#each view.record.fields as field}<dt>{field.name}</dt><dd>{field.value}</dd>{/each}</dl>
    <ul>{#each view.record.tags as tag}<li>{tag}</li>{/each}</ul>
  </section>
  <section class="marketplace__contents"><h2>{view.words.contents}</h2><ul>{#each view.contents as row}<li><a href={row.href}>{row.title}</a> × {row.quantityText}</li>{/each}</ul></section>
  <section class="marketplace__included"><h2>{view.words.included}</h2><ul>{#each view.included as row}<li><a href={row.href}>{row.title}</a> × {row.quantityText}</li>{/each}</ul></section>
</article>
