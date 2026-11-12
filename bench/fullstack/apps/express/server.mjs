// Express 5 with EJS views, as Express's guide sets one up, run as its production guide says
// (NODE_ENV=production, which caches the compiled views). htmx does the form, "show all" and
// navigation (hx-boost), as in the other htmx apps.
// With PROFILE=matched it adds the matched tier's production profile (bench/fullstack/README.md,
// "The matched tier") from the middleware Express's documentation names and Node's server settings.
import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { alertMessage, fetchItem, shelf } from "./lib/view-model.mjs";
import { fetchCatalogRecord } from "./lib/catalog.mjs";
import { fetchMarketplaceRecord, isLocale, pageModel, readQuery } from "./lib/marketplace.mjs";
import { recordJson, recordMethod, recordError } from "./lib/record-json.mjs";

const profile = process.env.PROFILE === "matched";
const app = express();
app.disable("x-powered-by");
app.set("view engine", "ejs");
app.set("views", fileURLToPath(new URL("./views", import.meta.url)));
if (profile) {
  // The profile's middleware, loaded only under it.
  const [{ default: timeout }, { default: compression }, { default: helmet }] = await Promise.all([import("connect-timeout"), import("compression"), import("helmet")]);
  app.use(
    // A 503 past 10 s (card-market's deadline), from Express's timeout middleware; a response whose
    // headers are sent (the live stream) is no longer timed. As its documentation says, a request
    // that has timed out must go no further (haltOnTimedout and the req.timedout checks below): a
    // second answer throws, which ends the process from a render and closes the connection otherwise.
    timeout("10s"),
    // Brotli or gzip when asked, from Express's compression middleware; not the live stream, which
    // it would hold back to fill its window.
    compression({ filter: (req, res) => !String(res.getHeader("Content-Type") ?? "").startsWith("text/event-stream") && compression.filter(req, res) }),
    // The security headers on every answer, from Helmet (Express's security guide), with axum-maud's
    // CSP, referrer and frame policies in place of Helmet's own; Helmet's other headers as it sets them.
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "default-src": ["'self'"], "script-src": ["'self'"], "style-src": ["'self'"], "img-src": ["'self'", "data:", "https:"],
          "object-src": ["'none'"], "base-uri": ["'self'"], "form-action": ["'self'"], "frame-ancestors": ["'none'"],
        },
      },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      xFrameOptions: { action: "deny" },
    }),
    // The header Helmet does not set, as Helmet's documentation sets one ("You might not need Helmet").
    (req, res, next) => {
      res.set("Permissions-Policy", "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()");
      next();
    },
  );
}
app.use("/static", express.static(fileURLToPath(new URL("./static", import.meta.url))));
// The pages and the JSON (not the static files, served above) are kept from shared caches, the same way.
if (profile) {
  app.use((req, res, next) => {
    res.set("Cache-Control", "private, no-cache");
    next();
  });
}
const form = express.urlencoded({ extended: false });
// After a body parser, connect-timeout's documentation stops a request that has timed out from going on.
function haltOnTimedout(req, res, next) {
  if (!req.timedout) next();
}
const parsed = (parser) => (profile ? [parser, haltOnTimedout] : [parser]);
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
  if (req.timedout) return;
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
app.post("/items/:id", ...parsed(form), item);

app.get("/api/items/:id", async (req, res) => {
  const view = await fetchItem(req.params.id);
  if (req.timedout) return;
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
  if (req.timedout) return;
  if (!record) return res.sendStatus(404);
  const posted = req.method === "POST" ? { email: field(req.body, "email"), target: field(req.body, "target_price") } : null;
  res.render("marketplace", pageModel(locale, record, readQuery(req.query), posted));
}
app.get("/marketplace/:locale/:id", marketplace);
app.post("/marketplace/:locale/:id", ...parsed(form), marketplace);

app.route("/api/marketplace/:id").get(recordJson(fetchMarketplaceRecord)).all(recordMethod);

app.get("/catalog/:id", async (req, res) => {
  const record = await fetchCatalogRecord(req.params.id);
  if (req.timedout) return;
  if (!record) return res.sendStatus(404);
  const prefix = typeof req.query.field === "string" ? req.query.field : "";
  res.render("catalog", { record, prefix, fields: record.fields.filter((f) => f.name.startsWith(prefix)) });
});

app.route("/api/catalog/:id").get(recordJson(fetchCatalogRecord)).all(recordMethod);

// The live benchmark (bench/live): GET /live/prices is a server-sent event stream and every
// POST /live/publish body goes to each open stream.
const streams = new Set();
app.get("/live/prices", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  res.write(": open\n\n");
  streams.add(res);
  req.on("close", () => streams.delete(res));
});
app.post("/live/publish", ...parsed(express.text({ type: () => true })), (req, res) => {
  // One data line per line of the body, as an event stream requires.
  const body = typeof req.body === "string" ? req.body : "";
  const event = `${body.split(/\r\n|\r|\n/).map((line) => `data: ${line}`).join("\n")}\n\n`;
  for (const stream of streams) stream.write(event);
  res.sendStatus(204);
});

app.use(recordError);

const port = Number(process.env.PORT ?? 8080);
const listening = () => console.log(`express item page listening on ${port}`);
if (profile) {
  // Node's server as app.listen makes it, given the profile's header timeout (30 s, as Corten's,
  // checked every second where Node's default checks every 30) and connection cap (MAX_CONNECTIONS;
  // Node closes a connection past it).
  const server = createServer({ headersTimeout: 30_000, connectionsCheckingInterval: 1_000 }, app);
  if (process.env.MAX_CONNECTIONS) server.maxConnections = Number(process.env.MAX_CONNECTIONS);
  server.listen(port, "0.0.0.0", listening);
} else {
  app.listen(port, "0.0.0.0", listening);
}
