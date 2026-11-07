import { Link, createFileRoute, useLocation } from "@tanstack/react-router";
import { getCatalogRecord } from "../catalog-api";
import { NotFound } from "../not-found";

export const Route = createFileRoute("/catalog/$id")({
  loader: ({ params }) => getCatalogRecord({ data: params.id }),
  staleTime: 0,
  gcTime: 0,
  head: () => ({
    meta: [{ title: "Catalog | Card Market" }],
    links: [{ rel: "stylesheet", href: "/catalog.css" }],
  }),
  notFoundComponent: NotFound,
  component: CatalogPage,
});

function CatalogPage() {
  const record = Route.useLoaderData();
  const field = useLocation({ select: (location) => {
    const value = (location.search as { field?: unknown }).field;
    return typeof value === "string" ? value : "";
  } });
  return (
    <article aria-label="Catalog record">
      <h1>{record.title}</h1>
      <p>{record.subtitle}</p>
      <p>{record.description}</p>
      <ul aria-label="Tags">{record.tags.map((tag, i) => <li key={i}>{tag}</li>)}</ul>
      <form method="get" action={`/catalog/${encodeURIComponent(record.id)}`}>
        <label>Field name <input key={`${record.id}:${field}`} name="field" defaultValue={field} /></label>
        <button type="submit">Filter</button>
      </form>
      <table>
        <caption>Record fields</caption>
        <thead><tr><th scope="col">Name</th><th scope="col">Value</th></tr></thead>
        <tbody>{record.fields.filter((entry) => entry.name.startsWith(field)).map((entry, i) =>
          <tr key={i}><th scope="row">{entry.name}</th><td>{entry.value}</td></tr>
        )}</tbody>
      </table>
      <nav aria-label="Related records"><ul>{record.related.map((related, i) =>
        <li key={i}><Link to="/catalog/$id" params={{ id: related.id }} preload={false}>{related.title}</Link></li>
      )}</ul></nav>
    </article>
  );
}
