import type { NextApiRequest, NextApiResponse } from "next";
import { isLocale, type MarketplaceRecord } from "../../../../lib/marketplace";
import { fetchMarketplaceRecord } from "../../../../lib/marketplace-server";
import { marketplaceFormIsSameOrigin, submitAlert } from "../../../../lib/alerts-http";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }
  const locale = String(req.query.locale ?? "");
  if (!isLocale(locale)) return res.status(400).json({ error: "Unsupported locale" });
  const protocol = (req.socket as { encrypted?: boolean }).encrypted ? "https:" : "http:";
  if (!marketplaceFormIsSameOrigin(req, protocol + "//" + req.headers.host + req.url))
    return res.status(403).json({ error: "Forbidden" });
  if (!(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded"))
    return res.status(415).json({ error: "Expected form data" });
  let record: MarketplaceRecord | null;
  try {
    record = await fetchMarketplaceRecord(String(req.query.id ?? ""));
  } catch {
    return res.status(502).json({ error: "marketplace source failed" });
  }
  if (!record) return res.status(404).json({ error: "not found" });
  const form = new URLSearchParams();
  for (const name of ["email", "target_price"]) form.set(name, typeof req.body?.[name] === "string" ? req.body[name] : "");
  try {
    return res.json({ message: submitAlert(req, res, locale, record, form) });
  } catch (error) {
    if (error instanceof URIError) return res.status(502).json({ error: "marketplace source failed" });
    throw error;
  }
}
