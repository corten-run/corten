import { randomBytes } from "node:crypto";

export type Alert = { item_id: string; email: string; target_minor: number };
type Session = { expires: number; alerts: Alert[] };
export const alertCookie = "tanstack_start_alerts";
export const alertLifetime = 3600;
// Route bundles in the same native server must address the same app-local sessions.
const server = globalThis as typeof globalThis & { __tanstackStartAlerts?: Map<string, Session> };
const sessions = server.__tanstackStartAlerts ??= new Map<string, Session>();

function findSession(token: string | undefined) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
  const session = sessions.get(token);
  if (session && session.expires > Date.now()) return session;
  sessions.delete(token);
  return undefined;
}
export function ensureSession(token: string | undefined): string {
  if (findSession(token)) return token!;
  for (const [id, session] of sessions) if (session.expires <= Date.now()) sessions.delete(id);
  if (sessions.size >= 10000) throw new Error("Alert session capacity exceeded");
  const id = randomBytes(32).toString("hex");
  sessions.set(id, { expires: Date.now() + alertLifetime * 1000, alerts: [] });
  return id;
}
export function readAlerts(token: string | undefined): Alert[] {
  return findSession(token)?.alerts.map((alert) => ({ ...alert })) ?? [];
}
export function appendAlert(token: string | undefined, alert: Alert): string {
  const id = ensureSession(token);
  const session = sessions.get(id)!;
  if (session.alerts.length >= 1000) throw new Error("Alert capacity exceeded");
  session.alerts.push({ ...alert });
  return id;
}
