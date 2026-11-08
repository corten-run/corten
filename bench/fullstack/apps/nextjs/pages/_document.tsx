import { Html, Head, Main, NextScript } from "next/document";
import type { DocumentProps } from "next/document";

export default function Document({ __NEXT_DATA__ }: DocumentProps) {
  return <Html lang={__NEXT_DATA__.props.pageProps.locale ?? "en"}>
    <Head /><body><Main /><NextScript /></body>
  </Html>;
}
