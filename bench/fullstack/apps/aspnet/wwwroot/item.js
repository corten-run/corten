// Shared by the htmx apps (django, fastapi, express, aspnet, spring, gin, drogon, axum-maud):
// byte-identical copies.
// The server renders the listings cheapest first; "high to low" is the same rows reversed, which
// is the order sortListings gives. The button holds both labels and shows one, as Corten's does.
// htmx does the form, "show all" and navigation (hx-boost).
document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-sort]");
  if (!button) return;
  const rows = button.parentElement.querySelector("tbody");
  rows.append(...[...rows.rows].reverse());
  const [ascending, descending] = button.children;
  const down = descending.hidden;
  ascending.hidden = down;
  descending.hidden = !down;
});
// The browser benchmark reads this mark: the page's scripts have run.
window.__hydratedAt = performance.now();
