// @ts-check
// The doctests' PriceList (script.rs, Ref::with) and the tests' (script/tests.rs): rows a script
// only puts in another order, by the value each gives its ref.

/**
 * Puts the rows in order of the cents each gives, cheapest first; rows at one price keep the
 * page's order.
 * @param {HTMLTableSectionElement} body @param {Map<HTMLTableRowElement, number>} rows
 */
export function sort(body, rows) {
  const sorted = Array.from(rows).sort(([, a], [, b]) => a - b);
  body.append(...sorted.map(([row]) => row));
}

/**
 * Puts the rows in order of the name each gives, in the page's language.
 * @param {HTMLTableSectionElement} body @param {Map<HTMLTableRowElement, string>} rows
 */
export function sortByName(body, rows) {
  const collator = new Intl.Collator(document.documentElement.lang);
  const sorted = Array.from(rows).sort(([, a], [, b]) => collator.compare(a, b));
  body.append(...sorted.map(([row]) => row));
}
