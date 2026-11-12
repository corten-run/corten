import type { NextApiRequest, NextApiResponse } from "next";
import type { MarketplaceRecord } from "../../../lib/marketplace";
import { fetchMarketplaceRecord } from "../../../lib/marketplace-server";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method === "POST") {
    const { isLocale, sameOrigin } = await import("../../../lib/marketplace");
    const { submitAlert } = await import("../../../lib/alerts-http");
    const locale = String(req.query.locale ?? "");
    if (!isLocale(locale)) return res.status(400).json({ error: "Unsupported locale" });
    const protocol = (req.socket as { encrypted?: boolean }).encrypted ? "https:" : "http:";
    const headers = new Headers();
    for (const name of ["origin", "sec-fetch-site"]) {
      const value = req.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    if (!sameOrigin(new Request(protocol + "//" + req.headers.host + req.url, { headers })))
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
    return res.json({ message: submitAlert(req, res, locale, record, form) });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD, POST");
    return res.status(405).json({ error: "method not allowed" });
  }
  try {
    const record = await fetchMarketplaceRecord(String(req.query.id ?? ""));
    return record ? res.json(record) : res.status(404).json({ error: "not found" });
  } catch {
    return res.status(502).json({ error: "marketplace source failed" });
  }
}
