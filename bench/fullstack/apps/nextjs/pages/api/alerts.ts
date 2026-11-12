import type { NextApiRequest, NextApiResponse } from "next";
import { alertsFor } from "../../lib/alerts-http";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "method not allowed" });
  }
  return res.json(alertsFor(req, res));
}
