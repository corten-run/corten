import { createCookie } from "react-router";
import { alertCookie, alertLifetime } from "./alerts.server";

export const sessionCookie = createCookie(alertCookie, {
  path: "/", httpOnly: true, sameSite: "lax", maxAge: alertLifetime,
});
