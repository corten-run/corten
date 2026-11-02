import { Link, useLoaderData } from "react-router";
import { shelf } from "../api.server";

export const meta = () => [{ title: "Popular items | Card Market" }];

// Corten's home page: cards with items in memory, links by id from the item API.
export function loader() {
  return shelf();
}

const numbers = Array.from({ length: 50 }, (_, index) => index + 1);

export default function Home() {
  const cards = useLoaderData<typeof loader>();
  return (
    <>
      <h1>Popular items</h1>
      {cards.length > 0 ? (
        <ul className="item-list__list">
          {cards.map((card) => (
            <li key={card.id}>
              <Link className="item-card__card" to={`/items/${card.id}`}>
                <strong>{card.title}</strong>
                {card.subtitle ? <span className="item-card__set">{card.subtitle}</span> : null}
                <span className="item-card__from">{card.from}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="item-list__list item-list__ids">
          {numbers.map((n) => (
            <li key={n}>
              <Link to={`/items/item_${n}`}>{`Item ${n}`}</Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
