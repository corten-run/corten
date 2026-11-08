<script lang="ts">
  import type { PageData } from "./$types";
  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>Catalog | Card Market</title>
  <link rel="stylesheet" href="/catalog.css" />
</svelte:head>

<article aria-label="Catalog record">
  <h1>{data.record.title}</h1>
  <p>{data.record.subtitle}</p>
  <p>{data.record.description}</p>
  <ul aria-label="Tags">{#each data.record.tags as tag}<li>{tag}</li>{/each}</ul>
  <form method="get" action={`/catalog/${encodeURIComponent(data.record.id)}`}>
        <label>Field name <input name="field" value={data.field} /></label>
    <button type="submit">Filter</button>
  </form>
  <table>
    <caption>Record fields</caption>
    <thead><tr><th scope="col">Name</th><th scope="col">Value</th></tr></thead>
    <tbody>{#each data.record.fields.filter((entry) => entry.name.startsWith(data.field)) as entry}
      <tr><th scope="row">{entry.name}</th><td>{entry.value}</td></tr>
    {/each}</tbody>
  </table>
  <nav aria-label="Related records"><ul>{#each data.record.related as related}
    <li><a href={`/catalog/${encodeURIComponent(related.id)}`}>{related.title}</a></li>
  {/each}</ul></nav>
</article>
