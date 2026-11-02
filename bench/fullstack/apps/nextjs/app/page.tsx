import Link from "next/link";
import { shelf } from "@/lib/api";

// Corten's home page: cards for the first 50 items with items in memory, links by id from the item
// API (which cannot list items). Rendered per request, since the items come from the environment.
export const dynamic = "force-dynamic";
export const metadata = { title: "Popular items | Card Market" };

const numbers = Array.from({ length: 50 }, (_, index) => index + 1);

export default function Home() {
  const items = shelf();
  return (
    <>
      <h1>Popular items</h1>
      {items.length > 0 ? (
        <ul className="item-list__list">
          {items.map((item) => (
            <li key={item.id}>
              <Link className="item-card__card" href={`/items/${item.id}`}>
                <strong>{item.title}</strong>
                {item.subtitle ? <span className="item-card__set">{item.subtitle}</span> : null}
                <span className="item-card__from">{item.summary ? `From ${item.summary.lowest ?? "—"}` : "No listings yet"}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="item-list__list item-list__ids">
          {numbers.map((n) => (
            <li key={n}>
              <Link href={`/items/item_${n}`}>{`Item ${n}`}</Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
