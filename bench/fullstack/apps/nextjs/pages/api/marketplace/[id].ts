import type { NextApiRequest, NextApiResponse } from "next";
import { fetchMarketplaceRecord } from "../../../lib/marketplace-server";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "method not allowed" });
  }
  try {
    const record = await fetchMarketplaceRecord(String(req.query.id ?? ""));
    return record ? res.json(record) : res.status(404).json({ error: "not found" });
  } catch {
    return res.status(502).json({ error: "marketplace source failed" });
  }
}
