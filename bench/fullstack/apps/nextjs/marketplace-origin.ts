export function parseMarketplacePublicOrigin(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  const url = URL.parse(value);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== value ||
      !/^(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])$/.test(url.hostname) || url.port === "0") {
    throw new Error("MARKETPLACE_PUBLIC_ORIGIN must be an exact HTTP(S) origin");
  }
  return url;
}

const publicOrigin = parseMarketplacePublicOrigin(process.env.MARKETPLACE_PUBLIC_ORIGIN);

export function publicOriginForHost(host: string | undefined): URL | undefined {
  return publicOrigin?.host === host ? publicOrigin : undefined;
}
