import { Fragment, useState } from "react";
import { data, Form, Link, useActionData, useLoaderData, useSearchParams, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { fetchItem } from "../api.server";
import { NotFound } from "../not-found";
import { alertMessage, counted, sortListings, type ItemView } from "../view-model";

export async function loader({ params }: LoaderFunctionArgs) {
  const item = await fetchItem(params.id ?? "");
  return item ? item : data(null, { status: 404 });
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  return { message: alertMessage(String(form.get("title") ?? ""), String(form.get("email") ?? ""), String(form.get("target_price") ?? "")) };
}

// Match the Leptos ServerAction, which does not refetch the item after a submit.
export const shouldRevalidate = ({ formMethod, defaultShouldRevalidate }: { formMethod?: string; defaultShouldRevalidate: boolean }) =>
  formMethod ? false : defaultShouldRevalidate;

export const meta = ({ data: item }: { data: ItemView | null }) => [{ title: item ? `${item.title} | Card Market` : "Not found | Card Market" }];

export default function ItemRoute() {
  const item = useLoaderData<typeof loader>() as ItemView | null;
  if (!item) return <NotFound />;
  return <ItemDetail item={item} />;
}

function ItemDetail({ item }: { item: ItemView }) {
  const [descending, setDescending] = useState(false);
  // "Show all" without JavaScript (or before hydration) loads the page with ?offers=all.
  const [searchParams] = useSearchParams();
  const [showAllOffers, setShowAllOffers] = useState(searchParams.get("offers") === "all");
  const actionData = useActionData<typeof action>();
  const listings = sortListings(item.listings, descending);
  const offers = showAllOffers ? item.offers : item.offers.slice(0, 5);
  return (
    <article>
      <div className="item-detail__top">
        <div className="item-detail__intro">
          <nav className="item-detail__crumbs">
            {item.categories.map((c) => (
              <a key={c.slug} href={`/categories/${c.slug}`}>{c.name}</a>
            ))}
          </nav>
          <h1>{item.title}</h1>
          {item.subtitle ? <p className="item-detail__subtitle">{item.subtitle}</p> : null}
          <ul className="item-detail__chips">
            {item.badges.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
        {item.images.length > 0 ? (
          <div className="item-detail__gallery">
            {item.images.map((url, i) => (
              <div key={url} className="item-detail__image" role="img" aria-label={`${item.title} image ${i + 1}`} data-src={url}></div>
            ))}
          </div>
        ) : null}
        <section className="item-detail__panel item-detail__summary gap-3 sm:gap-5">
          {item.summary ? (
            <>
              <span><strong>{item.summary.lowest ?? "—"}</strong>{" lowest"}</span>
              <span>{counted(item.summary.count, "listing", "listings")}</span>
              <span>{counted(item.summary.quantity, "available", "available")}</span>
            </>
          ) : (
            <span>No listings yet</span>
          )}
        </section>
      </div>
      <section className="item-detail__panel">
        <h2>Listings</h2>
        <button type="button" onClick={() => setDescending((d) => !d)}>
          <span hidden={descending}>Price: low to high</span>
          <span hidden={!descending}>Price: high to low</span>
        </button>
        <table>
          <thead>
            <tr><th>Seller</th><th>Condition</th><th>Ships from</th><th>Qty</th><th>Price</th></tr>
          </thead>
          <tbody>
            {listings.map((l) => (
              <tr key={l.id}>
                <td>{l.seller + (l.rating ? ` · ${l.rating} ★ (${l.reviews})` : "")}</td>
                <td>{l.condition}</td>
                <td>{l.ships_from}</td>
                <td>{l.quantity}</td>
                <td className="price__amount">{l.price}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="item-detail__panel">
        <h2>Offers</h2>
        <table>
          <thead>
            <tr><th>Buyer</th><th>Condition</th><th>Qty</th><th>Price</th></tr>
          </thead>
          <tbody>
            {offers.map((o) => (
              <tr key={o.id}>
                <td>{o.buyer}</td>
                <td>{o.condition}</td>
                <td>{o.quantity}</td>
                <td className="price__amount">{o.price}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {item.offers.length > 5 && !showAllOffers ? (
          <form
            method="get"
            action={`/items/${item.id}`}
            onSubmit={(event) => {
              event.preventDefault();
              setShowAllOffers(true);
            }}
          >
            <button name="offers" value="all">{`Show all ${item.offers.length} offers`}</button>
          </form>
        ) : null}
      </section>
      <section className="item-detail__panel">
        <h2>Price alert</h2>
        <div className="alert-form__form">
          <Form method="post">
            <input type="hidden" name="item_id" value={item.id} />
            <input type="hidden" name="title" value={item.title} />
            <label>Email<input type="email" name="email" required /></label>
            <label>Alert me below<input type="text" name="target_price" inputMode="decimal" required /></label>
            <button type="submit">Set alert</button>
          </Form>
        </div>
        <p className="alert-form__message" id="alert-message" aria-live="polite">{actionData?.message ?? ""}</p>
      </section>
      <section className="item-detail__panel">
        <h2>Details</h2>
        <p>{item.description}</p>
        <dl>
          {item.fields.map((f, i) => (
            <Fragment key={i}><dt>{f.name}</dt><dd>{f.value}</dd></Fragment>
          ))}
        </dl>
        {item.tags.length > 0 ? (
          <ul className="item-detail__chips">
            {item.tags.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        ) : null}
      </section>
      {item.contents.length > 0 ? <ContentList title="Contents" lines={item.contents} /> : null}
      {item.included_in.length > 0 ? <ContentList title="Included in" lines={item.included_in} /> : null}
    </article>
  );
}

function ContentList({ title, lines }: { title: string; lines: ItemView["contents"] }) {
  return (
    <section className="item-detail__panel">
      <h2>{title}</h2>
      <ul>
        {lines.map((c) => (
          <li key={c.id}>
            <Link to={`/items/${c.item_id}`}>{c.title}</Link>
            {` × ${c.quantity}`}
          </li>
        ))}
      </ul>
    </section>
  );
}
