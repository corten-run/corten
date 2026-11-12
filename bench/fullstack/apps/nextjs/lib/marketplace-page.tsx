import { Fragment, useState } from "react";
import { formatters, marketplacePath, sortedListings, type Locale, type MarketplaceQuery, type MarketplaceRecord } from "./marketplace";

export type MarketplaceProps = { record: MarketplaceRecord; locale: Locale; query: MarketplaceQuery; message?: string };
export function Marketplace({ record, locale, query, message = "" }: MarketplaceProps) {
  const [submitted, setSubmitted] = useState<string | null>(null);
  const f = formatters(locale);
  const t = f.labels;
  const money = (minor: number | null) => minor === null ? "\u2014" : f.money.format(minor / 100);
  const path = marketplacePath(locale, record.id);
  const params = new URLSearchParams({ seller: query.seller, sort: query.sort, offers: "all" });
  const offers = query.allOffers ? record.offers : record.offers.slice(0, 5);
  const plural = record.summary ? f.plurals.select(record.summary.count) : "other";
  const listingWord = plural === "one" ? t.listing_one : plural === "many" ? t.listing_many : t.listing_other;
  return <article className="marketplace">
    <nav className="marketplace__categories">{record.categories.map((category, i) =>
      <a key={i} href={marketplacePath(locale, "item_1")}>{category.name}</a>)}</nav>
    <h1>{record.title}</h1>
    {record.subtitle !== null && <p className="marketplace__subtitle">{record.subtitle}</p>}
    <ul className="marketplace__badges">{record.badges.map((badge, i) => <li key={i}>{badge}</li>)}</ul>
    <div className="marketplace__images">{record.images.map((url, i) =>
      <div key={i} className="marketplace__image" role="img" aria-label={record.title + " " + (i + 1)} data-src={url} />)}</div>
    <section className="marketplace__summary">{record.summary ? <>
      <span><strong>{money(record.summary.lowest_minor)}</strong>{" "}{t.lowest}</span>
      <span>{f.count.format(record.summary.count)}{" "}{listingWord}</span>
      <span>{f.count.format(record.summary.quantity)}{" "}{t.available}</span>
    </> : <span>{t.no_listings}</span>}</section>
    <section className="marketplace__listings">
      <h2>{t.listings}</h2>
      <form method="get" action={path}>
        <label>{t.filter}<input key={query.seller} name="seller" type="text" defaultValue={query.seller} /></label>
        <label>{t.sort}<select key={query.sort} name="sort" defaultValue={query.sort}>
          <option value="asc">{t.asc}</option><option value="desc">{t.desc}</option>
        </select></label>
        {query.allOffers && <input type="hidden" name="offers" value="all" />}
        <button type="submit">{t.apply}</button>
      </form>
      <table><thead><tr>{[t.seller, t.condition, t.ships_from, t.qty, t.price, t.reviews].map((label, i) =>
        <th scope="col" key={i}>{label}</th>)}</tr></thead>
        <tbody>{sortedListings(record, query).map((row) => <tr key={row.id} data-listing-id={row.id}>
          <td>{row.seller}{row.rating_hundredths !== null && (" \u00b7 " + f.rating.format(row.rating_hundredths / 100) + " \u2605")}</td>
          <td>{row.condition}</td><td>{row.ships_from}</td><td>{f.count.format(row.quantity)}</td>
          <td>{money(row.price_minor)}</td><td>{f.count.format(row.reviews)}</td>
        </tr>)}</tbody>
      </table>
    </section>
    <section className="marketplace__offers">
      <h2>{t.offers}</h2>
      <table><thead><tr>{[t.buyer, t.condition, t.qty, t.price].map((label, i) =>
        <th key={i} scope="col">{label}</th>)}</tr></thead>
        <tbody>{offers.map((row) => <tr key={row.id} data-offer-id={row.id}>
          <td>{row.buyer}</td><td>{row.condition}</td><td>{f.count.format(row.quantity)}</td><td>{money(row.price_minor)}</td>
        </tr>)}</tbody>
      </table>
      {!query.allOffers && record.offers.length > 5 && <a className="marketplace__more" href={path + "?" + params}>{t.show_all}</a>}
    </section>
    <section className="marketplace__alert">
      <h2>{t.alert}</h2>
      <form method="post" onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        try {
          const response = await fetch("/api/marketplace/" + encodeURIComponent(record.id) + "?locale=" + locale, {
            method: "POST", body: new URLSearchParams({
              email: String(form.get("email") ?? ""), target_price: String(form.get("target_price") ?? ""),
            }),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error ?? response.statusText);
          setSubmitted(result.message);
        } catch (error) {
          setSubmitted(error instanceof Error ? error.message : "Request failed");
        }
      }} action={path + (query.seller || query.sort !== "asc" || query.allOffers
        ? "?" + new URLSearchParams({ seller: query.seller, sort: query.sort, ...(query.allOffers ? { offers: "all" } : {}) }) : "")}>
        <label>{t.email}<input name="email" type="email" /></label>
        <label>{t.target}<input name="target_price" type="text" inputMode="decimal" /></label>
        <button type="submit">{t.submit}</button>
      </form>
      <p className="marketplace__message" aria-live="polite">{submitted ?? message}</p>
    </section>
    <section className="marketplace__details">
      <h2>{t.details}</h2><p>{record.description}</p>
      <dl>{record.fields.map((field, i) => <Fragment key={i}><dt>{field.name}</dt><dd>{field.value}</dd></Fragment>)}</dl>
      <ul>{record.tags.map((tag, i) => <li key={i}>{tag}</li>)}</ul>
    </section>
    {([["marketplace__contents", t.contents, record.contents], ["marketplace__included", t.included, record.included_in]] as const).map(([className, title, lines]) =>
      <section className={className} key={className}><h2>{title}</h2><ul>{lines.map((line) =>
        <li key={line.id}><a href={marketplacePath(locale, line.item_id)}>{line.title}</a>{" \u00d7 "}{f.count.format(line.quantity)}</li>)}</ul></section>)}
  </article>;
}
