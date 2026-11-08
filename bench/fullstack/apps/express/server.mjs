// Express 5 with EJS views, as Express's guide sets one up, run as its production guide says
// (NODE_ENV=production, which caches the compiled views). htmx does the form, "show all" and
// navigation (hx-boost), as in the other htmx apps.
import express from "express";
import { fileURLToPath } from "node:url";
import { alertMessage, fetchItem, shelf } from "./lib/view-model.mjs";
import { fetchCatalogRecord } from "./lib/catalog.mjs";
import { fetchMarketplaceRecord, isLocale, pageModel, readQuery } from "./lib/marketplace.mjs";

const app = express();
app.disable("x-powered-by");
app.set("view engine", "ejs");
app.set("views", fileURLToPath(new URL("./views", import.meta.url)));
app.use("/static", express.static(fileURLToPath(new URL("./static", import.meta.url))));
const form = express.urlencoded({ extended: false });
const field = (body, name) => (typeof body?.[name] === "string" ? body[name] : "");
const counts = new Intl.NumberFormat("en-US");
app.locals.grouped = (n) => counts.format(n);

app.get("/", (req, res) => {
  // Corten's home page: cards for the first 50 items with items in memory, links by id from the
  // item API (which cannot list items).
  res.render("home", { items: shelf() });
});

async function item(req, res) {
  const view = await fetchItem(req.params.id);
  if (!view) return res.status(404).render("not-found");
  let message = "";
  if (req.method === "POST") {
    message = alertMessage(field(req.body, "title"), field(req.body, "email"), field(req.body, "target_price"));
    // htmx swaps only the message; without JavaScript the whole page comes back.
    if (req.get("HX-Request")) return res.render("alert-message", { message });
  }
  const allOffers = req.query.offers === "all";
  res.render("item", {
    item: view,
    listings: [...view.listings].sort((a, b) => a.price_value - b.price_value),
    offers: allOffers ? view.offers : view.offers.slice(0, 5),
    moreOffers: view.offers.length > 5 && !allOffers,
    message,
  });
}
app.get("/items/:id", item);
app.post("/items/:id", form, item);

app.get("/api/items/:id", async (req, res) => {
  const view = await fetchItem(req.params.id);
  if (!view) return res.sendStatus(404);
  res.json(view);
});

// Express has no CSRF protection of its own, so, as the Gin and Drogon apps do, a post another
// site sends is refused: the browser says so in Sec-Fetch-Site, or its Origin is another host.
const crossSite = (req) => {
  const origin = req.get("Origin");
  return req.get("Sec-Fetch-Site") === "cross-site" || (origin !== undefined && origin !== `${req.protocol}://${req.get("Host")}`);
};

async function marketplace(req, res) {
  const { locale, id } = req.params;
  if (!isLocale(locale)) return res.status(400).type("text").send("Unsupported locale");
  if (req.method === "POST" && crossSite(req)) return res.status(403).type("text").send("Forbidden");
  const record = await fetchMarketplaceRecord(id);
  if (!record) return res.sendStatus(404);
  const posted = req.method === "POST" ? { email: field(req.body, "email"), target: field(req.body, "target_price") } : null;
  res.render("marketplace", pageModel(locale, record, readQuery(req.query), posted));
}
app.get("/marketplace/:locale/:id", marketplace);
app.post("/marketplace/:locale/:id", form, marketplace);

app.get("/api/marketplace/:id", async (req, res) => {
  const record = await fetchMarketplaceRecord(req.params.id);
  if (!record) return res.sendStatus(404);
  res.json(record);
});

app.get("/catalog/:id", async (req, res) => {
  const record = await fetchCatalogRecord(req.params.id);
  if (!record) return res.sendStatus(404);
  const prefix = typeof req.query.field === "string" ? req.query.field : "";
  res.render("catalog", { record, prefix, fields: record.fields.filter((f) => f.name.startsWith(prefix)) });
});

app.get("/api/catalog/:id", async (req, res) => {
  const record = await fetchCatalogRecord(req.params.id);
  if (!record) return res.sendStatus(404);
  res.json(record);
});

// The live benchmark (bench/live): GET /live/prices is a server-sent event stream and every
// POST /live/publish body goes to each open stream.
const streams = new Set();
app.get("/live/prices", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  res.write(": open\n\n");
  streams.add(res);
  req.on("close", () => streams.delete(res));
});
app.post("/live/publish", express.text({ type: () => true }), (req, res) => {
  const event = `data: ${typeof req.body === "string" ? req.body : ""}\n\n`;
  for (const stream of streams) stream.write(event);
  res.sendStatus(204);
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, "0.0.0.0", () => console.log(`express item page listening on ${port}`));
