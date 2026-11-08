import Head from "next/head";
import type { GetServerSideProps } from "next";
import { Marketplace, type MarketplaceProps } from "../../../lib/marketplace-page";
import { alertMessage, isLocale, readQuery, sameOrigin } from "../../../lib/marketplace";
import { fetchMarketplaceRecord } from "../../../lib/marketplace-server";

type Props = MarketplaceProps | { error: string; locale: string };
export const getServerSideProps: GetServerSideProps<Props> = async ({ params, req, res, resolvedUrl }) => {
  const locale = String(params?.locale ?? "");
  res.setHeader("Cache-Control", "private, no-store");
  if (!isLocale(locale)) {
    res.statusCode = 400;
    return { props: { error: "Unsupported locale", locale: "en" } };
  }
  const url = new URL(resolvedUrl, "http://" + req.headers.host);
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD, POST");
    return { props: { error: "Method not allowed", locale } };
  }
  let form: URLSearchParams | undefined;
  if (req.method === "POST") {
    const headers = new Headers();
    for (const name of ["origin", "sec-fetch-site"]) {
      const value = req.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const requestUrl = new URL(url);
    requestUrl.protocol = (req.socket as { encrypted?: boolean }).encrypted ? "https:" : "http:";
    if (!sameOrigin(new Request(requestUrl, { headers }))) {
      res.statusCode = 403;
      return { props: { error: "Forbidden", locale } };
    }
    if (!(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) {
      res.statusCode = 415;
      return { props: { error: "Expected form data", locale } };
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > 65536) {
        res.statusCode = 413;
        return { props: { error: "Form too large", locale } };
      }
      chunks.push(buffer);
    }
    form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }
  const record = await fetchMarketplaceRecord(String(params?.id ?? ""));
  if (!record) return { notFound: true };
  return { props: { record, locale, query: readQuery(url.searchParams),
    message: form ? alertMessage(locale, record.title, form) : "" } };
};

export default function MarketplacePage(props: Props) {
  if ("error" in props) return <h1>{props.error}</h1>;
  return <><Head><title>{props.record.title} | Card Market</title>
    <link rel="stylesheet" href="/marketplace.css" /></Head><Marketplace {...props} /></>;
}
