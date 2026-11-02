<script lang="ts">
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<svelte:head><title>Popular items | Card Market</title></svelte:head>

<h1>Popular items</h1>
{#if data.cards.length > 0}
  <ul class="item-list__list">
    {#each data.cards as card (card.id)}
      <li>
        <a class="item-card__card" href={`/items/${card.id}`}>
          <strong>{card.title}</strong>
          {#if card.subtitle}<span class="item-card__set">{card.subtitle}</span>{/if}
          <span class="item-card__from">{card.from}</span>
        </a>
      </li>
    {/each}
  </ul>
{:else}
  <ul class="item-list__list item-list__ids">
    {#each Array.from({ length: 50 }, (_, i) => i + 1) as n (n)}
      <li><a href={`/items/item_${n}`}>{`Item ${n}`}</a></li>
    {/each}
  </ul>
{/if}
