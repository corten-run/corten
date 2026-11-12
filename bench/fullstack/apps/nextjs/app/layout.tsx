import Link from "next/link";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { HydrationMark } from "./hydration-mark";
import "./style.css";
import "./components.css";

export const metadata = { title: "Card Market" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Only the matched build needs request-bound nonces on the native not-found route.
  if (process.env.PROFILE === "matched") await connection();
  return (
    <html lang="en">
      <body>
        <header className="site-header__bar">
          <Link href="/">Card Market</Link>
        </header>
        <main>{children}</main>
        <HydrationMark />
      </body>
    </html>
  );
}
