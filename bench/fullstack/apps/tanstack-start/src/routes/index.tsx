import { Link, createFileRoute } from "@tanstack/react-router";
import { getShelf } from "../item-api";

const numbers = Array.from({ length: 50 }, (_, index) => index + 1);

// Corten's home page: cards with items in memory, links by id from the item API.
export const Route = createFileRoute("/")({
  loader: () => getShelf(),
  head: () => ({ meta: [{ title: "Popular items | Card Market" }] }),
  component: Home,
});

function Home() {
  const cards = Route.useLoaderData();
  return (
    <>
      <h1>Popular items</h1>
      {cards.length > 0 ? (
        <ul className="item-list__list">
          {cards.map((card) => (
            <li key={card.id}>
              <Link className="item-card__card" to="/items/$id" params={{ id: card.id }}>
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
              <Link to="/items/$id" params={{ id: `item_${n}` }}>{`Item ${n}`}</Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
