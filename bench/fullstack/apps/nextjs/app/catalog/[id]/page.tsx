import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchCatalogRecord } from "@/lib/catalog";

export const dynamic = "force-dynamic";
export const metadata = { title: "Catalog | Card Market" };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ field?: string | string[] }>;
};

export default async function CatalogPage({ params, searchParams }: Props) {
  const record = await fetchCatalogRecord((await params).id);
  if (!record) notFound();
  const query = (await searchParams).field;
  const field = (Array.isArray(query) ? query[0] : query) ?? "";
  return (
    <>
      <link rel="stylesheet" href="/catalog.css" />
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
        <li key={i}><Link href={`/catalog/${encodeURIComponent(related.id)}`} prefetch={false}>{related.title}</Link></li>
      )}</ul></nav>
    </article>
    </>
  );
}
