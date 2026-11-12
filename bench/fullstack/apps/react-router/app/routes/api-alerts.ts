import { data, type LoaderFunctionArgs } from "react-router";
import { ensureSession, readAlerts } from "../alerts.server";
import { sessionCookie } from "../alert-cookie.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const previous = await sessionCookie.parse(request.headers.get("Cookie"));
  const token = ensureSession(previous);
  const headers = new Headers({ "Cache-Control": "private, no-store" });
  if (token !== previous) headers.append("Set-Cookie", await sessionCookie.serialize(token, {
    secure: new URL(request.url).protocol === "https:",
  }));
  return data(readAlerts(token), { headers });
}
