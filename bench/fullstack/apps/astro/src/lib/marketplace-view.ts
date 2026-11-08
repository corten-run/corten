import labels from "./marketplace-labels.json" with { type: "json" };

export const locales = ["en-US", "fr-FR", "de-DE"] as const;
export type Locale = typeof locales[number];
export type MarketplaceRecord = {
  id: string; title: string; subtitle: string | null; description: string;
  categories: { name: string; slug: string }[]; badges: string[]; tags: string[];
  images: string[]; fields: { name: string; value: string }[];
  summary: { lowest_minor: number | null; count: number; quantity: number } | null;
  listings: { id: string; seller: string; rating_hundredths: number | null; reviews: number;
    condition: string; ships_from: string; quantity: number; price_minor: number | null }[];
  offers: { id: string; buyer: string; condition: string; quantity: number; price_minor: number | null }[];
  contents: { id: string; item_id: string; title: string; quantity: number }[];
  included_in: { id: string; item_id: string; title: string; quantity: number }[];
};
export function isLocale(locale: string): locale is Locale {
  return locales.includes(locale as Locale);
}
const formatters = new Map(locales.map((locale) => [locale, {
  money: new Intl.NumberFormat(locale, { style: "currency", currency: "USD", currencyDisplay: "symbol",
    useGrouping: true, minimumFractionDigits: 2, maximumFractionDigits: 2, roundingMode: "halfExpand" }),
  rating: new Intl.NumberFormat(locale, { useGrouping: true, minimumFractionDigits: 0,
    maximumFractionDigits: 1, roundingMode: "halfExpand" }),
  count: new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 }),
  plurals: new Intl.PluralRules(locale, { type: "cardinal" }),
}]));
export function marketplacePath(locale: Locale, id: string) {
  return `/marketplace/${locale}/${encodeURIComponent(id)}`;
}
export function alertMessage(locale: Locale, title: string, email: string, target: string): string {
  const words = labels[locale];
  if (!email.includes("@")) return words.invalid_email;
  // Discover the decimal separator through Intl; grouping is deliberately not accepted.
  const decimal = formatters.get(locale)!.money.formatToParts(1.1).find((part) => part.type === "decimal")!.value;
  const text = target.trim();
  const pattern = decimal === "." ? /^\d+(?:\.\d+)?$/ : /^\d+(?:,\d+)?$/;
  if (!pattern.test(text)) return words.invalid_price;
  const amount = Number(text.replace(decimal, "."));
  if (!Number.isFinite(amount) || amount <= 0) return words.invalid_price;
  const values: Record<string, string> = { email, title, price: formatters.get(locale)!.money.format(amount) };
  return words.alert_set.replace(/\{(email|title|price)\}/g, (_, key: string) => values[key]!);
}
export function marketplaceView(record: MarketplaceRecord, locale: Locale, query: URLSearchParams) {
  const words = labels[locale];
  const fmt = formatters.get(locale)!;
  const money = (minor: number | null) => minor === null ? "\u2014" : fmt.money.format(minor / 100);
  const count = (value: number) => fmt.count.format(value);
  const seller = query.get("seller") ?? "";
  const sort = query.get("sort") === "desc" ? "desc" : "asc";
  const allOffers = query.get("offers") === "all";
  const path = marketplacePath(locale, record.id);
  const more = new URLSearchParams({ seller, sort, offers: "all" });
  const listings = record.listings.filter((row) => row.seller.startsWith(seller)).sort((a, b) => {
    if (a.price_minor === null) return b.price_minor === null ? 0 : 1;
    if (b.price_minor === null) return -1;
    return (a.price_minor - b.price_minor) * (sort === "desc" ? -1 : 1);
  }).map((row) => ({ ...row,
    sellerText: row.seller + (row.rating_hundredths === null ? "" : ` \u00b7 ${fmt.rating.format(row.rating_hundredths / 100)} \u2605`),
    quantityText: count(row.quantity), priceText: money(row.price_minor), reviewsText: count(row.reviews),
  }));
  const summary = record.summary === null ? null : {
    lowest: money(record.summary.lowest_minor),
    count: `${count(record.summary.count)} ${words[`listing_${fmt.plurals.select(record.summary.count)}` as keyof typeof words] ?? words.listing_other}`,
    quantity: count(record.summary.quantity),
  };
  return { record, locale, words, seller, sort, path, listings, summary,
    offers: (allOffers ? record.offers : record.offers.slice(0, 5)).map((row) => ({
      ...row, quantityText: count(row.quantity), priceText: money(row.price_minor),
    })),
    more: !allOffers && record.offers.length > 5 ? `${path}?${more}` : null,
    contents: record.contents.map((row) => ({ ...row, href: marketplacePath(locale, row.item_id), quantityText: count(row.quantity) })),
    included: record.included_in.map((row) => ({ ...row, href: marketplacePath(locale, row.item_id), quantityText: count(row.quantity) })),
  };
}
