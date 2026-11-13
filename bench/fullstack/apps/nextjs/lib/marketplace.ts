import labels from "./marketplace-labels.json" with { type: "json" };

export type Locale = keyof typeof labels;
export type MarketplaceRecord = {
  id: string; title: string; subtitle: string | null; description: string;
  categories: { name: string; slug: string }[];
  badges: string[]; tags: string[]; images: string[];
  fields: { name: string; value: string }[];
  summary: { lowest_minor: number | null; count: number; quantity: number } | null;
  listings: { id: string; seller: string; rating_hundredths: number | null; reviews: number;
    condition: string; ships_from: string; quantity: number; price_minor: number | null }[];
  offers: { id: string; buyer: string; condition: string; quantity: number; price_minor: number | null }[];
  contents: { id: string; item_id: string; title: string; quantity: number }[];
  included_in: { id: string; item_id: string; title: string; quantity: number }[];
};
export function isLocale(value: string): value is Locale {
  return Object.hasOwn(labels, value);
}
function createFormatters(locale: Locale) {
  return {
    labels: labels[locale],
    money: new Intl.NumberFormat(locale, { style: "currency", currency: "USD", currencyDisplay: "symbol",
      useGrouping: true, minimumFractionDigits: 2, maximumFractionDigits: 2, roundingMode: "halfExpand" }),
    rating: new Intl.NumberFormat(locale, { useGrouping: true, minimumFractionDigits: 0,
      maximumFractionDigits: 1, roundingMode: "halfExpand" }),
    count: new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 }),
    plurals: new Intl.PluralRules(locale, { type: "cardinal" }),
  };
}
const formats = new Map<Locale, ReturnType<typeof createFormatters>>();
export function formatters(locale: Locale) {
  let result = formats.get(locale);
  if (!result) {
    result = createFormatters(locale);
    formats.set(locale, result);
  }
  return result;
}
export type MarketplaceQuery = { seller: string; sort: "asc" | "desc"; allOffers: boolean };
export function readQuery(query: URLSearchParams): MarketplaceQuery {
  return { seller: query.get("seller") ?? "", sort: query.get("sort") === "desc" ? "desc" : "asc",
    allOffers: query.get("offers") === "all" };
}
export function marketplacePath(locale: Locale, id: string) {
  return "/marketplace/" + locale + "/" + encodeURIComponent(id);
}
export function sortedListings(record: MarketplaceRecord, query: MarketplaceQuery) {
  return record.listings.filter((row) => row.seller.startsWith(query.seller)).sort((a, b) => {
    if (a.price_minor === null) return b.price_minor === null ? 0 : 1;
    if (b.price_minor === null) return -1;
    return (a.price_minor - b.price_minor) * (query.sort === "desc" ? -1 : 1);
  });
}
// Intl exposes decimal symbols, but not a parser. Accept ungrouped decimals only
// instead of guessing whether a separator means grouping or a fraction.
export function targetMinor(locale: Locale, text: string): number | null {
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === "decimal")!.value;
  const escaped = decimal === "." ? "\\." : decimal;
  if (!new RegExp("^\\d+(?:" + escaped + "\\d{1,2})?$").test(text)) return null;
  const [whole, fraction = ""] = text.split(decimal);
  const digits = (whole + fraction.padEnd(2, "0")).replace(/^0+/, "");
  if (digits.length > 16) return null;
  const minor = Number(digits);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}
export function alertMessage(locale: Locale, title: string, form: FormData | URLSearchParams): string {
  const f = formatters(locale);
  const email = String(form.get("email") ?? "");
  if (!email.includes("@")) return f.labels.invalid_email;
  const minor = targetMinor(locale, String(form.get("target_price") ?? ""));
  if (minor === null) return f.labels.invalid_price;
  const digits = String(minor).padStart(3, "0");
  const price = f.money.format(`${digits.slice(0, -2)}.${digits.slice(-2)}` as `${number}`);
  const replacements: Record<string, string> = { email, title, price };
  return f.labels.alert_set.replace(/\{(email|title|price)\}/g, (_, name: string) => replacements[name]);
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return request.headers.get("sec-fetch-site") !== "cross-site" &&
    (origin === null || origin === new URL(request.url).origin);
}
