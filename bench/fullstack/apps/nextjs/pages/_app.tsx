import type { AppProps } from "next/app";
import "../app/style.css";
import "../app/components.css";

export default function MarketplaceApp({ Component, pageProps }: AppProps) {
  return <><header className="site-header__bar"><a href="/">Card Market</a></header>
    <main><Component {...pageProps} /></main></>;
}
