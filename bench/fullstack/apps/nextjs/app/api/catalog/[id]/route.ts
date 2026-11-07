import { fetchCatalogRecord } from "@/lib/catalog";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const record = await fetchCatalogRecord((await params).id);
  return record ? Response.json(record) : Response.json({ error: "not found" }, { status: 404 });
}
