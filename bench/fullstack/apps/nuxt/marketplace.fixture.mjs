export function marketplaceRecord() {
  const prices = [0, 1, 10, 125, 123450, 123456789, -123450, null, 125];
  return {
    id: "item_1", title: '<script>&" Ember', subtitle: "", description: '<b>Plain & "text"</b>',
    categories: [{ name: "Cards & decks", slug: "cards" }], badges: ["Rare", "<foil>"], tags: ["foil", "&"],
    images: ["/cards/dragon.webp", "https://invalid.example/image?x=1&y=2"],
    fields: [{ name: "<Set>", value: 'Ember "Reach"' }],
    summary: { lowest_minor: -123450, count: 1000000, quantity: 12345 },
    listings: prices.map((price_minor, i) => ({
      id: `listing_${i}`, seller: i === 8 ? " Alice" : i === 7 ? "alice" : `Alice ${i}`,
      rating_hundredths: [0, 400, 425, 475, 499, null, 425, null, 400][i],
      reviews: 1234, condition: "Near Mint", ships_from: "US", quantity: 1000, price_minor,
    })),
    offers: prices.slice(0, 8).map((price_minor, i) => ({
      id: `offer_${i}`, buyer: `Buyer ${i}`, condition: "Mint", quantity: 1000, price_minor,
    })),
    contents: [{ id: "line_1", item_id: "item_2", title: "Other & card", quantity: 1234 }],
    included_in: [{ id: "line_2", item_id: "item_3", title: "Deck", quantity: 2 }],
  };
}
export function marketplaceFixture() {
  return { item_1: marketplaceRecord(), item_2: { ...marketplaceRecord(), id: "item_2", title: "Empty item",
    subtitle: null, summary: null, categories: [], badges: [], tags: [], fields: [], images: [],
    listings: [], offers: [], contents: [], included_in: [],
  } };
}
