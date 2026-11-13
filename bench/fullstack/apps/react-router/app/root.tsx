import { useEffect } from "react";
import { Link, Links, Meta, Outlet, Scripts, useLocation, type HeadersFunction } from "react-router";
import components from "./components.css?url";
import styles from "./style.css?url";

export const links = () => [
  { rel: "stylesheet", href: styles },
  { rel: "stylesheet", href: components },
];

export const headers: HeadersFunction = ({ parentHeaders, errorHeaders }) => {
  const allow = errorHeaders?.get("Allow");
  if (!allow) return parentHeaders;
  const headers = new Headers(parentHeaders);
  headers.set("Allow", allow);
  return headers;
};

export function Layout({ children }: { children: React.ReactNode }) {
  const locale = useLocation().pathname.match(/^\/marketplace\/(en-US|fr-FR|de-DE)\//)?.[1] ?? "en";
  return (
    <html lang={locale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <header className="site-header__bar">
          <Link to="/">Card Market</Link>
        </header>
        <main>{children}</main>
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  // Effects run after hydration commits; the browser benchmark reads this mark.
  useEffect(() => {
    (window as unknown as { __hydratedAt?: number }).__hydratedAt = performance.now();
  }, []);
  return <Outlet />;
}
