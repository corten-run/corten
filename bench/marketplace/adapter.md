# Marketplace v2 adapter contract

This is the implementation contract for the eighteen adapters. Existing item/catalog routes
remain unchanged. V2 is a separate workload, with a new baseline, not a rewrite of old results.

## Routes and data

- `GET /marketplace/{locale}/{id}` renders the complete item page. Locale is exactly `en-US`,
  `fr-FR`, or `de-DE`. Unsupported locale is 400; unknown item is 404. No header negotiation.
- `POST /marketplace/{locale}/{id}` accepts form-encoded `email` and `target_price` and renders
  that page with an alert result. Use ordinary framework form handling; keep CSRF protections.
- `GET /api/marketplace/{id}` returns the entire numeric record below as JSON, unformatted,
  with no extra/missing keys. Unknown item is 404. JSON is independent of locale.
- `MARKETPLACE_SOURCE=fixture`: read a JSON object keyed by ID from
  `MARKETPLACE_FIXTURE_PATH` (default `/fixtures/marketplace.json`) once at startup. Typed
  records may be constructed at startup, but no formatted values, HTML, or serialized answers
  may be cached. Page formatting happens on every request; JSON uses the native serializer.
- Otherwise fetch `${API_BASE}/marketplace/records/{id}` exactly once per page or JSON request,
  parse it, and render/serialize it. No record/response cache or upstream JSON pass-through.
  Upstream 404 becomes 404, other upstream errors and redirects become 5xx. Do not follow
  redirects: that would fetch more than once. URL-encode the ID.

The complete numeric wire record (all keys required, empty arrays and nulls are meaningful):

```json
{
  "id": "item_1", "title": "Ember dragon", "subtitle": "First edition", "description": "A trading card.",
  "categories": [{"name": "Cards", "slug": "cards"}], "badges": ["Rare"], "tags": ["foil"],
  "images": ["/cards/dragon.webp"], "fields": [{"name": "Set", "value": "Ember Reach"}],
  "summary": {"lowest_minor": 123450, "count": 12, "quantity": 25},
  "listings": [{"id": "listing_1", "seller": "Alice", "rating_hundredths": 425,
    "reviews": 1234, "condition": "Near Mint", "ships_from": "US", "quantity": 2, "price_minor": 123450}],
  "offers": [{"id": "offer_1", "buyer": "Bob", "condition": "Near Mint", "quantity": 3, "price_minor": 120000}],
  "contents": [{"id": "line_1", "item_id": "item_2", "title": "Another card", "quantity": 2}],
  "included_in": []
}
```

`subtitle`, `summary`, `summary.lowest_minor`, `listing.rating_hundredths`, and listing/offer
`price_minor` may be null. All other strings/arrays are required. Money is signed integral USD
minor units; ratings are 0..500 hundredths. All counts are nonnegative integers. Content text,
condition names and field names are data, shown unchanged, not silently translated.

## Page structure

Use the framework's ordinary templates/components, escaping all data. Static translation
catalogs are allowed to be copied from `labels.json`; formatting or expected HTML from the test
oracle must never be imported by an adapter. Use native localization APIs or an established
library. Reusing formatter objects is allowed; manually adding `$` or swapping decimal marks
is not a locale formatter. Required exact numeric formatting is in `contract.mjs`.

Use the shared `marketplace.css`, copied byte-for-byte into each app's static assets. Link it
alongside the app's existing shell styles. The document has `html lang` equal to the full locale
and the normal site header. Its `main` contains exactly one `article.marketplace`:

1. `nav.marketplace__categories` with category names, links to `/marketplace/{locale}/item_1`.
2. `h1` title; `p.marketplace__subtitle` only when subtitle is non-null; `ul.marketplace__badges`
   with one `li` per badge (keep an empty `ul`).
3. `div.marketplace__images` with one `div.marketplace__image` per image, `role=img`,
   `aria-label` = title + space + 1-based image number, `data-src` the original URL (not fetched).
4. `section.marketplace__summary`: when summary exists, three spans: `strong` lowest price
   (or em dash) followed by space + `lowest` label; localized listing-count plural; grouped
   quantity followed by space + `available` label. Otherwise one span with `no_listings`.
5. `section.marketplace__listings`: `h2` listings label; GET form with labeled `seller` text
   input, `sort` select with values `asc`/`desc`, submit button `apply`; then a table with the six
   translated headers seller, condition, ships_from, qty, price, reviews. Each `tr` has
   `data-listing-id`; cells: seller with optional ` · {localized rating} ★` suffix, condition,
   ships_from, grouped quantity, formatted price or em dash, grouped reviews. Stable sort by
   numeric price, missing prices last; desc reverses price order but not equal-price input order.
   Case-sensitive `seller` prefix filter, no trimming. Empty prefix matches all. No hidden rows.
6. `section.marketplace__offers`: `h2` offers label; table with buyer/condition/qty/price
   headers and first five input-order offers (or all with `offers=all`); each tr `data-offer-id`.
   When more than five and not all, link `.marketplace__more` with `show_all` label, preserving
   locale, seller and sort, adding `offers=all`. No hidden/template/offscreen extra offer rows.
7. `section.marketplace__alert`: `h2` alert title; POST form with labels email/target, inputs
   `email` (email type) and `target_price` (text, decimal inputmode), button submit label. Always
   include `p.marketplace__message` (empty on GET). Email must contain @; target must be positive
   and read in the URL locale (decimal dot in en, comma in fr/de; grouping may be accepted).
   Error text is `invalid_email` or `invalid_price`; successful text is `alert_set` substituting
   email, title, and the locale-formatted target amount. Invalid forms return 200 with error.
8. `section.marketplace__details`: `h2` details; description p; dl with dt/dd per field; ul
   tags with one li each, even when empty.
9. `section.marketplace__contents` and `section.marketplace__included`: always present with
   translated h2 and ul; one li per line with localized-route link title, then ` × ` + grouped
   quantity. Navigation retains the locale.

All controls and links must work without JS and after the normal framework runtime loads. A
framework may enhance them using its ordinary APIs, but must keep the GET/POST fallbacks and
identical initial rows. Do not share a pre-rendered HTML service between frameworks.

## Validation

Copy shared labels/styles into each app's normal build assets. Add ecosystem-local tests for
formatting and request-time source handling, then run both sources through the independent
whole-page gate described in [the README](README.md#running). A formatting capture alone is
not conformance. Keep catalog and legacy behavior unchanged; never rewrite historical results
or use an incomplete/check-only round as a performance baseline.
