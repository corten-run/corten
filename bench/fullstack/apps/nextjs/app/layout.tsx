import Link from "next/link";
import type { ReactNode } from "react";
import { HydrationMark } from "./hydration-mark";
import "./style.css";
import "./components.css";

export const metadata = { title: "Card Market" };

export default function RootLayout({ children }: { children: ReactNode }) {
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
