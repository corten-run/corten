import { randomBytes } from "node:crypto";

const cookieName = "marketplace-alerts";
const sessions = new Map();

function session(req) {
  const value = req.headers.cookie?.split(";").map((pair) => pair.trim()).find((pair) => pair.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

export function readAlerts(req, res) {
  res.set("Cache-Control", "no-store").json(sessions.get(session(req)) ?? []);
}

export function appendAlert(req, res, alert) {
  let id = session(req);
  let rows = sessions.get(id);
  if (!rows) {
    do { id = randomBytes(32).toString("hex"); } while (sessions.has(id));
    rows = [];
    // No Domain or persistent expiry: a host-only browser session cookie.
    res.cookie(cookieName, id, { httpOnly: true, sameSite: "lax", secure: req.secure, path: "/" });
    sessions.set(id, rows);
  }
  // No await between lookup and append: Node's event loop serializes each operation.
  rows.push(alert);
}
