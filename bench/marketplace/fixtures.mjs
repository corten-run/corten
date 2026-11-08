// A deterministic rich application fixture, not preformatted display strings.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function records() {
  const prices = [0, 1, 10, 125, 123450, 123456789, -123450];
  const counts = [0, 1, 2, 1000, 1000000];
  const ratings = [0, 400, 425, 475, 499];
  return Object.fromEntries(Array.from({ length: 500 }, (_, i) => {
    const n = i + 1, id = `item_${n}`;
    const empty = n === 500;
    const record = {
      id, title: n === 17 ? 'Ember <script>globalThis.marketplaceInjected=true</script> & "dragon"' : `Ember dragon ${n}`,
      subtitle: n % 7 ? "First edition" : null,
      description: "Collectible trading card from Ember Reach. Compare sellers, inspect condition and shipping, and set a price alert.",
      categories: empty ? [] : [{ name: "Cards & collectibles", slug: "cards" }, { name: "Ember Reach", slug: "ember-reach" }],
      badges: empty ? [] : ["Rare", "First edition"], tags: empty ? [] : ["foil", "dragon", "collectible"],
      images: empty ? [] : ["/cards/dragon.webp", "/cards/dragon-back.webp"],
      fields: empty ? [] : [{ name: "Set", value: "Ember Reach" }, { name: "Artist", value: "Renée & Sons" }, { name: "Type", value: "Dragon" }, { name: "Collector number", value: `${n}/500` }],
      summary: n % 11 ? { lowest_minor: n % 13 ? prices[i % prices.length] : null, count: counts[i % counts.length], quantity: counts[(i + 2) % counts.length] } : null,
      listings: empty ? [] : Array.from({ length: 25 }, (_, j) => ({ id: `listing_${n}_${j}`, seller: ["Alice", "Bob", "alice", "Renée", '<&"\' +'][j % 5] + ` ${j}`,
        rating_hundredths: j % 6 ? ratings[j % ratings.length] : null, reviews: counts[j % counts.length], condition: j % 2 ? "Near Mint" : "Excellent", ships_from: j % 2 ? "US" : "FR", quantity: j + 1,
        price_minor: j % 9 ? prices[j % prices.length] : null })),
      offers: empty ? [] : Array.from({ length: 12 }, (_, j) => ({ id: `offer_${n}_${j}`, buyer: `Buyer ${j} & Co`, condition: "Near Mint", quantity: j + 1, price_minor: j % 7 ? prices[j % prices.length] : null })),
      contents: empty ? [] : [{ id: `line_${n}`, item_id: `item_${n % 500 + 1}`, title: `Ember dragon ${n % 500 + 1}`, quantity: 2 }],
      included_in: empty ? [] : [{ id: `box_${n}`, item_id: "item_1", title: "Ember collection", quantity: 1000 }],
    };
    return [id, record];
  }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const folder = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "marketplace.json"), JSON.stringify(records()));
}
