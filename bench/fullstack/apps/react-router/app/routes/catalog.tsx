import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { fetchCatalogRecord } from "../catalog.server";

export const links = () => [{ rel: "stylesheet", href: "/catalog.css" }];
export const meta = () => [{ title: "Catalog | Card Market" }];

export async function loader({ params, request }: LoaderFunctionArgs) {
  const record = await fetchCatalogRecord(params.id ?? "");
  if (!record) throw new Response("Not found", { status: 404 });
  return { record, field: new URL(request.url).searchParams.get("field") ?? "" };
}

export default function CatalogPage() {
  const { record, field } = useLoaderData<typeof loader>();
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
        <li key={i}><Link to={`/catalog/${encodeURIComponent(related.id)}`}>{related.title}</Link></li>
      )}</ul></nav>
    </article>
  );
}
